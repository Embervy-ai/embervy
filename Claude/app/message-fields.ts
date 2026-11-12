// Validates untrusted message fields before storage and rendering.
import { defuseChannelTags as contextChannelTags } from "../../shared/scripts/context-text";
// The page inserts these fields into HTML attributes.

import { MEMORY_IMAGE_PATH, MEMORY_VIDEO_PATH } from "../../shared/scripts/legacy-names";

export const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

const MEDIA_PREFIXES = ["/api/images", MEMORY_IMAGE_PATH, MEMORY_VIDEO_PATH];
export const MEDIA_PATH_RE = new RegExp(`^(?:${MEDIA_PREFIXES.map((p) => p.replace(/[/-]/g, "\\$&")).join("|")})/[A-Za-z0-9._-]+$`);

const PLAIN_URL_RE = /^[^\s"'<>\\`]+$/;

export function isSafeMessageId(id: unknown): boolean {
  if (typeof id === "number") return Number.isFinite(id) && MESSAGE_ID_RE.test(String(id));
  return typeof id === "string" && MESSAGE_ID_RE.test(id);
}

export function isSafeMediaUrl(url: unknown): boolean {
  if (typeof url !== "string" || !PLAIN_URL_RE.test(url)) return false;
  if (MEDIA_PATH_RE.test(url)) return url.split("/").every((part) => part !== "." && part !== "..");
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const absent = (v: unknown) => v === undefined || v === null || v === "";

export function brokenBroadcastField(msg: unknown): string | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return "the message must be a JSON object";
  const m = msg as Record<string, unknown>;
  if (!absent(m.id) && !isSafeMessageId(m.id)) return "id: letters, digits and . _ : - only, at most 64";
  for (const field of ["image_url", "audio_url", "file_url"]) {
    if (!absent(m[field]) && !isSafeMediaUrl(m[field])) {
      return `${field}: an /api/images/, ${MEMORY_IMAGE_PATH}/ or ${MEMORY_VIDEO_PATH}/ path, or an https address`;
    }
  }
  const quoted = m.reply_to as Record<string, unknown> | undefined;
  if (quoted && typeof quoted === "object" && !absent(quoted.id) && !isSafeMessageId(quoted.id)) {
    return "reply_to.id: letters, digits and . _ : - only, at most 64";
  }
  return null;
}

export function cleanReplyTo(raw: unknown): { id: string; snippet: string; role: "assistant" | "user" | "email" } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (!r.snippet) return undefined;
  const id = isSafeMessageId(r.id) ? String(r.id) : "";
  return { id, snippet: String(r.snippet).slice(0, 160), role: r.role === "assistant" ? "assistant" : r.role === "email" ? "email" : "user" };
}

// The app stores what a message answers; the agent sees it as one line above the text.
export function replyQuoteLine(raw: unknown, user: string): string {
  const quote = cleanReplyTo(raw);
  const snippet = quote?.snippet.replace(/\s+/g, " ").trim();
  if (!quote || !snippet) return "";
  if (quote.role === "assistant") return `↪ Replying to your message: "${snippet}"`;
  if (quote.role === "email") return `↪ Replying to an email: "${snippet}"`;
  return `↪ Replying to a message from ${user}: "${snippet}"`;
}

export function appReplyId(raw: unknown): string | undefined {
  return isSafeMessageId(raw) && !/^(room|peer)-/.test(String(raw)) ? String(raw) : undefined;
}

export function replyQuoteFromId(raw: unknown, inbox: readonly any[], outbox: readonly any[]): ReturnType<typeof cleanReplyTo> {
  const id = appReplyId(raw);
  if (!id) return undefined;
  for (const [entries, role] of [[inbox, "user"], [outbox, "assistant"]] as const) {
    const entry = entries.find((m) => m && String(m.id) === id && m.source !== "room" && m.source !== "peer" && m.source !== "scheduled" && m.type !== "reaction");
    if (entry && typeof entry.text === "string") {
      return cleanReplyTo({ id, snippet: entry.text.replace(/[\r\n]+/g, " "), role: role === "user" && entry.source === "email" ? "email" : role });
    }
  }
  return undefined;
}

export function defuseSenderLines(text: string): string {
  return text.replace(/\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g, "\n").replace(/\n([^\S\n]*)\[/g, "\n$1［");
}

export function safeChannelMeta(meta: Record<string, unknown>): Record<string, string> {
  const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return Object.fromEntries(Object.entries(meta).map(([key, value]) => [key,
    String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[&<>"']/g, ch => escapes[ch]),
  ]));
}

// Channel tags could let untrusted mail close its envelope and impersonate the sender.
export function defuseChannelTags(text: string): string {
  return contextChannelTags(text);
}
