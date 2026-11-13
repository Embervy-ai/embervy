/** system-prompt.ts — opt-in context files and minimal tool rules, read afresh at prompt construction. */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { systemPromptMode, type HeadSpec, type SystemPromptMode } from "./heads";
import { loadClaudeToolRules } from "./claude-prompt";
import { join } from "node:path";
import { notesDirectory, notesMaxBytes, notesSection } from "./notes";
import { skillsSection } from "./skills";

type Env = Record<string, string | undefined>;
type Log = (event: Record<string, unknown>) => void;

export const DEFAULT_TOOL_RULES = `## Tool use
- Read a file before editing it.
- Prefer dedicated tools (Read, Edit, Grep, Glob) to shell commands (cat, sed, grep).
- Run independent tool calls in parallel; wait for dependencies before dependent calls.
- Do not guess paths: inspect the filesystem first.
- Run long commands in the background rather than blocking the conversation; check their completion.
- Use helpers (the Agent tool, when available) for broad searches.
- Relay relevant helper results to the human: they cannot see the helpers' output.`;

/** Bound I/O too, not just the returned text. Never block on a FIFO/device or split a UTF-8 character. */
function readPromptFile(file: string, maxBytes: number, kind: "context" | "tool_rules" | "notes", log: Log, onTruncated?: () => void): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - bytes));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      chunks.push(chunk.subarray(0, n));
      bytes += n;
    }
    const data = Buffer.concat(chunks);
    const truncated = bytes > maxBytes;
    if (truncated) {
      log({ type: `${kind}_file_truncated`, file, max_bytes: maxBytes });
      onTruncated?.();
    }
    return new TextDecoder().decode(data.subarray(0, maxBytes), { stream: truncated });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    log({ type: `${kind}_file_${code === "ENOENT" ? "missing" : "read_failed"}`, file, error: code || String(error) });
    return null;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Brain supplies opt-in notes to every head, but other context files stay API-only because the CLI loads project instructions itself. */
export function systemPromptExtras(
  head: Pick<HeadSpec, "name" | "transport">,
  env: Env,
  log: Log,
  mode: SystemPromptMode = systemPromptMode(head, env),
  automaticRules?: string | null,
): string[] {
  const parts: string[] = [];
  const notesDir = notesDirectory(env);
  if (!notesDir && env.BRAIN_NOTES_DIR?.trim()) log({ type: "notes_dir_not_absolute", dir: env.BRAIN_NOTES_DIR.trim() });
  if (notesDir) {
    let truncated = false;
    const text = readPromptFile(join(notesDir, "NOTES.md"), notesMaxBytes(env), "notes", log, () => { truncated = true; });
    parts.push(notesSection(env, text, truncated));
  }
  const parsed = Number(env.BRAIN_CONTEXT_FILE_MAX_BYTES);
  const maxBytes = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 80000;
  if (head.transport === "api") {
    const skills = skillsSection(env, log);
    if (skills) parts.push(skills);
    const files = (env.BRAIN_CONTEXT_FILES ?? "").split(":").map((file) => file.trim()).filter(Boolean);
    const sections: string[] = [];
    for (const file of files) {
      const text = readPromptFile(file, maxBytes, "context", log);
      if (text !== null) sections.push(`### ${file}\n\n${text}`);
    }
    if (sections.length) parts.push(`## Context files\n\n${sections.join("\n\n")}`);
  }
  if (mode === "replace") {
    const file = env.BRAIN_TOOL_RULES_FILE?.trim();
    const rules = file ? readPromptFile(file, maxBytes, "tool_rules", log) : null;
    // An explicitly empty rules file is allowed; missing/unreadable falls back.
    if (rules === null) parts.push(automaticRules ? `## Tool use\n\n${automaticRules}` : DEFAULT_TOOL_RULES);
    else if (rules.trim()) parts.push(`## Tool use\n\n${rules}`);
  }
  return parts;
}

/** Runtime entry: append does not even look up a CLI. An explicit rules-file
 * override keeps its own semantics; otherwise replace uses the version cache. */
export async function loadSystemPromptExtras(
  head: Pick<HeadSpec, "name" | "transport">, env: Env, log: Log,
  mode: SystemPromptMode = systemPromptMode(head, env),
): Promise<string[]> {
  const automatic = mode === "replace" && !env.BRAIN_TOOL_RULES_FILE?.trim()
    ? await loadClaudeToolRules(env, log) : null;
  return systemPromptExtras(head, env, log, mode, automatic);
}
