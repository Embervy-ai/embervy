// Tracks token counts and tool activity during a streamed turn.

import { pipeEventToCanonicalEvents } from "./pipe-canonical";

const CHARS_PER_TOKEN = 4;

type MessageCount = { chars: number; real: number | null; final: boolean; coldIn: number; prompt: number | null };

export type LiveTokensSnapshot = {
  main: number; helpers: number; startedAt: number | null; estimated: boolean;
  cold?: number; window?: number | null;
  tool?: string | null;
  lastEventAt?: number;
};

function promptUsage(usage: any): { coldIn: number; prompt: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const input = n(usage.input_tokens), write = n(usage.cache_creation_input_tokens), read = n(usage.cache_read_input_tokens);
  if (!input && !write && !read) return null;
  return { coldIn: input + write, prompt: input + write + read };
}

function deltaChars(delta: any): number {
  if (!delta || typeof delta !== "object") return 0;
  for (const field of ["text", "thinking", "partial_json"]) {
    if (typeof delta[field] === "string") return delta[field].length;
  }
  return 0;
}

function outputTokens(usage: any): number | null {
  const n = usage?.output_tokens;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export class LiveTurnTokens {
  private messages = new Map<string, MessageCount>();
  private streaming = new Map<string, string>();
  private anonymous = 0;
  private lastMain: string | null = null;
  startedAt: number | null = null;
  private tools = new Map<string, string>();
  private lastEventAt: number | undefined;
  // The router observes the first event before reset() opens its turn.
  private betweenTurns = true;

  reset(now: number): void {
    const keep = new Set([...this.streaming].map(([scope, id]) => this.key(scope, id)));
    for (const key of [...this.messages.keys()]) if (!keep.has(key)) this.messages.delete(key);
    if (!this.betweenTurns) {
      this.tools.clear();
      this.lastEventAt = undefined;
    }
    this.betweenTurns = false;
    this.startedAt = now;
  }

  private key(scope: string, id: string): string {
    return `${scope}\u0000${id}`;
  }

  private entry(scope: string, id: string): MessageCount {
    const key = this.key(scope, id);
    let entry = this.messages.get(key);
    if (!entry) {
      entry = { chars: 0, real: null, final: false, coldIn: 0, prompt: null };
      this.messages.set(key, entry);
    }
    return entry;
  }

  observe(evt: any, scope: string, now = Date.now()): boolean {
    if (!evt || typeof evt !== "object") return false;
    const activity = typeof evt.type === "string" && [
      "stream_event", "assistant", "user", "tool_use", "tool_result", "result",
      "system", "rate_limit_event", "command_lifecycle", "control_request",
    ].includes(evt.type);
    if (activity) this.lastEventAt = now;
    if (scope === "main" && !evt.parent_tool_use_id) {
      for (const record of pipeEventToCanonicalEvents(evt)) {
        if (record.role === "assistant") {
          for (const call of record.tool_calls) {
            if (call.id && call.function.name) this.tools.set(call.id, call.function.name);
          }
        } else this.tools.delete(record.tool_call_id);
      }
      if (evt.type === "result") {
        this.tools.clear();
        this.lastEventAt = undefined;
        this.betweenTurns = true;
      }
    }
    const counted = this.observeCount(evt, scope);
    return counted || activity;
  }

  private observeCount(evt: any, scope: string): boolean {
    if (evt.type === "stream_event" && evt.event) {
      const se = evt.event;
      if (se.type === "message_start") {
        const id = typeof se.message?.id === "string" && se.message.id ? se.message.id : `anon-${++this.anonymous}`;
        this.streaming.set(scope, id);
        const entry = this.entry(scope, id);
        const prompt = promptUsage(se.message?.usage);
        if (!prompt) return false;
        entry.coldIn = prompt.coldIn;
        entry.prompt = prompt.prompt;
        if (scope === "main") this.lastMain = this.key(scope, id);
        return true;
      }
      const id = this.streaming.get(scope);
      if (!id) return false;
      if (se.type === "content_block_delta") {
        const chars = deltaChars(se.delta);
        if (!chars) return false;
        this.entry(scope, id).chars += chars;
        return true;
      }
      if (se.type === "message_delta") {
        const real = outputTokens(se.usage);
        if (real === null) return false;
        const entry = this.entry(scope, id);
        entry.real = Math.max(entry.real ?? 0, real);
        entry.final = true;
        return true;
      }
      if (se.type === "message_stop") this.streaming.delete(scope);
      return false;
    }
    // Streamed assistant messages can mirror a finished block with provisional startup usage.
    // Only final usage may replace the estimate; non-streamed helpers report final usage directly.
    if (evt.type === "assistant" && typeof evt.message?.id === "string") {
      const real = outputTokens(evt.message.usage);
      if (real === null) return false;
      const entry = this.entry(scope, evt.message.id);
      if (entry.final && entry.real !== null && entry.real >= real) return false;
      const streamed = this.streaming.get(scope) === evt.message.id || entry.chars > 0;
      if (!entry.final && streamed) {
        if (entry.real !== null && entry.real >= real) return false;
        entry.real = real;
        return true;
      }
      if (entry.real !== null && entry.real >= real) return false;
      entry.real = real;
      entry.final = true;
      return true;
    }
    return false;
  }

  snapshot(): LiveTokensSnapshot {
    let main = 0, helpers = 0, estimated = false, cold = 0;
    let window: number | null = null;
    for (const [key, entry] of this.messages) {
      const estimate = Math.ceil(entry.chars / CHARS_PER_TOKEN);
      const tokens = entry.final && entry.real !== null ? entry.real : Math.max(entry.real ?? 0, estimate);
      if (key.startsWith("main\u0000")) {
        main += tokens;
        cold += entry.coldIn + tokens;
        if (!entry.final && tokens > 0) estimated = true;
        if (key === this.lastMain && entry.prompt !== null) window = entry.prompt + tokens;
      } else helpers += tokens;
    }
    return { main, helpers, startedAt: this.startedAt, estimated, cold, window,
      tool: [...this.tools.values()].at(-1) ?? null,
      ...(this.lastEventAt !== undefined ? { lastEventAt: this.lastEventAt } : {}),
    };
  }
}
