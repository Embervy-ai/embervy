import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the real CLI in a child: no process.exit, module mocks, shell
// commands or network stubs escape into other worker/doctor tests.
const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));
const oldRun = "2025-01-01T04:00:00.000Z";
const marker = "PRIVATE-provider-text-key-https://secret.invalid/?token=secret";
function doctor(trace: Record<string, unknown> = {}, options: { text?: boolean; off?: boolean; never?: boolean; recent?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "doctor-dream-trace-"));
  homes.push(home);
  mkdirSync(join(home, "Claude/app"), { recursive: true });
  mkdirSync(join(home, "Brain"));
  writeFileSync(join(home, ".env"), options.off ? "EMBERVY_DREAM=off\n" : "");
  writeFileSync(join(home, "state.json"), JSON.stringify({ started_at: "2024-01-01T00:00:00Z" }));
  const health = {
    daemon_last_run: new Date().toISOString(), daemon_last_ok: true,
    dream_last_run: options.never ? null : options.recent ? new Date().toISOString() : oldRun,
    warnings: [], ...trace,
  };
  const runner = join(home, "runner.ts");
  writeFileSync(runner, `
import { mock } from "bun:test";
mock.module("node:child_process", () => ({
  spawnSync() { return { status: 0, stdout: "LoadState=not-found\\nActiveState=inactive\\n", stderr: "" }; },
}));
globalThis.fetch = async (url, init = {}) => {
  if (!new Headers(init.headers).has("Authorization")) return new Response("unauthorized", { status: 401 });
  const u = new URL(url);
  if (u.hostname !== "memory.invalid") throw new Error("Unexpected test request");
  if (u.pathname === "/health") return Response.json({ status: "ok" });
  const body = JSON.parse(init.body || "{}");
  if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
  if (body.params?.name === "health") return Response.json({ jsonrpc: "2.0", id: body.id,
    result: { content: [{ type: "text", text: "Health\\n\\n\x60\x60\x60json\\n" + JSON.stringify(${JSON.stringify(health)}) + "\\n\x60\x60\x60" }] } });
  return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "No results" }] } });
};
await import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});
`);
  const child = Bun.spawnSync([process.execPath, runner, ...(options.text ? [] : ["--json"])], {
    cwd: home, stdout: "pipe", stderr: "pipe", timeout: 8_000,
    env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home,
      EMBERVY_DOCTOR_SKIP_CANARY: "1", EMBERVY_URL: "https://memory.invalid", EMBERVY_API_KEY: "test",
      INSTALL_STATE_FILE: join(home, "state.json"), REBOOT_REQUIRED_FILE: join(home, "no-reboot"),
      REBOOT_REQUIRED_PKGS_FILE: join(home, "no-packages") },
  });
  expect(child.stderr.toString()).toBe("");
  const stdout = child.stdout.toString();
  expect(stdout).not.toContain(marker);
  const check = options.text ? null : JSON.parse(stdout).checks.find((c: any) => c.id === "memory.nightly");
  return { stdout, check };
}
function failed(code = "provider_http", status: unknown = 503) {
  return { dream_last_attempt: new Date(Date.now() - 60_000).toISOString(), dream_last_result: "failed",
    dream_last_error: { class: code, status } };
}
const legacyDetail = `daemon: successful run within 26 hours; dream: last successful run is older than 26 hours (${oldRun})`;
const providerSentence = " The last dream attempt failed because the provider returned an error (HTTP 503) after the configured attempts.";

test("doctor nightly warning without trace retains its exact previous wording", () => {
  expect(doctor().check).toMatchObject({ status: "WARN", detail: legacyDetail });
});

test("doctor overdue dream warning includes only the bounded human-readable cause", () => {
  expect(doctor(failed()).check).toMatchObject({ status: "WARN", detail: legacyDetail + providerSentence });
});

test("doctor prints the exact WARN line with and without the optional trace", () => {
  const prefix = "[WARN] Memory daemon and dream — ";
  expect(doctor({}, { text: true }).stdout.split("\n")).toContain(prefix + legacyDetail);
  expect(doctor(failed(), { text: true }).stdout.split("\n")).toContain(prefix + legacyDetail + providerSentence);
});

for (const [code, phrase] of [
  ["provider_unreachable", "the provider could not be reached"],
  ["provider_response", "the provider response was empty or unusable"],
  ["write_failed", "the dream note could not be saved"],
  ["unexpected", "an internal worker error"],
]) {
  test(`doctor explains ${code} without remote free text`, () => {
    const trace = failed(code, null);
    Object.assign(trace.dream_last_error, { message: marker, url: marker });
    const result = doctor(trace).check;
    expect(result.status).toBe("WARN");
    expect(result.detail).toContain(phrase);
  });
}

test("doctor handles never-successful and empty attempts without inventing a success", () => {
  expect(doctor(failed(), { never: true }).check).toMatchObject({ status: "WARN",
    detail: "daemon: successful run within 26 hours; dream: the nightly run has not happened yet" + providerSentence });
  expect(doctor({ dream_last_attempt: new Date().toISOString(), dream_last_result: "empty", dream_last_error: null }).check)
    .toMatchObject({ status: "WARN", detail: legacyDetail + " The last dream attempt had nothing to write." });
});

test("unknown classes, malformed status and stale traces cannot inject provider text", () => {
  expect(doctor(failed(marker, marker)).check.detail).toBe(legacyDetail);
  const malformed = doctor(failed("provider_http", marker)).check;
  expect(malformed.detail).toContain("the provider returned an error after the configured attempts.");
  expect(malformed.detail).not.toContain("HTTP");
  expect(doctor({ ...failed(), dream_last_attempt: "2024-01-01T04:00:00Z" }).check.detail).toBe(legacyDetail);
});

test("recent successes and deliberately disabled dreams do not gain overdue-failure warnings", () => {
  expect(doctor(failed(), { recent: true }).check).toMatchObject({ status: "OK",
    detail: "daemon: successful run within 26 hours; dream: successful run within 26 hours" });
  expect(doctor(failed(), { off: true }).check).toMatchObject({ status: "OK",
    detail: "daemon: successful run within 26 hours; dream: off by the house's choice (EMBERVY_DREAM=off)" });
});
