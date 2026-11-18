import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findThoughts, parseThoughts, renderThoughts, sameThought, selectThoughts, thoughtCandidates,
  thoughtKey, thoughtQueries, thoughtSettings, type Thought,
} from "./inlet-thoughts.ts";

const heading = "## Thoughts (memory): your own earlier conclusions, the state of that moment, not the truth";
const event = (id = 101, score = 0.8, content = "Storage conclusion: use separate volumes", ts = "2025-04-02 12:30:00"): Thought => ({
  id, kind: "observation", ts, content, entity_name: "topic", _final_score: score,
});
const classification = {
  persons: ["speaker"], places: ["venue"], turn_category: "technical",
  rag_queries: [{ q: "storage query", cat: "technical" }],
};
type Options = {
  env?: Record<string, string>; root?: string; message?: string; cls?: any;
  events?: Record<string, any[]>; failure?: string; lookup?: any; placeLookup?: any; fallback?: string;
  temporal?: boolean; noMemory?: boolean; noClassifier?: boolean; unsetSwitch?: boolean;
};

// The classifier is redirected locally; memory and archive requests use real loopback HTTP.
async function run(options: Options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "inlet-thoughts-"));
  const calls: any[] = [];
  let thoughtCalls = 0;
  let archiveStarted!: () => void;
  const archiveReady = new Promise<void>(resolve => { archiveStarted = resolve; });
  let thoughtsStarted!: () => void;
  const thoughtsReady = new Promise<void>(resolve => { thoughtsStarted = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() as any : null;
      calls.push({ path: url.pathname, body, query: Object.fromEntries(url.searchParams) });
      if (url.pathname === "/classify") {
        if (options.failure === "classifier") return new Response("private failure", { status: 503 });
        return Response.json({ choices: [{ message: { content: JSON.stringify(options.cls ?? classification) } }] });
      }
      if (url.pathname === "/lookup") {
        const fallback = { card: { description: "entity context" }, recent: [], relations: [], canon: [] };
        return Response.json(url.searchParams.get("name") === "venue"
          ? options.placeLookup ?? options.lookup ?? fallback : options.lookup ?? fallback);
      }
      if (url.pathname === "/mcp") {
        if (body.params.arguments.kind !== "observation") {
          return Response.json({ result: { content: [{ type: "text", text: options.fallback ?? "Found 0 events" }] } });
        }
        const query = body.params.arguments.query;
        if (++thoughtCalls >= 2) thoughtsStarted();
        if (options.failure === "timeout") return await new Promise<Response>(() => {});
        if (options.failure === "body timeout") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"result":')); } }));
        if (options.failure === "http") return new Response("private failure", { status: 503 });
        if (options.failure === "envelope") return new Response("not json");
        if (options.failure === "rpc") return Response.json({ error: { message: "private failure" } });
        if (options.failure === "nonsense" || (options.failure === "partial" && query === "Discuss storage")) {
          return Response.json({ result: { content: [{ type: "text", text: "Found events without JSON" }] } });
        }
        // A sequential implementation cannot cross these barriers. No arrival-order
        // assumption or polling deadline: the normal test timeout bounds a deadlock.
        if (options.failure === "parallel") await archiveReady;
        const events = options.events ? options.events[query] ?? [] : [event()];
        return Response.json({ result: { content: [{ type: "text", text:
          "Found events:\n\n```json\n" + JSON.stringify({ events, archive_hits: [], total: events.length }) + "\n```",
        }] } });
      }
      if (url.pathname === "/search") {
        archiveStarted();
        if (options.failure === "parallel") await thoughtsReady;
        return Response.json({ results: [{ filename: "excerpt.md", chunkIndex: 0, score: 0.85,
          sources: ["rerank"], content: "archive context", date: "2025-04-02" }] });
      }
      if (url.pathname === "/files") return Response.json({ files: [{ filename: "excerpt.md", date: "2025-04-02", total_chunks: 1, themes: "day context" }] });
      if (url.pathname === "/expand") return Response.json({ results: [], vetoes: [] });
      return new Response("Unexpected route", { status: 404 });
    },
  });
  const preload = join(root, "offline.ts");
  writeFileSync(preload, `
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://openrouter.ai") return original(${JSON.stringify(server.url + "classify")}, init);
      if (url.hostname !== "127.0.0.1") throw new Error("External network disabled");
      return original(input, init);
    };
  `);
  const started = Date.now();
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload,
      join(import.meta.dir, "inlet-worker.ts"), options.message ?? "Discuss storage"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root,
        OPENROUTER_API_KEY: options.noClassifier ? "" : "offline",
        EMBERVY_API_KEY: options.noMemory ? "" : "offline", EMBERVY_URL: server.url.toString().replace(/\/$/, ""),
        RAG_URL: server.url.toString().replace(/\/$/, ""), ...(options.unsetSwitch ? {} : { INLET_THOUGHTS: "1" }),
        INLET_TEMPORAL: options.temporal ? "1" : "0", INLET_NOW: "2025-04-03T12:00:00Z",
        EMBERVY_TIMEZONE: "UTC", EMBERVY_STRINGS_LOCAL: join(root, "missing.json"), ...options.env },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    return { stdout, stderr, calls, elapsed: Date.now() - started };
  } finally {
    server.stop(true);
    if (!options.root) rmSync(root, { recursive: true, force: true });
  }
}
const searches = (result: Awaited<ReturnType<typeof run>>) => result.calls.filter(call => call.body?.params?.arguments?.kind === "observation");
// Compare multisets, not Sets: duplicate or extra requests must still fail.
const byQuery = (params: any[]) => [...params].sort((a, b) =>
  a.arguments.query < b.arguments.query ? -1 : a.arguments.query > b.arguments.query ? 1 : 0);

test("only the exact switch value enables recall; disabled output and logging remain byte-identical", async () => {
  const baseline = await run({ unsetSwitch: true });
  for (const value of ["", "0", "true", "on", " 1", "1 "]) {
    const off = await run({ env: { INLET_THOUGHTS: value } });
    expect(searches(off)).toEqual([]);
    expect(off.stdout).toBe(baseline.stdout);
    expect(off.stderr).toBe(baseline.stderr);
  }
  expect(baseline.stderr).toBe("");
  expect(searches(baseline)).toEqual([]);
});

test("enabled thoughts use the real MCP contract and appear between entity and archive blocks", async () => {
  const on = await run({ events: { "storage query": [event(101, 0.8, "  Storage conclusion:\n  use\t separate volumes  ")] }, failure: "parallel" });
  expect(on.stdout).toContain(`${heading}\n- Thought from 2025-04-02 (topic): Storage conclusion: use separate volumes [#101]`);
  expect(on.stdout.indexOf(heading)).toBeGreaterThan(on.stdout.indexOf("## Place: venue"));
  expect(on.stdout.indexOf(heading)).toBeLessThan(on.stdout.indexOf("## Chronicle (RAG)"));
  expect(on.stdout.lastIndexOf("## Sure about the people named")).toBeGreaterThan(on.stdout.indexOf("## Chronicle (RAG)"));
  expect(byQuery(searches(on).map(call => call.body.params))).toEqual(byQuery(["storage query", "Discuss storage"].map(query => ({
    name: "find", arguments: { query, limit: 6, kind: "observation", mode: "hybrid", recency_boost: false, touch: false },
  }))));
  const off = await run({ env: { INLET_THOUGHTS: "0" } });
  expect(on.stdout.replace(`${heading}\n- Thought from 2025-04-02 (topic): Storage conclusion: use separate volumes [#101]\n\n`, "")).toBe(off.stdout);
});

test("thoughts precede the time window too", async () => {
  const result = await run({ temporal: true, message: "What happened yesterday?" });
  expect(result.stdout).toContain("## Time window (RAG)");
  expect(result.stdout.indexOf(heading)).toBeLessThan(result.stdout.indexOf("## Time window (RAG)"));
});

test("the threshold is applied after the per-query agreement bonus", async () => {
  const low = await run({ events: { "storage query": [event(101, 0.53)] } });
  expect(low.stdout).not.toContain(heading);
  const agreement = await run({ events: { "storage query": [event(101, 0.53)], "Discuss storage": [event(101, 0.52)] } });
  expect(agreement.stdout).toContain("[#101]");
  expect(agreement.stderr).toContain('"score":0.56');
  const higher = await run({ events: { "storage query": [event(101, 0.53)], "Discuss storage": [event(101, 0.53)] }, env: { INLET_THOUGHTS_MIN: "0.57" } });
  expect(higher.stdout).not.toContain(heading);
});

test("the newest conclusion wins over the higher-scored earlier version", async () => {
  const result = await run({ events: { "storage query": [event(101, 0.95), event(102, 0.7, "Storage conclusion (revised): choose shared storage", "2025-05-01 09:00:00")] }, env: { INLET_THOUGHTS_MAX: "3" } });
  expect(result.stdout).toContain("[#102]");
  expect(result.stdout).not.toContain("[#101]");
});

for (const location of ["person", "place", "canon", "fallback"]) {
  test(`an observation already displayed in the ${location} block is excluded`, async () => {
    const options: Options = {};
    const lookup = { card: null, recent: [event()], relations: [] };
    if (location === "person") options.lookup = lookup;
    if (location === "place") options.placeLookup = lookup;
    if (location === "canon") options.lookup = { card: null, recent: [], canon: [event()] };
    if (location === "fallback") {
      options.placeLookup = { card: null, recent: [] };
      options.fallback = "Found 1 events:\n[101] 2025-04-02 (observation/1) topic: already shown";
    }
    expect((await run(options)).stdout).not.toContain(heading);
  });
}

test("the next turn suppresses the shown id and fills its slot, without colliding with archive keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "inlet-thought-turns-"));
  const counter = join(root, "counter"), directory = join(root, "cache");
  const env = { INLET_COUNTER_FILE: counter, INLET_CHUNK_CACHE_DIR: directory };
  const events = { "storage query": [event(), event(202, 0.7, "Medical finding: gentle exercise supports recovery")] };
  try {
    writeFileSync(counter, "10");
    const first = await run({ root, env, events });
    expect(first.stdout).toContain("[#101]");
    const saved = JSON.parse(readFileSync(join(directory, "chunks.json"), "utf8"));
    expect(saved.shown.map((entry: any) => entry[0]).sort()).toEqual(["excerpt.md#0", "thought:101"]);
    writeFileSync(counter, "11");
    const second = await run({ root, env, events });
    expect(second.stdout).not.toContain("[#101]");
    expect(second.stdout).toContain("[#202]");
    writeFileSync(counter, "52");
    expect((await run({ root, env, events })).stdout).toContain("[#101]");
    writeFileSync(counter, "broken");
    expect((await run({ root, env, events })).stdout).toContain("[#101]");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["nonsense", "envelope", "http", "rpc", "partial", "timeout", "body timeout"]) {
  test(`memory ${failure} removes only the optional block`, async () => {
    const off = await run({ env: { INLET_THOUGHTS: "0" } });
    const result = await run({ failure });
    expect(result.stdout).toBe(off.stdout);
    expect(result.stderr.trim()).toBe("[inlet/thoughts] queries=2 candidates=[]");
    if (failure.includes("timeout")) {
      expect(result.elapsed).toBeGreaterThanOrEqual(7900);
      expect(result.elapsed).toBeLessThan(11000);
    }
  }, 15000);
}

for (const options of [
  { message: "[gateway:silent] mechanical storage" }, { failure: "classifier" },
  { noClassifier: true }, { noMemory: true },
]) {
  test(`unavailable or mechanical recall makes no observation calls: ${JSON.stringify(options)}`, async () => {
    const result = await run(options);
    const off = await run({ ...options, env: { INLET_THOUGHTS: "0" } });
    expect(searches(result)).toEqual([]);
    expect(result.stdout).toBe(off.stdout);
    expect(result.stderr).toContain("[inlet/thoughts] queries=0 candidates=[]");
  });
}

test("calibration logs at most five numeric candidates and never message, query or event text", async () => {
  const marker = "SECRET_CALIBRATION_CANARY";
  const result = await run({ message: marker, cls: { ...classification, rag_queries: [{ q: marker + " query" }] },
    events: { [marker + " query"]: Array.from({ length: 7 }, (_, index) => event(101 + index, 0.9 - index * 0.01, marker)) } });
  expect(result.stderr).not.toContain(marker);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  const candidates = JSON.parse(result.stderr.trim().split("candidates=")[1]);
  expect(candidates).toHaveLength(5);
  expect(candidates.map((value: any) => value.id)).toEqual([101, 102, 103, 104, 105]);
  expect(candidates.every((value: any) => Object.keys(value).join(",") === "id,score")).toBe(true);
});

test("query categories override the turn, allowed queries are capped, and the raw message is bounded", () => {
  const message = "x".repeat(400);
  expect(thoughtQueries({ turn_category: "identity", rag_queries: [
    { q: "skip" }, { q: "technical", cat: "technical" }, { q: "skip", cat: "casual" },
    { q: "default", cat: "default" }, { q: "medical", cat: "medical" }, { q: "fourth", cat: "technical" },
  ] }, message)).toEqual(["technical", "default", "medical", "x".repeat(300)]);
  expect(thoughtQueries({ rag_queries: [{ q: "default" }] }, "message")).toEqual(["default", "message"]);
  expect(thoughtQueries({ turn_category: "medical", rag_queries: [{ q: "inherit" }] }, "message")).toEqual(["inherit", "message"]);
});

test("the worker applies category precedence and the three-query cap before sending MCP requests", async () => {
  const result = await run({ message: "m".repeat(400), cls: {
    persons: [], places: [], turn_category: "identity", rag_queries: [
      { q: "skip" }, { q: "technical", cat: "technical" },
      { q: "medical", cat: "medical" }, { q: "default", cat: "default" },
      { q: "fourth must not be sent", cat: "technical" },
    ],
  } });
  // HTTP arrival is unordered; selection, multiplicity and the cap are not.
  expect(searches(result).map(call => call.body.params.arguments.query).sort())
    .toEqual(["technical", "medical", "default", "m".repeat(300)].sort());
  const inherited = await run({ cls: { persons: [], places: [], turn_category: "casual", rag_queries: [{ q: "skip" }] } });
  expect(searches(inherited).map(call => call.body.params.arguments.query)).toEqual(["Discuss storage"]);
});

test("the complete query plan exists before the first call, independently of completion order", async () => {
  let callsStarted = false;
  const reads: string[] = [];
  const lateReads: string[] = [];
  const cls = { turn_category: "identity", rag_queries: [
    ["skip", undefined], ["technical", "technical"], ["medical", "medical"],
    ["default", "default"], ["fourth", "technical"],
  ].map(([q, cat]) => ({ cat, get q() {
    (callsStarted ? lateReads : reads).push(q!);
    return q!;
  } })) };
  const calls: string[] = [];
  const complete: (() => void)[] = [];
  let readsAtFirstCall: string[] = [];
  const pending = findThoughts(thoughtQueries(cls, "m".repeat(400)), query => {
    if (!callsStarted) {
      readsAtFirstCall = [...reads];
      callsStarted = true;
      // A lazily consumed classifier would now lose its remaining queries.
      cls.rag_queries.length = 0;
    }
    calls.push(query);
    return new Promise(resolve => complete.push(() => resolve({ result: { content: [{
      type: "text", text: '```json\n' + JSON.stringify({ events: [event(calls.indexOf(query) + 1)] }) + '\n```',
    }] } })));
  });
  expect(readsAtFirstCall).toEqual(["technical", "medical", "default"]);
  expect(lateReads).toEqual([]);
  expect(calls).toEqual(["technical", "medical", "default", "m".repeat(300)]);
  // Resolve all requests in reverse order, with no sleeps or network timing.
  for (const finish of complete.reverse()) finish();
  expect((await pending)?.map(batch => (batch[0] as Thought).id)).toEqual([1, 2, 3, 4]);
});

test("exclusion uses displayed event identities, not ID-like text or undisplayed observations", async () => {
  const result = await run({ lookup: {
    card: { description: "entity context" },
    canon: [{ ...event(999), content: "A reference to [#101] is not that event" }],
    recent: [...Array.from({ length: 5 }, (_, index) => event(index + 1)), event(101)],
  } });
  expect(result.stdout).toContain(heading);
  expect(result.stdout).toContain("- Thought from 2025-04-02 (topic): Storage conclusion: use separate volumes [#101]");
});

test("the worker honors the maximum and score ordering after selection", async () => {
  const result = await run({ env: { INLET_THOUGHTS_MAX: "8" }, events: { "storage query": [
    event(1, 0.6, "alpha"), event(2, 0.9, "bravo"), event(3, 0.8, "charlie"), event(4, 0.7, "delta"),
  ] } });
  expect([...result.stdout.matchAll(/^- Thought from .*\[#(\d+)\]/gm)].map(match => Number(match[1])))
    .toEqual([2, 3, 4]);
});

test("invalid events are ignored and duplicates in one response do not earn an agreement bonus", () => {
  const valid = event(1, 0.53);
  const invalid = [null, { ...valid, id: "1" }, { ...valid, kind: "note" }, { ...valid, content: " \n" },
    { ...valid, _final_score: "0.9" }, { ...valid, ts: "bad" }, { ...valid, id: NaN }];
  const candidates = thoughtCandidates([[...invalid, valid, valid], [{ ...valid, _final_score: 0.5 }]], new Set());
  expect(candidates).toHaveLength(1);
  expect(candidates[0]._final_score).toBe(0.56);
  expect(thoughtCandidates([[valid]], new Set([1]))).toEqual([]);
  expect(thoughtCandidates([[valid, valid]], new Set())[0]._final_score).toBe(0.53);
});

test("topic prefixes and word-set similarity cover differently worded versions", () => {
  expect(sameThought(event(1, 1, "Topic heading: alpha"), event(2, 1, "topic heading (beta)"))).toBe(true);
  expect(sameThought(event(1, 1, "alpha bravo charlie"), event(2, 1, "delta alpha bravo echo"))).toBe(true);
  expect(sameThought(event(1, 1, "alpha bravo charlie"), event(2, 1, "delta alpha echo foxtrot"))).toBe(false);
  expect(sameThought(event(1, 1, "tiny: a b"), event(2, 1, "tiny: c d"))).toBe(true);
  expect(sameThought(event(1, 1, "one: a b"), event(2, 1, "one: c d"))).toBe(false);
  expect(sameThought(event(1, 1, "a ".repeat(50)), event(2, 1, "a ".repeat(50)))).toBe(false);
});

test("settings bound the selected count and text formatting without a cache or entity name", () => {
  const events = [event(1, 0.9, "alpha"), event(2, 0.8, "bravo"), event(3, 0.7, "charlie"), event(4, 0.6, "delta")];
  for (const [raw, count] of [["0", 1], ["-2", 1], ["2", 2], ["9", 3], ["invalid", 1]] as const) {
    expect(selectThoughts(events, thoughtSettings({ INLET_THOUGHTS_MAX: raw }), () => false)).toHaveLength(count);
  }
  expect(thoughtSettings({ INLET_THOUGHTS_MIN: "invalid" }).min).toBe(0.55);
  expect(thoughtSettings({ INLET_THOUGHTS_MIN: "" }).min).toBe(0.55);
  expect(renderThoughts([{ ...event(1, 1, " x".repeat(1600)), entity_name: null }]))
    .toBe(`${heading}\n- Thought from 2025-04-02: ${"x ".repeat(750)} [#1]`);
  expect(thoughtKey(event())).not.toContain("#");
});

test("structured memory parsing rejects missing JSON and accepts the product's fenced response", () => {
  expect(() => parseThoughts({ result: { content: [{ type: "text", text: "Found 0 events" }] } })).toThrow();
  expect(parseThoughts({ result: { content: [{ type: "text", text: 'Found 0 events:\n\n```json\n{"events":[]}\n```' }] } })).toEqual([]);
});
