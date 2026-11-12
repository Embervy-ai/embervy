// Renders conversation transcripts as a readable terminal log.
// Transcripts retain conversation history that full-screen terminal scrollback cannot preserve.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { appToolNames } from "../../shared/scripts/legacy-names";

const MAX_ENTRIES = 5000;
const MAX_FILES = 4;
const MAX_BODY_CHARS = 12000;

const REPLY_TOOLS = new Set([...appToolNames("reply"), ...appToolNames("voice_reply")]);

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HEADER_USER = "\x1b[1;36m";
const HEADER_SELF = "\x1b[1;33m";

export type LogEntry = (
  | { kind: "line"; text: string }
  | { kind: "tool"; summary: string; body: string; error: boolean }
) & { key?: string };

export interface LogNames {
  self: string;
  user: string;
}

export interface LogLabels {
  appMessage: string;
  result: string;
  context: string;
  sessionBoundary: string;
  error: string;
  truncated: string;
  change: string;
  changeNumber: string;
  unchangedLine: string;
  unchangedLines: string;
  helper: string;
  background: string;
  finished: string;
  stopped: string;
  systemNote: string;
  bridge: string;
}

export const DEFAULT_LOG_LABELS: LogLabels = {
  appMessage: "⇢ App message",
  result: "Result",
  context: "Context",
  sessionBoundary: "Session boundary",
  error: "Error",
  truncated: "characters in total, truncated",
  change: "Change",
  changeNumber: "Change {n}",
  unchangedLine: "unchanged line",
  unchangedLines: "unchanged lines",
  helper: "Helper",
  background: "In the background",
  finished: "finished",
  stopped: "stopped",
  systemNote: "system note",
  bridge: "Bridge (context from the previous session)",
};

export interface LogOptions {
  names: LogNames;
  labels?: Partial<LogLabels>;
  timeZone?: string;
}

interface Ctx {
  names: LogNames;
  labels: LogLabels;
  time: (ts: string | undefined) => string;
}

function context(options: LogOptions): Ctx {
  const labels = { ...DEFAULT_LOG_LABELS, ...(options.labels ?? {}) };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(options.timeZone ? { timeZone: options.timeZone } : {}) });
  } catch {
    format = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return {
    names: options.names,
    labels,
    time: (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? "" : format.format(d);
    },
  };
}

function oneLine(s: string, max: number): string {
  // Cut before flattening: a huge text would make the pattern slow for nothing.
  const head = s.length > max * 4 ? s.slice(0, max * 4) : s;
  const flat = head.replace(/[ \t\r\f\v]*\n\s*/g, " ⏎ ").trim();
  return flat.length > max || head.length < s.length ? `${flat.slice(0, max)}…` : flat;
}

function capBody(s: string, ctx: Ctx): string {
  if (s.length <= MAX_BODY_CHARS) return s;
  const lastBreak = s.lastIndexOf("\n", MAX_BODY_CHARS);
  const end = lastBreak >= MAX_BODY_CHARS * 0.8 ? lastBreak : MAX_BODY_CHARS;
  // A single long line can still cross the limit inside an SGR sequence.
  let head = s.slice(0, end).replace(/\x1b(?:\[[0-9;]*)?$/, "");
  if (/\x1b\[[0-9;]*m/.test(head.slice(head.lastIndexOf("\n") + 1)) && !head.endsWith(RESET)) head += RESET;
  return `${head}\n… (${s.length} ${ctx.labels.truncated})`;
}

export function toolSummary(name: string, input: any, labels: LogLabels = DEFAULT_LOG_LABELS): string {
  if ((name === "Agent" || name === "Task") && input) {
    const what = typeof input.description === "string" ? input.description : "";
    const kind = typeof input.subagent_type === "string" && input.subagent_type ? ` (${input.subagent_type})` : "";
    return `▸ ${labels.helper}${kind}${what ? `: ${oneLine(what, 100)}` : ""}`;
  }
  if (name === "Bash" && input?.run_in_background === true) {
    const what = typeof input.description === "string" && input.description.trim() ? input.description : String(input.command ?? "");
    return `▸ ${labels.background}: ${oneLine(what, 100)}`;
  }
  const shortName = name.replace(/^mcp__/, "").replace(/__/g, " · ");
  let detail = "";
  for (const key of ["description", "command", "file_path", "path", "pattern", "query", "subject", "prompt", "title"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) { detail = input[key]; break; }
  }
  return `▸ ${shortName}${detail ? `: ${oneLine(detail, 100)}` : ""}`;
}

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIFF_MAX_CELLS = 250_000;

export function lineDiff(oldText: string, newText: string, labels: LogLabels = DEFAULT_LOG_LABELS, context = 2): string {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const am = a.slice(prefix, a.length - suffix);
  const bm = b.slice(prefix, b.length - suffix);
  type Op = { type: " " | "-" | "+"; text: string };
  const ops: Op[] = a.slice(0, prefix).map((text) => ({ type: " ", text }));
  const n = am.length, m = bm.length;
  // Empty sides need no LCS table, even for very large insertions or deletions;
  // above the cap the changed range is shown whole, old then new.
  if (n && m && n * m <= DIFF_MAX_CELLS) {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ type: " ", text: am[i]! }); i++; j++; }
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ type: "-", text: am[i++]! });
      else ops.push({ type: "+", text: bm[j++]! });
    }
    while (i < n) ops.push({ type: "-", text: am[i++]! });
    while (j < m) ops.push({ type: "+", text: bm[j++]! });
  } else {
    for (const text of am) ops.push({ type: "-", text });
    for (const text of bm) ops.push({ type: "+", text });
  }
  for (const text of a.slice(a.length - suffix)) ops.push({ type: " ", text });

  const radius = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 2;
  const keep = new Array<boolean>(ops.length).fill(false);
  let next = 0;
  ops.forEach((op, index) => {
    if (op.type === " ") return;
    const end = Math.min(ops.length - 1, index + radius);
    for (let k = Math.max(next, index - radius); k <= end; k++) keep[k] = true;
    next = end + 1;
  });
  const out: string[] = [];
  let skipped = 0;
  const flush = () => {
    if (!skipped) return;
    out.push(`${DIM}  ⋯ ${skipped} ${skipped === 1 ? labels.unchangedLine : labels.unchangedLines}${RESET}`);
    skipped = 0;
  };
  ops.forEach((op, index) => {
    if (!keep[index]) { skipped++; return; }
    flush();
    out.push(op.type === "-" ? `${RED}- ${op.text}${RESET}`
      : op.type === "+" ? `${GREEN}+ ${op.text}${RESET}` : `${DIM}  ${op.text}${RESET}`);
  });
  flush();
  return out.join("\n");
}

function isEditPair(value: any): value is { old_string: string; new_string: string } {
  return value != null && typeof value.old_string === "string" && typeof value.new_string === "string";
}

export function formatToolInput(input: any, labels: LogLabels = DEFAULT_LOG_LABELS): string {
  if (input == null) return "";
  if (typeof input !== "object" || Array.isArray(input)) return JSON.stringify(input, null, 2);
  const parts: string[] = [];
  const single = isEditPair(input);
  const multi = !single && Array.isArray(input.edits) && input.edits.length > 0 && input.edits.every(isEditPair);
  for (const [key, value] of Object.entries(input)) {
    if ((single && (key === "old_string" || key === "new_string")) || (multi && key === "edits")) continue;
    if (typeof value === "string") parts.push(value.includes("\n") || value.length > 80 ? `${key}:\n${value}` : `${key}: ${value}`);
    else parts.push(`${key}: ${JSON.stringify(value, null, 2)}`);
  }
  if (single) parts.push(`${labels.change}:`, lineDiff(input.old_string, input.new_string, labels));
  else if (multi) {
    input.edits.forEach((edit: { old_string: string; new_string: string }, index: number) => {
      parts.push(`${labels.changeNumber.replaceAll("{n}", String(index + 1))}:`);
      const { old_string, new_string, ...fields } = edit;
      const extra = formatToolInput(fields, labels);
      if (extra) parts.push(extra);
      parts.push(lineDiff(old_string, new_string, labels));
    });
  }
  return parts.join("\n");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => typeof c?.text === "string" ? c.text : JSON.stringify(c)).join("\n");
  return content == null ? "" : JSON.stringify(content, null, 2);
}

export function taskNotificationLine(summary: string, labels: LogLabels = DEFAULT_LOG_LABELS): string {
  const command = summary.match(/^Background command "(.+)" (completed|failed|was stopped|killed)(?: \(exit code (\d+)\))?/);
  if (command) {
    const [, what, state, code] = command;
    const failed = state !== "completed" || (code !== undefined && code !== "0");
    const outcome = failed ? `${labels.stopped}${code !== undefined ? ` (exit ${code})` : ""}` : labels.finished;
    return `· ${labels.background}, ${outcome}: ${oneLine(what!, 110)}`;
  }
  const agent = summary.match(/^(?:Background agent|Agent) "(.+)" (finished|completed|failed|was stopped)/);
  if (agent) {
    const [, what, state] = agent;
    return `· ${labels.helper}, ${state === "failed" || state === "was stopped" ? labels.stopped : labels.finished}: ${oneLine(what!, 110)}`;
  }
  return `· ${oneLine(summary, 120) || labels.systemNote}`;
}

function collapseNoise(text: string, ctx: Ctx): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("<task-notification>")) {
    const summary = trimmed.match(/<summary>([^<]*)<\/summary>/)?.[1] ?? "";
    return `${DIM}${taskNotificationLine(summary, ctx.labels)}${RESET}`;
  }
  if (trimmed.startsWith("<system-reminder>")) return `${DIM}· ${ctx.labels.systemNote} (${trimmed.length})${RESET}`;
  return null;
}

// Context shares the user turn but must not be attributed to the speaker.
const PREAMBLE_START = /^(SENSE ·|⏰ |<inlet>|\[wake context|## PINS|📌)/;

function unwrapChannel(text: string): { name: string | null; text: string } {
  const m = text.trim().match(/^<channel\b([^>]*)>\n?([\s\S]*?)\n?<\/channel>$/);
  if (!m) return { name: null, text };
  return { name: m[1]!.match(/user="([^"]+)"/)?.[1] ?? null, text: m[2]! };
}

// A forward scan avoids regex backtracking on many unclosed channel tags.
function channelBlocks(text: string): string[] & { outside: string } {
  const blocks: string[] = [];
  let outside = "";
  let at = 0;
  for (;;) {
    let open = text.indexOf("<channel", at);
    while (open >= 0 && /[\w-]/.test(text.charAt(open + 8))) open = text.indexOf("<channel", open + 8);
    if (open < 0) break;
    const tagEnd = text.indexOf(">", open);
    const close = tagEnd < 0 ? -1 : text.indexOf("</channel>", tagEnd);
    if (close < 0) break;
    outside += text.slice(at, open);
    blocks.push(text.slice(open, close + "</channel>".length));
    at = close + "</channel>".length;
  }
  outside += text.slice(at);
  return Object.assign(blocks, { outside });
}

export function splitUserText(text: string): { preamble: string | null; parts: Array<{ name: string | null; text: string }> } {
  const trimmed = text.trim();
  let preamble: string | null = null;
  let rest = trimmed;
  // Retrieved context can quote channel tags, so the real envelope must follow the inlet.
  const inletEnd = PREAMBLE_START.test(trimmed) ? trimmed.lastIndexOf("</inlet>") : -1;
  const searchFrom = inletEnd >= 0 ? inletEnd + "</inlet>".length : 0;
  const found = trimmed.slice(searchFrom).search(/(^|\n)<channel\b/);
  const channelAt = found < 0 ? -1 : searchFrom + found;
  if (channelAt > 0) {
    preamble = trimmed.slice(0, channelAt).trim() || null;
    rest = trimmed.slice(channelAt).trim();
  } else if (channelAt < 0 && inletEnd >= 0) {
    preamble = trimmed.slice(0, inletEnd + "</inlet>".length).trim();
    rest = trimmed.slice(inletEnd + "</inlet>".length).trim();
  }
  const blocks = channelBlocks(rest);
  const onlyChannels = blocks.length > 1 && blocks.outside.trim() === "";
  const parts = onlyChannels ? blocks.map((b) => unwrapChannel(b)) : [unwrapChannel(rest)];
  return { preamble, parts: parts.filter((p) => p.text.trim()) };
}

function preambleEntry(preamble: string, ctx: Ctx): LogEntry {
  const kinds: string[] = [];
  if (preamble.includes("[wake context")) kinds.push("Wake");
  if (/📌|## PINS/.test(preamble)) kinds.push("Pins");
  if (/(^|\n)SENSE ·/.test(preamble)) kinds.push("Sense");
  if (preamble.includes("⏰")) kinds.push("Clock");
  if (preamble.includes("<inlet>")) kinds.push("Inlet");
  const size = preamble.length >= 1000 ? `${(preamble.length / 1000).toFixed(1)}k` : String(preamble.length);
  return { kind: "tool", summary: `${DIM}▸ ${ctx.labels.context}${kinds.length ? `: ${kinds.join(" · ")}` : ""} (${size})${RESET}`, body: capBody(preamble, ctx), error: false };
}

class LogWriter {
  readonly out: LogEntry[] = [];
  private lastSpeaker: string | null = null;
  readonly openTools = new Map<string, LogEntry & { kind: "tool" }>();
  constructor(readonly ctx: Ctx) {}

  private row = "";
  private counts = { line: 0, tool: 0 };
  sourceRow(row: number, raw: string) {
    // A rewritten or partially written record cannot impersonate the old anchor.
    this.row = `${row}:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
    this.counts = { line: 0, tool: 0 };
  }
  push(entry: LogEntry) {
    // Context can arrive later without renumbering the prose in its source record.
    entry.key = `${this.row}:${entry.kind}:${this.counts[entry.kind]++}`;
    this.out.push(entry);
  }
  line(text: string) { this.push({ kind: "line", text }); }
  text(text: string) { for (const l of text.split("\n")) this.line(l); }
  speak(speaker: string, color: string, ts: string | undefined) {
    if (this.lastSpeaker === speaker) return;
    if (this.out.length) this.line("");
    const time = this.ctx.time(ts);
    this.line(`${color}── ${speaker}${time ? ` · ${time}` : ""} ──${RESET}`);
    this.lastSpeaker = speaker;
  }
  userText(content: string, ts: string | undefined, inlet = "") {
    const collapsed = collapseNoise(content, this.ctx);
    if (collapsed) { this.line(collapsed); return; }
    let { preamble, parts } = splitUserText(content);
    if (inlet && !preamble?.includes("<inlet>")) preamble = [preamble, inlet].filter(Boolean).join("\n\n");
    if (!parts.length) { if (preamble) this.push(preambleEntry(preamble, this.ctx)); return; }
    parts.forEach((part, index) => {
      this.speak(part.name ?? this.ctx.names.user, HEADER_USER, ts);
      if (index === 0 && preamble) this.push(preambleEntry(preamble, this.ctx));
      this.text(part.text);
    });
  }
  reply(text: string, ts: string | undefined) {
    this.speak(this.ctx.names.self, HEADER_SELF, ts);
    this.line(`${HEADER_SELF}${this.ctx.labels.appMessage}${RESET}`);
    this.text(text);
    this.line("");
  }
  tool(id: string | undefined, name: string, input: any, rawInput: string, ts: string | undefined) {
    this.speak(this.ctx.names.self, HEADER_SELF, ts);
    const entry: LogEntry & { kind: "tool" } = {
      kind: "tool",
      summary: toolSummary(name, input, this.ctx.labels),
      body: capBody(input != null ? formatToolInput(input, this.ctx.labels) : rawInput, this.ctx),
      error: false,
    };
    this.push(entry);
    if (id) this.openTools.set(id, entry);
  }
  result(id: string | undefined, text: string, isError: boolean) {
    const target = id ? this.openTools.get(id) : undefined;
    if (target) {
      target.body += `\n\n── ${this.ctx.labels.result} ──\n${capBody(text, this.ctx)}`;
      if (isError) { target.error = true; target.summary += "  ✗"; }
      this.openTools.delete(id!);
    } else if (isError) {
      this.line(`${DIM}✗ ${this.ctx.labels.error}: ${oneLine(text, 120)}${RESET}`);
    }
  }
}

export function renderClaudeSession(rawLines: string[], options: LogOptions): LogEntry[] {
  const w = new LogWriter(context(options));
  for (const [row, raw] of rawLines.entries()) {
    w.sourceRow(row, raw);
    let entry: any;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (entry?.isSidechain) continue;
    // The CLI stores mid-turn arrivals as queued commands rather than user records.
    const att = entry?.type === "attachment" ? entry.attachment : null;
    if (att?.type === "queued_command" && typeof att.prompt === "string" && att.prompt.trim()) {
      w.userText(att.prompt, entry.timestamp ?? att.timestamp);
      continue;
    }
    const msg = entry?.message;
    if (!msg) continue;
    // Meta user lines are written by the CLI itself (image notes and the like), never by the person.
    if (entry.type === "user" && entry.isMeta === true) continue;
    if (entry.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content.trim()) w.userText(content, entry.timestamp);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") w.result(block.tool_use_id ? String(block.tool_use_id) : undefined, toolResultText(block.content), block.is_error === true);
          else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) w.userText(block.text, entry.timestamp);
        }
      }
      continue;
    }
    if (entry.type !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        w.speak(w.ctx.names.self, HEADER_SELF, entry.timestamp);
        w.text(block.text);
      } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        w.speak(w.ctx.names.self, HEADER_SELF, entry.timestamp);
        for (const l of block.thinking.split("\n")) w.line(`${DIM}${l}${RESET}`);
      } else if (block?.type === "tool_use") {
        const name = String(block.name ?? "tool");
        const replyText = REPLY_TOOLS.has(name) ? block.input?.text : null;
        if (typeof replyText === "string" && replyText.trim()) w.reply(replyText, entry.timestamp);
        else w.tool(block.id ? String(block.id) : undefined, name, block.input, "", entry.timestamp);
      }
    }
  }
  return w.out;
}

function withoutSaid(content: string, said: string[]): string {
  let rest = content.trim();
  for (const piece of said) {
    const p = piece.trim();
    if (!p) continue;
    const at = rest.indexOf(p);
    if (at >= 0) rest = (rest.slice(0, at) + rest.slice(at + p.length)).trim();
  }
  return rest === "." ? "" : rest;
}

export function renderBrainConversation(rawLines: string[], options: LogOptions, inlets: Array<{ ts: number; block: string }> = []): LogEntry[] {
  const w = new LogWriter(context(options));
  let inletAt = 0;
  // The closing record repeats replies and intermediate prose already shown in this turn.
  let turnTexts: string[] = [];
  for (const [row, raw] of rawLines.entries()) {
    w.sourceRow(row, raw);
    if (!raw.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (entry.role === "user") turnTexts = [];
    if (entry.role === "user") {
      const blocks: string[] = [];
      const ts = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
      while (inletAt < inlets.length && inlets[inletAt]!.ts <= ts) blocks.push(inlets[inletAt++]!.block);
      const content = typeof entry.content === "string" ? entry.content : "";
      if (!content.trim()) continue;
      if (content.startsWith("[bridge")) {
        w.push({ kind: "tool", summary: `${DIM}▸ ${w.ctx.labels.bridge}${RESET}`, body: capBody(content, w.ctx), error: false });
        continue;
      }
      w.userText(content, entry.ts, blocks.join("\n\n"));
      continue;
    }
    if (entry.role === "assistant") {
      const content = typeof entry.content === "string" ? entry.content : "";
      const fresh = withoutSaid(content, turnTexts);
      if (fresh) {
        w.speak(w.ctx.names.self, HEADER_SELF, entry.ts);
        w.text(fresh);
        turnTexts.push(fresh);
      }
      for (const tc of Array.isArray(entry.tool_calls) ? entry.tool_calls : []) {
        const name = String(tc?.function?.name ?? "tool");
        const rawArgs = String(tc?.function?.arguments ?? "");
        let args: any = null;
        try { args = JSON.parse(rawArgs || "null"); } catch { /* shown as raw text */ }
        const replyText = REPLY_TOOLS.has(name) ? args?.text : null;
        if (typeof replyText === "string" && replyText.trim()) { w.reply(replyText, entry.ts); turnTexts.push(replyText); }
        else w.tool(tc?.id ? String(tc.id) : undefined, name, args, rawArgs, entry.ts);
      }
      continue;
    }
    if (entry.role === "tool") {
      const text = typeof entry.content === "string" ? entry.content : toolResultText(entry.content);
      w.result(entry.tool_call_id ? String(entry.tool_call_id) : undefined, text, /^\s*error\b/i.test(text));
    }
  }
  return w.out.slice(-MAX_ENTRIES);
}

// Content timestamps preserve session order when unrelated writes change file modification times.
const fileCache = new Map<string, { size: number; mtime: number; key: string; entries: LogEntry[]; lastTs: number }>();

function lastTimestamp(rawLines: string[]): number {
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const m = rawLines[i]!.match(/"(?:timestamp|ts)":"([^"]+)"/);
    const t = m ? Date.parse(m[1]!) : Number.NaN;
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function optionsKey(options: LogOptions): string {
  return JSON.stringify([options.names, options.labels ?? null, options.timeZone ?? null]);
}

function renderedFile(path: string, options: LogOptions, render: (lines: string[], options: LogOptions) => LogEntry[], dependencyKey = "") {
  const stat = statSync(path);
  const size = stat.size;
  // A replacement at the same path is a different source, not a reusable anchor.
  const source = createHash("sha256").update(JSON.stringify([path, stat.dev, stat.ino, stat.birthtimeMs])).digest("hex").slice(0, 24);
  const key = source + optionsKey(options) + dependencyKey;
  const cached = fileCache.get(path);
  if (cached && cached.size === size && cached.mtime === stat.mtimeMs && cached.key === key) return cached;
  const rawLines = readFileSync(path, "utf8").split("\n");
  const entries = render(rawLines, options).map((entry) => ({ ...entry, key: `${source}:${entry.key}` }));
  const record = { size, mtime: stat.mtimeMs, key, entries, lastTs: lastTimestamp(rawLines) };
  fileCache.delete(path);
  fileCache.set(path, record);
  while (fileCache.size > MAX_FILES * 4) {
    const oldest = fileCache.keys().next().value;
    if (oldest === undefined) break;
    fileCache.delete(oldest);
  }
  return record;
}

// Helper runs can contain a copied session as one message; including them would duplicate the conversation.
const oneShotCache = new Map<string, boolean>();
function isOneShotSession(file: string): boolean {
  const cached = oneShotCache.get(file);
  if (cached !== undefined) return cached;
  let head = "";
  try {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch { return true; }
  const oneShot = head.includes('"entrypoint":"sdk-cli"') || head.includes('"promptSource":"sdk"');
  // A new file may not yet contain the fields needed to classify it.
  if (head.length > 200) oneShotCache.set(file, oneShot);
  return oneShot;
}

function newestFiles(dir: string, match: (name: string) => boolean): string[] {
  return readdirSync(dir)
    .filter(match)
    .map((f) => join(dir, f))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
}

function joinSessions(rendered: Array<{ entries: LogEntry[]; lastTs: number }>, ctx: Ctx): LogEntry[] {
  const collected: LogEntry[] = [];
  for (const { entries } of rendered.sort((a, b) => b.lastTs - a.lastTs).slice(0, MAX_FILES)) {
    const source = entries[0]?.key?.split(":")[0];
    collected.unshift(...entries,
      { kind: "line", text: `${DIM}════ ${ctx.labels.sessionBoundary} ════${RESET}`, key: `${source}:boundary` },
      { kind: "line", text: "", key: `${source}:boundary-blank` });
    if (collected.length >= MAX_ENTRIES) break;
  }
  while (collected.length) {
    const last = collected[collected.length - 1]!;
    if (last.kind === "line" && (last.text === "" || last.text.includes(ctx.labels.sessionBoundary))) collected.pop();
    else break;
  }
  return collected.slice(-MAX_ENTRIES);
}

export function claudeLogEntries(projectDir: string, options: LogOptions): LogEntry[] {
  let candidates: string[] = [];
  try {
    for (const f of newestFiles(projectDir, (n) => n.endsWith(".jsonl")).slice(0, 40)) {
      if (!isOneShotSession(f)) candidates.push(f);
      if (candidates.length >= MAX_FILES * 2) break;
    }
  } catch { return []; }
  const rendered = candidates
    .map((f) => { try { return renderedFile(f, options, renderClaudeSession); } catch { return null; } })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.entries.length > 0);
  return joinSessions(rendered, context(options));
}

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const inletCache = new Map<string, { size: number; inlets: Array<{ ts: number; block: string }> }>();

function sessionInlets(path: string): Array<{ ts: number; block: string }> {
  let size: number;
  try { size = statSync(path).size; } catch { return []; }
  const cached = inletCache.get(path);
  if (cached && cached.size === size) return cached.inlets;
  const inlets = readSessionInlets(path);
  inletCache.set(path, { size, inlets });
  return inlets;
}

function readSessionInlets(path: string): Array<{ ts: number; block: string }> {
  let fd: number | undefined;
  try {
    if (statSync(path).size > MAX_SESSION_BYTES) return [];
    fd = openSync(path, "r");
    // A bounded read also limits files that grow after the size check.
    const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_SESSION_BYTES) return [];
    const inlets: Array<{ ts: number; block: string }> = [];
    for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event?.type !== "inlet_injected") continue;
      const ts = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
      if (Number.isFinite(ts) && typeof event.block === "string" && event.block.startsWith("<inlet>")) {
        inlets.push({ ts, block: event.block.slice(0, 4000) });
      }
    }
    return inlets.sort((a, b) => a.ts - b.ts);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function brainLogEntries(logsDir: string, options: LogOptions): LogEntry[] {
  let files: string[];
  try { files = newestFiles(logsDir, (n) => n.startsWith("conversation-") && n.endsWith(".jsonl")).slice(0, MAX_FILES); }
  catch { return []; }
  const rendered = files
    .map((f) => {
      try {
        const inlets = sessionInlets(join(logsDir, basename(f).replace(/^conversation-/, "session-")));
        return renderedFile(f, options, (lines, opts) => renderBrainConversation(lines, opts, inlets), JSON.stringify(inlets));
      } catch { return null; }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.entries.length > 0);
  return joinSessions(rendered, context(options));
}

export function logHistoryPage(entries: LogEntry[], before: string | undefined, after: string | undefined, requestedSize = 200) {
  entries = entries.slice(-MAX_ENTRIES);
  const pageSize = Math.min(Math.max(Math.trunc(requestedSize) || 200, 1), 200);
  const end = before === undefined ? entries.length : entries.findIndex((entry) => entry.key === before);
  const afterIndex = after === undefined ? -1 : entries.findIndex((entry) => entry.key === after);
  const metadata = { nextOffset: null, limit: 200, totalCap: MAX_ENTRIES };
  if (end < 0 || (after !== undefined && (afterIndex < 0 || afterIndex >= end))) {
    return { ...metadata, lines: [] as LogEntry[], anchor_lost: true, nextBefore: null, nextAfter: null };
  }
  const start = after === undefined ? Math.max(end - pageSize, 0) : afterIndex + 1;
  const stop = after === undefined ? end : Math.min(start + pageSize, end);
  return { ...metadata, lines: entries.slice(start, stop), anchor_lost: false,
    nextBefore: after === undefined && start > 0 ? entries[start]!.key : null,
    nextAfter: after !== undefined && stop < end ? entries[stop - 1]!.key : null };
}

// Claude Code derives project directory names from the working directory path.
export function claudeProjectDir(home: string, env: Record<string, string | undefined>): string {
  if (env.CLAUDE_PROJECT_DIR?.trim()) return env.CLAUDE_PROJECT_DIR.trim();
  const base = env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME || "/root", ".claude");
  return join(base, "projects", home.replace(/\//g, "-"));
}
