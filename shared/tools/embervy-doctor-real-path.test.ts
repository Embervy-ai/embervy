import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));
const doctorPath = join(import.meta.dir, "embervy-doctor.ts");
const health = {
  version: "1.0.0", hot_count: 1, archive_count: 2, unresolved_observations: 0,
  daemon_last_run: null, daemon_last_ok: false, dream_last_run: null,
  daemon_mode: "normal", backlog_cursor: 0, warnings: ["daemon never ran"],
};
const tools = { jsonrpc: "2.0", id: 1, result: { tools: [
  { name: "find", description: "Find events", inputSchema: { type: "object", properties: {} } },
] } };
const files = { files: [{ name: "Session_1.md", size: 100, uploaded: "2026-01-01T00:00:00.000Z" }] };
// Past the young-archive threshold, where an empty probe is a real warning.
const grownArchive = { files: Array.from({ length: 25 }, (_, i) => ({ name: `Session_${i + 1}.md`, size: 100, uploaded: "2026-01-01T00:00:00.000Z" })) };
const index = "RAG API\n\nEndpoints:\nPOST /upload\nPOST /search\nPOST /delete\nPOST /delete-memory-edges\nGET /list\nGET /files\nGET /head\nGET /original\nPOST /fts-backfill\nPOST /expand\nGET /chunk\nPOST /graph-backfill\nPOST /edge\nGET /edges";
const hit = "## Chronicle (RAG)\n[Session_1.md] (85% [vector+bm25+rerank])\nRetrieved text";
type Check = { id: string; status: string; detail: string };
type Options = {
  offline?: boolean; env?: Record<string, string>; health?: unknown; tools?: unknown;
  files?: unknown; index?: unknown; unauth?: number; adapter?: unknown; adapterStatus?: number;
  inlet?: string; inletStatus?: number | null;
  canary?: string; canaryStatus?: number | null; canaryError?: string; failHttp?: number;
};

// The executable must run in a child because it exits the process.
function run(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "doctor-real-path-"));
  homes.push(home);
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "inlet.ts"), "");
  const state = { health, tools, files, index, unauth: 401, adapter: { ok: true }, adapterStatus: 200,
    inlet: hit, inletStatus: 0, canary: "OK", canaryStatus: 0, ...options };
  const runner = join(home, "stub.ts");
  const callsPath = join(home, "calls.json");
  const cli = (name: string, output: string, status: number | null, version = false) => {
    const outputPath = join(home, name + ".out");
    writeFileSync(outputPath, output);
    const versionCheck = version ? '[ "$1" = "--version" ] && { echo "fake build"; exit 0; }\n' : "";
    writeFileSync(join(home, "bin", name), `#!/bin/sh\n${versionCheck}/bin/cat '${outputPath}'\n${status === null ? "kill -TERM $$" : `exit ${status}`}\n`, { mode: 0o755 });
  };
  cli("bun", state.inlet, state.inletStatus);
  if (state.canaryError !== "ENOENT") cli("claude", state.canary, state.canaryStatus, true);
  writeFileSync(join(home, "bin", "systemctl"), '#!/bin/sh\nprintf "LoadState=not-found\\nActiveState=inactive\\n"\n', { mode: 0o755 });
  writeFileSync(runner, `
import { writeFileSync } from "node:fs";
const state = ${JSON.stringify(state)};
const calls = [];
function log(call) { calls.push(call); writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls)); }
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  log({ url, ...init, signal: undefined });
  const auth = init.headers?.Authorization;
  if (u.hostname === "127.0.0.1") return Response.json(state.adapter, { status: state.adapterStatus });
  if (state.failHttp) return new Response("failed", { status: state.failHttp });
  if (u.pathname === "/health") return Response.json(state.health);
  if (!auth) return new Response("<html>unexpected</html>", { status: state.unauth, headers: { Location: "https://unexpected.invalid/" } });
  if (u.hostname === "memory.invalid") {
    const rpc = JSON.parse(init.body);
    if (rpc.method === "tools/list") return Response.json(state.tools);
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [] } });
  }
  if (u.pathname === "/") return typeof state.index === "string" ? new Response(state.index) : Response.json(state.index);
  if (u.pathname === "/list") return Response.json(state.files);
  // Content-dependent checks need a usable topic before their output can be judged.
  if (u.pathname === "/head") return Response.json({ head: "THEMES=orchard pruning and harvest planning" });
  if (u.pathname === "/search") return Response.json({ mode: "hybrid", counts: { vector: 1, bm25: 1 }, reranked: true, results: [{ sources: ["rerank"] }] });
  throw new Error("unexpected URL " + url);
};
await import(${JSON.stringify(doctorPath)});
`);
  const child = Bun.spawnSync([process.execPath, runner, "--json", ...(options.offline ? ["--offline"] : [])], {
    cwd: home, stdout: "pipe", stderr: "pipe",
    env: { HOME: home, PATH: join(home, "bin"), EMBERVY_HOME: home, INLET_SCRIPT: join(home, "inlet.ts"),
      EMBERVY_URL: "https://memory.invalid", EMBERVY_API_KEY: "memory-test-key",
      RAG_URL: "https://rag.invalid", RAG_AUTH_TOKEN: "rag-test-key",
      APP_PASSWORD: "configured-test-password", APP_SESSION_SECRET: "s".repeat(48), ...options.env,
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
  });
  expect(child.stderr.toString()).toBe("");
  const report = JSON.parse(child.stdout.toString()) as { checks: Check[] };
  const calls = JSON.parse(readFileSync(callsPath, "utf8")) as any[];
  return { check: (id: string) => { const check = report.checks.find(c => c.id === id); expect(check).toBeDefined(); return check!; }, calls };
}

test("row 1: offline credentials are set but not checked; missing credentials and URLs still fail", () => {
  const present = run({ offline: true });
  for (const id of ["memory.key", "rag.token"]) {
    expect(present.check(id).status).toBe("SKIP");
    expect(present.check(id).detail).toBe("set, not checked — offline");
  }
  expect(present.calls.some(call => call.url?.includes(".invalid"))).toBe(false);
  const missing = run({ offline: true, env: { EMBERVY_API_KEY: "", RAG_AUTH_TOKEN: "", EMBERVY_URL: "", RAG_URL: "" } });
  for (const id of ["memory.key", "rag.token", "memory.url", "rag.url", "health.defaults", "adapter.doc"]) expect(missing.check(id).status).toBe("FAIL");
  expect(missing.check("adapter.hook").status).toBe("WARN");
  expect(run({ offline: true, env: { INLET_SCRIPT: "/nonexistent/doctor-inlet.ts" } }).check("inlet").status).toBe("FAIL");
  const noUrl = run({ env: { EMBERVY_URL: "", RAG_URL: "" } });
  for (const id of ["memory.url", "rag.url"]) expect(noUrl.check(id).status).toBe("FAIL");
  for (const id of ["memory.key", "rag.token", "sec.memory_unauth", "sec.rag_unauth"]) {
    expect(noUrl.check(id).status).toBe("SKIP");
    expect(noUrl.check(id).detail).toContain("not checked — no URL");
  }
});

for (const status of [401, 403, 200, 404, 302, 500, 503]) {
  test(`row 2: unauthenticated HTTP ${status} proves only explicit rejection`, () => {
    const report = run({ unauth: status });
    for (const id of ["sec.memory_unauth", "sec.rag_unauth"]) {
      const check = report.check(id);
      expect(check.status).toBe(status === 200 ? "FAIL" : [401, 403].includes(status) ? "OK" : "WARN");
      if (status === 200) expect(check.detail).toContain("fail-open");
      if (![200, 401, 403].includes(status)) expect(check.detail).toBe(`unexpected answer ${status}, auth not proven`);
    }
    expect(report.calls.filter(call => call.url?.includes(".invalid") && call.url !== "https://memory.invalid/health" && !call.headers?.Authorization)
      .every(call => call.redirect === "manual")).toBe(true);
  });
}

test("public memory liveness works without counters, while old workers remain supported", () => {
  expect(run({ health: { ok: true, version: "1.0.0" } }).check("memory.url").status).toBe("OK");
  for (const health of [{ ok: false, version: "1.0.0" }, { ok: true }, { version: "1.0.0" }]) {
    expect(run({ health }).check("memory.url").status).toBe("WARN");
  }
});

test("row 3: real endpoint contracts prove reachability and token validity", () => {
  const report = run();
  for (const id of ["memory.url", "memory.key", "rag.url", "rag.token"]) expect(report.check(id).status).toBe("OK");
  const list = report.calls.find(call => call.url === "https://memory.invalid/mcp" && call.headers?.Authorization);
  expect(JSON.parse(list.body)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(run({ files: { files: [] } }).check("rag.token").status).toBe("OK");
});

for (const body of ["<html>OK</html>", {}, null, { error: "failure" }]) {
  test(`row 3: HTTP 200 with wrong body ${JSON.stringify(body)} is not proof`, () => {
    const report = run({ health: body, tools: body, files: body, index: body });
    for (const id of ["memory.url", "rag.url"]) expect(report.check(id).status).toBe("WARN");
    for (const id of ["memory.key", "rag.token"]) expect(report.check(id).status).toBe("FAIL");
  });
}

for (const body of [
  { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "failed" }, result: tools.result },
  { ...tools, id: 2 }, { ...tools, jsonrpc: "1.0" },
  { jsonrpc: "2.0", id: 1, result: { tools: "not an array" } },
  { jsonrpc: "2.0", id: 1, result: { tools: [{}] } },
]) test(`row 3: malformed or errored RPC ${JSON.stringify(body)} fails token proof`, () => {
  expect(run({ tools: body }).check("memory.key").status).toBe("FAIL");
});

for (const body of [{ files: "wrong" }, { files: ["Session_1.md"] }, { files: [{}] },
  { files: [{ name: "Session_1.md", size: 100, uploaded: "bad" }] }, { ...files, error: "failed" }]) {
  test(`row 3: malformed archive list ${JSON.stringify(body)} fails token proof`, () => {
    expect(run({ files: body }).check("rag.token").status).toBe("FAIL");
  });
}

test("row 3: HTTP and configuration failures remain failures", () => {
  for (const failHttp of [401, 403, 500]) {
    const report = run({ failHttp });
    for (const id of ["memory.url", "memory.key", "rag.url", "rag.token"]) expect(report.check(id).status).toBe("FAIL");
  }
});

for (const [canary, canaryStatus, expected] of [
  ["OK", 0, "OK"], [" \nOK\n ", 0, "OK"], ["NOT OK", 0, "WARN"],
  ["prefix OK suffix", 0, "WARN"], ["", 0, "WARN"], ["OK", 1, "WARN"], ["OK", null, "WARN"],
] as const) test(`row 4: canary ${JSON.stringify(canary)} exit ${canaryStatus}`, () => {
  const check = run({ canary, canaryStatus }).check("claude-headless");
  expect(check.status).toBe(expected);
  if (expected === "WARN") expect(check.detail).toContain("affects header enrichment and any claude -p automation");
});

test("row 4: missing binary retains FAIL", () => {
  expect(run({ canaryError: "ENOENT" }).check("claude-headless").status).toBe("FAIL");
});

test("row 5: adapter health proves an answer, not a model call", () => {
  for (const ok of [true, "truthy"]) {
    const check = run({ env: { EMBERVY_SUBSTRATE: "gpt" }, adapter: { ok, backend: "test", model: "test" } }).check("gpt-adapter");
    expect(check.status).toBe("OK");
    expect(check.detail).toBe("adapter answers; model call not checked");
  }
  for (const adapter of [{ ok: false }, {}, "<html>OK</html>"]) expect(run({ env: { EMBERVY_SUBSTRATE: "gpt" }, adapter }).check("gpt-adapter").status).toBe("FAIL");
  expect(run({ env: { EMBERVY_SUBSTRATE: "gpt" }, adapterStatus: 500 }).check("gpt-adapter").status).toBe("FAIL");
  const offline = run({ offline: true, env: { EMBERVY_SUBSTRATE: "gpt" } });
  expect(offline.check("gpt-adapter").status).toBe("SKIP");
  expect(offline.check("gpt-adapter").detail).toContain("not checked — offline");
});

for (const inlet of [hit, "[Session_1.md] (RRF 0.0164 [vector+bm25])\nRetrieved text",
  "[Session_1.md] (context [edge], 2026-01-01)\nRetrieved text",
  JSON.stringify({ hookSpecificOutput: { additionalContext: hit } })]) {
  test(`row 6: successful inlet carries a real rendered hit ${JSON.stringify(inlet)}`, () => {
    expect(run({ inlet }).check("inlet").status).toBe("OK");
  });
}
for (const inlet of ["", "BYPASS", "## Chronicle (RAG)", "## Person: Example", "x".repeat(100),
  "[Session_1.md] (85% [rerank])", "[unrelated log message]", JSON.stringify({ hookSpecificOutput: { additionalContext: "x".repeat(100) } })]) {
  test(`row 6: inlet output without a retrieved hit warns ${JSON.stringify(inlet)}`, () => {
    const check = run({ inlet, files: grownArchive }).check("inlet");
    expect(check.status).toBe("WARN");
    expect(check.detail).toBe("inlet ran, no retrieved context seen");
  });
}

test("row 6: a retrieved marker cannot hide a nonzero or signalled exit, even on an empty archive", () => {
  for (const inletStatus of [1, null]) {
    expect(run({ inletStatus }).check("inlet").status).toBe("WARN");
    expect(run({ inletStatus, files: { files: [] }, env: { DOCTOR_PROBE_QUERY: "specific archived topic" } }).check("inlet").status).toBe("WARN");
  }
  expect(run({ inlet: "", files: { files: [] } }).check("inlet")).toMatchObject({ status: "SKIP" });
  expect(run({ offline: true }).check("inlet").status).toBe("SKIP");
});

test("literal status counts retain all FAIL and WARN branches", () => {
  const source = readFileSync(doctorPath, "utf8");
  const count = (status: string) => [...source.matchAll(new RegExp(`status: "${status}"`, "g"))].length;
  const counts = { FAIL: count("FAIL"), WARN: count("WARN"), SKIP: count("SKIP"), OK: count("OK") };
  expect(counts.FAIL).toBeGreaterThanOrEqual(27);
  expect(counts.WARN).toBeGreaterThanOrEqual(18);
});
