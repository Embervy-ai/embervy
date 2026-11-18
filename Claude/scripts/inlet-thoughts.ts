// Optional observation recall, kept separate from archive ranking and rendering.
export type Thought = {
  id: number; ts: string; kind: "observation"; content: string;
  entity_name?: string | null; _final_score: number;
};
type Query = { q: string; cat?: string };

export function thoughtQueries(cls: { rag_queries: Query[]; turn_category?: string } | null, message: string): string[] {
  if (!cls || message.startsWith("[gateway:silent")) return [];
  return [
    ...cls.rag_queries.filter(q => ["technical", "default", "medical"].includes(q.cat ?? cls.turn_category ?? "default"))
      .slice(0, 3).map(q => q.q),
    message.slice(0, 300),
  ];
}

export const THOUGHT_FIND_ARGS = {
  kind: "observation", mode: "hybrid", recency_boost: false, touch: false,
} as const;

export function parseThoughts(response: any): unknown[] {
  if (response?.error || response?.result?.isError) throw new Error("Memory search failed");
  for (const part of response?.result?.content ?? []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    for (const match of part.text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
      const data = JSON.parse(match[1]);
      if (Array.isArray(data?.events)) return data.events;
    }
  }
  throw new Error("Missing structured memory response");
}

export async function findThoughts(
  queries: string[], call: (query: string, signal: AbortSignal) => Promise<unknown>,
): Promise<unknown[][] | null> {
  if (!queries.length) return null;
  const signal = AbortSignal.timeout(8_000);
  try {
    return await Promise.all(queries.map(async query => parseThoughts(await call(query, signal))));
  } catch {
    // Partial batches would make ranking depend on which service request failed.
    return null;
  }
}

function isThought(value: any): value is Thought {
  return value?.kind === "observation" && typeof value.id === "number" && Number.isFinite(value.id) &&
    typeof value.content === "string" && !!value.content.trim() &&
    typeof value.ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.ts) && Number.isFinite(Date.parse(value.ts)) &&
    typeof value._final_score === "number" && Number.isFinite(value._final_score);
}

export function thoughtCandidates(batches: unknown[][], excluded: Set<number>): Thought[] {
  const merged = new Map<number, { thought: Thought; count: number }>();
  for (const batch of batches) {
    const perQuery = new Map<number, Thought>();
    for (const event of batch) {
      if (!isThought(event) || excluded.has(event.id)) continue;
      const previous = perQuery.get(event.id);
      if (!previous || event._final_score > previous._final_score) perQuery.set(event.id, event);
    }
    for (const event of perQuery.values()) {
      const previous = merged.get(event.id);
      merged.set(event.id, {
        thought: previous && previous.thought._final_score > event._final_score ? previous.thought : event,
        count: (previous?.count ?? 0) + 1,
      });
    }
  }
  return [...merged.values()].map(({ thought, count }) => ({
    ...thought, _final_score: thought._final_score + 0.03 * (count - 1),
  })).sort((a, b) => b._final_score - a._final_score || a.id - b.id);
}

function topic(text: string): string | null {
  const prefix = text.split(/[(:\r\n]/, 1)[0].trim().toLowerCase();
  return prefix.length >= 8 && prefix.length <= 80 ? prefix : null;
}
function words(text: string): Set<string> {
  return new Set(text.slice(0, 400).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}
export function sameThought(a: Thought, b: Thought): boolean {
  const prefix = topic(a.content);
  if (prefix !== null && prefix === topic(b.content)) return true;
  const left = words(a.content), right = words(b.content);
  const intersection = [...left].filter(word => right.has(word)).length;
  const union = left.size + right.size - intersection;
  return union > 0 && intersection / union >= 0.4;
}

export function thoughtSettings(env: Record<string, string | undefined>): { min: number; max: number } {
  const min = Number(env.INLET_THOUGHTS_MIN ?? 0.55);
  const max = Number(env.INLET_THOUGHTS_MAX ?? 1);
  return {
    min: env.INLET_THOUGHTS_MIN?.trim() === "" || !Number.isFinite(min) ? 0.55 : min,
    max: Number.isFinite(max) ? Math.max(1, Math.min(3, Math.floor(max))) : 1,
  };
}

// Archive keys always contain '#'; these keys never do, so the namespaces cannot collide.
export const thoughtKey = (thought: Thought): string => `thought:${thought.id}`;

export function selectThoughts(candidates: Thought[], settings: { min: number; max: number }, recent: (key: string) => boolean): Thought[] {
  const newest = candidates.filter(event => event._final_score >= settings.min)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.id - a.id);
  const distinct: Thought[] = [];
  for (const event of newest) {
    if (!distinct.some(other => sameThought(event, other))) distinct.push(event);
  }
  // Do not revive an older conclusion just because the newer one was recently shown.
  return distinct.filter(event => !recent(thoughtKey(event)))
    .sort((a, b) => b._final_score - a._final_score || a.id - b.id).slice(0, settings.max);
}

export function renderThoughts(events: Thought[]): string {
  if (!events.length) return "";
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  return "## Thoughts (memory): your own earlier conclusions, the state of that moment, not the truth\n" +
    events.map(event => {
      const entity = typeof event.entity_name === "string" ? flat(event.entity_name) : "";
      return `- Thought from ${event.ts.slice(0, 10)}${entity ? ` (${entity})` : ""}: ${flat(event.content).slice(0, 1500)} [#${event.id}]`;
    }).join("\n");
}

export function thoughtCalibration(queries: number, candidates: Thought[]): string {
  return `[inlet/thoughts] queries=${queries} candidates=${JSON.stringify(candidates.slice(0, 5).map(event => ({ id: event.id, score: event._final_score })))}`;
}
