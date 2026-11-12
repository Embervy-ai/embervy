// Cards ask before listed actions, including changes to approval settings; they are not a sandbox.
// A determined or injected agent with root can bypass these heuristics. Interpreter code such as
// python3 -c, variable expansion and arbitrary shell syntax are not parsed.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { homedir } from "node:os";
import { appMcpServer } from "./app-channel";

export interface ApprovalRule {
  tool: string;
  field: string;
  pattern: RegExp;
  label: string;
  protectedWrites?: boolean;
  scratchRm?: boolean;
}
export interface ApprovalMatch { label: string; trigger: "rule" | "BRAIN_APPROVAL_TOOLS" }
export interface ApprovalRules {
  source: "default" | "off" | "file";
  rules: ApprovalRule[];
  protectedRules?: ApprovalRule[];
  alwaysAsk: Set<string>;
  level?: "all" | "important" | "none";
}
type Log = (event: Record<string, unknown>) => void;

// `git stash push` stays on this machine; it is neither a publish nor a force push.
const NOT_STASH = String.raw`(?:(?!\bstash\b)[^;&|\n])`;
const COMMAND_RULES: Array<[string, string, boolean?]> = [
  ["deletes", String.raw`\brm\b[^;&|\n]*\s(?:--(?:recursive|force)\b|-[a-z]*[rf][a-z]*\b)`, true],
  ["deletes", String.raw`\brm\b[^;&|\n]*[*?\[]`, true],
  ["deletes", String.raw`\bfind\b[^;&|\n]*\s-delete\b`],
  ["deletes", String.raw`\bfind\b[^|\n]*\s-exec(?:dir)?\s+(?:[^\s;]*/)?rm\b`],
  ["deletes", String.raw`\bxargs\b[^;&|\n]*\b(?:rm)\b`],
  ["runs piped shell code", String.raw`(?<!\|)\|(?!\|)\s*(?:[^\s;&|]*/)?(?:sh|bash)(?=\s|$)`],
  ["deletes", String.raw`\b(?:shred|truncate|mkfs(?:\.[\w-]+)?)(?=\s|$)`],
  ["deletes", String.raw`\bdd\b[^;&|\n]*\sof=`],
  ["deletes", String.raw`\bgit\b[^;&|\n]*\breset\b[^;&|\n]*\s--hard\b`],
  ["deletes", String.raw`\bgit\b[^;&|\n]*\bclean\b[^;&|\n]*\s-[a-z]*f[a-z]*\b`],
  ["deletes", String.raw`\bgit\b[^;&|\n]*\bbranch\b[^;&|\n]*\s-D\b`],
  ["deletes", String.raw`\bgit\b${NOT_STASH}*\bpush\b[^;&|\n]*\s(?:--force(?:-with-lease|-if-includes)?\b|-[a-z]*f[a-z]*\b)`],
  ["deletes", String.raw`\b(?:DROP\s+(?:TABLE|DATABASE)|DELETE\s+FROM|TRUNCATE)\b`],
  ["deletes", String.raw`\bcrontab\b[^;&|\n]*\s-r\b`],
  ["stops a service", String.raw`\bsystemctl\b[^;&|\n]*\b(?:stop|disable|kill|restart)\b`],
  ["stops a service", String.raw`\b(?:shutdown|reboot|poweroff|halt|kill|pkill|killall)(?=\s|$)`],
  ["stops a service", String.raw`\btmux\b[^;&|\n]*\bkill-(?:server|session)\b`],
  ["publishes", String.raw`\bwrangler\b[^;&|\n]*\b(?:deploy|publish|delete|secret)\b`],
  ["publishes", String.raw`\bgit\b${NOT_STASH}*\bpush\b`],
  ["publishes", String.raw`\b(?:npm|bun)\s+publish\b`],
  ["publishes", String.raw`\bdocker\s+push\b`],
  ["publishes", String.raw`\bgh\s+(?:release\b|repo\s+(?:create|edit|delete)\b)`],
  ["sends", String.raw`\b(?:sendmail|msmtp|mutt)(?=\s|$)|\bmail\b[^;&|\n]*\s-s\b`],
];
const APPROVAL_PATH = String.raw`/(?:approval-settings\.json|approval-[^/]+\.ts)$|/\.claude/settings(?:\.local)?\.json$`;
const SYSTEM_PATH = String.raw`^/(?:etc|var/spool/cron)(?:/|$)|/\.ssh(?:/|$)|/systemd/(?:system|user)(?:/|$)|/(?:\.env(?:\.[^/]*)?|[^/]*\.env)$`;

export interface ApprovalContext { cwd?: string; inputCwd?: boolean; trimPaths?: boolean; scratch?: string }

// New targets still inherit the canonical location of their nearest existing parent.
export function approvalPath(path: string, cwd = process.cwd(), canonical = true): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  let current = resolve(cwd, expanded);
  if (!canonical) return current;
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...tail); } catch {}
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function protectedPathPattern(settings?: string, rules?: string, system = true): RegExp {
  const paths = [settings, rules, process.env.BRAIN_APPROVAL_SETTINGS,
    ...[process.env.BRAIN_APPROVAL_RULES].filter((path) => path && path !== "default" && path !== "off")];
  const exact = paths.filter((path): path is string => Boolean(path)).flatMap((path) => [true, false].map((canonical) => `^${escapePattern(approvalPath(path, process.cwd(), canonical))}$`));
  return new RegExp([...(system ? [SYSTEM_PATH] : []), APPROVAL_PATH, ...exact].join("|"), "i");
}

function protectedWriteRules(pattern: RegExp): ApprovalRule[] {
  return [
    ...["bash", "task_start"].map((tool) => ({ tool, field: "command", pattern, label: "writes system files", protectedWrites: true })),
    ...["write_file", "edit_file"].map((tool) => ({ tool, field: "path", pattern, label: "writes system files" })),
  ];
}

export function defaultApprovalRules(settings?: string): ApprovalRule[] {
  return [
    ...COMMAND_RULES.flatMap(([label, pattern, scratchRm]) => ["bash", "task_start"].map((tool) => ({ tool, field: "command", pattern: new RegExp(pattern, "i"), label, scratchRm }))),
    ...protectedWriteRules(protectedPathPattern(settings)),
  ];
}

export function parseApprovalRules(text: string, log: Log = () => {}, path?: string): ApprovalRule[] {
  const rules: ApprovalRule[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!Array.isArray(entry) || entry.length !== 4 || !entry.every((value) => typeof value === "string" && value.trim())) throw new Error("expected four nonempty strings");
      const [tool, field, pattern, label] = entry as string[];
      rules.push({ tool, field, pattern: new RegExp(pattern, "i"), label });
    } catch {
      // Do not log rule contents: a custom expression can contain private data.
      log({ type: "approval_rule_invalid", path, line: index + 1 });
    }
  }
  return rules;
}

export function loadApprovalRules(setting = "default", tools = "", log: Log = () => {}): ApprovalRules {
  const alwaysAsk = new Set(tools.split(",").map((tool) => tool.trim()).filter(Boolean));
  if (setting === "default") return { source: "default", rules: defaultApprovalRules(), alwaysAsk };
  if (setting === "off") return { source: "off", rules: [], alwaysAsk };
  let rules: ApprovalRule[] = [];
  try { rules = parseApprovalRules(readFileSync(setting, "utf8"), log, setting); }
  catch { log({ type: "approval_rules_unreadable", path: setting }); }
  // Custom action rules cannot silently remove the card for changing their own configuration.
  return { source: "file", rules, protectedRules: protectedWriteRules(protectedPathPattern(undefined, setting, false)), alwaysAsk };
}

// Only shipped server identities inherit the built-in exceptions.
export function approvalMcpServers(): string[] {
  const app = appMcpServer();
  return [...new Set(["app", app, app.replace(/-/g, "_"), "lore", "brain"])];
}

function approvalFreeToolNames(): Set<string> {
  return new Set([...APPROVAL_FREE_TOOLS].flatMap((tool) => [
    tool, ...approvalMcpServers().map((server) => `mcp__${server}__${tool}`),
  ]));
}

// Unknown tools require approval because read-like names do not establish safety.
export const APPROVAL_FREE_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "ToolSearch",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "TaskGet", "TaskList", "TaskOutput",
  "read_file", "list_dir", "grep", "glob", "repo_map", "outline", "rag_search", "web_search", "web_fetch",
  "status", "pins", "task_status", "task_output",
  // Memory lookups pass without a card even at level "all"; memory writes still ask.
  "find", "scan", "recall", "wake", "trace", "health",
  // Reply tools bypass cards to avoid asking permission for each answer.
  "reply", "voice_reply", "react", "send_file", "watchdog_status",
  // It asks the person itself when it loosens anything.
  "approval_settings",
]);

export function approvalSettingsFinding(path: string) {
  return {
    id: "approval-settings", label: "Approval settings could not be read",
    detail: "The agent is using important-action cards, not your saved approval level.",
    fix: `Repair ${path} with a valid level (all, important or none) and extra rules in the app settings.`,
  };
}

/** Stat on every call; atomic app replacements also invalidate the cache. */
export function createApprovalSettingsReader(path: string, log: Log = () => {}, finding: (entry: ReturnType<typeof approvalSettingsFinding>) => void = () => {}) {
  let stamp: string | undefined, cached: ApprovalRules | undefined;
  return (): ApprovalRules => {
    let next = "unreadable";
    try { const s = statSync(path); next = `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`; } catch {}
    if (cached && next === stamp) return cached;
    stamp = next;
    try {
      const settings = JSON.parse(readFileSync(path, "utf8"));
      if (!["all", "important", "none"].includes(settings?.level) || !Array.isArray(settings.extra)) throw new Error("invalid settings");
      const extra: ApprovalRule[] = settings.extra.map((entry: any) => {
        if (![entry?.label, entry?.tool, entry?.field, entry?.pattern].every((value) => typeof value === "string" && value.trim())) throw new Error("invalid rule");
        return { label: entry.label, tool: entry.tool, field: entry.field, pattern: new RegExp(entry.pattern, "i") };
      });
      cached = { source: "file", level: settings.level, rules: [...defaultApprovalRules(path), ...extra], alwaysAsk: new Set() };
    } catch {
      cached = { source: "default", level: "important", rules: defaultApprovalRules(path), alwaysAsk: new Set() };
      log({ type: "approval_settings_invalid", path, fallback: "important" });
      finding(approvalSettingsFinding(path));
    }
    return cached;
  };
}

function normalizedCommand(command: string): string {
  return command.replace(/''|""/g, "").replace(/\\\r?\n/g, "").replace(/\\([\s\S])/g, "$1");
}

// Tokenization distinguishes literal arguments from redirections without evaluating shell code.
function shellTokens(command: string): { tokens: string[]; complete: boolean } {
  const tokens: string[] = [];
  let end = 0, complete = true;
  for (const match of command.matchAll(/(?:'[^']*'|"[^"]*"|\\[\s\S]|[^\s'"\\;&|<>])+|&&|\|\||>\||>>?|[;&|<>\n]/g)) {
    complete &&= /^[ \t]*$/.test(command.slice(end, match.index));
    tokens.push(match[0]);
    end = match.index! + match[0].length;
  }
  return { tokens, complete: complete && /^[ \t]*$/.test(command.slice(end)) };
}

function shellWrites(command: string, pattern: RegExp, base: string, removals = false): boolean {
  const { tokens } = shellTokens(command);
  let cwd = base;
  let segment: string[] = [];
  const word = (value: string) => value.replace(/'([^']*)'|"([^"]*)"|\\([\s\S])/g, (_all, single, double, escaped) => single ?? double ?? escaped);
  const protectedTarget = (path: string) => Boolean(path) && [true, false].some((canonical) => pattern.test(approvalPath(path, cwd, canonical)));
  const destination = (target: string, sources: string[]) => {
    if (protectedTarget(target)) return true;
    let directory = target.endsWith("/");
    try { directory ||= statSync(approvalPath(target, cwd)).isDirectory(); } catch {}
    return directory && sources.some((source) => protectedTarget(join(target, basename(source))));
  };
  const check = (): boolean => {
    const args = segment.map(word);
    for (let i = 0; i < segment.length; i++) {
      if ([">", ">>", ">|"].includes(segment[i]) && segment[i + 1] && protectedTarget(word(segment[i + 1]))) return true;
    }
    let start = 0;
    while (start < args.length) {
      if (["-u", "-g", "--user", "--group"].includes(args[start])) { start += 2; continue; }
      if (args[start].includes("=") || ["sudo", "command", "env"].includes(basename(args[start])) || args[start].startsWith("-")) { start++; continue; }
      break;
    }
    const executable = basename(args[start] ?? "");
    const rest = args.slice(start + 1);
    if (executable === "cd" && rest[0]) cwd = approvalPath(rest[0], cwd);
    if (removals && executable === "rm") return rest.filter((arg) => !arg.startsWith("-")).some(protectedTarget);
    if (executable === "crontab") return !rest.includes("-l");
    if (executable === "tee") return rest.filter((arg) => !arg.startsWith("-")).some(protectedTarget);
    if (["cp", "mv", "install"].includes(executable)) {
      const target = rest.findIndex((arg) => arg === "-t" || arg === "--target-directory");
      const inline = rest.find((arg) => arg.startsWith("--target-directory=") || /^-t.+/.test(arg));
      const operands: string[] = [];
      let literal = false;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (!literal && arg === "--") { literal = true; continue; }
        if (!literal && ["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"].includes(arg)) { i++; continue; }
        if (literal || !arg.startsWith("-")) operands.push(arg);
      }
      const directory = target >= 0 ? rest[target + 1] : inline ? (inline.startsWith("--") ? inline.slice(inline.indexOf("=") + 1) : inline.slice(2)) : undefined;
      if (directory) return destination(directory, operands);
      return operands.length > 0 && destination(operands.at(-1)!, operands.slice(0, -1));
    }
    if (executable === "sed" && rest.some((arg) => /^-(?:[a-zA-Z]*i|i.*)$/.test(arg) || /^--in-place(?:=|$)/.test(arg))) {
      return rest.filter((arg) => !arg.startsWith("-")).some(protectedTarget);
    }
    return false;
  };
  for (const token of [...tokens, ";"]) {
    if ([";", "&&", "||", "|", "&", "\n"].includes(token)) {
      if (check()) return true;
      segment = [];
    } else segment.push(token);
  }
  return false;
}

// Symlinks cannot be excluded textually; scratch directories must be written only by the agent itself.
function scratchRemovals(command: string, setting: string): boolean {
  if (!setting) return false;
  const literalPath = (path: string) => path.startsWith("/") && !/[$`~{}\[\]\\'";|&<>\x00-\x1f\x7f]/.test(path);
  const roots = setting.split(":");
  if (!roots.every((root) => literalPath(root) && !/[*?]/.test(root))) return false;
  const normalize = (path: string) => posix.normalize(path).replace(/\/$/, "") || "/";
  const normalizedRoots = roots.map(normalize);
  const below = (path: string) => !normalizedRoots.includes(path) && normalizedRoots.some((root) => path.startsWith(root === "/" ? "/" : root + "/"));
  const target = (path: string) => {
    if (!literalPath(path)) return false;
    const parent = posix.dirname(path);
    if (/[*?]/.test(parent)) return false;
    // A glob's literal parent must already be a child, not the scratch root itself.
    if (/[*?]/.test(path) && !below(normalize(parent))) return false;
    return below(normalize(path));
  };
  const { tokens, complete } = shellTokens(command);
  if (!complete) return false;
  const segments: string[][] = [[]];
  let separator = "";
  for (const token of tokens) {
    if ([";", "&&", "||", "\n"].includes(token)) {
      if (!segments.at(-1)!.length) return false;
      segments.push([]);
      separator = token;
    } else segments.at(-1)!.push(token);
  }
  if (!segments.at(-1)!.length) {
    if (["&&", "||"].includes(separator)) return false;
    segments.pop();
  }
  let sawRm = false;
  for (const segment of segments) {
    const args: string[] = [];
    for (const token of segment) {
      // Only whole, simply quoted words qualify; concatenation and escapes stay with cards.
      if (!/^(?:'[^']*'|"[^"]*"|[^'"\s]+)$/.test(token)) return false;
      const arg = /^["']/.test(token) ? token.slice(1, -1) : token;
      if (/[$`~{}()\[\]\\;|&<>#\x00-\x1f\x7f]/.test(arg)) return false;
      args.push(arg);
    }
    if (segment[0] !== "rm") {
      // Unknown commands may wrap rm or change shell state; known direct actions retain their own rules.
      const harmless = ["echo", "printf", "pwd", "ls", "true", "false", ":"].includes(segment[0]);
      const gitAction = segment[0] === "git" && ["status", "diff", "log", "reset", "clean", "branch", "push"].includes(segment[1]);
      const publishes = (["npm", "bun"].includes(segment[0]) && segment[1] === "publish")
        || (segment[0] === "docker" && segment[1] === "push")
        || (segment[0] === "wrangler" && ["deploy", "publish", "delete", "secret"].includes(segment[1]))
        || (segment[0] === "gh" && (segment[1] === "release" || (segment[1] === "repo" && ["create", "edit", "delete"].includes(segment[2]))));
      const directAction = segment[0] === "dd";
      if (!harmless && !gitAction && !publishes && !directAction) return false;
      continue;
    }
    sawRm = true;
    let operands = 0, literal = false;
    for (const arg of args.slice(1)) {
      if (!literal && arg === "--") { literal = true; continue; }
      if (!literal && arg.startsWith("-")) {
        if (!/^(?:-[rfRidIv]+|--(?:recursive|force|dir|verbose|interactive(?:=(?:never|once|always))?|one-file-system|preserve-root|no-preserve-root))$/.test(arg)) return false;
        continue;
      }
      if (!target(arg)) return false;
      operands++;
    }
    if (!operands) return false;
  }
  return sawRm;
}

export function approvalMatch(config: ApprovalRules, mode: string, tool: string, input: Record<string, unknown>, context: ApprovalContext = {}): ApprovalMatch | null {
  if (!config.level && mode !== "app") return null;
  if (config.alwaysAsk.has(tool)) return { label: "always asks", trigger: "BRAIN_APPROVAL_TOOLS" };
  if (config.level === "none") return null;
  if (config.level === "all") return approvalFreeToolNames().has(tool) ? null : { label: "changes or sends", trigger: "rule" };
  const base = context.cwd ?? process.cwd();
  const cwd = context.inputCwd !== false && ["bash", "task_start"].includes(tool) && typeof input?.cwd === "string" ? approvalPath(input.cwd.trim(), base) : base;
  let scratchAllowed: boolean | undefined;
  for (const rule of [...config.rules, ...(config.protectedRules ?? [])]) {
    const value = input?.[rule.field];
    if (rule.tool !== tool || typeof value !== "string") continue;
    const pathValue = context.trimPaths !== false && ["write_file", "edit_file"].includes(tool) && rule.field === "path" ? value.trim() : value;
    const values = rule.field === "command" ? [value, normalizedCommand(value)]
      : /(?:^|_)(?:path|cwd)$/.test(rule.field) ? [true, false].map((canonical) => approvalPath(pathValue, rule.field === "cwd" ? base : cwd, canonical)) : [value];
    if (rule.scratchRm && ["bash", "task_start"].includes(tool) && rule.field === "command") {
      // Check the original spelling, never the expansion-hiding normalized form.
      scratchAllowed ??= scratchRemovals(value, context.scratch ?? process.env.BRAIN_APPROVAL_SCRATCH ?? "");
      if (scratchAllowed) continue;
    }
    if (values.some((candidate) => rule.protectedWrites ? shellWrites(candidate, rule.pattern, cwd, scratchAllowed === true) : rule.pattern.test(candidate))) return { label: rule.label, trigger: "rule" };
  }
  return null;
}
