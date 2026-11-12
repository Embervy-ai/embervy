// Converts streamed tool events into conversation records and calculates pipe recycle thresholds.

type ToolRecordLog = (event: Record<string, unknown>) => void;
type ToolRecordRule = { tool: string; when?: { field: string; equals: string | number | boolean | null }; allow: string[] };
type ToolRecordCall = { name: string; allow: Set<string> };

function referenceToolName(name: string): string {
  return name.replace(/^mcp__[^]+?__/, "");
}

export const DIAGNOSTIC_QUIET_MS = 30 * 60_000;

export function toolRecordChars(value: unknown): number {
  return (typeof value === "string" ? value : JSON.stringify(value) ?? "").length;
}

// Filters disk records only; model-facing messages must retain their full contents.
export class ToolRecordPolicy {
  private readonly rules: ToolRecordRule[] = [];
  private readonly calls = new Map<string, ToolRecordCall>();
  private lastMatchAt = Number.NEGATIVE_INFINITY;

  constructor(raw: string | undefined, log: ToolRecordLog = () => {}, private readonly now: () => number = Date.now) {
    if (!raw?.trim()) return;
    let entries: unknown;
    try { entries = JSON.parse(raw); } catch { entries = null; }
    if (!Array.isArray(entries)) {
      log({ type: "tool_record_config_invalid", entry: null });
      return;
    }
    entries.forEach((entry: any, index) => {
      const field = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v);
      const scalar = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);
      if (!entry || typeof entry.tool !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.tool)
        || (entry.allow !== undefined && (!Array.isArray(entry.allow) || entry.allow.length > 16 || !entry.allow.every(field)))
        || (entry.when !== undefined && (!entry.when || !field(entry.when.field) || !Object.hasOwn(entry.when, "equals") || !scalar(entry.when.equals)))) {
        // Never echo a malformed setting: it may itself contain customer data.
        log({ type: "tool_record_config_invalid", entry: index });
        return;
      }
      this.rules.push({ tool: referenceToolName(entry.tool), when: entry.when, allow: entry.allow ?? [] });
    });
  }

  private matching(name: string, input: unknown): ToolRecordCall | undefined {
    const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const rules = this.rules.filter((rule) => rule.tool === referenceToolName(name)
      && (!rule.when || (Object.hasOwn(args, rule.when.field) && args[rule.when.field] === rule.when.equals)));
    if (!rules.length) return;
    this.lastMatchAt = this.now();
    // Overlapping entries must not broaden one another's field permissions.
    const fields = (rule: ToolRecordRule) => new Set([...rule.allow, ...(rule.when ? [rule.when.field] : [])]);
    let allow = fields(rules[0]);
    for (const rule of rules.slice(1)) allow = new Set([...allow].filter((key) => fields(rule).has(key)));
    return { name, allow };
  }

  input(name: string, id: string | undefined, input: unknown): unknown {
    const call = this.matching(name, input);
    if (!call) {
      if (id) this.calls.delete(id);
      return input;
    }
    if (id) this.calls.set(id, call);
    if (!input || typeof input !== "object" || Array.isArray(input)) return { chars: toolRecordChars(input) };
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
      call.allow.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))
        ? value : { chars: toolRecordChars(value) },
    ]));
  }

  reference(id: string | undefined, value: unknown, name?: string, input?: unknown): string | undefined {
    const call = (id ? this.calls.get(id) : undefined) ?? (name ? this.matching(name, input) : undefined);
    if (!call) return;
    return `[tool reference: ${call.name}; call ${id ?? "unknown"}; ${toolRecordChars(value)} chars]`;
  }

  record<T extends Record<string, any>>(message: T): T {
    if (!this.rules.length) return message;
    let out = message;
    if (Array.isArray(message.tool_calls)) {
      out = { ...out, tool_calls: message.tool_calls.map((call: any) => {
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); } catch { args = call.function.arguments; }
        const saved = this.input(call.function.name, call.id, args);
        return saved === args ? call : { ...call, function: { ...call.function, arguments: JSON.stringify(saved) } };
      }) };
    }
    if (message.role === "tool") {
      const ref = this.reference(message.tool_call_id, message.content, message.name);
      if (ref !== undefined) out = { ...out, content: ref };
    }
    return out;
  }

  // Unstructured diagnostics cannot be attributed to one call, so matching calls suppress them temporarily.
  diagnostic<T>(value: T): T | string {
    return this.rules.length && this.now() - this.lastMatchAt < DIAGNOSTIC_QUIET_MS ? `[diagnostic omitted: ${toolRecordChars(value)} chars]` : value;
  }
}

export interface CanonicalAssistantEvent {
  role: "assistant";
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface CanonicalToolEvent {
  role: "tool";
  tool_call_id: string;
  content: unknown;
}

export type CanonicalPipeEvent = CanonicalAssistantEvent | CanonicalToolEvent;

export interface CanonicalProsaEvent {
  role: "assistant";
  content: string;
  intermediate: true;
}

export type CanonicalPipeRecord = CanonicalPipeEvent | CanonicalProsaEvent;

function contentBlocks(event: any): any[] {
  const content = event?.message?.content ?? event?.content;
  return Array.isArray(content) ? content : content ? [content] : [];
}

function assistantEventForToolUses(blocks: any[]): CanonicalAssistantEvent | null {
  const toolUses = blocks.filter((block) => block?.type === "tool_use");
  if (!toolUses.length) return null;

  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");

  return {
    role: "assistant",
    content: text || null,
    tool_calls: toolUses.map((block) => ({
      id: String(block.id ?? ""),
      type: "function" as const,
      function: {
        name: String(block.name ?? ""),
        arguments: JSON.stringify(block.input ?? {}),
      },
    })),
  };
}

function toolEventsForResults(blocks: any[]): CanonicalToolEvent[] {
  return blocks
    .filter((block) => block?.type === "tool_result")
    .map((block) => ({
      role: "tool" as const,
      tool_call_id: String(block.tool_use_id ?? ""),
      content: block.content,
    }));
}

export function pipeEventToCanonicalEvents(event: any): CanonicalPipeEvent[] {
  if (!event || typeof event !== "object") return [];

  if (event.type === "assistant") {
    const assistant = assistantEventForToolUses(contentBlocks(event));
    return assistant ? [assistant] : [];
  }

  if (event.type === "user") {
    return toolEventsForResults(contentBlocks(event));
  }

  if (event.type === "tool_use") {
    const assistant = assistantEventForToolUses([event]);
    return assistant ? [assistant] : [];
  }

  if (event.type === "tool_result") {
    return toolEventsForResults([event]);
  }

  return [];
}

function assistantTextOnly(event: any): string {
  const blocks = contentBlocks(event);
  if (blocks.some((block) => block?.type === "tool_use")) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Buffer text until another event proves it is intermediate prose.
// The caller logs the final answer, so forwarding it here would duplicate it.
export function createCanonicalPipeForwarder(
  sink: (evt: CanonicalPipeRecord) => void,
): { observe(event: any): void } {
  let pendingProsa: string | null = null;
  const flush = (): void => {
    if (pendingProsa !== null) {
      sink({ role: "assistant", content: pendingProsa, intermediate: true });
      pendingProsa = null;
    }
  };
  return {
    observe(event: any): void {
      if (!event || typeof event !== "object") return;
      if (event.type === "result") { pendingProsa = null; return; }
      const canonical = pipeEventToCanonicalEvents(event);
      if (canonical.length) {
        flush();
        for (const record of canonical) sink(record);
        return;
      }
      if (event.type === "assistant") {
        const text = assistantTextOnly(event);
        if (text) { flush(); pendingProsa = text; }
      }
    },
  };
}

export interface PipeRecycleDecision {
  recycle: boolean;
  fedTokens: number;
  threshold: number;
}

export function pipeRecycleDecision(fedTokens: number, threshold: number): PipeRecycleDecision {
  const safeFedTokens = Number.isFinite(fedTokens) ? Math.max(0, fedTokens) : 0;
  const safeThreshold = Number.isFinite(threshold) ? Math.max(0, threshold) : 0;
  return {
    recycle: safeFedTokens > safeThreshold,
    fedTokens: safeFedTokens,
    threshold: safeThreshold,
  };
}

export function claudePipeGcTokens(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BRAIN_PIPE_GC_TOKENS;
  if (raw === undefined || raw.trim() === "") return 150_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 150_000;
}

export function claudePipeGcHeadroom(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BRAIN_PIPE_GC_HEADROOM;
  if (raw === undefined || raw.trim() === "") return 40_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 40_000;
}

export function claudePipeGcCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = env.BRAIN_PIPE_GC_CEILING;
  if (raw === undefined || raw.trim() === "") return 172_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 172_000;
}

// A large initial prompt leaves too little working room under a fixed threshold, causing repeated recycling.
export function pipeGcEffectiveThreshold(
  baselineTokens: number | undefined,
  floor: number,
  headroom: number,
  ceiling: number,
): number {
  const safeFloor = Number.isFinite(floor) ? Math.max(0, floor) : 0;
  const safeCeiling = Number.isFinite(ceiling) ? Math.max(0, ceiling) : safeFloor;
  const base = Number.isFinite(baselineTokens) ? Math.max(0, baselineTokens as number) : 0;
  const raised = base > 0 ? Math.max(safeFloor, base + Math.max(0, headroom)) : safeFloor;
  return Math.min(raised, safeCeiling);
}

// Character estimates undercount tool-heavy content, so reported usage takes precedence.
export function pipeGcSnapshot(
  visibleChars: number,
  threshold: number,
  lastHopPromptTokens?: number,
): PipeRecycleDecision & { pending: boolean; basis: "usage" | "chars_estimate" } {
  const usageTokens = Number.isFinite(lastHopPromptTokens) ? Math.max(0, lastHopPromptTokens as number) : 0;
  const estimate = Number.isFinite(visibleChars) ? Math.ceil(Math.max(0, visibleChars) / 3.6) : 0;
  const basis: "usage" | "chars_estimate" = usageTokens > 0 ? "usage" : "chars_estimate";
  const fedTokens = basis === "usage" ? usageTokens : estimate;
  const decision = pipeRecycleDecision(fedTokens, threshold);
  return { ...decision, pending: decision.recycle, basis };
}

export function pipeRecycleAtTurnStart(pending: boolean, fedTokens: number, threshold: number): boolean {
  return pending || pipeRecycleDecision(fedTokens, threshold).recycle;
}
