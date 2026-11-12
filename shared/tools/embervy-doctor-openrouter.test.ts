import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));
const secret = "sk-or-private-test-value-never-print";
type Options = {
  status?: number; failure?: "network" | "timeout"; key?: string | null;
  source?: "root" | "app" | "process"; prefix?: boolean; rootEmpty?: boolean;
  offline?: boolean; text?: boolean; startup?: boolean; disabled?: boolean;
};
type Check = { id: string; group: string; status: string; detail: string; fix?: string };

// The executable exits, so all network and command mocks stay inside its child process.
function run(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "doctor-openrouter-"));
  homes.push(home);
  mkdirSync(join(home, "Brain"));
  mkdirSync(join(home, "Claude/scripts"), { recursive: true });
  mkdirSync(join(home, "Claude/app"));
  writeFileSync(join(home, "Claude/scripts/inlet-worker.ts"), "export {};\n");
  writeFileSync(join(home, "Brain/brain.env"), options.disabled ? "BRAIN_INLET=false\n" : "");
  const key = options.key === undefined ? secret : options.key;
  const name = options.prefix ? "TEST_OPENROUTER_API_KEY" : "OPENROUTER_API_KEY";
  const source = options.source ?? "root";
  const root = join(home, ".env");
  const app = join(home, "Claude/app/.env");
  writeFileSync(root, "");
  if (key !== null && source !== "process") writeFileSync(source === "root" ? root : app, `${name}=${key}\n`);
  if (options.rootEmpty) writeFileSync(root, `${name}=\n`);
  const callsPath = join(home, "calls.json");
  const statusPath = join(home, "status.json");
  writeFileSync(callsPath, "[]");
  const runner = join(home, "runner.ts");
  writeFileSync(runner, `
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
const options = ${JSON.stringify(options)};
const calls = [];
mock.module("node:child_process", () => ({
  spawnSync() { return { status: 0, stdout: "LoadState=not-found\\nActiveState=inactive\\n", stderr: "" }; },
}));
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "openrouter.ai") {
    calls.push({ url, method: init.method, authorized: new Headers(init.headers).get("Authorization") === ${JSON.stringify(`Bearer ${key}`)},
      hasSignal: init.signal instanceof AbortSignal, redirect: init.redirect, body: init.body ?? null });
    writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
    if (options.failure === "network") throw new Error(${JSON.stringify(`network failure echoing ${secret}`)});
    if (options.failure === "timeout") return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(${JSON.stringify(`timeout echoing ${secret}`)})), { once: true });
    });
    return new Response(${JSON.stringify(`private response body ${secret}`)}, { status: options.status ?? 200 });
  }
  if (u.hostname === "archive.invalid") {
    if (!new Headers(init.headers).has("Authorization")) return new Response("unauthorized", { status: 401 });
    if (u.pathname === "/") return new Response("RAG API\\n");
    if (u.pathname === "/list") return Response.json({ files: [{ name: "Session_1.md", size: 100, uploaded: "2025-01-01T00:00:00Z" }] });
    if (u.pathname === "/head") return Response.json({ head: "# Session without a topic header" });
  }
  throw new Error("No mocked response for this URL");
};
await import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});
`);
  const began = Date.now();
  const child = Bun.spawnSync([process.execPath, runner, ...(options.text ? [] : ["--json"]),
    ...(options.offline ? ["--offline"] : []), ...(options.startup ? ["--startup-child"] : [])], {
    cwd: home, stdout: "pipe", stderr: "pipe", timeout: 8_000,
    env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home,
      EMBERVY_DOCTOR_SKIP_CANARY: "1", DOCTOR_STATUS_FILE: statusPath,
      RAG_URL: "https://archive.invalid", RAG_AUTH_TOKEN: "archive-test-token",
      ...(options.disabled ? { EMBERVY_HARNESS: "brain" } : {}),
      ...(options.prefix ? { AGENT_PREFIX: "TEST" } : {}),
      ...(key !== null && source === "process" ? { [name]: key } : {}),
      REBOOT_REQUIRED_FILE: join(home, "no-reboot"), REBOOT_REQUIRED_PKGS_FILE: join(home, "no-packages") },
  });
  const stdout = child.stdout.toString(), stderr = child.stderr.toString();
  expect(stderr).toBe("");
  expect(stdout).not.toContain(secret);
  expect(stderr).not.toContain(secret);
  if (!options.startup) expect(readFileSync(statusPath, "utf8")).not.toContain(secret);
  const checks: Check[] = options.text ? [] : options.startup
    ? stdout.trim().split("\n").map(line => JSON.parse(line)) : JSON.parse(stdout).checks;
  const entries = checks.filter(c => c.id === "inlet.openrouter-key");
  if (!options.text) expect(entries).toHaveLength(1);
  return { home, stdout, check: entries[0], checks, elapsed: Date.now() - began,
    calls: JSON.parse(readFileSync(callsPath, "utf8")) as any[] };
}

test("200 accepts the key with a bounded authenticated GET and no model call", () => {
  const result = run();
  expect(result.check).toMatchObject({ group: "Inlet", status: "OK" });
  expect(result.calls).toEqual([{ url: "https://openrouter.ai/api/v1/key", method: "GET",
    authorized: true, hasSignal: true, redirect: "error", body: null }]);
});

for (const status of [401, 403]) test(`${status} warns even when the archive has no THEMES`, () => {
  const result = run({ status });
  expect(result.check.status).toBe("WARN");
  expect(result.check.detail).toContain(`OpenRouter rejects the key (HTTP ${status})`);
  expect(result.check.detail).toContain("agent receives no automatic context");
  expect(result.check.detail).toContain(join(result.home, ".env"));
  expect(result.check.detail).toContain("OPENROUTER_API_KEY");
  for (const id of ["inlet", "rag.hybrid", "rag.fts", "rag.rerank"]) {
    const entry = result.checks.find(c => c.id === id)!;
    expect(entry.status).toBe("SKIP");
    expect(entry.detail).toContain("THEMES");
  }
});

test("network failure skips with a safe reason instead of echoing the error", () => {
  expect(run({ failure: "network" }).check).toMatchObject({ status: "SKIP",
    detail: "key acceptance not checked — network error reaching OpenRouter" });
});

test("a hanging request aborts after the short deadline and skips", () => {
  const result = run({ failure: "timeout" });
  expect(result.check.status).toBe("SKIP");
  expect(result.check.detail).toContain("timed out after 3 seconds");
  expect(result.elapsed).toBeLessThan(5_000);
}, 10_000);

test("an unset or empty optional key skips without an OpenRouter request", () => {
  for (const key of [null, ""]) {
    const result = run({ key });
    expect(result.check.status).toBe("SKIP");
    expect(result.check.detail).toContain("optional inlet classifier not configured");
    expect(result.calls).toEqual([]);
  }
});

test("offline mode never sends the configured key", () => {
  const result = run({ offline: true });
  expect(result.check).toMatchObject({ status: "SKIP", detail: "set, not checked — offline" });
  expect(result.calls).toEqual([]);
});

for (const status of [429, 500, 302]) test(`HTTP ${status} does not falsely reject or accept the key`, () => {
  const result = run({ status });
  expect(result.check.status).toBe("SKIP");
  expect(result.check.detail).toContain(`HTTP ${status}`);
});

test("warnings name the app file and the prefixed variable actually read", () => {
  const result = run({ status: 401, source: "app", prefix: true });
  expect(result.check.detail).toContain(join(result.home, "Claude/app/.env"));
  expect(result.check.detail).toContain("TEST_OPENROUTER_API_KEY");
  expect(result.calls[0].authorized).toBe(true);
});

test("process environment is supported without overriding an explicit empty house value", () => {
  const result = run({ source: "process", status: 401 });
  expect(result.check.status).toBe("WARN");
  expect(result.check.detail).toContain("process environment");
  expect(result.check.detail).toContain(join(result.home, ".env"));
  const empty = run({ source: "process", rootEmpty: true });
  expect(empty.check.status).toBe("SKIP");
  expect(empty.calls).toEqual([]);
});

test("text output includes the actionable warning, never response bodies or key values", () => {
  const result = run({ text: true, status: 401 });
  expect(result.stdout).toContain("[WARN] OpenRouter key accepted");
  expect(result.stdout).toContain("OPENROUTER_API_KEY");
  expect(result.stdout).toContain("agent receives no automatic context");
  expect(result.stdout).not.toContain("private response body");
});

test("startup checks the key independently of a deliberately disabled inlet", () => {
  const result = run({ startup: true, disabled: true, status: 403 });
  expect(result.check.status).toBe("WARN");
  expect(result.checks.find(c => c.id === "inlet")?.status).toBe("SKIP");
  expect(result.calls).toHaveLength(1);
});
