// Runs a persistent CLI subprocess and routes its streamed events to individual turns.
// Keeping the subprocess alive preserves its prompt cache.

import { brainLocale, tr } from "./texts";
import { APPROVAL_HOOK_MATCHER, approvalHookCommand, type ApprovalHookOptions } from "./approval-hook";
import { brainTimezone } from "./time-marks";
import { claudeAuthExpired, ClaudeAuthExpiredError, isClaudeAuthText, type ClaudeAuthProfile } from "./claude-auth";
import { notesCliEnvironment } from "./notes";
import { spawn, type Subprocess } from "bun";
import { redactPreview, toolLogPreview, type HelperActivity } from "./live-view";
import { LiveTurnTokens, type LiveTokensSnapshot } from "./live-tokens";
import { appReplySpeech, appReplyToolNames, peerSpeechLine, roomSpeechLine } from "./app-channel";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { ToolRecordPolicy, createCanonicalPipeForwarder, pipeEventToCanonicalEvents, type CanonicalPipeEvent, type CanonicalPipeRecord } from "./pipe-canonical";
import { createSecureTempMarkdown, type SecureTempMarkdown } from "./secure-temp";

const toolNameById = new Map<string, string>();
function toolInputPreview(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const pick = input.command ?? input.file_path ?? input.path ?? input.query ?? input.pattern ?? input.url ?? input.prompt ?? input.text ?? input.description;
  if (typeof pick !== "string" || !pick.trim()) return "";
  const one = redactPreview(pick).replace(/\s+/g, " ").trim();
  return `  ${one.length > 70 ? one.slice(0, 69) + "…" : one}`;
}
function pipeClock(): string {
  return new Date().toLocaleTimeString(brainLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: brainTimezone() });
}

// Unexpected death needs canonical startup context on restart, not a conversation projection.
export function isUnexpectedPipeDeathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.startsWith("ClaudePipe: turn timeout after") || message.startsWith("ClaudePipe: stdout EOF before result event");
}

export interface PipeOptions {
  authProfile?: ClaudeAuthProfile;
  model: string;
  systemPrompt: string;
  systemPromptMode?: "append" | "replace";
  settingsPath: string;
  settingSources: string;
  cwd: string;
  binary?: string;
  birthEnv?: Record<string, string | undefined>;
  mcpConfig?: string | string[];
  disableTools?: boolean;
  // Output filtering cannot undo tool side effects, so blocked tools must not be offered.
  disallowedTools?: string[];
  maxOutputTokens?: number;
  // Other pipe-backed heads can opt out without changing their request loop.
  maxToolHops?: number;
  env?: Record<string, string>;
  // Empty credentials are not unset; simultaneous API-key and OAuth credentials cause HTTP 401.
  unsetEnv?: string[];
  permissionPrompts?: "none" | "host";
  permissionPromptTool?: string;
  approvalHook?: ApprovalHookOptions;
  effort?: string | null;
  toolRecords?: ToolRecordPolicy;
  logEvent?: (e: any) => void;
  onSelfTurn?: (event: SelfTurnEvent) => void;
  onUsage?: (sample: PipeUsageSample) => void;
  onLiveTokens?: (snapshot: LiveTokensSnapshot) => void;
  onToolUse?: (tool: { id?: string; name: string; input: unknown }) => void;
  onHelperActivity?: (event: HelperActivity) => void;
  onCanonicalEvent?: (evt: CanonicalPipeRecord) => void;
  onTuiStep?: (s: {
    kind: "app-in" | "app-out" | "term-in" | "term-out" | "tool" | "meta" | "error";
    title: string;
    body?: string;
    collapsed?: boolean;
  }) => void;
}

const DEFAULT_PIPE_IDLE_TIMEOUT_MS = 600_000;
// Bound control waits so an unresponsive CLI permits fallback.
const CONTROL_TIMEOUT_MS = 10_000;

export interface ControlResult {
  ok: boolean;
  response?: any;
  error?: string;
}

export interface AppliedSettings {
  ok: boolean;
  model?: string | null;
  effort?: string | null;
  error?: string;
}
// Outlast the CLI's own tool waits so it can finish the wait and report its result first.
const DEFAULT_PIPE_TOOL_WAIT_TIMEOUT_MS = 1_900_000;

function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Tool calls can silence the CLI while approval is pending, so allow the card's full lifetime.
export function pipeReadTimeoutMs(outstandingToolCalls: number, env: Record<string, string | undefined> = process.env): number {
  const idle = positiveMs(env.BRAIN_CLAUDE_PIPE_TURN_TIMEOUT_MS, DEFAULT_PIPE_IDLE_TIMEOUT_MS);
  if (outstandingToolCalls <= 0) return idle;
  return Math.max(idle, positiveMs(env.BRAIN_CLAUDE_PIPE_TOOL_TIMEOUT_MS, DEFAULT_PIPE_TOOL_WAIT_TIMEOUT_MS));
}

export function claudePipeToolIsolationArgs(disableTools: boolean): string[] {
  return disableTools ? ["--tools", "", "--strict-mcp-config"] : [];
}

export function forwardCanonicalPipeEvent(
  event: any,
  onCanonicalEvent?: (evt: CanonicalPipeEvent) => void,
): void {
  if (!onCanonicalEvent) return;
  for (const canonical of pipeEventToCanonicalEvents(event)) onCanonicalEvent(canonical);
}

export interface HopUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  total_input: number;
}

export type UsageSource = "turn" | "cache_ping" | "helper" | "internal";
export interface UsageTokens { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null }
export interface PipeUsageSample extends UsageTokens {
  message_id: string; model: string; source: UsageSource; helper_id?: string;
  ts: string; partial?: boolean; reason?: string; reported_result_usage?: UsageTokens; reported_total_tokens?: number;
}
export const UNKNOWN_MODEL = "unknown";
export const usageNumber = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
/** max keeps a late or duplicate older mirror from rolling back a delta. */
export function mergeMessageUsage(target: Record<string, any>, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    const n = usageNumber(usage[field]);
    if (n !== null) target[field] = Math.max(target[field] ?? 0, n);
    else if (usage[field] !== undefined && target[field] === undefined) target[field] = null;
  }
}
export function anthropicUsage(u: any): UsageTokens {
  if (!u || typeof u !== "object") return { input: null, output: null, cache_read: null, cache_write: null };
  return { input: usageNumber(u.input_tokens), output: usageNumber(u.output_tokens),
    cache_read: u.cache_read_input_tokens === undefined ? 0 : usageNumber(u.cache_read_input_tokens),
    cache_write: u.cache_creation_input_tokens === undefined ? 0 : usageNumber(u.cache_creation_input_tokens) };
}

// Aggregate result usage cannot be added to per-message counts or attributed to individual models.
export class PipeUsageLedger {
  private pending = new Map<string, { sample: PipeUsageSample; raw: any; streaming: boolean; complete: boolean; classicFinal: boolean; sawStream: boolean; classicUsage: boolean }>();
  private streams = new Map<string, string>();
  private replayStreams = new Set<string>();
  private seen = new Set<string>();
  private results = new Set<string>();
  private mainObserved = false;
  private observedHelpers = new Set<string>();
  private gaps = 0;
  private missingIds = new Set<string>();
  private helpers = new Set<string>();
  private helperObserved = new Set<string>();
  constructor(private emit: (sample: PipeUsageSample) => void) {}
  private send(sample: PipeUsageSample): void { try { this.emit(sample); } catch { /* accounting cannot break a turn */ } }
  private key(scope: string, id: string): string { return JSON.stringify([scope, id]); }
  private ready(entry: { raw: any; complete: boolean; classicFinal: boolean }): boolean {
    return entry.complete && (entry.classicFinal || ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].every((f) => usageNumber(entry.raw?.[f]) !== null));
  }
  private flush(scope: string, partial = false): void {
    const entry = this.pending.get(scope);
    if (!entry) return;
    this.pending.delete(scope);
    this.seen.add(this.key(scope, entry.sample.message_id));
    const tokens = anthropicUsage(entry.raw);
    // Missing stream cache fields remain unknown unless a classic usage mirror supplies their semantics.
    if (entry.sawStream && !entry.classicUsage) {
      tokens.cache_read = usageNumber(entry.raw?.cache_read_input_tokens);
      tokens.cache_write = usageNumber(entry.raw?.cache_creation_input_tokens);
    }
    this.send({ ...entry.sample, ...tokens,
      ...(partial || (entry.streaming && !entry.complete) ? { partial: true } : {}),
      ...(!entry.raw ? { reason: "message_usage_not_reported" } : {}) });
  }
  private take(scope: string, id: unknown, model: unknown, usage: any, source: UsageSource, streaming?: boolean): void {
    if (scope === "main") this.mainObserved = true;
    else { this.helpers.add(scope); this.helperObserved.add(scope); this.observedHelpers.add(scope); }
    if (typeof id !== "string" || !id) {
      if (!this.missingIds.has(scope)) {
        this.missingIds.add(scope);
        this.send({ ...anthropicUsage(null), message_id: `missing-id:${++this.gaps}`, model: UNKNOWN_MODEL, source,
          ...(scope !== "main" ? { helper_id: scope } : {}), ts: new Date().toISOString(), reason: "message_id_not_reported" });
      }
      return;
    }
    if (this.seen.has(this.key(scope, id))) return;
    if (this.pending.get(scope)?.sample.message_id !== id) this.flush(scope);
    let entry = this.pending.get(scope);
    if (!entry) {
      entry = { sample: { ...anthropicUsage(null), message_id: id, model: UNKNOWN_MODEL, source,
        ...(scope !== "main" ? { helper_id: scope } : {}), ts: new Date().toISOString() }, raw: null, streaming: false, complete: false, classicFinal: false, sawStream: false, classicUsage: false };
      this.pending.set(scope, entry);
    }
    if (typeof model === "string" && model.trim()) entry.sample.model = model;
    if (streaming !== undefined) entry.streaming = streaming;
    if (streaming) entry.sawStream = true;
    if (usage && typeof usage === "object") {
      entry.raw ??= {};
      mergeMessageUsage(entry.raw, usage);
      entry.sample.ts = new Date().toISOString();
    }
  }
  observe(evt: any, source: UsageSource = "turn"): void {
    const scope = typeof evt.parent_tool_use_id === "string" && evt.parent_tool_use_id ? evt.parent_tool_use_id : "main";
    if (scope !== "main") source = "helper";
    if (evt.type === "assistant") {
      const msg = evt.message;
      if (!msg) return;
      this.take(scope, msg.id, msg.model, msg.usage, source);
      const entry = this.pending.get(scope);
      if (entry && entry.sample.message_id === msg.id) {
        if (msg.usage && typeof msg.usage === "object") entry.classicUsage = true;
        if (typeof msg.stop_reason === "string" && msg.stop_reason) { entry.complete = true; entry.classicFinal = true; }
        if (this.ready(entry) && !entry.streaming) this.flush(scope);
      }
      if (scope === "main" && Array.isArray(msg.content)) for (const block of msg.content) {
        if (["Agent", "Task"].includes(block?.name) && typeof block.id === "string") this.helpers.add(block.id);
      }
    } else if (evt.type === "stream_event") {
      const se = evt.event;
      if (se?.type === "message_start") {
        if (typeof se.message?.id === "string" && this.seen.has(this.key(scope, se.message.id))) { this.replayStreams.add(scope); return; }
        this.replayStreams.delete(scope);
        if (typeof se.message?.id === "string") this.streams.set(scope, se.message.id);
        this.take(scope, se.message?.id, se.message?.model, se.message?.usage, source, true);
      } else if (se?.type === "message_delta") {
        if (!this.replayStreams.has(scope)) this.take(scope, this.streams.get(scope), undefined, se.usage, source);
      } else if (se?.type === "message_stop") {
        if (this.replayStreams.delete(scope)) return;
        const entry = this.pending.get(scope);
        if (entry && entry.sample.message_id === this.streams.get(scope)) {
          entry.streaming = false; entry.complete = true;
          // A later classic mirror may supply counters omitted by the stream.
          if (this.ready(entry)) this.flush(scope);
        }
        this.streams.delete(scope);
      }
    } else if (evt.type === "result") {
      const identity = typeof evt.result_index === "number" ? `index:${evt.result_index}` : evt.uuid;
      const resultKey = this.key(scope, String(identity));
      if (identity !== undefined && this.results.has(resultKey)) return;
      if (identity !== undefined) this.results.add(resultKey);
      this.flush(scope);
      this.missingIds.delete(scope);
      if (scope === "main") {
        // A parent result does not end an asynchronous helper's current message.
        if (!this.mainObserved) this.send({ ...anthropicUsage(null), message_id: `result-only:${++this.gaps}`, model: typeof evt.model === "string" && evt.model.trim() ? evt.model : UNKNOWN_MODEL, source,
          ts: new Date().toISOString(), reason: "result_without_hops", reported_result_usage: anthropicUsage(evt.usage) });
        this.mainObserved = false;
      } else {
        this.helpers.add(scope); this.helperObserved.add(scope);
        if (!this.observedHelpers.has(scope)) this.send({ ...anthropicUsage(null), message_id: `helper-result-only:${++this.gaps}`,
          model: typeof evt.model === "string" && evt.model.trim() ? evt.model : UNKNOWN_MODEL, source: "helper", helper_id: scope,
          ts: new Date().toISOString(), reason: "result_without_hops", reported_result_usage: anthropicUsage(evt.usage) });
        this.observedHelpers.delete(scope);
      }
    } else if (evt.type === "system" && evt.subtype === "task_started" && evt.task_type === "local_agent" && typeof evt.tool_use_id === "string") {
      this.helpers.add(evt.tool_use_id);
    } else if (evt.type === "system" && evt.subtype === "task_notification" && typeof evt.tool_use_id === "string") {
      this.finishHelper(evt.tool_use_id, evt.usage?.total_tokens);
    }
  }
  private finishHelper(id: string, reportedTotal?: unknown): void {
    this.flush(id);
    if (this.helpers.has(id) && !this.helperObserved.has(id)) {
      this.helperObserved.add(id);
      this.send({ ...anthropicUsage(null), message_id: `helper-missing:${id}`, model: UNKNOWN_MODEL, source: "helper", helper_id: id,
        ts: new Date().toISOString(), reason: "helper_usage_not_reported",
        ...(usageNumber(reportedTotal) !== null ? { reported_total_tokens: usageNumber(reportedTotal)! } : {}) });
    }
  }
  snapshot(): void { for (const [scope, entry] of this.pending) if (this.ready(entry) && !entry.streaming) this.flush(scope); }
  finish(): void {
    for (const [scope, entry] of [...this.pending]) this.flush(scope, !entry.complete);
    for (const helper of this.helpers) this.finishHelper(helper);
  }
}

function modelFromUsage(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.model === "string" && value.model.trim()) return value.model;
  if (value instanceof Map) {
    const first = value.keys().next().value;
    return typeof first === "string" && first.trim() ? first : undefined;
  }
  const firstKey = Object.keys(value).find((key) => key.trim().length > 0);
  return firstKey;
}

export function servedModelFromPipeEvent(event: any): string | undefined {
  const candidates = [
    event?.message?.model,
    modelFromUsage(event?.message?.modelUsage),
    modelFromUsage(event?.message?.model_usage),
    modelFromUsage(event?.modelUsage),
    modelFromUsage(event?.model_usage),
    event?.model,
    event?.model_id,
    event?.result?.model,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export interface ServedModelUpdate {
  servedModel: string | undefined;
  assistantModelSeen: boolean;
}

export function updateServedModel(
  current: string | undefined,
  event: any,
  assistantModelSeen = false,
): ServedModelUpdate {
  const candidate = servedModelFromPipeEvent(event);
  if (event?.type === "assistant" && candidate) {
    return { servedModel: candidate, assistantModelSeen: true };
  }
  if (!assistantModelSeen && candidate) return { servedModel: candidate, assistantModelSeen };
  return { servedModel: current, assistantModelSeen };
}

// JSON.stringify omits undefined fields; null preserves an explicitly unknown model.
export function servedModelForAkte(servedModel: string | undefined): string | null {
  return servedModel ?? null;
}

// Encoded image length does not measure vision tokens; use a 1,600-token fallback estimate.
const IMAGE_ESTIMATE_CHARS = 1600 * 3.6;
function textVisibleChars(text: string): number {
  return text.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, " ".repeat(IMAGE_ESTIMATE_CHARS))
    .replace(/(?:\/9j\/|iVBORw0KGgo|R0lGOD|UklGR)[A-Za-z0-9+/\r\n]{4096,}={0,2}/g, " ".repeat(IMAGE_ESTIMATE_CHARS)).length;
}
function pipeContentChars(content: any): number {
  if (typeof content === "string") return textVisibleChars(content);
  if (Array.isArray(content)) return content.reduce((n, c) => n + pipeContentChars(c), Math.max(0, content.length - 1));
  if (content?.type === "image" || content?.type === "image_url" || content?.type === "input_image") return IMAGE_ESTIMATE_CHARS;
  if (typeof content?.text === "string") return textVisibleChars(content.text);
  return content == null ? 0 : textVisibleChars(JSON.stringify(content));
}

export function pipeEventVisibleChars(event: any): number {
  if (!event || typeof event !== "object") return 0;
  if (event.type === "tool_use") return JSON.stringify(event.input ?? {}).length;
  if (event.type === "tool_result") return pipeContentChars(event.content);

  const content = event?.message?.content ?? event?.content;
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  if (event.type === "assistant") {
    return blocks.reduce((sum: number, block: any) => {
      if (block?.type === "text" && typeof block.text === "string") return sum + block.text.length;
      if (block?.type === "tool_use") return sum + JSON.stringify(block.input ?? {}).length;
      return sum;
    }, 0);
  }
  if (event.type === "user") {
    return blocks.reduce((sum: number, block: any) =>
      sum + (block?.type === "tool_result" ? pipeContentChars(block.content) : 0), 0);
  }
  return 0;
}

export class PipeVisibleContext {
  private chars: number;

  constructor(initialChars = 0) {
    this.chars = Math.max(0, Number.isFinite(initialChars) ? initialChars : 0);
  }

  addUserPayload(payload: string): void {
    this.chars += payload.length;
  }

  observe(event: any): void {
    this.chars += pipeEventVisibleChars(event);
  }

  getBrainVisibleChars(): number {
    return this.chars;
  }

  brainVisibleTokens(): number {
    return Math.ceil(this.chars / 3.6);
  }
}

export function observePipeStreamEvent(
  event: any,
  context: PipeVisibleContext,
  onCanonicalEvent?: (evt: CanonicalPipeEvent) => void,
): void {
  forwardCanonicalPipeEvent(event, onCanonicalEvent);
  context.observe(event);
}

export const CLI_NO_OUTPUT_PROMPT = "Your previous response had no visible output. Please continue and produce a user-visible response.";

export function isCliNoOutputPrompt(text: string): boolean {
  return text.trim() === CLI_NO_OUTPUT_PROMPT;
}

export interface SendResult {
  gatewaySilent?: boolean;
  finalContent: string;
  // A tool invocation is not proof of delivery; its result must confirm success.
  appReplyTexts: string[];
  undeliveredReplyTexts: string[];
  roomTexts?: string[];
  peerTexts?: string[];
  resultUsage: HopUsage;
  hopUsages: HopUsage[];
  maxHopPromptTokens: number;
  lastHopPromptTokens: number;
  lastHopInputReported?: boolean;
  sumHopPromptTokens: number;
  sawCompactBoundary: boolean;
  assistantText: string;
  finalText?: string;
  nonAppToolUses: Array<{ id?: string; name: string; inputChars: number }>;
  servedModel?: string;
  rateLimitInfo?: any;
  resultIndex?: number | null;
  originKind?: string | null;
}

export function pipeWatchdogTokens(result: SendResult, pipe: { brainVisibleTokens(): number }, log?: (event: Record<string, unknown>) => void): number {
  if (result.lastHopInputReported ?? result.lastHopPromptTokens > 0) return result.lastHopPromptTokens;
  const tokens = pipe.brainVisibleTokens();
  log?.({ type: "watchdog_fallback", reason: "last_hop_input_usage_missing", tokens });
  return tokens;
}



// Only echoed outbound IDs identify this caller's turns; other turns belong to the CLI.
export type SelfTurnKind = "task" | "wake" | "steer" | "self";

export interface SelfTurnEvent {
  phase: "start" | "end";
  turn: number;
  kind: SelfTurnKind;
  notices: string[];
  wakePrompt: string | null;
  status?: "done" | "error" | "lost" | "absorbed";
  error?: string;
  authExpired?: boolean;
  originKind?: string | null;
  resultIndex?: number | null;
  result?: SendResult | null;
  announced?: boolean;
}

export interface SendOptions {
  usageSource?: "turn" | "cache_ping" | "internal";
  steerable?: boolean;
  onWritten?: () => void;
}

// Give a pending CLI-initiated turn time to open before writing the next send.
const SELF_TURN_GRACE_MS = 3000;
const STEER_ECHO_TURNS = 2;

interface Outbound {
  uuid: string;
  text: string;
  kind: "send" | "steer";
  usageSource?: "turn" | "cache_ping" | "internal";
  steerable: boolean;
  written: boolean;
  writtenTurnSeq: number;
  closesSinceWrite: number;
  onWritten?: () => void;
  resolve?: (result: SendResult) => void;
  reject?: (error: Error) => void;
}

interface OpenTurn {
  seq: number;
  acc: TurnAccumulator;
  owner: Outbound | null;
  notices: string[];
  foreignCommand: boolean;
  steerSpill: boolean;
  decided: boolean;
  announced: boolean;
  unmatchedReplays: number;
  toolHops: number;
  toolRequestIds: Set<string>;
  toolCallIds: Set<string>;
  hopLimit: number | null;
}

function replayText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => typeof c?.text === "string" ? c.text : "").join("");
  return "";
}

function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item: any) => typeof item === "string" ? item : typeof item?.name === "string" ? item.name : "")
    .filter((name) => name.length > 0);
}

function clip(text: string, max = 300): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export class TurnAccumulator {
  private readonly appReplyTools = appReplyToolNames();
  private readonly workerName = process.env.BRAIN_WORKER_NAME ?? "Worker";
  gatewaySilent = false;
  cliAuthFailure = false;
  readonly appReplyTexts: string[] = [];
  readonly undeliveredReplyTexts: string[] = [];
  private readonly pendingReplies = new Map<string, { text: string; name: string }>();
  readonly roomTexts: string[] = [];
  private readonly pendingRooms = new Map<string, string>();
  readonly peerTexts: string[] = [];
  private readonly pendingPeers = new Map<string, string>();
  readonly hopUsages: HopUsage[] = [];
  private readonly usageById = new Map<string, { raw: Record<string, any>; hop: HopUsage }>();
  private readonly assistantTextBlocks: string[] = [];
  readonly nonAppToolUses: Array<{ id?: string; name: string; inputChars: number }> = [];
  private firstAssistantEventLogged = false;
  private streamMsgId: string | null = null;
  private streamText = "";
  private readonly classicTextSeenIds = new Set<string>();
  private readonly outstandingToolIds = new Set<string>();
  private readonly liveToolIds = new Set<string>();
  sawCompactBoundary = false;
  servedModel: string | undefined;
  private assistantModelSeen = false;
  rateLimitInfo: any = null;
  wakePrompt: string | null = null;
  private finalTextOnly: string | null = null;

  constructor(
    private readonly opts: PipeOptions,
    private readonly canonicalForwarder: { observe(event: any): void } | null,
    private readonly visibleContext: PipeVisibleContext,
    rateLimitInfo: any,
  ) {
    opts.toolRecords ??= new ToolRecordPolicy(process.env.BRAIN_TOOL_REFERENCES, opts.logEvent);
    this.rateLimitInfo = rateLimitInfo ?? null;
  }

  outstandingTools(): number {
    return this.outstandingToolIds.size;
  }

  observeModel(evt: any): void {
    ({ servedModel: this.servedModel, assistantModelSeen: this.assistantModelSeen } = updateServedModel(this.servedModel, evt, this.assistantModelSeen));
  }

  private noteText(text: string): void {
    this.assistantTextBlocks.push(text);
    if (!this.firstAssistantEventLogged) {
      this.firstAssistantEventLogged = true;
      this.opts.logEvent?.({ type: "claude_pipe_first_assistant_text", text_preview: toolLogPreview(text), chars: text.length });
    }
    this.opts.onTuiStep?.({ kind: "term-out", title: `◆ ${this.workerName}  (${pipeClock()})`, body: text, collapsed: false });
  }

  private addUsage(id: string | null | undefined, usage: any): void {
    // Missing identity is not safe to deduplicate; remain on the logged fallback.
    if (typeof id !== "string" || !id) return;
    let entry = this.usageById.get(id);
    if (!entry) {
      entry = { raw: {}, hop: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, total_input: 0 } };
      this.usageById.set(id, entry);
      this.hopUsages.push(entry.hop);
    }
    mergeMessageUsage(entry.raw, usage);
    const u = entry.hop;
    for (const field of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const) u[field] = entry.raw[field] ?? 0;
    u.total_input = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  }

  observe(evt: any): void {
    if (evt.type === "user" && isCliNoOutputPrompt(replayText(evt.message?.content))) this.gatewaySilent = true;
    if (evt.type === "stream_event" && evt.event) {
      const se = evt.event;
      if (se.type === "message_start") {
        this.streamMsgId = se.message?.id ?? null;
        this.addUsage(this.streamMsgId, se.message?.usage);
        this.streamText = "";
        this.observeModel({ type: "assistant", message: { model: se.message?.model } });
      } else if (se.type === "content_block_delta" && se.delta?.type === "text_delta" && typeof se.delta.text === "string") {
        this.streamText += se.delta.text;
      } else if (se.type === "message_delta" && se.usage && this.streamMsgId) {
        this.addUsage(this.streamMsgId, se.usage);
      } else if (se.type === "message_stop") {
        if (this.streamText.trim() && !(this.streamMsgId && this.classicTextSeenIds.has(this.streamMsgId))) {
          const synthetic = { type: "assistant", message: { id: this.streamMsgId ?? undefined, content: [{ type: "text", text: this.streamText }] } };
          this.canonicalForwarder?.observe(synthetic);
          this.visibleContext.observe(synthetic);
          this.noteText(this.streamText);
          this.finalTextOnly = this.streamText.trim();
        }
        this.streamText = "";
        this.streamMsgId = null;
      }
      return;
    }

    if (evt.type === "user" && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block?.type !== "tool_result") continue;
        this.finalTextOnly = null;
        if (typeof block.tool_use_id === "string") this.outstandingToolIds.delete(block.tool_use_id);
        const content = block.content;
        let preview = "";
        let fullChars = 0;
        if (typeof content === "string") {
          preview = content;
          fullChars = content.length;
        } else if (Array.isArray(content)) {
          const joined = content.map((c: any) => typeof c?.text === "string" ? c.text : JSON.stringify(c)).join(" ");
          preview = content.map((c: any) => typeof c?.text === "string" ? c.text : toolLogPreview(c, Infinity)).join(" ");
          fullChars = joined.length;
        } else if (content != null) {
          const s = JSON.stringify(content);
          preview = toolLogPreview(content, Infinity);
          fullChars = s.length;
        }
        const reference = this.opts.toolRecords!.reference(block.tool_use_id, content);
        preview = toolLogPreview(reference ?? preview);
        this.opts.logEvent?.({ type: "claude_pipe_tool_result_seen", tool_use_id: block.tool_use_id, is_error: !!block.is_error, content_preview: preview, content_chars: fullChars });
        this.settleReply(block.tool_use_id, !!block.is_error, preview);
        this.settleRoom(block.tool_use_id, !!block.is_error);
        this.settlePeer(block.tool_use_id, !!block.is_error);
        const toolName = (typeof block.tool_use_id === "string" && toolNameById.get(block.tool_use_id)) || "tool";
        this.opts.onTuiStep?.({
          kind: block.is_error ? "error" : "tool",
          title: block.is_error ? tr`✗ ${toolName} error  (${fullChars} chars)` : tr`◂ ${toolName} result  (${fullChars} chars)`,
          body: preview,
          collapsed: true,
        });
      }
      return;
    }

    if (evt.type === "assistant" && evt.message) {
      const msg = evt.message;
      this.observeModel(evt);
      this.addUsage(msg.id ?? evt.requestId ?? evt.uuid, msg.usage);
      if (!Array.isArray(msg.content)) return;
      if (msg.content.some((block: any) => block?.type === "tool_use")) this.finalTextOnly = null;
      else {
        const text = msg.content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("\n").trim();
        if (text) this.finalTextOnly = text;
      }
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          if (typeof msg.id === "string") this.classicTextSeenIds.add(msg.id);
          this.noteText(block.text);
        } else if (block?.type === "tool_use") {
          const inputChars = JSON.stringify(block.input ?? {}).length;
          const savedInput = this.opts.toolRecords!.input(block.name, block.id, block.input ?? {});
          const isAppReply = this.appReplyTools.has(block.name);
          if (typeof block.id === "string") {
            this.outstandingToolIds.add(block.id);
            toolNameById.set(block.id, block.name);
          }
          if (typeof block.id !== "string" || !this.liveToolIds.has(block.id)) {
            if (typeof block.id === "string") this.liveToolIds.add(block.id);
            try { this.opts.onToolUse?.({ id: block.id, name: block.name, input: block.input }); }
            catch { this.opts.logEvent?.({ type: "claude_pipe_live_callback_error", callback: "onToolUse" }); }
          }
          this.opts.logEvent?.({
            type: "claude_pipe_tool_use_seen",
            id: block.id,
            name: block.name,
            input_chars: inputChars,
            is_app_reply_tool: isAppReply,
            input_preview: toolLogPreview(savedInput),
          });
          this.opts.onTuiStep?.({
            kind: "tool",
            title: `▸ ${block.name}${toolInputPreview(block.name, savedInput)}  (${pipeClock()})`,
            body: toolLogPreview(savedInput, Infinity, 2),
            collapsed: true,
          });
          if (block.name === "ScheduleWakeup" && typeof block.input?.prompt === "string") this.wakePrompt = this.opts.toolRecords!.reference(block.id, block.input.prompt) ?? block.input.prompt;
          if (isAppReply) {
            const text = appReplySpeech(block.name, block.input);
            if (text.trim()) {
              if (typeof block.id === "string") this.pendingReplies.set(block.id, { text, name: block.name });
              else this.noteUndelivered(text, null, "no tool_use id");
            }
          } else {
            this.nonAppToolUses.push({ id: block.id, name: block.name, inputChars });
            const roomLine = roomSpeechLine(block.name, block.input);
            if (roomLine && typeof block.id === "string") this.pendingRooms.set(block.id, roomLine);
            const peerLine = peerSpeechLine(block.name, block.input);
            if (peerLine && typeof block.id === "string") this.pendingPeers.set(block.id, peerLine);
          }
        }
      }
    }
  }

  private settleReply(toolUseId: unknown, isError: boolean, preview: string): void {
    if (typeof toolUseId !== "string") return;
    const reply = this.pendingReplies.get(toolUseId);
    if (!reply) return;
    this.pendingReplies.delete(toolUseId);
    if (isError) {
      this.noteUndelivered(reply.text, toolUseId, preview);
      return;
    }
    this.appReplyTexts.push(reply.text);
    this.opts.onTuiStep?.({ kind: "app-out", title: `▶ ${this.workerName} → App  (${reply.name})`, body: this.opts.toolRecords!.reference(toolUseId, reply.text) ?? reply.text, collapsed: false });
  }

  private settleRoom(toolUseId: unknown, isError: boolean): void {
    if (typeof toolUseId !== "string") return;
    const line = this.pendingRooms.get(toolUseId);
    if (line === undefined) return;
    this.pendingRooms.delete(toolUseId);
    if (!isError) this.roomTexts.push(line);
  }

  private settlePeer(toolUseId: unknown, isError: boolean): void {
    if (typeof toolUseId !== "string") return;
    const line = this.pendingPeers.get(toolUseId);
    if (line === undefined) return;
    this.pendingPeers.delete(toolUseId);
    if (!isError) this.peerTexts.push(line);
  }

  private noteUndelivered(text: string, toolUseId: string | null, reason: string): void {
    this.undeliveredReplyTexts.push(text);
    this.opts.logEvent?.({ type: "claude_pipe_app_reply_undelivered", tool_use_id: toolUseId, reason: reason.slice(0, 300), characters: text.length });
  }

  finish(evt: any): { result: SendResult; isError: boolean; resultText: string } {
    this.observeModel(evt);
    for (const [id, reply] of this.pendingReplies) this.noteUndelivered(reply.text, id, "no tool_result before the turn ended");
    this.pendingReplies.clear();
    const undelivered = [...new Set(this.undeliveredReplyTexts)].filter((text) => !this.appReplyTexts.includes(text));
    const resultText = typeof evt.result === "string" ? evt.result : evt.result == null ? "" : String(evt.result);
    const u = evt.usage ?? {};
    const resultUsage: HopUsage = {
      input_tokens: u.input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_input: 0,
    };
    resultUsage.total_input = resultUsage.input_tokens + resultUsage.cache_creation_input_tokens + resultUsage.cache_read_input_tokens;
    // Delivered replies are the actual speech; the result text may contain only an MCP echo.
    const finalContent = this.appReplyTexts.length > 0 ? this.appReplyTexts.join("\n\n") : resultText;
    const hops = this.hopUsages;
    return {
      isError: !!evt.is_error,
      resultText,
      result: {
        finalContent,
        gatewaySilent: this.gatewaySilent,
        appReplyTexts: this.appReplyTexts,
        undeliveredReplyTexts: undelivered,
        roomTexts: this.roomTexts,
        peerTexts: this.peerTexts,
        resultUsage,
        hopUsages: hops,
        maxHopPromptTokens: hops.reduce((m, h) => Math.max(m, h.total_input), 0),
        lastHopPromptTokens: hops.length ? hops[hops.length - 1].total_input : 0,
        lastHopInputReported: usageNumber([...this.usageById.values()].at(-1)?.raw.input_tokens) !== null,
        sumHopPromptTokens: hops.reduce((s, h) => s + h.total_input, 0),
        sawCompactBoundary: this.sawCompactBoundary,
        assistantText: this.assistantTextBlocks.join("\n\n").trim(),
        finalText: this.finalTextOnly ?? "",
        nonAppToolUses: this.nonAppToolUses,
        servedModel: this.servedModel,
        rateLimitInfo: this.rateLimitInfo,
        resultIndex: typeof evt.result_index === "number" ? evt.result_index : null,
        originKind: typeof evt.origin?.kind === "string" ? evt.origin.kind : null,
      },
    };
  }
}

export class ClaudePipe {
  private proc: Subprocess | null = null;
  private stopped = false;
  private eof = false;
  private startedAt = 0;
  private sessionId: string | null = null;
  // Subagent events do not count: they live in their own context.
  private visibleContext = new PipeVisibleContext();
  private systemPromptFile: string | null = null;
  private systemPromptTemp: SecureTempMarkdown | null = null;
  private canonicalForwarder: { observe(event: any): void } | null = null;

  private readerDone: Promise<void> | null = null;
  private turnSeq = 0;
  private openTurn: OpenTurn | null = null;
  private outbound: Outbound[] = [];
  private queuedSend: Outbound | null = null;
  private activeSend: Outbound | null = null;
  private echoSeen = false;
  private echoedUuids = new Set<string>();
  private fallbackLogged = false;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private expectTurnUntil = 0;
  private expectTimer: ReturnType<typeof setTimeout> | null = null;
  private waitLogged = false;
  private bgTasks = new Map<string, { type: string; description: string }>();
  private subagentTasks = new Set<string>();
  private pendingNotices: string[] = [];
  private pendingRateLimit: any = null;
  private stderrAuthFailure = false;
  private pendingWakePrompt: string | null = null;
  private resultsSeen = 0;
  private initLogged = false;
  private pendingControls = new Map<string, { subtype: string; resolve: (result: ControlResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private controlSeq = 0;

  private maxToolHops = 0;
  private readonly usageLedger: PipeUsageLedger;
  constructor(private opts: PipeOptions) {
    opts.toolRecords ??= new ToolRecordPolicy(process.env.BRAIN_TOOL_REFERENCES, opts.logEvent);
    this.usageLedger = new PipeUsageLedger((sample) => opts.onUsage?.(sample));
    if (opts.onCanonicalEvent) this.canonicalForwarder = createCanonicalPipeForwarder(opts.onCanonicalEvent);
  }

  async start(initialBridgeForLog: string = ""): Promise<void> {
    if (this.proc) throw new Error("ClaudePipe already started");
    this.stopped = false;
    this.eof = false;

    const modelId = this.opts.model.replace(/^anthropic\//, "");

    // A private prompt file avoids argv size limits for large bridges.
    // Keep it until stop because unlinking at spawn races the CLI's read.
    this.systemPromptTemp = createSecureTempMarkdown(`claude-pipe-system-${process.pid}`, this.opts.systemPrompt);
    const systemPromptFile = this.systemPromptTemp.path;
    this.systemPromptFile = systemPromptFile;

    const args = [
      "-p",
      // Brain owns the disk transcript; the CLI must not keep a second copy.
      "--no-session-persistence",
      "--model", modelId,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      // Without this flag pure text answers never appear as classic events.
      "--include-partial-messages",
      "--verbose",
      // Echoed message IDs let the router attribute results to the correct send.
      "--replay-user-messages",
      this.opts.systemPromptMode === "replace" ? "--system-prompt-file" : "--append-system-prompt-file", systemPromptFile,
      "--settings", this.settingsArgForThisPipe(),
      "--setting-sources", this.opts.settingSources,
    ];
    if (this.opts.disableTools) {
      // Disabling built-ins alone does not prevent project MCP autoload.
      args.push(...claudePipeToolIsolationArgs(true));
    }
    if (!this.opts.disableTools && this.opts.mcpConfig) {
      const configs = Array.isArray(this.opts.mcpConfig) ? this.opts.mcpConfig : [this.opts.mcpConfig];
      if (configs.length) args.push("--mcp-config", ...configs);
    }
    if (!this.opts.disableTools && this.opts.disallowedTools?.length) {
      args.push("--disallowedTools", this.opts.disallowedTools.join(","));
    }
    if (this.opts.permissionPromptTool) args.push("--permission-prompt-tool", this.opts.permissionPromptTool);
    else if (this.opts.permissionPrompts) args.push("--permission-prompts", this.opts.permissionPrompts);
    if (this.opts.effort) args.push("--effort", this.opts.effort);

    const birthEnv = this.opts.birthEnv ?? process.env;
    const env: Record<string, string> = {
      ...(Object.fromEntries(Object.entries(birthEnv).filter(([, value]) => value !== undefined)) as Record<string, string>),
      EMBERVY_BRAIN_SUBTURN: "1",
      // Auto-compact off — Brain owns the cut, not Claude.
      DISABLE_AUTO_COMPACT: "1",
      DISABLE_AUTOCOMPACT: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS:
        birthEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "1000000",
      CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE:
        birthEnv.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE ?? "950000",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING:
        birthEnv.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING ?? "1",
      ...(typeof this.opts.maxOutputTokens === "number"
        ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(this.opts.maxOutputTokens) }
        : {}),
      ...(this.opts.env ?? {}),
    };
    for (const key of this.opts.unsetEnv ?? []) delete env[key];
    const maxToolHops = this.opts.maxToolHops ?? Number(env.BRAIN_PIPE_MAX_TOOL_HOPS);
    this.maxToolHops = Number.isFinite(maxToolHops) && maxToolHops > 0 ? maxToolHops : 0;
    Object.assign(env, notesCliEnvironment(env));
    // This environment setting outranks session effort and would silently override live changes.
    delete env.CLAUDE_CODE_EFFORT_LEVEL;

    this.proc = spawn([this.opts.binary || (this.opts.birthEnv ?? process.env).BRAIN_CLAUDE_BIN || "claude", ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.opts.cwd,
      env,
    });

    if (!this.proc.stdin) throw new Error("ClaudePipe: stdin not available");
    if (!this.proc.stdout) throw new Error("ClaudePipe: stdout not available");
    this.startedAt = Date.now();

    this.visibleContext = new PipeVisibleContext(this.opts.systemPrompt.length);

    this.opts.logEvent?.({
      type: "claude_pipe_started",
      model: modelId,
      pid: this.proc.pid,
      system_chars: this.opts.systemPrompt.length,
      initial_bridge_chars_for_log: initialBridgeForLog.length,
      tools_disabled: this.opts.disableTools === true,
      brain_visible_chars_start: this.getBrainVisibleChars(),
      env_context_tokens: env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      env_blocking_limit: env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE,
      env_disable_adaptive_thinking: env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
      max_output_tokens: this.opts.maxOutputTokens,
      effort: this.opts.effort ?? null,
    });

    // Read between sends so CLI-initiated turns cannot be attributed to the next send.
    this.readerDone = this.readLoop(this.proc.stdout as ReadableStream<Uint8Array>);

    // Drain stderr (otherwise the pipe buffer deadlocks). Fire-and-forget.
    if (this.proc.stderr) {
      const proc = this.proc;
      const logEvent = this.opts.logEvent;
      void (async () => {
        try {
          const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            if (this.opts.authProfile && isClaudeAuthText(buf)) {
              this.stderrAuthFailure = true;
              buf = "";
            }
            if (buf.length > 4000) {
              logEvent?.({ type: "claude_pipe_stderr", text: this.opts.toolRecords!.diagnostic(buf.slice(-4000)) });
              buf = "";
            }
          }
          if (buf.trim()) logEvent?.({ type: "claude_pipe_stderr", text: this.opts.toolRecords!.diagnostic(buf.slice(-4000)) });
        } catch (e: any) {
          logEvent?.({ type: "claude_pipe_stderr_error", error: e.message });
        }
      })();
    }
  }

  // The CLI counts thinking tokens against the output cap, so capped pings disable thinking.
  settingsArgForThisPipe(): string {
    if (typeof this.opts.maxOutputTokens !== "number" && !this.opts.approvalHook) return this.opts.settingsPath;
    let base: Record<string, unknown> = {};
    try { base = JSON.parse(readFileSync(resolve(this.opts.cwd, this.opts.settingsPath), "utf8")); }
    catch { try { base = JSON.parse(this.opts.settingsPath); } catch { base = {}; } }
    const settings: Record<string, unknown> = { ...base, ...(typeof this.opts.maxOutputTokens === "number" ? { alwaysThinkingEnabled: false } : {}) };
    if (this.opts.approvalHook) {
      const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
      const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
      settings.hooks = { ...hooks, PreToolUse: [...preToolUse, {
        matcher: APPROVAL_HOOK_MATCHER, hooks: [{ type: "command", command: approvalHookCommand(this.opts.approvalHook) }],
      }] };
    }
    return JSON.stringify(settings);
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isAlive(): boolean {
    if (!this.proc || this.stopped || this.eof) return false;
    return this.proc.exitCode === null;
  }

  brainVisibleTokens(): number {
    return this.visibleContext.brainVisibleTokens();
  }

  getBrainVisibleChars(): number {
    return this.visibleContext.getBrainVisibleChars();
  }

  isBusy(): boolean {
    return this.isAlive() && Boolean(this.openTurn || this.activeSend || this.queuedSend);
  }

  hasOpenTurn(): boolean {
    return this.isAlive() && this.openTurn !== null;
  }

  canSteer(): boolean {
    if (!this.isAlive() || !this.proc?.stdin) return false;
    const owner = this.openTurn?.owner;
    if (owner && !owner.steerable) return false;
    if (this.activeSend && !this.activeSend.steerable) return false;
    return this.openTurn !== null || this.activeSend !== null;
  }

  // A steer that misses the running turn can start a separate CLI turn.
  // False means nothing was delivered, so the caller can send it normally.
  steer(text: string): boolean {
    if (!this.canSteer()) return false;
    const entry: Outbound = {
      uuid: randomUUID(), text, kind: "steer", steerable: true, written: false,
      writtenTurnSeq: this.turnSeq, closesSinceWrite: 0,
    };
    if (!this.writeLine(entry)) return false;
    this.visibleContext.addUserPayload(text);
    this.opts.logEvent?.({ type: "claude_pipe_steering_sent", chars: text.length, preview: toolLogPreview(text, 200), into: this.openTurn ? (this.openTurn.owner ? "own_turn" : "self_turn") : "written_send" });
    return true;
  }

  // The CLI retains its context; resending the system prompt or bridge would duplicate it.
  async send(userBlock: string, options: SendOptions = {}): Promise<SendResult> {
    if (!this.proc || this.stopped || this.eof) throw new Error("ClaudePipe: not started or stopped");
    if (this.queuedSend || this.activeSend) throw new Error("ClaudePipe: send already in flight (no parallel sends)");
    if (!this.proc.stdin) throw new Error("ClaudePipe: streams not ready");
    return await new Promise<SendResult>((resolve, reject) => {
      this.queuedSend = {
        uuid: randomUUID(), text: userBlock, kind: "send", steerable: options.steerable !== false,
        usageSource: options.usageSource ?? "turn",
        written: false, writtenTurnSeq: 0, closesSinceWrite: 0, onWritten: options.onWritten, resolve, reject,
      };
      this.pump();
    });
  }


  control(request: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<ControlResult> {
    const subtype = String(request.subtype ?? "");
    if (!this.isAlive() || !this.proc?.stdin) return Promise.resolve({ ok: false, error: "pipe not running" });
    this.controlSeq += 1;
    const requestId = `brain_ctl_${this.controlSeq}_${randomUUID().slice(0, 8)}`;
    return new Promise<ControlResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingControls.delete(requestId)) return;
        this.opts.logEvent?.({ type: "claude_pipe_control_timeout", subtype, ms: timeoutMs });
        resolve({ ok: false, error: `no control_response for ${subtype} within ${timeoutMs} ms` });
      }, timeoutMs);
      this.pendingControls.set(requestId, { subtype, resolve, timer });
      try {
        const sink = this.proc!.stdin as any;
        sink.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n");
        if (typeof sink.flush === "function") void sink.flush();
      } catch (error) {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        resolve({ ok: false, error: `stdin write failed: ${String(error)}` });
      }
    });
  }

  async appliedSettings(): Promise<AppliedSettings> {
    const answer = await this.control({ subtype: "get_settings" });
    if (!answer.ok) return { ok: false, error: answer.error };
    const applied = answer.response?.applied;
    if (!applied || typeof applied !== "object") return { ok: false, error: "get_settings without applied" };
    return {
      ok: true,
      model: typeof applied.model === "string" ? applied.model : null,
      effort: typeof applied.effort === "string" ? applied.effort : null,
    };
  }

  // The CLI can accept an ignored value; only readback proves the applied setting.
  async setEffort(level: string | null): Promise<AppliedSettings> {
    const answer = await this.control({ subtype: "apply_flag_settings", settings: { effortLevel: level } });
    if (!answer.ok) return { ok: false, error: answer.error };
    const applied = await this.appliedSettings();
    if (applied.ok) this.opts.effort = level;
    this.opts.logEvent?.({ type: "claude_pipe_effort_live", requested: level, applied: applied.effort ?? null, ok: applied.ok });
    return applied;
  }

  async setModel(model: string): Promise<AppliedSettings> {
    const answer = await this.control({ subtype: "set_model", model });
    if (!answer.ok) return { ok: false, error: answer.error };
    const applied = await this.appliedSettings();
    if (applied.ok) this.opts.model = applied.model || model;
    this.opts.logEvent?.({ type: "claude_pipe_model_live", requested: model, applied: applied.model ?? null, ok: applied.ok });
    return applied;
  }

  private noteControlResponse(evt: any): void {
    const response = evt.response ?? {};
    const requestId = String(response.request_id ?? "");
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      this.opts.logEvent?.({ type: "claude_pipe_control_response_unmatched", request_id: requestId || null });
      return;
    }
    this.pendingControls.delete(requestId);
    clearTimeout(pending.timer);
    if (response.subtype === "success") pending.resolve({ ok: true, response: response.response ?? null });
    else {
      const error = String(response.error ?? `control ${pending.subtype} failed`);
      this.opts.logEvent?.({ type: "claude_pipe_control_error", subtype: pending.subtype, error: this.opts.toolRecords!.diagnostic(error.slice(0, 300)) });
      pending.resolve({ ok: false, error });
    }
  }

  private failControls(reason: string): void {
    for (const [, pending] of this.pendingControls) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: reason });
    }
    this.pendingControls.clear();
  }

  async stop(timeoutMs = 5000): Promise<void> {
    if (!this.proc || this.stopped) return;
    this.stopped = true;
    this.clearExpectTimer();
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    try {
      const sink = this.proc.stdin as any;
      if (sink && typeof sink.end === "function") await sink.end();
    } catch { /* ignore */ }
    const deadline = Date.now() + timeoutMs;
    while (this.proc.exitCode === null && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (this.proc.exitCode === null) {
      try { this.proc.kill("SIGTERM"); } catch { /* ignore */ }
      const deadline2 = Date.now() + 2000;
      while (this.proc.exitCode === null && Date.now() < deadline2) {
        await new Promise(r => setTimeout(r, 100));
      }
      if (this.proc.exitCode === null) {
        try { this.proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
    // Let the reader see EOF, so a waiting send is answered before stop() returns.
    if (this.readerDone) await Promise.race([this.readerDone, new Promise(r => setTimeout(r, 500))]);
    this.failAll(new Error("ClaudePipe: stdout EOF before result event (pipe died)"));
    this.clearReadTimer();
    this.opts.logEvent?.({
      type: "claude_pipe_stopped",
      pid: this.proc.pid,
      exit_code: this.proc.exitCode,
      uptime_ms: Date.now() - this.startedAt,
      brain_visible_chars_final: this.getBrainVisibleChars(),
    });
    if (this.systemPromptTemp) {
      try { this.systemPromptTemp.cleanup(); } catch { /* ignore */ }
      this.systemPromptTemp = null;
    }
    this.systemPromptFile = null;
  }

  private async readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) this.onLine(line);
        }
      }
      const tail = (buffer + decoder.decode()).trim();
      if (tail) this.onLine(tail);
    } catch (error) {
      this.opts.logEvent?.({ type: "claude_pipe_reader_error", error: String(error) });
    } finally {
      this.onEof();
    }
  }

  private onLine(line: string): void {
    let evt: any;
    try { evt = JSON.parse(line); } catch { this.armReadTimer(); return; }
    try {
      this.route(evt);
    } catch (error) {
      // Keep the reader alive after a routing error so waiting sends can still finish.
      this.opts.logEvent?.({ type: "claude_pipe_route_error", error: String(error), event_type: evt?.type ?? null });
    }
    this.armReadTimer();
  }

  private route(evt: any): void {
    if (!evt || typeof evt !== "object") return;
    // Helpers have separate contexts and must not contribute to the resident's transcript.
    const parent = evt.parent_tool_use_id;
    if (typeof parent === "string" && parent.length > 0) {
      this.usageLedger.observe(evt, "helper");
      this.noteLive(evt, parent);
      this.noteSubagentEvent(evt, parent);
      return;
    }
    if (evt.type === "control_response") { this.noteControlResponse(evt); return; }
    // Only synthetic authentication diagnostics count; assistant discussion of sign-in failure is not evidence.
    if (this.opts.authProfile && evt.type === "assistant" && (evt.error === "authentication_failed" ||
      (evt.message?.model === "<synthetic>" && Array.isArray(evt.message?.content) && evt.message.content.some((b: any) => b?.type === "text" && isClaudeAuthText(b.text ?? ""))))) {
      this.ensureTurn().acc.cliAuthFailure = true;
      return;
    }
    this.canonicalForwarder?.observe(evt);
    this.visibleContext.observe(evt);

    const type = evt.type;
    const usageOwner = this.openTurn?.owner ?? (!this.echoSeen ? this.activeSend : null);
    this.usageLedger.observe(evt, usageOwner?.usageSource ?? "internal");
    this.noteLive(evt, "main");
    if (type === "control_request") {
      this.opts.logEvent?.({ type: "claude_pipe_control_request_unanswered", subtype: evt.request?.subtype ?? null });
      return;
    }
    if (type === "rate_limit_event") {
      if (evt.rate_limit_info) {
        if (this.openTurn) this.openTurn.acc.rateLimitInfo = evt.rate_limit_info;
        else this.pendingRateLimit = evt.rate_limit_info;
      }
      return;
    }
    if (type === "system") {
      switch (evt.subtype) {
        case "init": {
          const turn = this.ensureTurn();
          this.noteInit(evt);
          turn.acc.observeModel(evt);
          return;
        }
        case "task_started": this.noteTaskStarted(evt); return;
        case "task_notification": this.noteTaskNotification(evt); return;
        case "permission_denied": {
          const reason = evt.decision_reason ?? evt.message ?? null;
          this.opts.logEvent?.({
            type: "claude_pipe_permission_denied",
            tool_name: evt.tool_name ?? null,
            tool_use_id: evt.tool_use_id ?? null,
            reason: reason == null ? reason : this.opts.toolRecords!.diagnostic(reason),
          });
          return;
        }
        case "compact_boundary":
          if (this.openTurn) this.openTurn.acc.sawCompactBoundary = true;
          this.opts.logEvent?.({
            type: "claude_pipe_compact_boundary_seen",
            disable_auto_compact: "1",
            pre_tokens: evt.compactMetadata?.preTokens,
            note: "Claude compacted despite DISABLE_AUTO_COMPACT=1 — log only, no abort.",
          });
          return;
        default:
          return;
      }
    }
    if (type === "command_lifecycle") { this.noteLifecycle(evt); return; }
    if (type === "user" && (evt.isReplay === true || evt.is_replay === true)) { this.noteReplay(evt); return; }
    if (type === "result") { this.closeTurn(evt); return; }
    if (type === "assistant" || type === "stream_event" || type === "user") {
      const turn = this.ensureTurn();
      if (type === "assistant" || evt.event?.type === "message_start") this.decide(turn);
      turn.acc.observe(evt);
      if (type === "assistant") this.enforceToolHopLimit(turn, evt);
    }
  }

  private enforceToolHopLimit(turn: OpenTurn, evt: any): void {
    if (!this.maxToolHops || turn.hopLimit !== null) return;
    const blocks = evt.message?.content;
    if (!Array.isArray(blocks)) return;
    const tools = blocks.filter((block: any) => block?.type === "tool_use");
    if (!tools.length) return;
    // Classic events may split or replay one model message; parallel tools share its request.
    const id = evt.message?.id ?? evt.requestId ?? evt.uuid;
    if (typeof id === "string" && id && turn.toolRequestIds.has(id)) return;
    const toolIds = tools.map((block: any) => block.id).filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
    const replay = toolIds.length === tools.length && toolIds.every((id: string) => turn.toolCallIds.has(id));
    if (typeof id === "string" && id) turn.toolRequestIds.add(id);
    for (const toolId of toolIds) turn.toolCallIds.add(toolId);
    if (replay) return;
    turn.toolHops += 1;
    if (turn.toolHops < this.maxToolHops) return;
    turn.hopLimit = turn.toolHops;
    this.opts.logEvent?.({ type: "tool_hop_limit", hops: turn.toolHops });
    // Do not await here: the reader must keep routing the control acknowledgement and result.
    void this.control({ subtype: "interrupt" }).then((answer) => {
      if (!answer.ok) this.opts.logEvent?.({ type: "claude_pipe_hop_limit_interrupt_failed", turn: turn.seq, error: answer.error });
    });
  }

  private noteSubagentEvent(evt: any, parent: string): void {
    if (evt.type !== "assistant" && evt.type !== "user") return;
    const content = evt.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    this.opts.logEvent?.({
      type: "claude_pipe_subagent_event",
      parent_tool_use_id: parent,
      event: evt.type,
      blocks: blocks.slice(0, 8).map((b: any) => b?.type === "tool_use" ? `tool_use:${b.name}` : String(b?.type ?? "?")),
    });
  }

  private noteInit(evt: any): void {
    if (!this.sessionId && evt.session_id) {
      this.sessionId = evt.session_id;
      this.opts.logEvent?.({ type: "claude_pipe_session_id", session_id: this.sessionId, note: "diagnostic only — not used for --resume" });
      // Exclude this CLI session from archive selection without relying on a second transcript.
      try {
        const path = process.env.BRAIN_PIPE_SESSION_DENYLIST
          ?? `${process.env.BRAIN_STATE_DIR ?? `${import.meta.dir}/state`}/brain-pipe-sessions.txt`;
        const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
        if (!existing.includes(this.sessionId!)) appendFileSync(path, this.sessionId + "\n");
      } catch { /* writing the denylist must never disturb the pipe */ }
    }
    if (!this.initLogged) {
      // Record loaded configuration names only, never their contents.
      this.initLogged = true;
      this.opts.logEvent?.({
        type: "claude_pipe_init",
        session_id: evt.session_id ?? null,
        claude_code_version: evt.claude_code_version ?? null,
        model: evt.model ?? null,
        cwd: evt.cwd ?? null,
        permission_mode: evt.permissionMode ?? null,
        tools_count: Array.isArray(evt.tools) ? evt.tools.length : null,
        mcp_servers: Array.isArray(evt.mcp_servers)
          ? evt.mcp_servers.map((s: any) => ({ name: typeof s === "string" ? s : s?.name ?? null, status: typeof s === "string" ? null : s?.status ?? null }))
          : [],
        skills: namesOf(evt.skills),
        agents: namesOf(evt.agents),
      });
    }
  }

  private noteTaskStarted(evt: any): void {
    const id = typeof evt.task_id === "string" ? evt.task_id : "";
    if (!id) return;
    if (evt.owned_by_subagent === true) { this.subagentTasks.add(id); return; }
    // Foreground tools emit these events too, but do not initiate independent turns.
    if (evt.is_backgrounded === true && !this.bgTasks.has(id)) {
      const task = { type: String(evt.task_type ?? "task"), description: String(evt.description ?? ""), toolUseId: typeof evt.tool_use_id === "string" ? evt.tool_use_id : undefined };
      this.bgTasks.set(id, task);
      if (task.type === "local_agent" || task.type === "local_bash") {
        this.emitHelper({ id, phase: "start", description: task.description, kind: task.type, toolUseId: task.toolUseId });
      }
    }
  }

  private emitHelper(event: HelperActivity): void {
    const reference = this.opts.toolRecords!.reference(event.toolUseId, event.description);
    if (reference !== undefined) event = { ...event, description: reference };
    try { this.opts.onHelperActivity?.(event); }
    catch { this.opts.logEvent?.({ type: "claude_pipe_live_callback_error", callback: "onHelperActivity" }); }
  }

  private noteTaskNotification(evt: any): void {
    const id = typeof evt.task_id === "string" ? evt.task_id : "";
    const task = this.bgTasks.get(id);
    if (!task) return;
    this.bgTasks.delete(id);
    const status = String(evt.status ?? "done");
    if (task.type === "local_agent" || task.type === "local_bash") {
      this.emitHelper({ id, phase: "end", description: task.description, status, kind: task.type, toolUseId: task.toolUseId });
    }
    // Use the resident's description for helpers to avoid importing their text as resident speech.
    const notice = task.type === "local_bash" && typeof evt.summary === "string" && evt.summary.trim()
      ? clip(evt.summary)
      : clip(`Background ${task.type === "local_agent" ? "agent" : task.type} "${task.description}" ${status}`);
    this.pendingNotices.push(this.opts.toolRecords!.reference(task.toolUseId, notice) ?? notice);
    this.expectTurn();
    this.opts.logEvent?.({ type: "claude_pipe_task_notification", task_id: id, task_type: task.type, status });
  }

  private noteLifecycle(evt: any): void {
    if (evt.state !== "started") return; // Queued and completed events do not mark turn boundaries.
    const entry = this.outbound.find((e) => e.uuid === evt.command_uuid);
    if (entry) {
      this.echoSeen = true;
      this.attachEcho(this.ensureTurn(), entry, "lifecycle");
      return;
    }
    if (!this.openTurn) {
      this.ensureTurn().foreignCommand = true;
    }
  }

  private noteReplay(evt: any): void {
    const text = replayText(evt.message?.content);
    if (isCliNoOutputPrompt(text)) this.ensureTurn().acc.observe(evt);
    const entry = this.outbound.find((e) => e.uuid === evt.uuid)
      ?? this.outbound.find((e) => e.text.trim() === text.trim());
    if (entry) {
      this.echoSeen = true;
      this.attachEcho(this.ensureTurn(), entry, "replay");
      return;
    }
    if (typeof evt.uuid === "string" && this.echoedUuids.has(evt.uuid)) return;
    if (!this.openTurn) {
      // Local-command echoes have no result; opening a turn for one would leave it permanently busy.
      this.opts.logEvent?.({ type: "claude_pipe_replay_outside_turn", local_command: text.includes("<local-command-stdout>"), preview: toolLogPreview(text, 120) });
      return;
    }
    const turn = this.openTurn;
    turn.unmatchedReplays += 1;
    this.opts.logEvent?.({ type: "claude_pipe_replay_unmatched", turn: turn.seq, chars: text.length });
  }

  private attachEcho(turn: OpenTurn, entry: Outbound, via: "lifecycle" | "replay"): void {
    this.outbound = this.outbound.filter((e) => e !== entry);
    if (this.echoedUuids.size > 256) this.echoedUuids.clear();
    this.echoedUuids.add(entry.uuid);
    if (entry.kind === "send") {
      if (!turn.owner) turn.owner = entry;
      else if (turn.owner !== entry) this.opts.logEvent?.({ type: "claude_pipe_second_send_in_turn", turn: turn.seq });
      return;
    }
    const spill = entry.writtenTurnSeq < turn.seq && !(this.activeSend && turn.owner === this.activeSend);
    if (spill && !turn.owner) turn.steerSpill = true;
    this.opts.logEvent?.({ type: "claude_pipe_steer_echo", turn: turn.seq, via, spill });
  }

  private ensureTurn(): OpenTurn {
    if (this.openTurn) return this.openTurn;
    this.turnSeq += 1;
    const turn: OpenTurn = {
      seq: this.turnSeq,
      acc: new TurnAccumulator(this.opts, this.canonicalForwarder, this.visibleContext, this.pendingRateLimit),
      owner: null,
      notices: this.pendingNotices,
      foreignCommand: false,
      steerSpill: false,
      decided: false,
      announced: false,
      unmatchedReplays: 0,
      toolHops: 0,
      toolRequestIds: new Set(),
      toolCallIds: new Set(),
      hopLimit: null,
    };
    this.pendingNotices = [];
    this.pendingRateLimit = null;
    this.expectTurnUntil = 0;
    this.clearExpectTimer();
    this.openTurn = turn;
    this.liveTokens.reset(Date.now());
    this.emitLive();
    return turn;
  }

  private liveTokens = new LiveTurnTokens();
  private liveTimer: ReturnType<typeof setTimeout> | null = null;

  private noteLive(evt: any, scope: string): void {
    if (!this.opts.onLiveTokens || !this.liveTokens.observe(evt, scope) || this.liveTimer) return;
    this.liveTimer = setTimeout(() => { this.liveTimer = null; this.emitLive(); }, 1000);
  }

  private emitLive(): void {
    if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; }
    try { this.opts.onLiveTokens?.(this.liveTokens.snapshot()); } catch { /* display only */ }
  }

  private selfKind(turn: OpenTurn, originKind: string | null): SelfTurnKind {
    if (originKind === "task-notification") return "task";
    if (turn.foreignCommand) return "wake";
    if (turn.notices.length) return "task";
    if (turn.steerSpill) return "steer";
    return "self";
  }

  private decide(turn: OpenTurn): void {
    if (turn.decided) return;
    turn.decided = true;
    if (turn.owner) return;
    if (this.activeSend?.written && !this.echoSeen) return;
    turn.announced = true;
    const kind = this.selfKind(turn, null);
    this.opts.logEvent?.({ type: "claude_pipe_self_turn_start", turn: turn.seq, kind, notices: turn.notices.length });
    this.emitSelf({ phase: "start", turn: turn.seq, kind, notices: turn.notices, wakePrompt: kind === "wake" ? this.pendingWakePrompt : null });
  }

  private closeTurn(evt: any): void {
    const turn = this.ensureTurn();
    const { result, isError: cliError, resultText } = turn.acc.finish(evt);
    if (turn.hopLimit !== null) {
      const note = `(Tool-call limit reached after ${turn.hopLimit} model requests. The saved state is ready for the next turn.)`;
      result.finalContent = note;
      result.finalText = note;
      result.assistantText = note;
    }
    this.openTurn = null;
    this.emitLive();
    this.resultsSeen += 1;
    if (typeof evt.result_index === "number" && evt.result_index !== this.resultsSeen - 1) {
      this.opts.logEvent?.({ type: "claude_pipe_result_index_gap", expected: this.resultsSeen - 1, got: evt.result_index });
    }
    if (turn.acc.wakePrompt) this.pendingWakePrompt = turn.acc.wakePrompt;

    // Unmatched steering input may initiate a separate CLI turn after this result.
    for (const entry of this.outbound) if (entry.kind === "steer") entry.closesSinceWrite += 1;
    const expired = this.outbound.filter((e) => e.kind === "steer" && e.closesSinceWrite >= STEER_ECHO_TURNS);
    if (expired.length) {
      this.outbound = this.outbound.filter((e) => !expired.includes(e));
      this.opts.logEvent?.({ type: "claude_pipe_steer_echo_missing", count: expired.length });
    }
    if (this.outbound.some((e) => e.kind === "steer") || this.pendingNotices.length) this.expectTurn();

    let owner = turn.owner;
    const originKind = result.originKind ?? null;
    if (!owner && this.activeSend?.written && !this.echoSeen && !originKind && !turn.foreignCommand && !turn.notices.length) {
      // Without CLI echoes, unmarked results need a waiting-send fallback to avoid hanging the caller.
      owner = this.activeSend;
      this.outbound = this.outbound.filter((e) => e !== owner);
      if (!this.fallbackLogged) {
        this.fallbackLogged = true;
        this.opts.logEvent?.({ type: "claude_pipe_attribution_fallback", turn: turn.seq, note: "no echo from the CLI yet — unmarked turn given to the waiting send" });
      }
    }

    const failureText = resultText || (Array.isArray(evt.errors) ? evt.errors.filter((e: unknown) => typeof e === "string").join("\n") : "");
    const code = evt.status_code ?? evt.statusCode ?? evt.auth_status_code ?? evt.status ?? evt.error?.status ?? evt.error?.status_code ?? evt.error?.code ?? evt.error?.type ?? evt.error_code;
    const auth = Boolean(cliError && this.opts.authProfile && (turn.acc.cliAuthFailure || this.stderrAuthFailure ||
      (result.rateLimitInfo?.status !== "rejected" && claudeAuthExpired(this.opts.authProfile, failureText, code))));
    // An intentional budget interrupt is an orderly turn boundary, even if the CLI reports an error.
    const isError = cliError && (turn.hopLimit === null || auth || result.rateLimitInfo?.status === "rejected");
    if (owner && owner.kind === "send") {
      if (this.activeSend === owner) this.activeSend = null;
      this.opts.logEvent?.({ type: "claude_pipe_turn_end", turn: turn.seq, owner: "brain", result_index: result.resultIndex, origin: originKind, is_error: isError });
      if (isError) {
        owner.reject?.(auth ? new ClaudeAuthExpiredError() : Object.assign(new Error(`claude -p reported is_error=true: ${this.opts.toolRecords!.diagnostic(resultText.slice(0, 300))}`), { rateLimitInfo: result.rateLimitInfo ?? null }));
      }
      else owner.resolve?.(result);
      if (turn.announced) {
        this.emitSelf({ phase: "end", turn: turn.seq, kind: this.selfKind(turn, originKind), notices: turn.notices, wakePrompt: null, status: "absorbed", originKind, resultIndex: result.resultIndex ?? null, result: null, announced: true });
      }
    } else {
      const kind = this.selfKind(turn, originKind);
      const wakePrompt = kind === "wake" ? this.pendingWakePrompt : null;
      if (kind === "wake") this.pendingWakePrompt = null;
      this.opts.logEvent?.({ type: "claude_pipe_turn_end", turn: turn.seq, owner: "self", kind, result_index: result.resultIndex, origin: originKind, is_error: isError, unmatched_replays: turn.unmatchedReplays });
      this.emitSelf({
        phase: "end", turn: turn.seq, kind, notices: turn.notices, wakePrompt,
        status: isError ? "error" : "done", authExpired: auth,
        error: auth ? "Claude sign-in expired" : isError ? this.opts.toolRecords!.diagnostic(resultText.slice(0, 300)) : undefined,
        originKind, resultIndex: result.resultIndex ?? null, result, announced: turn.announced,
      });
    }
    this.stderrAuthFailure = false;
    this.pump();
  }

  private emitSelf(event: SelfTurnEvent): void {
    try {
      this.opts.onSelfTurn?.(event);
    } catch (error) {
      this.opts.logEvent?.({ type: "claude_pipe_self_turn_handler_error", error: String(error) });
    }
  }

  private writeLine(entry: Outbound): boolean {
    if (!this.proc?.stdin) return false;
    try {
      const payload = JSON.stringify({ type: "user", uuid: entry.uuid, message: { role: "user", content: entry.text } }) + "\n";
      const sink = this.proc.stdin as any;
      sink.write(payload);
      if (typeof sink.flush === "function") void sink.flush();
      entry.written = true;
      entry.writtenTurnSeq = this.turnSeq;
      this.outbound.push(entry);
      return true;
    } catch {
      return false;
    }
  }

  private pump(): void {
    const entry = this.queuedSend;
    if (!entry || this.eof || this.stopped || !this.proc) return;
    if (this.openTurn || this.activeSend) return;
    const wait = this.expectTurnUntil - Date.now();
    if (wait > 0) {
      if (!this.waitLogged) {
        this.waitLogged = true;
        this.opts.logEvent?.({ type: "claude_pipe_send_waits_for_self_turn", max_wait_ms: wait });
      }
      // Re-checked on expiry: a later notice may have moved the deadline.
      if (!this.expectTimer) this.expectTimer = setTimeout(() => { this.expectTimer = null; this.pump(); }, wait + 5);
      return;
    }
    this.waitLogged = false;
    this.queuedSend = null;
    if (!this.writeLine(entry)) {
      entry.reject?.(new Error("ClaudePipe: stdin write failed"));
      return;
    }
    this.activeSend = entry;
    this.visibleContext.addUserPayload(entry.text);
    try { entry.onWritten?.(); } catch (error) {
      this.opts.logEvent?.({ type: "claude_pipe_on_written_error", error: String(error) });
    }
    this.armReadTimer();
  }

  private expectTurn(): void {
    this.expectTurnUntil = Date.now() + SELF_TURN_GRACE_MS;
  }

  private clearExpectTimer(): void {
    if (this.expectTimer) { clearTimeout(this.expectTimer); this.expectTimer = null; }
  }

  private clearReadTimer(): void {
    if (this.readTimer) { clearTimeout(this.readTimer); this.readTimer = null; }
  }

  /** An idle pipe is silent by design; its death shows as EOF. */
  private armReadTimer(): void {
    this.clearReadTimer();
    if (this.eof || this.stopped) return;
    if (!this.openTurn && !this.activeSend) return;
    const ms = pipeReadTimeoutMs(this.openTurn?.acc.outstandingTools() ?? 0);
    this.readTimer = setTimeout(() => this.onReadTimeout(ms), ms);
  }

  private onReadTimeout(ms: number): void {
    this.readTimer = null;
    if (this.eof || this.stopped) return;
    this.opts.logEvent?.({ type: "claude_pipe_read_timeout", ms, open_turn: this.openTurn?.seq ?? null, waiting_send: Boolean(this.activeSend) });
    this.failAll(new Error(`ClaudePipe: turn timeout after ${ms}ms`));
    void this.stop(1000).catch(() => undefined);
  }

  private onEof(): void {
    if (this.eof) return;
    this.eof = true;
    this.clearReadTimer();
    this.clearExpectTimer();
    this.opts.logEvent?.({ type: "claude_pipe_eof", stopped: this.stopped, exit_code: this.proc?.exitCode ?? null, open_turn: this.openTurn?.seq ?? null });
    this.failAll(new Error("ClaudePipe: stdout EOF before result event (pipe died)"));
  }

  flushUsage(): void { this.usageLedger.snapshot(); }

  private failAll(error: Error): void {
    if (this.opts.authProfile && (this.stderrAuthFailure || this.openTurn?.acc.cliAuthFailure)) error = new ClaudeAuthExpiredError();
    this.usageLedger.finish();
    // Pipe death makes helper completion unobservable; mark tasks lost rather than successful.
    for (const [id, task] of this.bgTasks) {
      if (task.type === "local_agent" || task.type === "local_bash") {
        this.emitHelper({ id, phase: "end", description: task.description, status: "lost" });
      }
    }
    this.bgTasks.clear();
    this.failControls(error.message);
    const sends = [this.activeSend, this.queuedSend].filter((e): e is Outbound => e !== null);
    this.activeSend = null;
    this.queuedSend = null;
    this.outbound = [];
    const turn = this.openTurn;
    this.openTurn = null;
    for (const entry of sends) entry.reject?.(error);
    if (turn && !(turn.owner && sends.includes(turn.owner))) {
      this.emitSelf({ phase: "end", turn: turn.seq, kind: this.selfKind(turn, null), notices: turn.notices, wakePrompt: null, status: "lost", error: error.message, authExpired: error instanceof ClaudeAuthExpiredError, originKind: null, resultIndex: null, result: null, announced: turn.announced });
    }
  }
}
