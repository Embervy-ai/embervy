/** Display-only redaction and live formatters. Terminal lines expose only
 * explicitly allowed metadata (command/description/path), never full payloads. */
import { tr } from "./texts";
import { isAppReplyTool } from "./app-channel";
export const LIVE_LINE_LIMIT = 100;

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const REDACTED = "[redacted]";

export function redactPreview(text: string, env: Record<string, string | undefined> = process.env): string {
  const secrets = [...new Set(Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value!))].sort((a, b) => b.length - a.length);
  // Cover serialized property names too; string leaves are handled before JSON escaping.
  const variants = [...new Set(secrets.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  const escaped = variants.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Preserve existing markers when display layers apply the same policy more than once.
  const out = escaped.length ? text.replace(new RegExp(escaped.join("|") + "|\\[redacted\\]", "g"), () => REDACTED) : text;
  return out.replace(/^([ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=)[^\r\n\u2028\u2029]*/gm,
    (line, prefix: string, name: string) => SECRET_NAME.test(name) ? prefix + REDACTED : line);
}

export function toolLogPreview(value: unknown, max = 500, space?: number): string {
  // Redact string leaves before JSON escaping so assignment lines and escaped secrets still match.
  const text = typeof value === "string" ? value
    : JSON.stringify(value, (_key, item) => typeof item === "string" ? redactPreview(item) : item, space) ?? "";
  // Always redact before clipping: a boundary must not expose the start of a secret.
  return redactPreview(text).slice(0, max);
}

function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactPreview(value)
    // Strip terminal control sequences, including OSC hyperlinks/title changes.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ").trim();
}

function clip(text: string, max = LIVE_LINE_LIMIT): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

export function liveViewEnabled(value?: string): boolean {
  return value?.trim().toLowerCase() !== "off";
}

export function formatToolUse(name: string, input: unknown): string {
  const args = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const mcp = /^mcp__([^]+?)__(.+)$/.exec(name);
  const tool = mcp ? mcp[2] : name;
  const key = tool.toLowerCase();
  // Message bodies, subjects, recipients etc. are deliberately never inspected.
  if ((key === "reply" || key === "voice_reply") && isAppReplyTool(name)) return "  ▸ reply → App";
  const aliases: Record<string, string> = {
    bash: "Bash", read: "Read", read_file: "Read", edit: "Edit", edit_file: "Edit",
    write: "Write", write_file: "Write", multiedit: "Edit",
  };
  const label = aliases[key] ?? (mcp ? `${tool} (${mcp[1]})` : name);
  let detail = "";
  if (key === "bash") detail = clean(args.description) || clean(args.command);
  if (["read", "read_file", "edit", "edit_file", "write", "write_file", "multiedit"].includes(key)) {
    detail = clean(args.file_path) || clean(args.path);
    if (!detail && Array.isArray(args.paths)) detail = args.paths.map(clean).filter(Boolean).join(", ");
    if (detail.length > 75 && !Array.isArray(args.paths)) detail = detail.split(/[\\/]/).pop() || detail;
  }
  return clip(`  ▸ ${clean(label) || "tool"}${detail ? `: ${detail}` : ""}`);
}

export interface HelperActivity {
  id: string;
  phase: "start" | "end";
  description: string;
  status?: string;
  /** the CLI's task type (local_bash, local_agent, …); absent for resident tasks */
  kind?: string;
  /** the tool_use that started it: a helper's usage carries it as helper_id */
  toolUseId?: string;
}

export function formatHelperActivity(event: HelperActivity): string {
  const description = clean(event.description) || tr("Background task");
  if (event.phase === "start") return clip(tr`  ▸ Helper started: ${description}`);
  // Leave space for the status even when the description is long.
  const status = /^(completed|failed|stopped|cancelled|killed|done|lost|exit -?\d{1,10}|exit unknown)$/.test(event.status ?? "")
    ? tr(event.status!) : tr("ended");
  const suffix = ` (${status})`;
  return clip(tr`  ◂ Helper returned: ${description}`, LIVE_LINE_LIMIT - suffix.length) + suffix;
}

export function formatHelperCount(count: number): string {
  return tr`  · ${Math.max(0, Math.floor(count))} helpers running`;
}

/** A line on Brain's terminal prompt that a terminal wrote, not a person: the
 * answer to a colour, cursor or device query (an SSH client attached with write
 * access answers the background-colour query, and readline keeps what follows
 * the escape). Sent with Enter it would reach the head as the person's words. */
export function isTerminalReply(raw: string): boolean {
  if (/[\x1b\x9b\x9d]/.test(raw)) return true;
  const line = raw.trim();
  return /^\]?\d{1,3};(?:rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}|rgba:[0-9a-f/]+)\\?$/i.test(line)
    || /^\[\??[\d;]+[cnR]$/.test(line);
}
