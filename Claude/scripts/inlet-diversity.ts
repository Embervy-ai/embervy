// Diversifies and merges retrieved excerpts.
export type DiversityHit = {
  filename: string;
  chunkIndex: number;
  content: string;
  score?: number | null;
  sources?: string[];
  chunkIndexes?: number[];
};
type Options<T> = { enabled?: boolean; relevance?: (hit: T) => number };

export function pickDiverseHits<T extends DiversityHit>(
  hits: T[], options: Options<T> & { limit?: number; lambda?: number } = {},
): T[] {
  if (options.enabled === false) return hits;
  const limit = options.limit ?? 5;
  if (!hits.length || limit <= 0) return [];
  const score = options.relevance ?? ((hit: T) => hit.score ?? 0);
  const scores = hits.map(score);
  const low = Math.min(...scores), high = Math.max(...scores);
  const relevance = scores.map((value) => high === low ? 1 : (value - low) / (high - low));
  // Three-word shingles detect shared sentences without penalising a shared subject.
  const shingles = hits.map((hit) => {
    const words = hit.content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const size = Math.min(3, words.length);
    const result = new Set<string>();
    if (size) for (let i = 0; i <= words.length - size; i++) result.add(words.slice(i, i + size).join(" "));
    return result;
  });
  const similarity = (a: number, b: number): number => {
    if (hits[a].filename === hits[b].filename && Math.abs(hits[a].chunkIndex - hits[b].chunkIndex) === 1) return 1;
    let shared = 0;
    for (const word of shingles[a]) if (shingles[b].has(word)) shared++;
    const union = shingles[a].size + shingles[b].size - shared;
    return union ? shared / union : 0;
  };
  const picked = [0];
  const remaining = new Set(hits.map((_, i) => i).slice(1));
  while (picked.length < limit && remaining.size) {
    let best = -1, bestValue = -Infinity;
    for (const i of remaining) {
      const closest = Math.max(...picked.map((j) => similarity(i, j)));
      const value = relevance[i] - (options.lambda ?? 0.5) * closest;
      if (value > bestValue) { best = i; bestValue = value; }
    }
    picked.push(best);
    remaining.delete(best);
  }
  return picked.map((i) => hits[i]);
}

export function mergeAdjacentHits<T extends DiversityHit>(hits: T[], options: Options<T> = {}): T[] {
  if (options.enabled === false) return hits;
  const score = options.relevance ?? ((hit: T) => hit.score ?? 0);
  const files = new Map<string, T[]>();
  for (const hit of hits) {
    const list = files.get(hit.filename) ?? [];
    list.push(hit);
    files.set(hit.filename, list);
  }
  const position = new Map(hits.map((hit, i) => [hit, i]));
  const result: { hit: T; position: number }[] = [];
  for (const file of files.values()) {
    const ordered = [...file].sort((a, b) => a.chunkIndex - b.chunkIndex);
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && ordered[end].chunkIndex === ordered[end - 1].chunkIndex + 1) end++;
      const group = ordered.slice(start, end);
      if (group.length === 1) result.push({ hit: group[0], position: position.get(group[0])! });
      else {
        let content = group[0].content;
        let best = group[0];
        for (const next of group.slice(1)) {
          let overlap = Math.min(content.length, next.content.length);
          while (overlap >= 20 && !content.endsWith(next.content.slice(0, overlap))) overlap--;
          content += overlap >= 20 ? next.content.slice(overlap) : `\n\n${next.content}`;
          if ((next.score ?? 0) > (best.score ?? 0)) best = next;
        }
        // Trimming before the full merge would hide overlaps with later chunks.
        result.push({
          hit: {
            ...best, chunkIndex: group[0].chunkIndex,
            chunkIndexes: group.map((hit) => hit.chunkIndex), content: content.slice(0, 900),
            sources: [...new Set(group.flatMap((hit) => hit.sources ?? []))],
          },
          position: Math.min(...group.map((hit) => position.get(hit)!)),
        });
      }
      start = end;
    }
  }
  return result.sort((a, b) => score(b.hit) - score(a.hit) || a.position - b.position).map((entry) => entry.hit);
}
