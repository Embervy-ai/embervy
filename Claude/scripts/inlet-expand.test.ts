import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const query = "deployment decision";
const anchor = { filename: "Session_1_part01.md", chunkIndex: 4, content: "Original statement", score: 0.8, sources: ["bm25", "rerank"] };
const neighbor = { filename: "Session_1_part02.md", chunkIndex: 0, content: "Next part context", edge: "NEXT", via: "Session_1_part01.md_chunk_4", hop: 1, score: null };
const episode = { ...neighbor, filename: "Session_2.md", content: "Episode context", edge: "SAME_EPISODE", score: 0.7 };
const veto = { src: "Session_1_part01.md_chunk_4", dst: "Session_3.md_chunk_2", type: "CORRECTED_BY", note: null, origin: "manual", dst_content: "The corrected statement" };
type RequestLog = { body: any; authorization: string | null };

async function run(worker: string, options: {
  hits?: any[]; switch?: string;
  expand?: (body: any) => Response | Promise<Response>;
} = {}) {
  const calls: RequestLog[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/search") return Response.json({ results: options.hits ?? [anchor] });
      if (path === "/expand") {
        const body = await req.json();
        calls.push({ body, authorization: req.headers.get("authorization") });
        return options.expand?.(body) ?? Response.json({ results: [], vetoes: [] });
      }
      return new Response("Unexpected request", { status: 500 });
    },
  });
  const proc = Bun.spawn([process.execPath, resolve(root, worker), query], {
    cwd: "/tmp",
    // No inherited API keys, no classifier call, no external network.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      RAG_URL: server.url.origin, RAG_AUTH_TOKEN: "test-token",
      EMBERVY_URL: server.url.origin, EMBERVY_API_KEY: "test-key",
      OPENROUTER_API_KEY: "",
      ...(options.switch === undefined ? {} : { INLET_EXPAND: options.switch }),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 4_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).toBe(0);
    return { stdout, stderr, calls };
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

for (const worker of ["Claude/scripts/inlet-worker.ts"]) {
  describe(`${worker}: graph expansion`, () => {
    test("default on: neighbours across parts and episode hits enter the block", async () => {
      const r = await run(worker, { expand: () => Response.json({ results: [neighbor, episode] }) });
      expect(r.stdout).toContain("Original statement");
      expect(r.stdout).toContain("Next part context");
      expect(r.stdout).toContain("Episode context");
      expect(r.stdout).toContain("context [edge+NEXT]");
      expect(r.stdout).toContain("[edge+SAME_EPISODE]");
      expect(r.calls[0]).toEqual({
        authorization: "Bearer test-token",
        body: {
          anchors: [{ filename: anchor.filename, chunkIndex: 4 }], query,
          exclude: [{ filename: anchor.filename, chunkIndex: 4 }],
          veto_for: [{ filename: anchor.filename, chunkIndex: 4 }],
        },
      });
      expect(r.calls[1].body).toMatchObject({ neighbors: 0, episodeTopK: 0 });
    });

    test("veto is immediately under the affected hit, even on RRF fallback", async () => {
      const r = await run(worker, {
        hits: [{ ...anchor, score: 0.016, sources: ["bm25"] }],
        expand: () => Response.json({ results: [], vetoes: [veto, veto] }),
      });
      expect(r.stdout).toContain("Original statement\n⚠ Corrected by → Session_3.md#2: The corrected statement");
      expect(r.stdout.match(/⚠/g)).toHaveLength(1);
    });

    test("new contextual hits get their own veto lookup and bounded warnings", async () => {
      const r = await run(worker, {
        expand: (body) => body.neighbors === 0
          ? Response.json({ vetoes: [{ ...veto, src: "Session_1_part02.md_chunk_0", type: "SUPERSEDED_BY", dst: "memory:42", note: "New\naccount " + "x".repeat(600) }] })
          : Response.json({ results: [neighbor] }),
      });
      expect(r.stdout).toContain("Next part context\n⚠ Superseded by → memory:42: New account ");
      expect(r.stdout).not.toContain("x".repeat(301));
      expect(r.calls[1].body.veto_for).toEqual([{ filename: neighbor.filename, chunkIndex: 0 }]);
    });

    test("404 leaves the exact old search block intact", async () => {
      const baseline = await run(worker, { switch: "0" });
      const r = await run(worker, { expand: () => new Response("missing", { status: 404 }) });
      expect(r.stdout).toBe(baseline.stdout);
      expect(r.calls).toHaveLength(1);
    });

    test("slow /expand fails open within the extra stage deadline", async () => {
      const baseline = await run(worker, { switch: "0" });
      const started = Date.now();
      const r = await run(worker, { expand: async () => {
        await Bun.sleep(1_500);
        return Response.json({ results: [neighbor] });
      } });
      expect(r.stdout).toBe(baseline.stdout);
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(r.calls).toHaveLength(1);
    });

    test("deadline also covers a response body that never finishes", async () => {
      const baseline = await run(worker, { switch: "0" });
      const r = await run(worker, { expand: () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"results":[')); },
      }), { headers: { "Content-Type": "application/json" } }) });
      expect(r.stdout).toBe(baseline.stdout);
      expect(r.calls).toHaveLength(1);
    });

    test("invalid JSON leaves the exact old search block intact", async () => {
      const baseline = await run(worker, { switch: "0" });
      const r = await run(worker, { expand: () => new Response("not json") });
      expect(r.stdout).toBe(baseline.stdout);
    });

    test("failed second lookup preserves first-response context and warnings", async () => {
      const r = await run(worker, { expand: (body) => body.neighbors === 0
        ? new Response("unavailable", { status: 503 })
        : Response.json({ results: [{ ...neighbor, edge: "PREV" }], vetoes: [veto] }),
      });
      expect(r.calls).toHaveLength(2);
      expect(r.stdout).toContain("Next part context");
      expect(r.stdout).toContain("context [edge+PREV]");
      expect(r.stdout).toContain("Original statement\n⚠ Corrected by");
    });

    test("malformed expansion cannot discard search hits or valid vetoes", async () => {
      const r = await run(worker, { expand: () => Response.json({ results: {}, vetoes: [null, { ...veto, type: "NEXT" }, veto] }) });
      expect(r.stdout).toContain("Original statement\n⚠ Corrected by");
      expect(r.stdout.match(/⚠/g)).toHaveLength(1);
    });

    test("no duplicates; five-hit / 500-character budget still applies", async () => {
      const hits = [anchor, anchor, ...Array.from({ length: 4 }, (_, i) => ({
        ...anchor, filename: `Session_${10 + i}.md`, content: `Search ${i}`, score: 0.7 - i * 0.1,
      }))];
      const longNeighbor = { ...neighbor, content: "N".repeat(600) };
      const r = await run(worker, { hits, expand: (body) => Response.json({
        results: body.neighbors === 0 ? [] : [{ ...anchor, edge: "PREV" }, longNeighbor, longNeighbor,
          { ...neighbor, chunkIndex: 1, edge: "PREV", content: "Second neighbour" }, episode, { ...episode, chunkIndex: 2 }],
      }) });
      expect(r.stdout.match(/Original statement/g)).toHaveLength(1);
      expect(r.stdout.match(/\[Session_/g)).toHaveLength(5);
      expect(r.stdout.match(/\[Session_1_part02.md\]/g)).toHaveLength(1);
      expect(r.stdout).toContain("N".repeat(500));
      expect(r.stdout).not.toContain("N".repeat(501));
      expect(r.stdout).toContain("Search 0");
      expect(r.stdout).toContain("Search 1");
      expect(r.stdout).not.toContain("Search 2");
      expect(r.stdout).toContain("Episode context");
      expect(r.stdout).not.toContain("Second neighbour");
      expect(r.calls[0].body.anchors).toHaveLength(3);
      expect(r.calls[0].body.veto_for).toHaveLength(5);
    });

    test("switch off means no /expand calls", async () => {
      for (const value of ["0", "off", "false"]) {
        const r = await run(worker, { switch: value });
        expect(r.calls).toHaveLength(0);
        expect(r.stdout).toBe("## Chronicle (RAG)\n[Session_1_part01.md] (80% [bm25+rerank])\nOriginal statement\n");
      }
    });

    test("suppressed search hits do not become expansion anchors", async () => {
      const r = await run(worker, { hits: [{ ...anchor, score: 0.1 }] });
      expect(r.calls).toHaveLength(0);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toContain("confidence gate suppressed");
    });
  });
}

test("Brain launches the configured worker with inherited inlet configuration", () => {
  const src = readFileSync(resolve(root, "Brain/brain.ts"), "utf8");
  expect(src).toContain('const INLET_WORKER = process.env.BRAIN_INLET_WORKER ?? ""');
  expect(src).toContain('Bun.spawn(["bun", INLET_WORKER, userText.slice(0, 4000), recent]');
  expect(src).toContain('env: { ...(process.env as Record<string, string>), INLET_COUNTER_FILE:');
  expect(readFileSync(resolve(root, "Claude/scripts/inlet-worker.ts"), "utf8")).toContain('from "./inlet-expand.ts"');
});
