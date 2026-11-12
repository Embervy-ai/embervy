import { approvalMatch, createApprovalSettingsReader, loadApprovalRules, type ApprovalContext, type ApprovalMatch, type ApprovalRules } from "./approval-rules";
import { splitPrefixedToolName } from "./mcp-stdio";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ApprovalHookOptions { rules: string; tools: string; settings?: string; scratch?: string }

/** Share the mapping with permission cards so their reason matches the hook. */
export function pipeApprovalMatch(config: ApprovalRules, mode: string, tool: string, input: Record<string, unknown>, context: ApprovalContext = {}): ApprovalMatch | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  // Claude Code supplies cwd in the hook envelope, not in arbitrary tool arguments.
  context = { ...context, inputCwd: false, trimPaths: false };
  // The permission-prompt tool is the card transport, not another action to approve.
  const split = splitPrefixedToolName(tool);
  if (config.level && config.alwaysAsk.has(tool)) return approvalMatch(config, mode, tool, input, context);
  if (config.level && split?.server === "brain" && split.tool === "approve") return null;
  let names: string[], mapped = input;
  if (tool === "Bash") names = ["bash", "task_start"];
  else if (["Write", "Edit", "MultiEdit"].includes(tool)) {
    names = ["write_file", "edit_file"];
    mapped = { ...input, path: input.file_path };
  } else if (splitPrefixedToolName(tool)) names = [tool];
  else if (config.level) names = [tool];
  else return null;
  // Whole-tool choices take precedence over patterns, including native CLI names.
  for (const name of [tool, ...names]) {
    if (config.alwaysAsk.has(name)) return approvalMatch(config, mode, name, mapped, context);
  }
  for (const name of names) {
    const match = approvalMatch(config, mode, name, mapped, context);
    if (match) return match;
  }
  return null;
}

export const APPROVAL_HOOK_MATCHER = "Bash|Write|Edit|MultiEdit|mcp__.*";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function approvalHookCommand(options: ApprovalHookOptions): string {
  // Pin the runtime so PATH cannot select a different executable.
  return `${options.settings ? `BRAIN_APPROVAL_SETTINGS=${shellQuote(options.settings)} ` : ""}BRAIN_APPROVAL_RULES=${shellQuote(options.rules)} BRAIN_APPROVAL_TOOLS=${shellQuote(options.tools)} BRAIN_APPROVAL_SCRATCH=${shellQuote(options.scratch ?? "")} ${shellQuote(process.execPath)} ${shellQuote(import.meta.path)}`;
}

export function approvalSettingsArg(settingsPath: string, cwd: string, options: ApprovalHookOptions): string {
  let base: Record<string, any>;
  try { base = JSON.parse(readFileSync(resolve(cwd, settingsPath), "utf8")); }
  catch { base = JSON.parse(settingsPath); }
  const hooks = base.hooks ?? {};
  const previous = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  return JSON.stringify({ ...base, hooks: { ...hooks, PreToolUse: [...previous, {
    matcher: ".*", hooks: [{ type: "command", command: approvalHookCommand(options) }],
  }] } });
}

if (import.meta.main) {
  try {
    const call = JSON.parse(await Bun.stdin.text());
    const setting = process.env.BRAIN_APPROVAL_RULES ?? "default";
    const settings = process.env.BRAIN_APPROVAL_SETTINGS;
    if ((settings || setting !== "off") && typeof call?.tool_name === "string") {
      let invalid = false;
      const config = settings ? createApprovalSettingsReader(settings, () => {}, () => { invalid = true; })() : loadApprovalRules(setting, process.env.BRAIN_APPROVAL_TOOLS ?? "");
      if (invalid && process.env.BRAIN_CONTROL_TOKEN) {
        await fetch(`http://127.0.0.1:${process.env.BRAIN_CONTROL_PORT ?? "3910"}/tool`, {
          method: "POST", headers: { authorization: `Bearer ${process.env.BRAIN_CONTROL_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "approval_settings_check", args: {} }), signal: AbortSignal.timeout(1000),
        }).catch(() => undefined);
      }
      const match = pipeApprovalMatch(config, "app", call.tool_name, call.tool_input, { cwd: typeof call.cwd === "string" ? resolve(call.cwd) : process.cwd() });
      if (match) console.log(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: match.label,
      } }));
    }
  } catch {
    // A hook failure must leave Claude Code's normal permission layer in charge.
  }
}
