import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp } from "./test-app-start";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "app-start-"));
  return {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_DOCTOR_INTERVAL_MIN: "0",
      EMBERVY_TMUX_SESSION: "app-start-no-such-session",
      APP_SESSION_SECRET: crypto.randomUUID(),
    },
    clean: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a foreign healthy server is not the spawned app", async () => {
  const f = fixture();
  const foreign = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: req => new URL(req.url).pathname === "/health"
      ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 }),
  });
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  try {
    let oldReadiness: Promise<boolean> | undefined;
    let firstChild: ReturnType<typeof Bun.spawn> | undefined;
    app = await startTestApp({
      ...f, firstPort: foreign.port,
      spawn: (cmd, options) => {
        const child = Bun.spawn(cmd, options);
        if (!firstChild) {
          firstChild = child;
          // Readiness polled only by port, which a foreign app on that port also passes.
          oldReadiness = (async () => {
            let up = false;
            for (let i = 0; i < 100 && !up; i++) {
              up = await fetch(`http://127.0.0.1:${foreign.port}/health`).then(r => r.ok, () => false);
              if (!up) await Bun.sleep(100);
            }
            return up;
          })();
        }
        return child;
      },
    });
    expect(await oldReadiness).toBe(true);
    expect(firstChild?.exitCode).not.toBeNull();
    expect(app.port).not.toBe(foreign.port);
    expect(app.proc.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${foreign.port}/health`)).status).toBe(200);
  } finally {
    if (app) { app.proc.kill(); await app.proc.exited; }
    foreign.stop(true);
    f.clean();
  }
}, 30_000);

test("a child that exits immediately is retried on another port", async () => {
  const f = fixture();
  const ports: number[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  try {
    app = await startTestApp({
      ...f,
      spawn: (cmd, options) => {
        ports.push(Number(options.env.EMBERVY_APP_PORT));
        const child = Bun.spawn(ports.length === 1 ? [process.execPath, "-e", "process.exit(23)"] : cmd, options);
        children.push(child);
        return child;
      },
    });
    expect(ports).toHaveLength(2);
    expect(ports[1]).not.toBe(ports[0]);
    expect(children[0].exitCode).toBe(23);
    expect(app.proc.exitCode).toBeNull();
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    f.clean();
  }
}, 30_000);

test("retry exhaustion names each port and reaps every child", async () => {
  const f = fixture();
  const ports: number[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    let message = "";
    try {
      await startTestApp({
        ...f,
        spawn: (_cmd, options) => {
          ports.push(Number(options.env.EMBERVY_APP_PORT));
          const child = Bun.spawn([process.execPath, "-e", "process.exit(23)"], options);
          children.push(child);
          return child;
        },
      });
    } catch (error) { message = (error as Error).message; }
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    expect(message).toContain("failed after 3 attempts");
    for (const port of ports) expect(message).toContain(`port ${port}: child exited`);
    expect(children.every(child => child.exitCode === 23)).toBe(true);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    f.clean();
  }
}, 15_000);

test("an identity deadline stops a live child before retrying", async () => {
  const f = fixture();
  const ports: number[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    let message = "";
    try {
      await startTestApp({
        ...f, timeoutMs: 300,
        spawn: (_cmd, options) => {
          expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
          ports.push(Number(options.env.EMBERVY_APP_PORT));
          const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], options);
          children.push(child);
          return child;
        },
      });
    } catch (error) { message = (error as Error).message; }
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
    expect(message).toContain("deadline 300ms exceeded");
    expect(children.every(child => child.signalCode === "SIGKILL")).toBe(true);
  } finally {
    for (const child of children) { child.kill(); await child.exited; }
    f.clean();
  }
}, 15_000);

test("a normal start returns a working session cookie", async () => {
  const f = fixture();
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  try {
    app = await startTestApp(f);
    const headers = { "cf-ray": "test-ray", "cf-connecting-ip": "127.0.0.1" };
    expect((await fetch(`${app.base}/api/messages`, { headers })).status).toBe(401);
    expect((await fetch(`${app.base}/api/messages`, { headers: { ...headers, cookie: app.cookie } })).status).toBe(200);
    expect(app.proc.exitCode).toBeNull();
  } finally {
    if (app) { app.proc.kill(); await app.proc.exited; }
    f.clean();
  }
}, 30_000);
