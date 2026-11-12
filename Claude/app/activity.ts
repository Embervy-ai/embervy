export type ActivityState = "idle" | "thinking" | "tool" | "done" | "needs_input";

export interface ActivityInput {
  paneText?: string;
  paneInMode?: boolean;
  processRunning?: boolean;
  paneChangedAt?: number;
  now?: number;
}

export interface ActivityEvent {
  ts: string;
  event: "turn_start" | "tool_start" | "tool_end" | "turn_end";
  tool?: string;
}

/** Returns null when hook events are absent, invalid, or older than ten minutes. */
export function classifyFromEvents(events: ActivityEvent[], now = Date.now()): ActivityState | null {
  const latest = events
    .map((event) => ({ event, at: Date.parse(event.ts) }))
    .filter(({ at }) => Number.isFinite(at) && at <= now)
    .sort((a, b) => a.at - b.at)
    .at(-1);
  if (!latest || now - latest.at > 10 * 60_000) return null;
  if (latest.event.event === "tool_start") return "tool";
  if (latest.event.event === "turn_start" || latest.event.event === "tool_end") return "thinking";
  return now - latest.at <= 15_000 ? "done" : "idle";
}

/** Combines hook primacy with the terminal-dialog override and TUI fallback. */
export function classifyObservedActivity(events: ActivityEvent[], input: ActivityInput, now = Date.now()): ActivityState {
  if (input.processRunning === false) return "idle";
  const tuiState = classifyActivity({ ...input, now });
  if (tuiState === "needs_input") return "needs_input";
  return classifyFromEvents(events, now) ?? tuiState;
}

const TOOL_LINE = /(?:^|\n)\s*(?:[⏺●]\s*)?(?:Bash|Read|Write|Edit|Glob|Grep|WebSearch|WebFetch|Task|Tool)\s*(?:\(|…|\.\.\.|:)/im;
const SPINNER_LINE = /(?:^|\n)\s*[✻✽✶✳✢·]\s*[^\n]+/gmu;
const SPINNER_DURATION = /\bfor\s+\d+\s*(?:ms|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hours?)(?:\s+\d+\s*(?:ms|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hours?))*/iu;
const FINISHED_VERB = /^\s*[✻✽✶✳✢·*]\s*\p{L}+ed\b/iu;
const DIALOG_ANSWER_LINE = /(?:^|\n)\s*(?:yes|no|y|n)\s*(?=\n|$)/im;
const EMPTY_PROMPT_LINE = /(?:^|\n)\s*(?:❯|>)\s*[\s\u00a0]*(?=\n|$)/m;

function lastMatchIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  let last = -1;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) last = match.index;
  return last;
}

function latestNeedsInputIndex(text: string): number {
  return Math.max(
    lastMatchIndex(text, /do you want to[\s\S]{0,500}?(?:\by\s*\/\s*n\b|yes\s*\/\s*no|allow|deny)/i),
    lastMatchIndex(text, /trust this folder\??|use (?:the )?(?:up and down )?arrow keys|select (?:an?|one) (?:option|answer)|choose (?:an?|one) (?:option|answer)/i),
    lastMatchIndex(text, /(?:^|\n)\s*[❯>]\s*(?:\[[ x]\]|\d+[.)])\s+.+\n\s*(?:\[[ x]\]|\d+[.)])\s+/m),
  );
}

function latestSpinnerIndexes(text: string): { active: number; finished: number } {
  let active = -1;
  let finished = -1;
  for (const match of text.matchAll(SPINNER_LINE)) {
    const line = match[0];
    const isInterruptible = /esc to interrupt/i.test(line);
    const hasDuration = SPINNER_DURATION.test(line);
    const hasFinishedVerb = FINISHED_VERB.test(line);
    if (isInterruptible || (!hasDuration && !hasFinishedVerb)) active = match.index;
    else finished = match.index;
  }
  return { active, finished };
}

/** Classifies an observed terminal snapshot without performing I/O. */
export function classifyActivity(input: ActivityInput): ActivityState {
  const text = input.paneText ?? "";
  if (input.processRunning === false) return "idle";

  const tail = text.slice(-4000);
  const needsInputAt = latestNeedsInputIndex(tail);
  const toolAt = lastMatchIndex(tail, TOOL_LINE);
  const { active: thinkingAt, finished: finishedThinkingAt } = latestSpinnerIndexes(tail);
  const dialogAnswerAt = lastMatchIndex(tail, DIALOG_ANSWER_LINE);
  const promptAt = lastMatchIndex(tail, EMPTY_PROMPT_LINE);
  const latestActiveAt = Math.max(toolAt, thinkingAt);
  if (needsInputAt > Math.max(latestActiveAt, dialogAnswerAt, promptAt)) return "needs_input";

  // The input stays visible during work; only a newer finished spinner ends it.
  // The interrupt hint can live in the footer instead of on the spinner line.
  const interruptibleFooter = tail.split("\n").filter((line) => line.trim()).slice(-5)
    .some((line) => /esc to interrupt/i.test(line));
  if (thinkingAt > finishedThinkingAt || interruptibleFooter) {
    return toolAt >= 0 && toolAt >= thinkingAt ? "tool" : "thinking";
  }

  // The terminal renders status/footer lines below the input row, so an empty
  // prompt does not need to be the final non-empty line in the snapshot.
  if (promptAt > Math.max(toolAt, thinkingAt, needsInputAt)) {
    const now = input.now ?? Date.now();
    if (input.paneChangedAt && now - input.paneChangedAt <= 15_000) return "done";
    return "idle";
  }

  if (finishedThinkingAt > latestActiveAt) {
    const now = input.now ?? Date.now();
    return input.paneChangedAt && now - input.paneChangedAt <= 15_000 ? "done" : "idle";
  }
  if (latestActiveAt === toolAt && toolAt >= 0) return "tool";
  if (thinkingAt >= 0) return "thinking";
  return "idle";
}
