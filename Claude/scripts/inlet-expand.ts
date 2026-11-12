/** Used by the Claude inlet worker, which Brain can run too. No model dependency. */
import { contextLine } from "../../shared/scripts/context-text";
export type ChunkRef = { filename: string; chunkIndex: number };
type Hit = ChunkRef & { content: string; score?: number | null; sources?: string[]; edge?: string; via?: string };
type Veto = { src: string; dst: string; type: "CORRECTED_BY" | "SUPERSEDED_BY"; note?: string | null; dst_content?: string | null };

const key = (r: ChunkRef) => `${r.filename}_chunk_${r.chunkIndex}`;
const ref = (r: ChunkRef): ChunkRef => ({ filename: r.filename, chunkIndex: r.chunkIndex });
const validRef = (r: any): boolean => !!r && typeof r.filename === "string" &&
  /^[A-Za-z0-9._-]+\.md$/.test(r.filename) && Number.isInteger(r.chunkIndex) && r.chunkIndex >= 0;

export async function expandInletHits(
  top: Hit[], known: Hit[], query: string, url: string, token: string,
): Promise<{ hits: Hit[]; vetoes: Map<string, Veto[]> }> {
  const vetoes = new Map<string, Veto[]>();
  const fallback = { hits: top, vetoes };
  if (/^(0|off|false)$/i.test(process.env.INLET_EXPAND?.trim() || "") || !top.length) return fallback;
  const anchors = top.filter(validRef).slice(0, 3);
  if (!anchors.length) return fallback;
  // One shared deadline, including body reads and the optional veto-only call.
  // Classifier (15s) + search (8s) + expansion (1s) stay below the 25s hook cap.
  const signal = AbortSignal.timeout(1_000);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  async function request(body: object): Promise<any | null> {
    try {
      const res = await fetch(`${url}/expand`, {
        method: "POST", headers, body: JSON.stringify(body), signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === "object" ? data : null;
    } catch { return null; }
  }
  function collect(data: any, requested: ChunkRef[]) {
    const allowed = new Set(requested.map(key));
    for (const v of Array.isArray(data?.vetoes) ? data.vetoes : []) {
      if (!v || !allowed.has(v.src) || typeof v.dst !== "string" ||
          !["CORRECTED_BY", "SUPERSEDED_BY"].includes(v.type)) continue;
      const list = vetoes.get(v.src) ?? [];
      if (list.some((old) => old.dst === v.dst && old.type === v.type)) continue;
      if (list.length < 2) list.push({
        src: v.src, dst: v.dst, type: v.type,
        note: typeof v.note === "string" ? v.note : null,
        dst_content: typeof v.dst_content === "string" ? v.dst_content : null,
      });
      vetoes.set(v.src, list);
    }
  }
  const data = await request({
    anchors: anchors.map(ref), query,
    exclude: known.filter(validRef).slice(0, 200).map(ref),
    veto_for: top.filter(validRef).map(ref),
  });
  if (!data) return fallback;
  // Veto collection is independent of result validity and of reranker scores.
  collect(data, top);
  const seen = new Set(known.map(key));
  const candidates: Hit[] = [];
  for (const r of Array.isArray(data.results) ? data.results : []) {
    if (!validRef(r) || typeof r.content !== "string" || !r.content.trim() ||
        !["NEXT", "PREV", "SAME_EPISODE"].includes(r.edge) || seen.has(key(r))) continue;
    seen.add(key(r));
    candidates.push({
      ...ref(r), content: r.content,
      score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : null,
      sources: ["edge", r.edge], edge: r.edge,
    });
  }
  // /expand returns all neighbours before episode hits. Reserve one slot for
  // each kind when available, otherwise episode context would always starve.
  const additions = [
    candidates.find((r) => r.edge !== "SAME_EPISODE"),
    candidates.find((r) => r.edge === "SAME_EPISODE"),
  ].filter((r): r is Hit => !!r);
  for (const r of candidates) {
    if (additions.length === 2) break;
    if (!additions.includes(r)) additions.push(r);
  }
  if (!additions.length) return fallback;
  // Preserve the strongest three search hits; use at most two contextual slots.
  // Do not compare unscored neighbours or ambiguous episode RRF/rerank scores
  // with search confidence. Fill unused slots from the original search order.
  const hits = [...top.slice(0, 3), ...additions, ...top.slice(3)].slice(0, 5);
  // Newly included chunks can themselves be outdated. Query only their vetoes,
  // without another graph/episode expansion, within the SAME time budget.
  const extra = await request({
    anchors: additions.map(ref), veto_for: additions.map(ref),
    neighbors: 0, episodeTopK: 0,
  });
  collect(extra, additions);
  return { hits, vetoes };
}

export function renderInletVetoes(hit: ChunkRef, vetoes: Map<string, Veto[]>): string {
  const lines = (vetoes.get(key(hit)) ?? []).map((v) => {
    const target = contextLine(v.dst.replace(/_chunk_(\d+)$/, "#$1"), 200);
    const text = contextLine(v.note || v.dst_content || "", 300);
    return `⚠ ${v.type === "CORRECTED_BY" ? "Corrected by" : "Superseded by"} → ${target}${text ? `: ${text}` : ""}`;
  });
  return lines.length ? `\n${lines.join("\n")}` : "";
}
