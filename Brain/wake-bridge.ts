// Carries cut metadata and recent conversation into the next session.
// Loading clips whole turns to fit the model window while preserving the capsule when it fits.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ALIASES } from "./aliases";
import { appMcpServer, toolCallSpeech } from "./app-channel";

export function toolOutreachDelivered(result: unknown): boolean {
  const text = typeof result === "string" ? result : Array.isArray(result)
    ? result.map((block) => typeof block?.text === "string" ? block.text : "").join("\n")
    : JSON.stringify(result) ?? "";
  // A tool reports its own failure at the start of its result. Error words later in a
  // delivered text are content (a reply may quote an error message) and must not drop it.
  if (/"isError"\s*:\s*true/.test(text)) return false;
  return !/^\s*(?:error\b|failed\b|failure\b|NOT (?:delivered|sent)\b)/i.test(text);
}

export function isMailCall(call: any): boolean {
  const servers = ["app", appMcpServer(), appMcpServer().replace(/-/g, "_")];
  return ["email", ...servers.map((server) => `mcp__${server}__email`)].includes(call?.function?.name);
}

export function mailOutboxPath(env: Record<string, string | undefined> = process.env): string | null {
  const data = env.EMBERVY_APP_DATA_DIR
    || (env.EMBERVY_HOME ? join(env.EMBERVY_HOME, "Claude", "app", "data") : "")
    || (env.BRAIN_APP_INBOX_FILE ? dirname(env.BRAIN_APP_INBOX_FILE) : "");
  return data ? join(data, "email-outbox.jsonl") : null;
}

// Bridge and archive ask once per assistant turn; the outbox is read again only when it changed.
let outboxCache: { key: string; entries: any[] } | undefined;

function readOutbox(): any[] {
  try {
    const path = mailOutboxPath();
    if (!path) return [];
    const stat = statSync(path);
    const key = `${path}:${stat.mtimeMs}:${stat.size}`;
    if (outboxCache?.key !== key) {
      outboxCache = { key, entries: readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
    }
    return outboxCache.entries;
  } catch { return []; /* Without a readable receipt, a draft cannot become sent mail. */ }
}

export function mailSpeech(calls: unknown): string[] {
  const texts: string[] = [];
  const mails = (Array.isArray(calls) ? calls : []).filter((call) => isMailCall(call) && toolOutreachDelivered(call.mail_result));
  if (!mails.length) return texts;
  const outbox = readOutbox();
  const line = (value: unknown) => typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim() : "";
  for (const call of mails) {
    let args: any;
    try { args = JSON.parse(call.function.arguments); } catch { continue; }
    const result = typeof call.mail_result === "string" ? call.mail_result : JSON.stringify(call.mail_result) ?? "";
    const id = result.match(/\[Email outgoing\] id=([^\s"\\]+) status=/)?.[1];
    const sent = id ? outbox.findLast((entry) => entry.id === id) : undefined;
    if (sent && (sent.status === "sent" || sent.sent_at) && typeof sent.body === "string") {
      texts.push(`[Email outgoing]\nTo: ${line(sent.to)}\nSubject: ${line(sent.subject)}\n\n${sent.body.trim()}`);
    } else {
      texts.push(`[Mail draft to ${line(args.to)}: ${line(args.subject)}, not sent]`);
    }
  }
  return texts;
}

function withoutStoredMail(text: string, calls: unknown): string {
  for (const call of Array.isArray(calls) ? calls : []) {
    if (!isMailCall(call)) continue;
    try {
      const args = JSON.parse(call.function.arguments);
      const body = typeof args.body === "string" ? args.body.trim() : "";
      if (body) text = text.replace(`[Email outgoing]\nTo: ${args.to ?? ""}\nSubject: ${args.subject ?? ""}\n\n${body}`, "");
    } catch { /* Legacy text without attributable mail must not imply a send. */ }
  }
  return text.replace(/\[Email outgoing\][\s\S]*$/, "").trim();
}

export function outreachSpeech(record: { tool_calls?: unknown; mail_calls?: unknown; outreach_text?: unknown; gateway_text?: unknown }): string {
  const { texts, rooms, peers } = toolCallSpeech(record.tool_calls);
  // An explicit empty delivery list must not fall back to attempted tool calls.
  const outreach = typeof record.outreach_text === "string"
    ? withoutStoredMail(record.outreach_text, record.mail_calls ?? record.tool_calls)
    : [...texts, ...rooms, ...peers].filter(Boolean).join("\n\n").trim();
  const gateway = typeof record.gateway_text === "string" ? record.gateway_text.trim() : "";
  return [outreach, ...mailSpeech(record.mail_calls ?? record.tool_calls), gateway].filter((text) => text && ![".", "[still]", ...ALIASES.quietTags].includes(text)).join("\n\n");
}

// Delivery can finish after the next turn starts; receipts target an immutable record id.
export function resolveOutreachRecords(records: LogRecord[]): LogRecord[] {
  const updates = new Map<string, LogRecord>();
  const results = new Map<string, unknown>();
  for (const record of records) {
    if (record.role === "tool" && typeof record.tool_call_id === "string") results.set(record.tool_call_id, record.content);
    if (record.role !== "system" || typeof record.speech_update !== "string") continue;
    const update = updates.get(record.speech_update) ?? {};
    if (typeof record.outreach_text === "string") update.outreach_text = record.outreach_text;
    if (typeof record.gateway_text === "string") update.gateway_text = record.gateway_text;
    updates.set(record.speech_update, update);
  }
  let pipeSpeech: string[] = [];
  let pipeMails: any[] = [];
  return records.map((record) => {
    const update = record.speech_id ? updates.get(record.speech_id) : undefined;
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls.filter((call: any) =>
      !results.has(call.id) || toolOutreachDelivered(results.get(call.id))).map((call: any) =>
        isMailCall(call) && results.has(call.id) ? { ...call, mail_result: results.get(call.id) } : call) : undefined;
    const resolved = { ...record, ...(calls ? { tool_calls: calls } : {}), ...update };
    if (record.origin === "claude_pipe" && record.role === "assistant" && !record.intermediate) {
      const text = outreachSpeech({ ...resolved, mail_calls: [] });
      if (text) pipeSpeech.push(text);
      pipeMails.push(...(calls ?? []).filter(isMailCall));
    } else if (!record.origin && record.role === "assistant") {
      if (record.via === "pipe") {
        if (typeof resolved.outreach_text !== "string") resolved.outreach_text = pipeSpeech.join("\n\n");
        if (!Array.isArray(resolved.mail_calls)) resolved.mail_calls = pipeMails;
      }
      pipeSpeech = [];
      pipeMails = [];
    }
    return resolved;
  });
}

export type BridgeMode = "sessions" | "turns";

export type LogRecord = Record<string, any>;

export const CACHE_PING_ORIGIN = "cache_ping";
export function isCachePingRecord(record: LogRecord): boolean {
  return ALIASES.stored("origin", record?.origin) === CACHE_PING_ORIGIN;
}

// Notices logged at turn end must precede the answer, matching the model's input order.
/** The log up to the first record at or after `since`; what follows is carried by the fresh zone. */
export function logBefore(log: string, since: string): string {
  const limit = Date.parse(since);
  if (!Number.isFinite(limit)) return log;
  const kept: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (line) {
      try {
        const ts = (JSON.parse(line) as { ts?: unknown }).ts;
        if (typeof ts === "string" && Date.parse(ts) >= limit) break;
      } catch { /* a torn line stays where it is */ }
    }
    kept.push(raw);
  }
  return kept.join("\n");
}

export function orderedRecords(text: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
  const noticeAtMarker = new Map<number, number>();
  const moved = new Set<number>();
  const lastMarker = new Map<number, number>();
  records.forEach((record, index) => {
    if (record.role === "system" && record.self_turn_start && typeof record.turn === "number") lastMarker.set(record.turn, index);
    else if (record.role === "user" && record.self_turn && typeof record.turn === "number" && lastMarker.has(record.turn)) {
      noticeAtMarker.set(lastMarker.get(record.turn)!, index);
      moved.add(index);
      lastMarker.delete(record.turn);
    }
  });
  const out: LogRecord[] = [];
  records.forEach((record, index) => {
    const notice = noticeAtMarker.get(index);
    if (notice !== undefined) out.push(records[notice]);
    if (!moved.has(index) && (record.role !== "system" || record.speech_update)) out.push(record);
  });
  return out;
}

function toolUseBlocks(toolCalls: unknown): any[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call: any) => {
    let input: unknown = {};
    try { input = JSON.parse(call?.function?.arguments || "{}"); } catch { input = {}; }
    return { type: "tool_use", id: String(call?.id ?? ""), name: String(call?.function?.name ?? ""), input };
  });
}

const textBlock = (text: unknown): any[] => (typeof text === "string" && text.trim() ? [{ type: "text", text }] : []);

// Custom cleaners expect this transcript format, so every model's log is adapted to it.
export function adaptConversationLog(text: string): string {
  const out: string[] = [];
  for (const record of orderedRecords(text)) {
    const timestamp = typeof record.ts === "string" ? record.ts : "";
    const push = (type: "user" | "assistant", content: unknown) => out.push(JSON.stringify({ type, message: { role: type, content }, timestamp }));
    if (isCachePingRecord(record)) continue;
    if (record.role === "user") {
      const content = typeof record.content === "string" ? record.content : "";
      if (content.trim() && !content.startsWith("[bridge ")) push("user", content);
    } else if (record.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: String(record.tool_call_id ?? ""), content: record.content ?? "" }]);
    } else if (record.role === "assistant") {
      let blocks: any[];
      if (record.origin === "claude_pipe") blocks = record.intermediate ? textBlock(record.content) : [...textBlock(record.content), ...toolUseBlocks(record.tool_calls)];
      else if (record.via === "pipe") blocks = textBlock(record.pipe_final_text);
      else blocks = [...(record.content === "." ? [] : textBlock(record.content)), ...toolUseBlocks(record.tool_calls)];
      if (blocks.length) push("assistant", blocks);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

export interface SpeakerRules { userName: string; workerName: string; systemLine: RegExp; scheduledLine: RegExp }

const CHANNEL_BODY = /<channel[^>]*>([\s\S]*?)<\/channel>/g;

export function isScheduledTurn(prompt: string): boolean {
  return /<channel\b[^>]*\bkind="scheduled"[^>]*>/.test(prompt);
}

export function roomUserSpeaker(content: string, fallback: string): string {
  const text = content.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/)?.[1] ?? content;
  return text.trim().match(/^\[([^\]/\r\n]+)\/([^\]/\r\n]+)\]/)?.[2].trim() || fallback;
}

export type TurnLine = [speaker: string, text: string, ts?: string, display?: { day?: string; time: string }];

function usableTimestamp(ts: unknown): ts is string {
  return typeof ts === "string" && /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(ts) && Number.isFinite(Date.parse(ts));
}

export function nativeMessages(records: LogRecord[], rules: SpeakerRules): TurnLine[] {
  const out: TurnLine[] = [];
  const push = (speaker: string, text: string, ts: unknown) => out.push(usableTimestamp(ts) ? [speaker, text, ts] : [speaker, text]);
  let orphanSpeech: LogRecord[] = [];
  for (const record of resolveOutreachRecords(records)) {
    if (record.intermediate) continue;
    if (record.origin === "claude_pipe" && record.role === "assistant" && Array.isArray(record.tool_calls)) orphanSpeech.push(record);
    if (record.origin) continue;
    if (record.role === "user" && typeof record.content === "string") {
      const content = record.content.trim();
      if (!content || content.startsWith("[bridge ")) continue;
      if (isScheduledTurn(content)) continue;
      // An internal input (a start greeting, a finished background job, a reminder) is Brain speaking, never the person.
      const speaker = rules.scheduledLine.test(content) ? tr(SCHEDULED_SPEAKER) : record.internal_input === true || rules.systemLine.test(content) ? "System" : rules.userName;
      const bodies = [...content.matchAll(CHANNEL_BODY)].map((m) => m[1].trim()).filter(Boolean);
      for (const text of bodies.length ? bodies : [content]) push(speaker === rules.userName ? roomUserSpeaker(text, speaker) : speaker, text, record.ts);
    } else if (record.role === "assistant") {
      orphanSpeech = [];
      const text = outreachSpeech(record);
      if (text) push(rules.workerName, text, record.ts);
    }
  }
  for (const record of orphanSpeech) {
    const text = outreachSpeech(record);
    if (text) push(rules.workerName, text, record.ts);
  }
  return out;
}

export interface Life { id: string; path: string; startMs: number; mtimeMs: number }

const LIFE_FILE = /^conversation-(\d+)-([A-Za-z0-9]+)\.jsonl$/;

export function listLives(logDir: string, sinceMs = 0): Life[] {
  let files: string[] = [];
  try { files = readdirSync(logDir); } catch { return []; }
  const lives: Life[] = [];
  for (const file of files) {
    const match = LIFE_FILE.exec(file);
    if (!match) continue;
    const startMs = Number(match[1]);
    if (!Number.isFinite(startMs) || startMs < sinceMs) continue;
    let mtimeMs = 0;
    try { mtimeMs = statSync(join(logDir, file)).mtimeMs; } catch { continue; }
    lives.push({ id: `${match[1]}-${match[2]}`, path: join(logDir, file), startMs, mtimeMs });
  }
  return lives.sort((a, b) => b.startMs - a.startMs || b.mtimeMs - a.mtimeMs);
}

export interface JumpUnit {
  captured_at_ms: number;
  life_start_ms: number;
  session_id: string;
  sha256: string;
  sources: string[];
  text: string;
}

export interface BridgeManifest { sha256: string; session_id: string; written_at: string; empty: boolean }

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const jumpPath = (stateDir: string) => join(stateDir, "bridge-jump.json");
const manifestPath = (stateDir: string) => join(stateDir, "bridge-written.json");

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export const readManifest = (stateDir: string): BridgeManifest | null => readJson<BridgeManifest>(manifestPath(stateDir));
export const readJump = (stateDir: string): JumpUnit | null => readJson<JumpUnit>(jumpPath(stateDir));

const TURNS_HEADER = "# Wake Bridge — {0}\n# Continuous thread, verbatim, without reasoning/tool ballast.\n# Sources (old→new): {1}\n\n---\n";
const US_SECTION = "\n---\n\n# Us — last close moment (from {0}, because the ending session was all workshop)\n\n";

function bothLanguages(key: string, phrase: (text: string) => string): string {
  return [...new Set((["en", "de", "local"] as const).map((language) => escapeRegex(phrase(textForLanguage(language, key)))))].join("|");
}

export function extractJumpTurns(bridge: string): { text: string; sources: string[] } {
  let body = bridge;
  const marker = "## CAPSULE: TURNS";
  const at = body.indexOf(marker);
  if (at >= 0) body = body.slice(at + marker.length);
  const freshAt = body.indexOf(`\n${FRESH_ZONE_MARKER}\n`);
  if (freshAt >= 0) body = body.slice(0, freshAt);
  body = body.replace(/^\s*\[turns clipped — oldest dropped, capsule intact\]\s*/, "");
  const thread = bothLanguages(TURNS_HEADER, (text) => text.split("\n")[1].slice(2).split(",")[0]);
  const sourcesLine = bothLanguages(TURNS_HEADER, (text) => text.split("\n")[2].slice(2).split(": {1}")[0]);
  const us = bothLanguages(US_SECTION, (text) => text.split("# ")[1].split(" (")[0]);
  const sources = new RegExp(`^# (?:${sourcesLine}): (.*)$`, "m").exec(body)?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  body = body.replace(new RegExp(`^\\s*(?:# Wake Bridge — [^\\n]*\\n|# (?:${thread})[^\\n]*\\n|# (?:${sourcesLine})[^\\n]*\\n)+`), "");
  const usAt = body.search(new RegExp(`\\n---\\n\\n# (?:${us})`));
  if (usAt >= 0) body = body.slice(0, usAt);
  // The header's closing rule otherwise duplicates the first turn's own separator.
  return { text: body.trim().replace(/^---\n(?=---\n)/, ""), sources };
}

export function jumpContext(stateDir: string, since: number | null = null): { jump: JumpUnit | null; boundaryMs: number } {
  let jump = readJump(stateDir);
  if (jump && (!jump.text || (since !== null && jump.captured_at_ms < since))) jump = null;
  return { jump, boundaryMs: jump ? jump.life_start_ms : since ?? 0 };
}

// An imported or hand-written bridge counts as one session until newer sessions push it out.
export function captureJumpIfForeign(stateDir: string, raw: string, life: { sessionId: string; startMs: number; now: Date }): boolean {
  const own = readManifest(stateDir);
  const sha = sha256(raw);
  if (own && own.sha256 === sha) return false;
  const { text, sources } = extractJumpTurns(raw);
  if (!text) return false;
  const unit: JumpUnit = { captured_at_ms: life.now.getTime(), life_start_ms: life.startMs, session_id: life.sessionId, sha256: sha, sources, text };
  writePrivate(jumpPath(stateDir), JSON.stringify(unit));
  return true;
}

export interface TurnsUnit { label: string; kind: "life" | "jump"; jsonl?: string; text?: string; log?: string }

export interface TurnsResult {
  body: string;
  parts: Array<{ label: string; kind: string; text: string }>;
  used: string[];
  user_turns: number;
}

export interface TurnsOptions extends SpeakerRules {
  mode: BridgeMode;
  n: number;
  turns: number;
  minUserTurns: number;
}

export interface TurnsPasses {
  lines(lines: TurnLine[]): TurnLine[];
  text(text: string): string;
}

const NO_PASSES: TurnsPasses = { lines: (lines) => lines, text: (text) => text };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseRendered(text: string, speakers: string[]): TurnLine[] | null {
  const pattern = new RegExp(`(?:^|\\n)(?:## ([^\\n]+)\\n\\n)?---\\n\\n\\*\\*(${speakers.map(escapeRegex).join("|")})\\*\\*(?: · ([0-2]\\d:[0-5]\\d))?\\n\\n`, "g");
  const matches = [...text.matchAll(pattern)];
  const out: TurnLine[] = [];
  let day: string | undefined;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    day = match[1] ?? day;
    const content = text.slice(match.index! + match[0].length, matches[i + 1]?.index ?? text.length).trim();
    // An imported clock has no offset or authoritative log timestamp; preserve its display without inventing an instant.
    if (content) out.push(match[3] ? [match[2], content, undefined, { day, time: match[3] }] : [match[2], content]);
  }
  return out.length ? out : null;
}

export function renderLines(lines: TurnLine[], state: { day?: string } = {}): string {
  return lines.map(([speaker, text, ts, display]) => {
    if (usableTimestamp(ts)) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: brainTimezone(), weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(ts)).map((part) => [part.type, part.value]));
      display = {
        day: tr("{0}, {1} {2} {3}", tr(parts.weekday), parts.day, tr(parts.month), parts.year),
        time: `${parts.hour}:${parts.minute}`,
      };
    }
    const heading = display?.day && display.day !== state.day ? `## ${display.day}\n\n` : "";
    if (display?.day) state.day = display.day;
    return `${heading}---\n\n**${speaker}**${display ? ` · ${display.time}` : ""}\n\n${text}\n`;
  }).join("\n");
}

export function nativeTurns(units: TurnsUnit[], opts: TurnsOptions, passes: TurnsPasses = NO_PASSES): TurnsResult {
  const speakers = [...new Set([opts.userName, opts.workerName, "System", SCHEDULED_SPEAKER, tr(SCHEDULED_SPEAKER)])];
  const isUserTurn = ([speaker, text]: TurnLine) => speaker === opts.userName || (speaker !== opts.workerName && roomUserSpeaker(text, "") === speaker);
  const userCount = (lines: TurnLine[]) => lines.filter(isUserTurn).length;
  const linesOf = (unit: TurnsUnit): { lines: TurnLine[] | null; verbatim: string } => {
    if (unit.kind === "jump") {
      const text = (unit.text ?? "").trim();
      return { lines: parseRendered(text, speakers), verbatim: text };
    }
    return { lines: nativeMessages(orderedRecords(unit.log ?? ""), opts), verbatim: "" };
  };
  const collected: Array<{ label: string; kind: string; text: string; lines?: TurnLine[] }> = [];
  let taken = 0;
  if (opts.mode === "turns") {
    let need = opts.turns;
    for (const unit of units) {
      if (need <= 0) break;
      const { lines, verbatim } = linesOf(unit);
      if (!lines) {
        if (verbatim) { collected.push({ label: unit.label, kind: unit.kind, text: verbatim }); need -= verbatim.split(`**${opts.userName}**`).length - 1; }
        continue;
      }
      const userIdx = lines.map((line, i) => (isUserTurn(line) ? i : -1)).filter((i) => i >= 0);
      const slice = userIdx.length >= need ? lines.slice(userIdx[userIdx.length - need]) : lines;
      if (!slice.length) continue;
      need -= Math.min(need, userIdx.length);
      collected.push({ label: unit.label, kind: unit.kind, text: "", lines: passes.lines(slice) });
    }
    taken = opts.turns - Math.max(0, need);
  } else {
    let substantial = 0;
    for (const unit of units) {
      if (substantial >= opts.n || collected.length >= opts.n + 2) break;
      const { lines, verbatim } = linesOf(unit);
      if (!lines) {
        if (verbatim) { collected.push({ label: unit.label, kind: unit.kind, text: verbatim }); if (verbatim.split(`**${opts.userName}**`).length - 1 >= opts.minUserTurns) substantial += 1; }
        continue;
      }
      if (!lines.length) continue;
      collected.push({ label: unit.label, kind: unit.kind, text: "", lines: passes.lines(lines) });
      if (userCount(lines) >= opts.minUserTurns) substantial += 1;
    }
  }
  collected.reverse();
  const dayState: { day?: string } = {};
  for (const part of collected) {
    part.text = passes.text(part.lines ? renderLines(part.lines, dayState) : part.text);
    delete part.lines;
  }
  const used = collected.map((c) => c.label);
  const title = opts.mode === "turns" ? tr`last ${taken} turns from ${collected.length} cleaned session(s)` : tr`last ${collected.length} cleaned session(s)`;
  const body = collected.length
    ? tr(TURNS_HEADER, title, used.join(", ")) + collected.map((c) => c.text).join("\n")
    : "";
  return { body, parts: collected, used, user_turns: body.split(`**${opts.userName}**`).length - 1 };
}

export interface CleanedTurns {
  result: TurnsResult;
  cleaner: string;
  fallback: string | null;
  lint(kb: number): string;
  logFields: Record<string, unknown>;
}

export interface BridgeCleaning {
  clean(units: TurnsUnit[], cfg: WakeBridgeConfig, log: (event: Record<string, unknown>) => void): CleanedTurns;
}

export function nativeCleaning(units: TurnsUnit[], cfg: TurnsOptions): CleanedTurns {
  const result = nativeTurns(units, cfg);
  return {
    result, cleaner: "native", fallback: null,
    lint: (kb) => tr`${result.used.length} session(s), ${kb} KB, ${result.user_turns} ${cfg.userName} turns · ${tr("Cleaning: Brain")}`,
    logFields: { cleaner: "native", fallback: null },
  };
}

import { brainLanguage, brainLocale, textForLanguage, tr } from "./texts";
import { brainTimezone } from "./time-marks";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function houseStamp(date: Date, timeZone = brainTimezone()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false, timeZoneName: "shortOffset",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = tr(WEEKDAYS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)] ?? parts.weekday);
  const zone = timeZone === "Europe/Berlin" ? ({ "GMT+2": "CEST", "GMT+1": "CET" } as Record<string, string>)[parts.timeZoneName] ?? parts.timeZoneName : parts.timeZoneName;
  const day = brainLanguage() === "de" ? `${parts.day}.${parts.month}.${parts.year}` : `${parts.year}-${parts.month}-${parts.day}`;
  return `${weekday}, ${day} ${parts.hour === "24" ? "00" : parts.hour}:${parts.minute} ${zone}`;
}

export interface Capsule { lint: string; facts: string[]; arc: string; note: string; turns: string; fresh?: string }

export const FRESH_ZONE_MARKER = "## CAPSULE: FRESH ZONE";

export function renderCapsule(c: Capsule): string {
  return `# Wake Capsule\n\n## CAPSULE: LINT\n${c.lint}\n\n## ${tr("CAPSULE: FACTS")}\n${c.facts.join("\n")}\n\n## ${tr("CAPSULE: ARC")}\n${c.arc}\n\n## ${tr("CAPSULE: NOTE")}\n${c.note}\n\n## CAPSULE: TURNS\n${c.turns}\n${c.fresh ? `\n${FRESH_ZONE_MARKER}\n${c.fresh}\n` : ""}`;
}

export const SCHEDULED_SPEAKER = "System (scheduled)";

export const HOUSE_NOTE = "State at the cut. Only wake knows the night since then (daemon, dream, mood) — do it first.";
export const BRAIN_NOTE = "State at the cut. Only wake knows the night since then (daemon, dream, mood) — Brain puts it into your first turn as wake context; read it first.";

const REASONS: Record<string, string> = {
  SIGTERM: "SIGTERM (external cut: brain-cutoff.sh)",
  "context watchdog": "Context watchdog (cut threshold reached)",
  command: "/exit or /respawn",
  move: "/move (cut to another head)",
  exit: "Process exit (exit hook)",
  "birth-rebuild": "Rebuilt at startup — the previous session ended without a bridge (unclean exit)",
};

export interface FactsInput { sessionPrefix: string; workerName: string; mode: BridgeMode; n: number; turns: number; jump?: BridgeJump | null }

export interface BridgeJump {
  stayBeganMs(stateDir: string): number | null;
  cutReason(reason: string): string | null;
  sessionsScope(n: number): string;
  unitLabel(sources: string[]): string;
  livesFile(bridgeFile: string): string;
}

function importedLabel(sources: string[]): string {
  return sources.length ? tr`Imported bridge (${sources.join(", ")})` : tr("Imported bridge (source unspecified)");
}

export function numberLine(cfg: Pick<FactsInput, "sessionPrefix" | "workerName">, ending: number, archived: boolean, minTurns: number): string {
  const same = cfg.sessionPrefix === cfg.workerName;
  const me = (k: number) => (same ? `**${cfg.sessionPrefix} ${k}**` : `**${cfg.workerName}**, Session ${cfg.sessionPrefix}_${k}`);
  const name = (k: number) => (same ? `${cfg.sessionPrefix} ${k}` : `${cfg.sessionPrefix}_${k}`);
  return archived
    ? tr`- You are ${me(ending + 1)} (the ending session becomes ${name(ending)}).`
    : tr`- You are ${me(ending)} (the ending session has no archive of its own: fewer than ${minTurns} turns).`;
}

export function factsLines(cfg: FactsInput, cut: { now: Date; reason: string; model: string; sessionId: string; nextHead?: string }): string[] {
  const scope = cfg.mode === "turns"
    ? tr`the last ${cfg.turns} turns (BRAIN_BRIDGE_MODE=turns)`
    : cfg.jump ? cfg.jump.sessionsScope(cfg.n)
    : tr`${cfg.n} whole session(s), plus at most two short ones riding along (BRAIN_BRIDGE_MODE=sessions; an imported bridge counts as one)`;
  const reason = cfg.jump?.cutReason(cut.reason) ?? tr(REASONS[cut.reason] ?? cut.reason);
  return [
    tr`- ${cfg.sessionPrefix} number: see RAG /list.`,
    tr`- Cut: ${houseStamp(cut.now)} — reason: ${reason}`,
    tr`- Model at cut: ${cut.model}`,
    ...(cut.nextHead ? [tr`- Next head: ${cut.nextHead}`] : []),
    tr`- Bridge scope: ${scope}; capped to the head's window on loading (oldest turns dropped first)`,
    tr`- Substrate: Brain, session ${cut.sessionId}`,
  ];
}

// Bytes are never fewer than characters, so this byte cap is conservative relative to the character estimate.
export const BYTES_PER_TOKEN = 3.6;

export function bridgeCapBytes(cutTokens: number, share: number, maxBytes: number): number | null {
  const byCut = cutTokens > 0 && share > 0 ? Math.floor(cutTokens * share * BYTES_PER_TOKEN) : Infinity;
  const cap = Math.min(byCut, maxBytes > 0 ? maxBytes : Infinity);
  return Number.isFinite(cap) ? cap : null;
}

export const CLIP_NOTICE = "[turns clipped — oldest dropped, capsule intact]";

export type TurnSpeakers = readonly string[];

function turnBoundary(whole: string, speakers: TurnSpeakers, format: "bridge" | "speakers"): RegExp | null {
  return turnRule(whole, speakers, format)?.boundary ?? null;
}

// Known speakers prevent message formatting from being mistaken for turn boundaries.
function turnRule(whole: string, speakers: TurnSpeakers, format: "bridge" | "speakers"): { boundary: RegExp; leading: RegExp } | null {
  const known = speakers.filter((name) => name.trim()).map(escapeRegex).join("|");
  const clock = "(?: · [0-2]\\d:[0-5]\\d)?";
  if (known && new RegExp(`(?:^|\\n\\n|\\n---\\n)\\*\\*(?:${known})\\*\\*${clock}\\n\\n`).test(whole)) {
    return { boundary: new RegExp(`(?:\\n\\n|\\n---\\n)(?=\\*\\*(?:${known})\\*\\*${clock}\\n\\n)`), leading: new RegExp(`^(?:---\\n+)?(?=\\*\\*(?:${known})\\*\\*${clock}\\n\\n)`) };
  }
  if (format === "speakers") return { boundary: /\n\n(?=\*\*[^*\n]+\*\*(?: · [0-2]\d:[0-5]\d)?\n\n)/, leading: /^(?=\*\*[^*\n]+\*\*(?: · [0-2]\d:[0-5]\d)?\n\n)/ };
  if (/\n---\n\n\*\*[^*\n]+\*\*(?: · [0-2]\d:[0-5]\d)?\n\n/.test(whole)) return { boundary: /\n---\n\n(?=\*\*[^*\n]+\*\*(?: · [0-2]\d:[0-5]\d)?\n\n)/, leading: /^(?:---\n+)?(?=\*\*[^*\n]+\*\*(?: · [0-2]\d:[0-5]\d)?\n\n)/ };
  return /\n---\n/.test(whole) ? { boundary: /\n---\n\n*/, leading: /^(?!#)/ } : null;
}

function fromWholeTurn(tail: string, boundary: RegExp | null): string {
  const match = boundary?.exec(tail);
  return match ? tail.slice(match.index + match[0].length) : "";
}

export function aboutWords(words: number): number {
  if (words < 100) return words;
  const step = 10 ** (Math.floor(Math.log10(words)) - 1);
  return Math.round(words / step) * step;
}

export function longTurnPlaceholder(words: number): string {
  return tr`[very long message, about ${aboutWords(words).toLocaleString(brainLocale())} words, kept in full in the chronicle]`;
}

// A regex with overlapping newline quantifiers takes quadratic time on long newline runs.
export function layoutTailStart(rest: string): number {
  let j = rest.length;
  while (j > 0 && rest.charCodeAt(j - 1) === 10) j--;
  if (j >= 3 && rest.slice(j - 3, j) === "---") {
    let m = j - 3;
    while (m > 0 && rest.charCodeAt(m - 1) === 10) m--;
    if (m < j - 3) return m;
  }
  return j;
}

export function placeholderTurn(text: string): string {
  const head = /^\*\*[^*\n]+\*\*(?: · [0-2]\d:[0-5]\d)?[^\S\n]*\n\n/.exec(text)?.[0] ?? "";
  const rest = text.slice(head.length);
  const body = rest.slice(0, layoutTailStart(rest));
  const tail = rest.slice(body.length);
  return head + longTurnPlaceholder(body.split(/\s+/).filter(Boolean).length) + tail;
}

// A turn larger than the entire budget gets a placeholder rather than a partial quotation.
// Its full text stays in the archive.
function withPlaceholders(whole: string, space: number, rule: { boundary: RegExp; leading: RegExp } | null, size: (s: string) => number): string | null {
  if (!rule || space <= 0) return null;
  const spans: Array<{ at: number; start: number; end: number }> = [];
  const lead = rule.leading.exec(whole);
  let open: { at: number; start: number } | null = lead ? { at: 0, start: lead[0].length } : null;
  const all = new RegExp(rule.boundary.source, "g");
  for (let match = all.exec(whole); match; match = all.exec(whole)) {
    if (!match[0]) { all.lastIndex += 1; continue; }
    if (open && match.index > open.start) spans.push({ ...open, end: match.index });
    open = { at: match.index, start: match.index + match[0].length };
  }
  if (open && whole.length > open.start) spans.push({ ...open, end: whole.length });
  const kept: Array<{ separator: string; text: string }> = [];
  let used = 0;
  let placeholders = 0;
  for (let i = spans.length - 1; i >= 0; i--) {
    const separator = whole.slice(spans[i].at, spans[i].start);
    let text = whole.slice(spans[i].start, spans[i].end);
    let cost = size(separator) + size(text);
    if (used + cost > space) {
      if (cost <= space) break;
      text = placeholderTurn(text);
      cost = size(separator) + size(text);
      if (used + cost > space) break;
      placeholders += 1;
    }
    kept.unshift({ separator, text });
    used += cost;
  }
  return placeholders ? kept.map((turn, i) => (i ? turn.separator : "") + turn.text).join("") : null;
}

export function tailWholeTurns(text: string, maxCharacters: number, speakers: TurnSpeakers = []): string {
  if (text.length <= maxCharacters) return text;
  const rule = turnRule(text, speakers, "bridge");
  return withPlaceholders(text, maxCharacters, rule, (s) => s.length)
    ?? fromWholeTurn(text.slice(text.length - Math.max(0, maxCharacters)), rule?.boundary ?? null);
}

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

function tailBytes(text: string, budget: number): string {
  const all = utf8.encode(text);
  if (budget <= 0) return "";
  // Drop a multi-byte character cut at the front rather than keeping a replacement character.
  return new TextDecoder().decode(all.subarray(Math.max(0, all.length - budget))).replace(/^�+/, "");
}

function headBytes(text: string, budget: number): string {
  if (budget <= 0) return "";
  return new TextDecoder().decode(utf8.encode(text).subarray(0, budget)).replace(/�+$/, "");
}

export function clipBridge(text: string, maxBytes: number | null, speakers: TurnSpeakers = []): { text: string; clipped: boolean } {
  if (maxBytes === null || bytes(text) <= maxBytes) return { text, clipped: false };
  const marker = "## CAPSULE: TURNS";
  let idx = text.indexOf(marker);
  if (idx === -1) idx = 0;
  const capsule = text.slice(0, idx);
  const notice = `${marker}\n\n${CLIP_NOTICE}\n\n`;
  const budget = Math.max(0, maxBytes - bytes(capsule + notice));
  const turns = text.slice(idx);
  const rule = turnRule(turns, speakers, "bridge");
  const tail = withPlaceholders(turns, budget, rule, bytes) ?? fromWholeTurn(tailBytes(turns, budget), rule?.boundary ?? null);
  let out = capsule + notice + tail;
  // Even the capsule must be clipped if it cannot fit; a small model must not overflow.
  if (bytes(out) > maxBytes) out = headBytes(out, maxBytes);
  return { text: out, clipped: true };
}

export function clipSpeakerText(text: string, maxBytes: number | null, speakers: TurnSpeakers = []): { text: string; clipped: boolean } {
  if (maxBytes === null || bytes(text) <= maxBytes) return { text, clipped: false };
  const notice = "[turns clipped — oldest dropped]\n\n";
  const budget = maxBytes - bytes(notice);
  const rule = turnRule(text, speakers, "speakers");
  const tail = withPlaceholders(text, budget, rule, bytes) ?? fromWholeTurn(tailBytes(text, budget), rule?.boundary ?? null);
  let out = notice + tail;
  if (bytes(out) > maxBytes) out = headBytes(out, maxBytes);
  return { text: out, clipped: true };
}

export function fitBirthMaterial(bridge: string | null, soFar: string | null, cap: number | null, speakers: TurnSpeakers = []): { bridge: string | null; soFar: string | null; clipped: boolean } {
  if (cap === null) return { bridge, soFar, clipped: false };
  const own = soFar ? clipSpeakerText(soFar, cap, speakers) : null;
  let clipped = Boolean(own?.clipped);
  let fitted: string | null = bridge;
  if (bridge) {
    const turnsAt = bridge.indexOf("## CAPSULE: TURNS");
    const capsuleFloor = bytes(bridge.slice(0, Math.max(0, turnsAt))) + bytes(`## CAPSULE: TURNS\n\n${CLIP_NOTICE}\n\n`);
    const room = Math.max(turnsAt >= 0 ? capsuleFloor : 0, cap - (own ? bytes(own.text) : 0));
    const b = clipBridge(bridge, room, speakers);
    fitted = b.text;
    clipped = clipped || b.clipped;
  }
  return { bridge: fitted, soFar: own ? own.text : null, clipped };
}

export interface WakeBridgeConfig extends TurnsOptions {
  bridgeFile: string;
  stateDir: string;
  logDir: string;
  sessionPrefix: string;
  noBridgeMarker: string;
  cleaning?: BridgeCleaning | null;
  jump?: BridgeJump | null;
  /** Renders the fresh zone from the ending session's log; absent or empty means none.
   *  With `since`, the ending session's turns stop where the fresh zone begins. */
  freshZone?: ((log: string) => string | { text: string; since?: string }) | null;
}

export interface CutInfo {
  sessionId: string;
  ownLogFallback?: string;
  reason: string;
  model: string;
  nextHead?: string;
  now: Date;
  wakeByBrain: boolean;
  manifestSessionId?: string;
}

export interface WakeBuilt {
  sha256: string;
  capsule: Capsule;
  cleaner: string;
  fallback: string | null;
  manifestSessionId: string;
}

function lifeLabel(life: Life): string {
  const short = (ms: number) => houseStamp(new Date(ms)).replace(/^\S+, /, "").replace(/\.\d{4} /, ". ").replace(/ \S+$/, "");
  return tr`Brain session ${short(life.startMs)}–${short(life.mtimeMs)} (conversation-${life.id}.jsonl)`;
}

export function markOwnBridge(stateDir: string, text: string, sessionId: string, now: Date, empty = false): string {
  const sha = sha256(text);
  writePrivate(manifestPath(stateDir), JSON.stringify({ sha256: sha, session_id: sessionId, written_at: now.toISOString(), empty } satisfies BridgeManifest));
  return sha;
}

function writeBridgeFile(cfg: WakeBridgeConfig, text: string, sessionId: string, now: Date, empty: boolean): string {
  mkdirSync(dirname(cfg.bridgeFile), { recursive: true });
  const tmp = `${cfg.bridgeFile}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, cfg.bridgeFile);
  return markOwnBridge(cfg.stateDir, text, sessionId, now, empty);
}

// Bound disk reads when short sessions accumulate.
export const MAX_LIVES_READ = 50;

function candidateUnits(lives: Life[], cfg: WakeBridgeConfig, cut: CutInfo): TurnsUnit[] {
  const units: TurnsUnit[] = [];
  let real = 0;
  let userLines = 0;
  let satisfiedAt: number | null = null;
  for (const life of lives.slice(0, MAX_LIVES_READ)) {
    let log = "";
    if (life.path) { try { log = readFileSync(life.path, "utf8"); } catch { log = ""; } } else log = cut.ownLogFallback ?? "";
    const lines = nativeMessages(orderedRecords(log), cfg);
    units.push({ label: lifeLabel(life), kind: "life", log });
    if (cfg.mode === "sessions") {
      if (lines.length >= 2) real += 1;
      if (real >= cfg.n + 4) break;
    } else {
      userLines += lines.filter(([speaker]) => speaker === cfg.userName).length;
      if (satisfiedAt === null && userLines >= cfg.turns) satisfiedAt = units.length;
      if (satisfiedAt !== null && units.length > satisfiedAt) break;
    }
  }
  return units;
}

// Synchronous on purpose: it runs from the SIGTERM handler and the exit hook.
export function writeWakeBridgeSync(cfg: WakeBridgeConfig, cut: CutInfo, log: (event: Record<string, unknown>) => void = () => {}): WakeBuilt | "empty" | null {
  const manifestId = cut.manifestSessionId ?? cut.sessionId;
  if (cfg.noBridgeMarker && existsSync(cfg.noBridgeMarker)) {
    writeBridgeFile(cfg, "", manifestId, cut.now, true);
    try { unlinkSync(cfg.noBridgeMarker); } catch { /* gone */ }
    if (cfg.jump) { try { rmSync(cfg.jump.livesFile(cfg.bridgeFile), { force: true }); } catch { /* none */ } }
    log({ type: "bridge_empty_on_purpose", marker: cfg.noBridgeMarker });
    return "empty";
  }
  const { jump, boundaryMs } = jumpContext(cfg.stateDir, cfg.jump?.stayBeganMs(cfg.stateDir) ?? null);
  const lives = listLives(cfg.logDir, boundaryMs);
  if (!lives.some((life) => life.id === cut.sessionId) && cut.ownLogFallback) {
    lives.unshift({ id: cut.sessionId, path: "", startMs: Number(cut.sessionId.split("-")[0]) || cut.now.getTime(), mtimeMs: cut.now.getTime() });
  }
  const units = candidateUnits(lives, cfg, cut);
  if (jump) units.push({ label: cfg.jump ? cfg.jump.unitLabel(jump.sources) : importedLabel(jump.sources), kind: "jump", text: jump.text });

  // The fresh zone takes the end of the ending session, so the turns stop before it and nothing is carried twice.
  let fresh = "";
  const endingUnit = units.find((unit) => unit.kind === "life");
  if (cfg.freshZone && endingUnit?.log) {
    try {
      const out = cfg.freshZone(endingUnit.log);
      const cut = typeof out === "string" ? { text: out } : out;
      if (cut.text.trim()) {
        fresh = cut.text;
        if (cut.since) endingUnit.log = logBefore(endingUnit.log, cut.since);
      }
    } catch (error) { log({ type: "bridge_fresh_zone_failed", error: String(error) }); }
  }
  const cleaned = cfg.cleaning ? cfg.cleaning.clean(units, cfg, log) : nativeCleaning(units, cfg);
  const result = cleaned.result;
  // A short first session can fit wholly into the fresh zone; the fresh zone alone is still worth carrying.
  if (!result.body.trim() && !fresh.trim()) {
    log({ type: "bridge_nothing_to_carry", lives: lives.length, jump: Boolean(jump) });
    return null;
  }
  const kb = Math.floor(bytes(result.body) / 1024);
  const capsule: Capsule = {
    lint: cleaned.lint(kb),
    facts: factsLines(cfg, cut),
    arc: tr("(RAG not queried yet — the bridge is built before export)"),
    note: tr(cut.wakeByBrain ? BRAIN_NOTE : HOUSE_NOTE),
    turns: result.body,
  };
  if (fresh) capsule.fresh = fresh;
  const sha = writeBridgeFile(cfg, renderCapsule(capsule), manifestId, cut.now, false);
  if (cfg.jump) {
    const livesFile = cfg.jump.livesFile(cfg.bridgeFile);
    const lives = result.parts.filter((part) => part.kind === "life").map((part) => part.text).join("\n");
    try {
      if (lives.trim()) writePrivate(livesFile, lives.endsWith("\n") ? lives : `${lives}\n`);
      else rmSync(livesFile, { force: true });
    } catch { /* optional: the bridge file alone is enough */ }
  }
  log({ type: "bridge_written", ...(capsule.fresh ? { fresh_chars: capsule.fresh.length } : {}), mode: cfg.mode, sessions: result.used.length, lives: result.parts.filter((p) => p.kind === "life").length, jump: result.parts.some((p) => p.kind === "jump"), kb, user_turns: result.user_turns, ...cleaned.logFields });
  return { sha256: sha, capsule, cleaner: cleaned.cleaner, fallback: cleaned.fallback, manifestSessionId: manifestId };
}

// A delayed archive response must not overwrite a replacement bridge.
export function finishWakeBridge(cfg: WakeBridgeConfig, built: WakeBuilt, facts: { numberLine?: string; arc: string; now: Date }): boolean {
  let current = "";
  try { current = readFileSync(cfg.bridgeFile, "utf8"); } catch { return false; }
  if (sha256(current) !== built.sha256) return false;
  const capsuleFacts = [...built.capsule.facts];
  if (facts.numberLine) capsuleFacts[0] = facts.numberLine;
  const capsule = { ...built.capsule, facts: capsuleFacts, arc: facts.arc };
  built.sha256 = writeBridgeFile(cfg, renderCapsule(capsule), built.manifestSessionId, facts.now, false);
  built.capsule = capsule;
  return true;
}

// SIGKILL bypasses exit hooks, so recovery may need to rebuild from the log.
export function birthRebuildNeeded(cfg: Pick<WakeBridgeConfig, "bridgeFile" | "stateDir" | "logDir" | "jump">, ownSessionId: string): string | null {
  let raw: string | null = null;
  try { raw = readFileSync(cfg.bridgeFile, "utf8"); } catch { raw = null; }
  if (raw !== null && raw.trim()) return null;
  const previous = listLives(cfg.logDir, jumpContext(cfg.stateDir, cfg.jump?.stayBeganMs(cfg.stateDir) ?? null).boundaryMs).filter((life) => life.id !== ownSessionId);
  if (!previous.length) return null;
  const manifest = readManifest(cfg.stateDir);
  return manifest && manifest.session_id === previous[0].id ? null : previous[0].id;
}
