import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const notice = "(Memory search ran without its query step this turn; results come from the raw message and may be less precise.)";
const valid = JSON.stringify({ persons: [], places: [], rag_queries: [{ q: "classified query", cat: "technical" }] });
const empty = { content: "", provider: "X", finish: "length" };
type Reply = { content?: unknown; provider?: unknown; finish?: string; status?: number; error?: string; envelope?: boolean };
type Options = { replies?: Reply[]; env?: Record<string, string>; elapsed?: number; aborted?: boolean };

// Like the worker context tests, run the real worker with a fetch preload, never a live service.
async function run(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "inlet-retry-"));
  const capture = join(root, "calls.json");
  const preload = join(root, "offline.ts");
  writeFileSync(preload, `
    import { writeFileSync } from "node:fs";
    const options = ${JSON.stringify(options)};
    const replies = options.replies ?? [{ content: ${JSON.stringify(valid)}, provider: "Y", finish: "stop" }];
    const calls = [], timeouts = [];
    let attempts = 0, clock = 0, firstSignal;
    Object.defineProperty(performance, "now", { value: () => clock });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const controller = new AbortController();
    AbortSignal.timeout = (ms) => {
      timeouts.push(ms);
      return ms === 15000 ? controller.signal : originalTimeout(ms);
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const classifier = url.pathname.endsWith("/completions");
      if (classifier && !firstSignal) firstSignal = init.signal;
      calls.push({ url: String(input), path: url.pathname, body,
        authorization: init?.headers?.Authorization,
        sameSignal: classifier ? init.signal === firstSignal : undefined });
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ calls, timeouts }));
      if (classifier) {
        const reply = replies[Math.min(attempts++, replies.length - 1)];
        if (attempts === 1) {
          clock = options.elapsed ?? 0;
          if (options.aborted) controller.abort();
        }
        if (reply.error) throw new DOMException("PRIVATE ERROR", reply.error);
        if (reply.status) return new Response("PRIVATE BODY", { status: reply.status });
        if (reply.envelope) return new Response("PRIVATE ENVELOPE");
        return Response.json({ provider: reply.provider, choices: [{ finish_reason: reply.finish,
          message: { content: reply.content, reasoning: "PRIVATE REASONING" } }] });
      }
      if (url.origin === "https://rag.test" && url.pathname === "/search")
        return Response.json({ results: [{ filename: "sample.md", chunkIndex: 0, score: 0.9,
          sources: ["rerank"], content: "retrieved context" }] });
      throw new Error("Unexpected offline route: " + url);
    };
  `);
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload,
      join(import.meta.dir, "inlet-worker.ts"), "raw message"], {
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: root,
        OPENROUTER_API_KEY: "offline-key", RAG_URL: "https://rag.test",
        INLET_TEMPORAL: "0", INLET_EXPAND: "0", ...options.env },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    const { calls, timeouts } = JSON.parse(readFileSync(capture, "utf8"));
    const requests = calls.filter((call: any) => call.path.endsWith("/completions"));
    return { stdout, stderr, requests, calls, timeouts };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function logs(stderr: string) {
  const lines = stderr.trim().split("\n");
  for (const line of lines) {
    expect(line).toMatch(/^\[inlet\/classifier\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(line).not.toContain("PRIVATE");
    expect(line).not.toContain("offline-key");
  }
  return lines;
}

function degraded(result: Awaited<ReturnType<typeof run>>) {
  expect(result.stdout.split("\n")[0]).toBe(notice);
  expect(result.stdout.split(notice)).toHaveLength(2);
  expect(result.stdout).toContain("retrieved context");
  expect(result.calls.find((call: any) => call.path === "/search").body.query).toBe("raw message");
  expect(logs(result.stderr).at(-1)).toEndWith("parse failure");
}

test("empty content retries once, excludes its provider and logs recovery without response text", async () => {
  const result = await run({ replies: [empty, { content: valid, provider: "Y", finish: "stop" }] });
  expect(result.requests).toHaveLength(2);
  const [first, second] = result.requests;
  expect(first.body.provider).toBeUndefined();
  expect(second.body).toEqual({ ...first.body, provider: { ignore: ["X"] } });
  expect(first.body.model).toBe("qwen/qwen3.5-9b");
  expect(first.body.max_tokens).toBe(400);
  expect(first.body.temperature).toBe(0);
  expect(first.body.reasoning).toEqual({ enabled: false });
  expect(first.body.response_format).toEqual({ type: "json_object" });
  expect(second.authorization).toBe(first.authorization);
  expect(second.sameSignal).toBe(true);
  expect(result.timeouts.filter((ms: number) => ms === 15000)).toHaveLength(1);
  expect(result.stdout).not.toContain(notice);
  expect(result.calls.find((call: any) => call.path === "/search").body.query).toBe("classified query");
  const lines = logs(result.stderr);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEndWith('unusable response provider="X" finish_reason="length" reason="empty"');
  expect(lines[1]).toContain('recovered first_provider="X" provider="Y"');
});

test("two empty responses keep the existing notice and stop after two calls", async () => {
  const result = await run({ replies: [empty, { ...empty, provider: "Y" }] });
  expect(result.requests).toHaveLength(2);
  degraded(result);
  const lines = logs(result.stderr);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toEndWith('unusable response provider="X" finish_reason="length" reason="empty"');
  expect(lines[1]).toEndWith('unusable response provider="Y" finish_reason="length" reason="empty"');
  expect(result.stderr).not.toContain("recovered");
});

for (const content of [
  "{}",
  '{"rag_queries":[]}',
  JSON.stringify({ rag_queries: [null, 12, "  ", {}, { q: "\t" }, { q: 7 }], rag_query: "must not replace an array" }),
]) {
  test(`an object without usable queries retries and recovers: ${content}`, async () => {
    const result = await run({ replies: [{ content, provider: "X", finish: "stop" }, { content: valid, provider: "Y", finish: "stop" }] });
    expect(result.requests).toHaveLength(2);
    const [first, second] = result.requests;
    expect(first.body.provider).toBeUndefined();
    expect(second.body).toEqual({ ...first.body, provider: { ignore: ["X"] } });
    expect(second.sameSignal).toBe(true);
    expect(result.timeouts.filter((ms: number) => ms === 15000)).toHaveLength(1);
    expect(result.stdout).not.toContain(notice);
    expect(result.calls.find((call: any) => call.path === "/search").body.query).toBe("classified query");
    const lines = logs(result.stderr);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEndWith('unusable response provider="X" finish_reason="stop" reason="no_queries"');
    expect(lines[1]).toEndWith('recovered first_provider="X" provider="Y"');
  });
}

test("two empty objects log both providers and degrade after exactly two requests", async () => {
  const result = await run({ replies: [
    { content: "{}", provider: "X", finish: "stop" },
    { content: "{}", provider: "Y", finish: "stop" },
  ] });
  expect(result.requests).toHaveLength(2);
  expect(result.requests[1].body.provider).toEqual({ ignore: ["X"] });
  degraded(result);
  const lines = logs(result.stderr);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toEndWith('unusable response provider="X" finish_reason="stop" reason="no_queries"');
  expect(lines[1]).toEndWith('unusable response provider="Y" finish_reason="stop" reason="no_queries"');
  expect(result.stderr).not.toContain("recovered");
});

test("empty content followed by an empty object logs both unusable reasons", async () => {
  const result = await run({ replies: [empty, { content: "{}", provider: "Y", finish: "stop" }] });
  expect(result.requests).toHaveLength(2);
  degraded(result);
  const lines = logs(result.stderr);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toEndWith('unusable response provider="X" finish_reason="length" reason="empty"');
  expect(lines[1]).toEndWith('unusable response provider="Y" finish_reason="stop" reason="no_queries"');
  expect(result.stderr).not.toContain("recovered");
});

for (const content of [valid,
  JSON.stringify({ rag_queries: [null, "  ", " classified query "] }),
  JSON.stringify({ rag_query: " classified query " }),
]) {
  test(`a valid first response uses exactly one request: ${content}`, async () => {
    const result = await run({ replies: [{ content, provider: "Y", finish: "stop" }] });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].body.provider).toBeUndefined();
    expect(result.stdout).not.toContain(notice);
    expect(result.stderr).toBe("");
    expect(result.calls.find((call: any) => call.path === "/search").body.query).toBe("classified query");
  });
}

for (const configured of [" A, B, A, , ", " A, X, X, , "]) {
  test(`configured exclusions are trimmed and merged without duplicates: ${configured}`, async () => {
    const result = await run({ env: { INLET_PROVIDER_IGNORE: configured }, replies: [empty, { content: valid, provider: "Y" }] });
    expect(result.requests).toHaveLength(2);
    const initial = configured.includes("X") ? ["A", "X"] : ["A", "B"];
    expect(result.requests[0].body.provider).toEqual({ ignore: initial });
    expect(result.requests[1].body.provider).toEqual({ ignore: [...new Set([...initial, "X"])] });
  });
}

test("blank exclusions add no provider field", async () => {
  const result = await run({ env: { INLET_PROVIDER_IGNORE: " , , " } });
  expect(result.requests[0].body.provider).toBeUndefined();
});

for (const content of [null, "   ", "PRIVATE NON-JSON", "{PRIVATE INVALID JSON}", "null", "[]"]) {
  test(`unusable content retries without logging content: ${JSON.stringify(content)}`, async () => {
    const result = await run({ replies: [{ ...empty, content }, { content: valid, provider: "Y" }] });
    expect(result.requests).toHaveLength(2);
    expect(result.stdout).not.toContain(notice);
    expect(logs(result.stderr)[0]).toEndWith('unusable response provider="X" finish_reason="length" reason="empty"');
  });
}

test("missing provider retries with only configured exclusions", async () => {
  for (const ignore of ["", "A"]) {
    const result = await run({ env: { INLET_PROVIDER_IGNORE: ignore }, replies: [{ content: "" }, { content: valid }] });
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1].body).toEqual(result.requests[0].body);
    expect(result.requests[1].body.provider).toEqual(ignore ? { ignore: ["A"] } : undefined);
    expect(logs(result.stderr).at(-1)).toContain('recovered first_provider="unknown" provider="unknown"');
  }
});

for (const options of [{ elapsed: 14500 }, { elapsed: 15001 }, { aborted: true }]) {
  for (const content of ["", "{}"]) {
    test(`insufficient remaining budget or an aborted signal prevents retry: ${JSON.stringify(options)}, ${JSON.stringify(content)}`, async () => {
      const result = await run({ ...options, replies: [{ ...empty, content }] });
      expect(result.requests).toHaveLength(1);
      degraded(result);
      const lines = logs(result.stderr);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEndWith(`unusable response provider="X" finish_reason="length" reason="${content ? "no_queries" : "empty"}"`);
    });
  }
}

for (const [reply, reason] of [
  [{ status: 503 }, "status 503"], [{ error: "TimeoutError" }, "timeout"],
  [{ error: "AbortError" }, "timeout"], [{ error: "Error" }, "request failure"],
  [{ envelope: true }, "parse failure"],
] as [Reply, string][]) {
  test(`existing failure is not retried: ${JSON.stringify(reply)}`, async () => {
    const result = await run({ replies: [reply] });
    expect(result.requests).toHaveLength(1);
    expect(result.stdout).toContain(notice);
    expect(logs(result.stderr)).toHaveLength(1);
    expect(result.stderr.trim()).toEndWith(reason);
  });
}

test("a retry timeout uses the existing signal and timeout failure", async () => {
  const result = await run({ replies: [empty, { error: "TimeoutError" }] });
  expect(result.requests).toHaveLength(2);
  expect(result.requests[1].sameSignal).toBe(true);
  expect(result.timeouts.filter((ms: number) => ms === 15000)).toHaveLength(1);
  expect(result.stdout).toContain(notice);
  expect(logs(result.stderr).at(-1)).toEndWith("timeout");
  expect(result.stderr).not.toContain("recovered");
});
