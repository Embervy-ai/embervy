/**
 * fresh-zone.ts — the last steps before a cut, with their tool calls and
 * results, for the bridge. The turns above it carry only what reached someone;
 * the fresh zone carries the work in hand, so a cut can fall mid-task and the
 * next session sees the last command and its result instead of having to
 * finish and write everything down before the cut. Terminal prose rides along;
 * only read/search results are routinely shortened, with a per-block safety cap.
 * System notices, inlet and body-state lines stay out. Thinking is not recorded
 * in the conversation log and cannot be carried. Off unless
 * BRAIN_BRIDGE_FRESH_CHARS is above zero.
 */
import { houseStamp, isCachePingRecord, isScheduledTurn, orderedRecords, roomUserSpeaker, toolOutreachDelivered, type SpeakerRules } from "./wake-bridge";
import { appReplySpeech } from "./app-channel";
import { FRESH_ZONE_INTRO, tr } from "./texts";

const CHANNEL_BODY = /<channel[^>]*>([\s\S]*?)<\/channel>/g;
// Read material can be fetched again by the next session, unlike the work performed.
const READ_TOOLS = /(?:Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch|ToolSearch)$|^mcp__.+__(?:read|find|recall|scan|search|list|wake|fetch|get|see)$/;

// The sense label in the house language, taken from the catalogue, so a translated label goes too.
const senseLabels = (): string[] => [...new Set(["SENSE", tr`SENSE · window: ${"0"}/${"0"} (${"0"}%${""})${""}`.split(" · ")[0].trim()])];

function withoutContext(text: string): string {
  const labels = senseLabels().map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(/<inlet\b[^>]*>[\s\S]*?(?:<\/inlet>|$)/g, "")
    .replace(new RegExp(`^(?:${labels}) · [^\\r\\n]*(?:\\r?\\n|$)`, "gm"), "").trim();
}

function blockClip(text: string, max: number): string {
  if (text.length <= max) return text;
  let keep = max;
  let notice = "";
  do {
    notice = `\n[… ${text.length - keep} ${tr("characters cut")}]`;
    if (keep + notice.length <= max) break;
    keep = Math.max(0, max - notice.length);
  } while (keep > 0);
  return (text.slice(0, keep) + notice).slice(0, max);
}

export interface FreshZoneOptions {
  /** Whole blocks are taken from the end until this many characters are reached. */
  maxChars: number;
  /** Read/search results are cut after this many characters, subject to the block cap. */
  resultChars?: number;
  /** Accepted for compatibility; arguments use only the one-third block cap. */
  argChars?: number;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max} ${tr("characters cut")}]`;

const clock = (ts: unknown): string => {
  if (typeof ts !== "string" || !Number.isFinite(Date.parse(ts))) return "";
  const match = / (\d{2}:\d{2})/.exec(houseStamp(new Date(ts)));
  return match ? ` · ${match[1]}` : "";
};

const contentText = (content: unknown): string =>
  typeof content === "string" ? content : content == null ? "" : JSON.stringify(content);

// A tool result can be a list of content blocks; images become one short line, never their base64.
function blockList(content: unknown): unknown[] | null {
  if (Array.isArray(content)) return content;
  if (typeof content !== "string" || !content.trimStart().startsWith("[")) return null;
  try { const parsed = JSON.parse(content); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

export function resultText(content: unknown): string {
  const blocks = blockList(content);
  if (!blocks || !blocks.every((b) => b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string")) return contentText(content);
  return blocks.map((b) => {
    const block = b as { type: string; text?: unknown };
    if (block.type === "text") return typeof block.text === "string" ? block.text : "";
    if (block.type === "image") return `[${tr("image")}]`;
    return JSON.stringify(block);
  }).filter((t) => t !== "").join("\n");
}

function argumentsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function argumentText(raw: unknown): string {
  const parsed = argumentsOf(raw);
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>).map(([key, value]) =>
      `${key}: ${withoutContext(typeof value === "string" ? value : JSON.stringify(value))}`).join("\n");
  }
  return contentText(raw);
}

/** The fresh zone and the time of the first record it carries; the turns above end there. */
export interface FreshCut { text: string; since?: string }

/** Renders the end of one conversation log; empty when there is nothing to carry. */
export function freshZone(log: string, rules: SpeakerRules, options: FreshZoneOptions): string {
  return freshZoneCut(log, rules, options).text;
}

export function freshZoneCut(log: string, rules: SpeakerRules, options: FreshZoneOptions): FreshCut {
  if (!(options.maxChars > 0)) return { text: "" };
  const resultChars = Math.max(0, options.resultChars ?? 6000);
  const blockChars = Math.floor(options.maxChars / 3);
  if (!blockChars) return { text: "" };
  const blocks: Array<{ text: string; record: number; ts?: string }> = [];
  const records = orderedRecords(log);
  const toolNames = new Map<string, string>();
  const outreachUpdates = new Map<string, string>();
  const replies = new Set<string>();
  // Receipts may arrive after the final assistant record; do not filter failed tool calls.
  for (const record of records) {
    if (record.role === "system" && typeof record.speech_update === "string" && typeof record.outreach_text === "string") {
      outreachUpdates.set(record.speech_update, record.outreach_text);
    }
  }
  records.forEach((record, index) => {
    if (record.intermediate || isCachePingRecord(record)) return;
    const at = { record: index, ts: typeof record.ts === "string" ? record.ts : undefined };
    const push = (header: string, body: string, readLimit?: number) => {
      const clean = withoutContext(body);
      if (!clean) return;
      const full = `${header}\n${clean}`;
      const shortened = readLimit === undefined ? full : `${header}\n${clip(clean, readLimit)}`;
      blocks.push({ ...at, text: shortened.length <= blockChars ? shortened : blockClip(full, blockChars) });
    };
    if (record.role === "user" && record.internal_input === true) return;
    if (record.role === "user" && !record.origin && typeof record.content === "string") {
      const content = withoutContext(record.content);
      if (!content || content.startsWith("[bridge ") || isScheduledTurn(content)
        || content.startsWith("[task] ") || rules.systemLine.test(content) || rules.scheduledLine.test(content)) return;
      const bodies = [...content.matchAll(CHANNEL_BODY)].map((m) => m[1].trim()).filter(Boolean);
      for (const body of bodies.length ? bodies : [content]) {
        push(`**${roomUserSpeaker(body, rules.userName)}**${clock(record.ts)}\n`, body);
      }
    } else if (record.role === "assistant") {
      const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      for (const call of calls) {
        const name = String(call?.function?.name ?? call?.name ?? "tool");
        const args = call?.function?.arguments ?? call?.arguments;
        if (typeof call?.id === "string") toolNames.set(call.id, name);
        const reply = appReplySpeech(name, argumentsOf(args)).trim();
        if (reply) replies.add(reply);
        push(`→ ${name}${clock(record.ts)}`, argumentText(args) || "(empty)");
      }
      if (record.via === "pipe" || !calls.length) {
        const raw = record.via === "pipe" ? record.pipe_final_text : record.content;
        const text = typeof raw === "string" ? raw.replace(/^\s*\[still\]\s*$/gm, "").trim() : "";
        const outreach = outreachUpdates.get(record.speech_id) ?? record.outreach_text;
        if (text && text !== "." && !replies.has(text)
          && !(record.via !== "pipe" && typeof outreach === "string" && outreach.trim() === text)) {
          push(`**${rules.workerName}** (terminal)${clock(record.ts)}\n`, text);
        }
        replies.clear();
      }
    } else if (record.role === "tool") {
      const text = withoutContext(resultText(record.content)) || "(empty)";
      const name = toolNames.get(record.tool_call_id) ?? String(record.name ?? "");
      const error = record.is_error || record.isError || !toolOutreachDelivered(record.content);
      push(`← ${error ? tr("error") : tr("result")}`, text, !error && READ_TOOLS.test(name) ? resultChars : undefined);
    }
  });
  let start = blocks.length, size = 0;
  while (start > 0) {
    size += blocks[start - 1].text.length + 2;
    if (size > options.maxChars && start < blocks.length) break;
    start -= 1;
  }
  // A record is carried whole, so the turns above never end in the middle of one.
  while (start > 0 && start < blocks.length && blocks[start - 1].record === blocks[start].record) start -= 1;
  const kept = blocks.slice(start);
  if (!kept.length) return { text: "" };
  const text = `${tr(FRESH_ZONE_INTRO)}\n\n${kept.map((b) => b.text).join("\n\n")}`;
  return kept[0].ts ? { text, since: kept[0].ts } : { text };
}
