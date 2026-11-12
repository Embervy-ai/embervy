import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mergeAdjacentHits, pickDiverseHits, type DiversityHit } from "./inlet-diversity.ts";

const hit = (filename: string, chunkIndex: number, content: string, score = 0.8): DiversityHit =>
  ({ filename, chunkIndex, content, score, sources: ["bm25", "rerank"] });
const shared = "The lantern stayed lit beside the open window.";
const pair = [
  hit("Session_1.md", 12, `We opened the gate. ${shared}`, 0.9),
  hit("Session_1.md", 13, `${shared} Then we closed the shutters.`, 0.85),
];

describe("adjacent excerpts", () => {
  test("the longest overlap is removed exactly once, with score and sources united", () => {
    const input = [pair[1], { ...pair[0], sources: ["vector", "rerank"] }];
    const result = mergeAdjacentHits(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filename: "Session_1.md", chunkIndex: 12, chunkIndexes: [12, 13], score: 0.9,
      content: `We opened the gate. ${shared} Then we closed the shutters.`,
      sources: ["vector", "rerank", "bm25"],
    });
    expect(input[0]).toBe(pair[1]);
    expect(input[1].content).toBe(pair[0].content);
  });

  test("no false overlap under twenty characters", () => {
    const result = mergeAdjacentHits([hit("s.md", 1, "First short overlap"), hit("s.md", 2, "short overlap last")]);
    expect(result[0].content).toBe("First short overlap\n\nshort overlap last");
  });

  test("exactly twenty characters is enough", () => {
    const overlap = "abcdefghijklmnopqrst";
    expect(mergeAdjacentHits([hit("s.md", 1, `A${overlap}`), hit("s.md", 2, `${overlap}B`)])[0].content)
      .toBe(`A${overlap}B`);
  });

  test("three adjacent chunks form one chain, even in reverse score order", () => {
    const second = "We counted the stars above the garden.";
    const result = mergeAdjacentHits([
      hit("s.md", 3, `${second} End.`, 0.9),
      hit("s.md", 1, `Start. ${shared}`, 0.7),
      hit("s.md", 2, `${shared} ${second}`, 0.8),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(`Start. ${shared} ${second} End.`);
    expect(result[0].chunkIndexes).toEqual([1, 2, 3]);
    expect(result[0].score).toBe(0.9);
  });

  test("non-adjacent chunks and different files stay separate", () => {
    const input = [hit("a.md", 1, "one"), hit("a.md", 3, "three"), hit("b.md", 2, "two")];
    expect(mergeAdjacentHits(input)).toEqual(input);
  });

  test("output order follows the best score of each excerpt", () => {
    const result = mergeAdjacentHits([hit("b.md", 0, "Other", 0.88), ...pair]);
    expect(result.map((r) => r.score)).toEqual([0.9, 0.88]);
  });

  test("ties retain input order rather than grouping by file", () => {
    const input = [hit("a.md", 1, "one"), hit("b.md", 0, "two"), hit("a.md", 4, "three")];
    expect(mergeAdjacentHits(input)).toEqual(input);
  });

  test("the chain is joined before its 900-character budget is applied", () => {
    const result = mergeAdjacentHits([
      hit("s.md", 0, "a".repeat(850) + shared),
      hit("s.md", 1, shared + "b".repeat(100)),
    ]);
    expect(result[0].content).toBe(("a".repeat(850) + shared + "b".repeat(100)).slice(0, 900));
    expect(result[0].content).toHaveLength(900);
    const single = hit("alone.md", 0, "s".repeat(1000));
    expect(mergeAdjacentHits([single])[0]).toBe(single);
  });

  test("unscored neighbours retain references and the scored anchor wins", () => {
    const result = mergeAdjacentHits([{ ...pair[1], score: null, sources: ["edge", "NEXT"] }, pair[0]]);
    expect(result[0].score).toBe(0.9);
    expect(result[0].chunkIndexes).toEqual([12, 13]);
    expect(result[0].sources).toEqual(["bm25", "rerank", "edge", "NEXT"]);
  });

  test("a supplied ordering key preserves the time boost", () => {
    const input = [hit("inside.md", 0, "Inside", 0.5), hit("outside.md", 0, "Outside", 0.6)];
    const relevance = (r: DiversityHit) => r.score! * (r.filename === "inside.md" ? 1.25 : 1);
    expect(mergeAdjacentHits(input, { relevance })).toEqual(input);
  });
});

const different = [
  "Copper kettles hang above warm kitchen tiles",
  "Wild foxes cross frozen mountain paths quietly",
  "Tiny sailboats drift beneath distant violet clouds",
  "Fresh software builds pass every automated check",
  "Old violins rest inside polished wooden cases",
  "Bright flowers grow around narrow village streets",
];
const candidates = () => [
  hit("a.md", 0, different[0], 0.9),
  hit("duplicate.md", 0, different[0] + " today", 0.89),
  ...different.slice(1).map((text, i) => hit(`other${i}.md`, 0, text, 0.88 - i * 0.01)),
  hit("last.md", 0, "Unrelated lower scoring candidate", 0.1),
];

describe("maximal marginal relevance", () => {
  test("a different session beats a near-duplicate with a slightly higher score", () => {
    const input = candidates();
    expect(pickDiverseHits(input)).toEqual([input[0], input[2], input[3], input[4], input[5]]);
  });

  test("a direct neighbour counts as similarity one even with different words", () => {
    const input = candidates();
    input[1] = hit("a.md", 1, "Entirely novel words describe another event", 0.89);
    expect(pickDiverseHits(input)).toEqual([input[0], input[2], input[3], input[4], input[5]]);
  });

  test("all different returns today's top five", () => {
    const input = different.map((text, i) => hit(`${i}.md`, 0, text, 0.9 - i * 0.01));
    expect(pickDiverseHits(input)).toEqual(input.slice(0, 5));
  });

  test("lambda zero keeps the relevance order", () => {
    const input = candidates();
    expect(pickDiverseHits(input, { lambda: 0 })).toEqual(input.slice(0, 5));
  });

  test("normalisation uses the supplied sort key, not displayed scores", () => {
    const input = [
      hit("inside.md", 0, different[0], 0.8),
      hit("outside.md", 0, different[0], 0.785),
      hit("other.md", 0, different[1], 0.78),
    ];
    const ranks = new Map([[input[0], 100], [input[1], 99], [input[2], 1]]);
    expect(pickDiverseHits(input)[1]).toBe(input[2]);
    expect(pickDiverseHits(input, { relevance: (r) => ranks.get(r)! })[1]).toBe(input[1]);
    expect(pickDiverseHits(input, { relevance: (r) => ranks.get(r)! * 12 + 7 })[1]).toBe(input[1]);
  });

  test("equal scores, short texts, punctuation and empty text are deterministic", () => {
    const input = [hit("a.md", 0, "HELLO, world!"), hit("b.md", 0, "hello world"), hit("c.md", 0, ""), hit("d.md", 0, "Novel")];
    expect(pickDiverseHits(input)).toEqual([input[0], input[2], input[3], input[1]]);
    expect(pickDiverseHits([])).toEqual([]);
    expect(pickDiverseHits(input, { limit: 0 })).toEqual([]);
  });

  test("the INLET_DIVERSITY=0 option returns the same input unchanged in both functions", () => {
    const input = [...pair, ...candidates()];
    expect(pickDiverseHits(input, { enabled: false })).toBe(input);
    expect(mergeAdjacentHits(input, { enabled: false })).toBe(input);
  });
});

const stubHits = [...pair, ...different.slice(1, 4).map((text, i) => hit(`Other_${i}.md`, 0, text + ".", 0.8 - i * 0.1))];
async function runStub(options: { enabled?: string; expandNeighbor?: boolean; long?: boolean; vetoes?: boolean; hits?: DiversityHit[] } = {}) {
  const calls: { path: string; body: any }[] = [];
  const hits = options.hits ?? (options.expandNeighbor ? stubHits.filter((r) => r !== pair[1]) : stubHits);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = await req.json();
      calls.push({ path, body });
      if (path === "/search") return Response.json({ results: options.long ? [
        hit("Long.md", 0, "a".repeat(600) + shared, 0.9),
        hit("Long.md", 1, shared + "b".repeat(600), 0.8),
        hit("Single.md", 0, "s".repeat(600), 0.7),
      ] : hits });
      if (path === "/expand") return Response.json({
        results: options.expandNeighbor && body.neighbors !== 0 ? [{ ...pair[1], edge: "NEXT", score: null }] : [],
        vetoes: options.vetoes ? body.veto_for.map((ref: any) => ({
          src: `${ref.filename}_chunk_${ref.chunkIndex}`, dst: `Correction.md_chunk_${ref.chunkIndex}`,
          type: ref.chunkIndex === 12 ? "CORRECTED_BY" : "SUPERSEDED_BY", note: `Warning for ${ref.chunkIndex}`,
        })) : [],
      });
      return new Response("Unexpected request", { status: 500 });
    },
  });
  const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, "inlet-worker.ts"), "archive context"], {
    cwd: "/tmp",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", RAG_URL: server.url.origin, RAG_AUTH_TOKEN: "test-token",
      OPENROUTER_API_KEY: "", INLET_TEMPORAL: "0",
      ...(options.enabled === undefined ? {} : { INLET_DIVERSITY: options.enabled }),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 4_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    return { stdout, calls };
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

describe("worker with a loopback RAG stub", () => {
  test("MMR selects five from the gated pool rather than slicing the relevance order", async () => {
    const input = candidates();
    input[input.length - 1].sources = ["bm25"];
    const on = await runStub({ hits: input });
    const off = await runStub({ hits: input, enabled: "0" });
    expect(on.stdout).not.toContain("[duplicate.md]");
    expect(on.stdout).toContain(`[${input[5].filename}]`);
    expect(on.stdout.match(/^\[/gm)).toHaveLength(5);
    expect(off.stdout).toContain("[duplicate.md]");
    expect(off.stdout).not.toContain(`[${input[5].filename}]`);
  });

  test("the confidence gate still rejects weak reranked hits but retains RRF fallback", async () => {
    const input = [
      hit("strong.md", 0, different[0], 0.8),
      hit("weak.md", 0, different[1], 0.19),
      { ...hit("fallback.md", 0, different[2], 0.016), sources: ["bm25"] },
    ];
    const { stdout, calls } = await runStub({ hits: input });
    expect(stdout).toContain("[strong.md]");
    expect(stdout).toContain("[fallback.md] (RRF 0.0160 [bm25])");
    expect(stdout).not.toContain("[weak.md]");
    expect(calls[1].body.anchors.map((r: any) => r.filename)).toEqual(["strong.md", "fallback.md"]);
  });

  test("two overlapping neighbours and three other hits render four excerpts without repeated sentences", async () => {
    const { stdout } = await runStub();
    expect(stdout).toBe("## Chronicle (RAG)\n" + [
      `[Session_1.md#12–13] (90% [bm25+rerank])\nWe opened the gate. ${shared} Then we closed the shutters.`,
      ...stubHits.slice(2).map((r) => `[${r.filename}] (${Math.round(r.score! * 100)}% [bm25+rerank])\n${r.content}`),
    ].join("\n\n---\n\n") + "\n");
    expect(stdout.match(/^\[/gm)).toHaveLength(4);
    for (const sentence of ["We opened the gate.", shared, "Then we closed the shutters.", ...stubHits.slice(2).map((r) => r.content)]) {
      expect(stdout.split(sentence)).toHaveLength(2);
    }
  });

  test("the off switch restores the exact original five-hit block and expansion inputs", async () => {
    const off = await runStub({ enabled: "0" });
    expect(off.stdout).toBe("## Chronicle (RAG)\n" + [...stubHits].sort((a, b) => b.score! - a.score!)
      .map((r) => `[${r.filename}] (${Math.round(r.score! * 100)}% [bm25+rerank])\n${r.content.slice(0, 500)}`)
      .join("\n\n---\n\n") + "\n");
    expect(off.stdout.split(shared)).toHaveLength(3);
    expect(off.calls[1].body.anchors).toEqual([pair[0], pair[1], stubHits[2]].map(({ filename, chunkIndex }) => ({ filename, chunkIndex })));
  });

  test("neighbours added by expansion merge and warnings from both chunks stay attached", async () => {
    const { stdout, calls } = await runStub({ expandNeighbor: true, vetoes: true });
    expect(stdout).toContain("[Session_1.md#12–13] (90% [bm25+rerank+edge+NEXT])");
    expect(stdout.split(shared)).toHaveLength(2);
    const merged = stdout.split("\n\n---\n\n")[0];
    expect(merged).toContain("⚠ Corrected by → Correction.md#12: Warning for 12");
    expect(merged).toContain("⚠ Superseded by → Correction.md#13: Warning for 13");
    expect(calls[2].body).toMatchObject({ neighbors: 0, episodeTopK: 0 });
  });

  test("warnings on both search neighbours remain under the merged excerpt", async () => {
    const { stdout } = await runStub({ vetoes: true });
    const merged = stdout.split("\n\n---\n\n")[0];
    expect(merged).toContain("Warning for 12");
    expect(merged).toContain("Warning for 13");
  });

  test("merged excerpts render up to 900 characters while singles stay at 500", async () => {
    const { stdout } = await runStub({ long: true });
    expect(stdout).toContain("[Long.md#0–1]");
    const mergedText = stdout.split("\n\n---\n\n")[0].split("\n").slice(2).join("\n");
    expect(mergedText).toHaveLength(900);
    expect(stdout).toContain("s".repeat(500));
    expect(stdout).not.toContain("s".repeat(501));
  });
});
