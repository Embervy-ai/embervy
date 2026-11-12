import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


const dirs: string[] = [];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function house(previousState: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-background-"));
  dirs.push(dir);
  mkdirSync(join(dir, "state"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "shared", "tools"), { recursive: true });
  for (const name of ["tmux", "pgrep", "pkill", "setsid"]) {
    writeFileSync(join(dir, "bin", name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, "bin", name), 0o755);
  }
  writeFileSync(join(dir, "shared", "tools", "embervy-doctor.ts"), `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "doctor-calls.log"))}, (process.env.EMBERVY_DOCTOR_BACKGROUND ?? "-") + "\\n");
console.log(JSON.stringify({ result: "PASS-WITH-WARN", summary: { pass: 1, warn: 1, fail: 0, skip: 0 },
  checks: [{ id: "example.ok", group: "Core", label: "Fine", status: "OK" }, { id: "example.warn", group: "Core", label: "Wobbly", status: "WARN", detail: "example" }] }));
`);
  if (previousState) writeFileSync(join(dir, "state", "doctor-last.json"), previousState);
  const preload = join(dir, "preload.ts");
  writeFileSync(preload, `import { mock } from "bun:test";\nimport { appendFileSync } from "node:fs";\nmock.module(${JSON.stringify(Bun.resolveSync("web-push", import.meta.dir))}, () => ({ default: { setVapidDetails() {}, async sendNotification() { appendFileSync(${JSON.stringify(join(dir, "push.log"))}, "push\\n"); } } }));\n`);
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data", "push-subscriptions.json"), JSON.stringify([{ endpoint: "https://fcm.googleapis.com/fcm/send/doctor-background", keys: { p256dh: "x", auth: "y" } }]));
  const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = socket.port; socket.stop(true);
  if (port === 3030) throw new Error("refusing production port");
  const proc = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
    cwd: dir, env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_HOME: dir,
      APP_PASSWORD: "example-password", APP_SESSION_SECRET: "example-session-secret", INTERNAL_API_TOKEN: "example-internal-token",
      VAPID_PUBLIC_KEY: "example-public", VAPID_PRIVATE_KEY: "example-private",
      EMBERVY_TERMINAL_PANEL: "0", EMBERVY_STRINGS_LOCAL: join(dir, "missing.json"),
      EMBERVY_DOCTOR_INTERVAL_MIN: "0.02",
    }, stdout: "ignore", stderr: "ignore",
  });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(base + "/health")).ok; } catch {}
    if (!ready) await Bun.sleep(100);
  }
  if (!ready) throw new Error("test server did not come up");
  const state = () => { try { return JSON.parse(readFileSync(join(dir, "state", "doctor-last.json"), "utf8")); } catch { return null; } };
  const calls = () => (existsSync(join(dir, "doctor-calls.log")) ? readFileSync(join(dir, "doctor-calls.log"), "utf8").trim().split("\n") : []);
  const pushes = () => (existsSync(join(dir, "push.log")) ? readFileSync(join(dir, "push.log"), "utf8").trim().split("\n").length : 0);
  const waitFor = async (cond: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !cond()) await Bun.sleep(100);
  };
  return { state, calls, pushes, waitFor };
}

describe("the doctor in the background", () => {
  test("runs on its own, without the canary, stores the result and pushes on a regression", async () => {
    const h = await house(JSON.stringify({ state: "ok", checks: [{ id: "example.warn", group: "Core", label: "Wobbly", status: "OK" }] }));
    await h.waitFor(() => h.state()?.state === "warn" && h.pushes() > 0);
    expect(h.state()?.state).toBe("warn");
    expect(h.calls()[0]).toBe("1");
    expect(h.pushes()).toBeGreaterThan(0);
  }, 30_000);

  test("the first result of a house is no regression: no push", async () => {
    const h = await house(null);
    await h.waitFor(() => h.state()?.state === "warn");
    expect(h.state()?.state).toBe("warn");
    await Bun.sleep(500);
    expect(h.pushes()).toBe(0);
  }, 30_000);
});
