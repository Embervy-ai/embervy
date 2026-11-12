import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(home: string, env: Record<string, string> = {}) {
  const began = Date.now();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "embervy-doctor.ts"), "--startup", "--json"], { cwd: home, env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home, EMBERVY_HARNESS: "brain", ...env }, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  expect(Date.now() - began).toBeLessThan(20_000);
  const report = JSON.parse(text);
  for (const entry of report.checks) if (entry.status !== "OK") for (const field of ["id", "label", "detail", "fix"]) expect(typeof entry[field] === "string" && entry[field].length > 0).toBe(true);
  return report.checks as Array<{ id: string; status: string; detail: string }>;
}

test("startup identity rejects missing and empty files, and hearing is optional", async () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-startup-"));
  try {
    mkdirSync(join(home, "Brain"));
    writeFileSync(join(home, "Brain/brain.env"), `BRAIN_SYSTEM=${home}/identity.md\nBRAIN_INLET=false\n`);
    let checks = await run(home);
    expect(checks.find(c => c.id === "identity")?.status).toBe("FAIL");
    expect(checks.find(c => c.id === "hear")?.status).toBe("SKIP");
    writeFileSync(join(home, "identity.md"), " \n");
    checks = await run(home);
    expect(checks.find(c => c.id === "identity")?.status).toBe("FAIL");
    writeFileSync(join(home, "identity.md"), "# Identity\n");
    checks = await run(home, { EMBERVY_HEAR_URL: "http://127.0.0.1:1/hear" });
    expect(checks.find(c => c.id === "identity")?.status).toBe("OK");
    expect(checks.find(c => c.id === "hear")?.status).toBe("FAIL");
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20_000);

test("startup resolves a relative Brain identity against the house, not the caller", async () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-startup-relative-"));
  try {
    mkdirSync(join(home, "Brain"));
    writeFileSync(join(home, "Brain/brain.env"), "BRAIN_SYSTEM=identity.md\nBRAIN_INLET=false\n");
    writeFileSync(join(home, "identity.md"), "# Identity\n");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "embervy-doctor.ts"), "--startup", "--json", "--offline"], { cwd: tmpdir(), env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home, EMBERVY_HARNESS: "brain" }, stdout: "pipe", stderr: "pipe" });
    const report = JSON.parse(await new Response(child.stdout).text());
    await child.exited;
    for (const id of ["identity", "adapter.doc"]) expect(report.checks.find((c: any) => c.id === id)?.status).toBe("OK");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("startup hearing probes the configured service without sending audio", async () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-startup-hear-"));
  const methods: string[] = [];
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { methods.push(request.method); return new Response(null, { status: 405 }); } });
  try {
    const checks = await run(home, { EMBERVY_HEAR_URL: `http://127.0.0.1:${service.port}/hear` });
    expect(checks.find(c => c.id === "hear")?.status).toBe("OK");
    expect(methods).toEqual(["GET", "HEAD"]);
  } finally { service.stop(true); rmSync(home, { recursive: true, force: true }); }
});

test("startup hearing accepts a POST-only service that is healthy or refuses HEAD with 501", async () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-startup-hear-post-"));
  let health = 200, head = 501;
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return Response.json({ ok: true }, { status: health });
    return new Response(null, { status: request.method === "HEAD" ? head : 404 });
  } });
  try {
    const url = `http://127.0.0.1:${service.port}/hear`;
    let checks = await run(home, { EMBERVY_HEAR_URL: url });
    expect(checks.find(c => c.id === "hear")?.status).toBe("OK");
    expect(checks.find(c => c.id === "hear")?.detail).toContain("/health");
    health = 404;
    checks = await run(home, { EMBERVY_HEAR_URL: url });
    expect(checks.find(c => c.id === "hear")?.status).toBe("OK");
    head = 500;
    checks = await run(home, { EMBERVY_HEAR_URL: url });
    expect(checks.find(c => c.id === "hear")?.status).toBe("FAIL");
  } finally { service.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 20_000);

test("startup deadline contains a hanging core endpoint", async () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-startup-timeout-"));
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const checks = await run(home, { EMBERVY_URL: `http://127.0.0.1:${service.port}`, EMBERVY_API_KEY: "test" });
    expect(checks.find(c => c.id === "memory.url")?.status).toBe("FAIL");
  } finally { service.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 20_000);
