import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests health checks against local harness settings and simulated archive responses.

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function house(brainEnv: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "doctor-brain-"));
  dirs.push(home);
  mkdirSync(join(home, "Brain"), { recursive: true });
  mkdirSync(join(home, "Claude", "scripts"), { recursive: true });
  writeFileSync(join(home, "Claude", "scripts", "inlet-worker.ts"), "process.stdout.write('');\n");
  if (brainEnv !== null) writeFileSync(join(home, "Brain", "brain.env"), brainEnv.replaceAll("$HOME", home));
  return home;
}

function doctor(home: string, extraEnv: Record<string, string> = {}, args: string[] = ["--offline"]) {
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "embervy-doctor.ts"), ...args, "--json"], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, EMBERVY_HOME: home, EMBERVY_APP_PORT: "9", EMBERVY_DOCTOR_SKIP_CANARY: "1", ...extraEnv,
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return JSON.parse(run.stdout.toString()) as { checks: Array<{ id: string; status: string; label: string; detail?: string; fix?: string }> };
}
const find = (report: ReturnType<typeof doctor>, id: string) => report.checks.find((c) => c.id === id);

/** The same run without blocking this process, so a fake worker served from here can answer. */
async function doctorAsync(home: string, extraEnv: Record<string, string>): Promise<ReturnType<typeof doctor>> {
  const run = Bun.spawn(["bun", join(import.meta.dir, "embervy-doctor.ts"), "--json"], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, EMBERVY_HOME: home, EMBERVY_APP_PORT: "9", EMBERVY_DOCTOR_SKIP_CANARY: "1", ...extraEnv,
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(run.stdout).text();
  await run.exited;
  return JSON.parse(out);
}

describe("inlet wiring on the Brain harness", () => {
  test("Brain's inlet worker counts as wired; no Claude Code hook is asked for", () => {
    const home = house("BRAIN_INLET=true\nBRAIN_INLET_WORKER=$HOME/Claude/scripts/inlet-worker.ts\n");
    const line = find(doctor(home, { EMBERVY_HARNESS: "brain" }), "adapter.hook");
    expect(line?.status).toBe("OK");
    expect(line?.label).toContain("Brain");
  });

  test("without a worker in Brain's settings it warns and says where to set it", () => {
    const home = house("BRAIN_INLET=true\n");
    const line = find(doctor(home, { EMBERVY_HARNESS: "brain" }), "adapter.hook");
    expect(line?.status).toBe("WARN");
    expect(line?.detail).toContain("BRAIN_INLET_WORKER");
  });

  test("an inlet switched off on purpose is no warning", () => {
    const home = house("BRAIN_INLET=false\n");
    expect(find(doctor(home, { EMBERVY_HARNESS: "brain" }), "adapter.hook")?.status).toBe("SKIP");
  });

  test("the Claude Code path still looks for the hook", () => {
    const home = house(null);
    const line = find(doctor(home), "adapter.hook");
    expect(line?.status).toBe("WARN");
    expect(line?.label).toContain("UserPromptSubmit");
  });
});

test("project settings register the inlet and an explicit override remains authoritative", () => {
  const home = house(null);
  mkdirSync(join(home, ".claude"));
  const settings = join(home, ".claude/settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "inlet.sh" }] }] } }));
  const line = find(doctor(home, { HOME: join(home, "user") }), "adapter.hook");
  expect(line?.status).toBe("OK");
  expect(line?.detail).toBe(`registered in ${settings}`);
  const override = join(home, "custom.json");
  writeFileSync(override, "{}");
  const missing = find(doctor(home, { INLET_HOOK_SETTINGS: override }), "adapter.hook") as any;
  expect(missing?.status).toBe("WARN");
  expect(missing?.fix).toContain(override);
});

describe("Brain's notebook", () => {
  test("a configured directory passes and a missing directory fails", () => {
    const home = house("BRAIN_NOTES_DIR=$HOME/notes\n");
    expect(find(doctor(home, { EMBERVY_HARNESS: "brain" }), "brain.notes")?.status).toBe("FAIL");
    mkdirSync(join(home, "notes"));
    writeFileSync(join(home, "notes/NOTES.md"), "# Notes\n");
    const report = doctor(home, { EMBERVY_HARNESS: "brain" });
    expect(find(report, "brain.notes")?.status).toBe("OK");
    expect(find(report, "brain.notes.index")?.status).toBe("OK");
  });

  test("a missing index is a notice rather than a failure", () => {
    const home = house("BRAIN_NOTES_DIR=$HOME/notes\n");
    mkdirSync(join(home, "notes"));
    expect(find(doctor(home, { EMBERVY_HARNESS: "brain" }), "brain.notes.index")?.status).toBe("SKIP");
  });

  test("CLI notes for this working directory warn even with a foreign ambient config", () => {
    const home = house("BRAIN_NOTES_DIR=$HOME/notes\nBRAIN_CLAUDE_CWD=$HOME\n");
    mkdirSync(join(home, "notes"));
    const memory = join(home, ".claude/projects", home.replace(/[^A-Za-z0-9]/g, "-"), "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "MEMORY.md"), "# Memory\n");
    const vars = { EMBERVY_HARNESS: "brain", CLAUDE_CONFIG_DIR: join(home, "other-config") };
    expect(find(doctor(home, vars), "brain.notes.legacy")).toBeUndefined();
    writeFileSync(join(memory, "rule.md"), "A rule.\n");
    const line = find(doctor(home, vars), "brain.notes.legacy");
    expect(line?.status).toBe("WARN");
    expect(line?.detail).toContain("no head reads them");
  });

  test("an unset switch is a notice and Claude Code houses have no notebook checks", () => {
    const home = house("");
    const line = find(doctor(home, { EMBERVY_HARNESS: "brain" }), "brain.notes");
    expect(line?.status).toBe("SKIP");
    expect(line?.detail).toContain("still uses Claude Code");
    expect(doctor(home).checks.some(c => c.id.startsWith("brain.notes"))).toBe(false);
  });
});

describe("a young archive", () => {
  test("the probe uses session themes, and an empty inlet on few files is no warning", async () => {
    const queries: string[] = [];
    const rag = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (!req.headers.has("Authorization")) return new Response("unauthorized", { status: 401 });
        if (url.pathname === "/list") return Response.json({ files: ["Session_1.md", "Session_2.md"].map(name => ({ name, size: 100, uploaded: new Date().toISOString() })) });
        if (url.pathname === "/head") return Response.json({ head: "THEMES=orchard pruning and harvest planning" });
        if (url.pathname === "/search") {
          const body = await req.json() as { query: string };
          queries.push(body.query);
          return Response.json({ mode: "hybrid", reranked: true, counts: { vector: 2, bm25: 2 }, results: [{ sources: ["Wren_1.md"] }] });
        }
        return new Response("unauthorized", { status: 401 });
      },
    });
    try {
      const home = house(null);
      const report = await doctorAsync(home, { RAG_URL: `http://127.0.0.1:${rag.port}`, RAG_AUTH_TOKEN: "test-token-not-real" });
      expect(queries).toContain("orchard pruning and harvest planning");
      expect(find(report, "rag.fts")?.status).toBe("OK");
      const inlet = find(report, "inlet");
      expect(inlet?.status).toBe("SKIP");
      expect(inlet?.detail).toContain("young");
    } finally {
      rag.stop(true);
    }
  }, 60_000);
});

test("the app refuses to start with an empty password", async () => {
  const home = house(null);
  const runner = join(home, "app-password-runner.ts");
  writeFileSync(runner, `
import { mock } from "bun:test";
mock.module("hono", () => ({ Hono: class { constructor() { throw new Error("routing started before password guard"); } } }));
mock.module("hono/bun", () => ({ serveStatic() { throw new Error("static routing started before password guard"); } }));
mock.module("web-push", () => ({ default: {
  setVapidDetails() { throw new Error("push setup started before password guard"); },
  sendNotification() { throw new Error("push delivery started before password guard"); },
} }));
await import(${JSON.stringify(join(import.meta.dir, "../../Claude/app/server.ts"))});
`);
  const server = Bun.spawn([process.execPath, runner], {
    cwd: home, env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home,
      EMBERVY_APP_PORT: "0", EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_DATA_DIR: join(home, "data"),
      APP_PASSWORD: "", APP_SESSION_SECRET: "", INTERNAL_API_TOKEN: "house-internal-token", EMBERVY_TERMINAL_PANEL: "0" },
    stdout: "ignore", stderr: "pipe",
  });
  const code = await server.exited;
  expect(code).not.toBe(0);
  expect(await new Response(server.stderr).text()).toContain("APP_PASSWORD is empty");
}, 20_000);

describe("app password detection", () => {
  test("an active house unit fails with an empty password and accepts a configured password", () => {
    const home = house(null);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=active\\n"\n', { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}`, EMBERVY_APP_SERVICE: "embervy-second-app", EMBERVY_APP_PORT: "9", RAG_AUTH_TOKEN: "long-rag-token" };
    const missing = find(doctor(home, env), "health.defaults");
    expect(missing?.status).toBe("FAIL");
    expect(missing?.detail).toContain("APP_PASSWORD is empty");
    expect(missing?.fix).toContain("restart embervy-second-app");
    expect(find(doctor(home, { ...env, APP_PASSWORD: "a-real-house-password", APP_SESSION_SECRET: "s".repeat(48) }), "health.defaults")?.status).toBe("OK");
    writeFileSync(join(home, ".env"), "APP_PASSWORD=\n");
    expect(find(doctor(home, { ...env, APP_PASSWORD: "inherited-password", APP_SESSION_SECRET: "s".repeat(48) }), "health.defaults")?.status).toBe("FAIL");
  });

  test("an absent app is not checked, not claimed protected", () => {
    const home = house(null);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "LoadState=not-found\\nActiveState=inactive\\n"\n', { mode: 0o755 });
    const line = find(doctor(home, { PATH: `${bin}:${process.env.PATH}`, EMBERVY_APP_PORT: "9", RAG_AUTH_TOKEN: "long-rag-token" }), "health.app_password");
    expect(line?.status).toBe("SKIP");
    expect(line?.detail).toContain("no app layer");
  });

  test("a responding port fails even if the service is unavailable", async () => {
    const home = house(null);
    const app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("alive") });
    try {
      const report = await doctorAsync(home, { EMBERVY_APP_PORT: String(app.port), RAG_AUTH_TOKEN: "long-rag-token" });
      expect(find(report, "health.defaults")?.detail).toContain("APP_PASSWORD is empty");
      expect(find(report, "health.defaults")?.status).toBe("FAIL");
    } finally { app.stop(true); }
  });
});

for (const harness of ["brain", "claude-code"]) {
  test(`nightly health follows the agent tool on ${harness}`, async () => {
    let health: any = {};
    let archiveAgeHours = 27;
    const calls: any[] = [];
    const worker = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ ok: true });
      if (req.headers.get("Authorization") === "Bearer house-rag-key") {
        if (path === "/list") return Response.json({ files: [{ name: "Session_1.md", size: 100, uploaded: new Date(Date.now() - archiveAgeHours * 3600000).toISOString() }] });
        if (path === "/search") return Response.json({ mode: "hybrid", reranked: true, counts: { vector: 1, bm25: 1 }, results: [{ sources: ["Session_1.md"] }] });
        return Response.json({ ok: true });
      }
      if (req.headers.get("Authorization") !== "Bearer house-memory-key") return new Response("unauthorized", { status: 401 });
      const body = await req.json() as any;
      if (body.method === "tools/call") {
        calls.push(body.params);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `health\n\n\`\`\`json\n${JSON.stringify(health)}\n\`\`\`` }] } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    } });
    const home = house(null);
    const env = { EMBERVY_HARNESS: harness, EMBERVY_URL: `http://127.0.0.1:${worker.port}`, EMBERVY_API_KEY: "house-memory-key", EMBERVY_APP_PORT: "9" };
    const started = (hours: number) => writeFileSync(join(home, "state.json"), JSON.stringify({ started_at: new Date(Date.now() - hours * 3600000).toISOString() }));
    try {
      started(2);
      health = { daemon_last_run: null, daemon_last_ok: false, dream_last_run: null, warnings: ["daemon never ran"] };
      let line = find(await doctorAsync(home, env), "memory.nightly");
      expect(line?.status).toBe("OK");
      expect(line?.detail).toContain("not due yet");
      started(27);
      line = find(await doctorAsync(home, env), "memory.nightly");
      expect(line?.status).toBe("WARN");
      expect(line?.detail).toContain("the nightly run has not happened yet");
      const recent = new Date(Date.now() - 3600000).toISOString();
      health = { daemon_last_run: recent, daemon_last_ok: false, dream_last_run: recent, warnings: ["last daemon run failed: model unavailable"] };
      line = find(await doctorAsync(home, env), "memory.nightly");
      expect(line?.status).toBe("WARN");
      expect(line?.detail).toContain("model unavailable");
      health.daemon_last_ok = true;
      health.warnings = [];
      expect(find(await doctorAsync(home, env), "memory.nightly")?.status).toBe("OK");
      health.dream_last_run = new Date(Date.now() - 27 * 3600000).toISOString();
      expect(find(await doctorAsync(home, env), "memory.nightly")?.status).toBe("WARN");
      health.dream_last_run = null;
      line = find(await doctorAsync(home, { ...env, EMBERVY_DREAM: "off" }), "memory.nightly");
      expect(line?.status).toBe("OK");
      expect(line?.detail).toContain("dream: off");
      health = {};
      line = find(await doctorAsync(home, env), "memory.nightly");
      expect(line?.status).toBe("WARN");
      expect(line?.detail).toContain("not checked");
      rmSync(join(home, "state.json"));
      health = { daemon_last_run: null, daemon_last_ok: false, dream_last_run: null, warnings: [] };
      line = find(await doctorAsync(home, env), "memory.nightly");
      expect(line?.status).toBe("SKIP");
      expect(line?.detail).toContain("house age unknown");
      started(2);
      health.warnings = ["last daemon run failed: scheduler error"];
      line = find(await doctorAsync(home, env), "memory.nightly");
      expect(line?.status).toBe("WARN");
      expect(line?.detail).toContain("scheduler error");
      rmSync(join(home, "state.json"));
      health.warnings = [];
      const archiveEnv = { ...env, RAG_URL: `http://127.0.0.1:${worker.port}`, RAG_AUTH_TOKEN: "house-rag-key" };
      line = find(await doctorAsync(home, archiveEnv), "memory.nightly");
      expect(line?.status).toBe("WARN");
      expect(line?.detail).toContain("the nightly run has not happened yet");
      archiveAgeHours = 2;
      line = find(await doctorAsync(home, archiveEnv), "memory.nightly");
      expect(line?.status).toBe("OK");
      expect(line?.detail).toContain("not due yet");
      expect(calls.every(params => params.name === "health")).toBe(true);
      expect(calls.length).toBe(11);
    } finally { worker.stop(true); }
  }, 60_000);
}

const probeThemes = "amber orchard pruning and harvest planning";
const probeHit = "[Session_25.md] (85% [rerank])\nArchive content";
const probeFiles = Array.from({ length: 25 }, (_, i) => ({ name: `Session_${i + 1}.md`, size: 100, uploaded: new Date(1700000000000 + i * 1000).toISOString() }));
type ProbeOptions = { empty?: boolean; unreadable?: boolean; noThemes?: boolean; offline?: boolean; override?: string; brain?: boolean; noHit?: boolean; exit?: number; newestUnreadable?: boolean; missingScript?: boolean; brainInlet?: "disabled" | "unconfigured" };

function contentProbe(options: ProbeOptions = {}) {
  const home = house(options.brainInlet === "unconfigured" ? "BRAIN_INLET=true\n"
    : `${options.brainInlet === "disabled" ? "BRAIN_INLET=false\n" : ""}BRAIN_INLET_WORKER=$HOME/Claude/scripts/inlet-worker.ts\n`);
  const worker = join(home, "Claude/scripts/inlet-worker.ts");
  const fallback = join(home, "fallback.ts");
  const callsFile = join(home, "calls.json");
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  const logger = `
import { readFileSync, writeFileSync } from "node:fs";
function log(call) {
  let calls = [];
  try { calls = JSON.parse(readFileSync(${JSON.stringify(callsFile)}, "utf8")); } catch {}
  calls.push(call);
  writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
}`;
  const workerSource = `${logger}
const options = ${JSON.stringify(options)};
log({ command: "bun", args: process.argv.slice(1), cwd: process.cwd() });
const query = process.argv[2];
const expected = options.override || ${JSON.stringify(probeThemes)};
// Boilerplate is below the simulated confidence floor; archive content is above it.
process.stdout.write(query === expected && query !== "session" && !options.noHit ? ${JSON.stringify(probeHit)} : "");
process.exit(options.exit ?? 0);
`;
  writeFileSync(worker, workerSource);
  writeFileSync(fallback, workerSource);
  if (options.missingScript) rmSync(options.brain ? worker : fallback);
  const runner = join(home, "probe-runner.ts");
  // Isolate the exiting executable and stub HTTP so no live service is contacted.
  writeFileSync(runner, `${logger}
const options = ${JSON.stringify(options)};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  log({ url: String(url), body: init.body });
  if (options.offline) throw new Error("offline must not call HTTP");
  if (!init.headers?.Authorization) return new Response("unauthorized", { status: 401 });
  if (u.pathname === "/list") return Response.json({ files: options.empty ? [] : ${JSON.stringify(probeFiles)} });
  if (u.pathname === "/head") {
    if (options.unreadable || options.newestUnreadable && u.searchParams.get("filename") === "Session_25.md") return new Response("unreadable", { status: 403 });
    return Response.json({ head: options.noThemes ? "SUMMARY=no topics" : ${JSON.stringify(`THEMES=${probeThemes}\nSUMMARY=archive content`)} });
  }
  if (u.pathname === "/search") return Response.json({ mode: "hybrid", reranked: true, counts: { vector: 1, bm25: 1 }, results: [{ sources: ["rerank"] }] });
  if (u.pathname === "/") return new Response("RAG API\\n");
  return Response.json({});
};
await import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});
`);
  const result = Bun.spawnSync([process.execPath, runner, "--json", ...(options.offline ? ["--offline"] : [])], {
    cwd: home, stdout: "pipe", stderr: "pipe",
    env: { PATH: bin, HOME: home, EMBERVY_HOME: home,
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs"),
      RAG_URL: "https://rag.invalid", RAG_AUTH_TOKEN: "isolated-test-token",
      INLET_SCRIPT: fallback, EMBERVY_HARNESS: options.brain ? "brain" : "claude-code",
      EMBERVY_DOCTOR_SKIP_CANARY: "1", EMBERVY_APP_PORT: "9",
      ...(options.override ? { DOCTOR_PROBE_QUERY: options.override } : {}) },
  });
  expect(result.stderr.toString()).toBe("");
  const report = JSON.parse(result.stdout.toString());
  const check = report.checks.find((c: any) => c.id === "inlet");
  expect(check).toBeDefined();
  let calls: any[] = [];
  try { calls = JSON.parse(readFileSync(callsFile, "utf8")); } catch {}
  return { check, calls, worker, fallback };
}

describe("archive-derived inlet probe", () => {
  test("grown archive is OK exactly when derived content returns a retrieved hit", () => {
    const ok = contentProbe();
    expect(ok.check.status).toBe("OK");
    expect(ok.calls.find(c => c.command === "bun").args).toEqual([ok.fallback, probeThemes]);
    expect(ok.calls.find(c => c.url?.includes("/head?")).url).toContain("filename=Session_25.md");
    expect(JSON.parse(ok.calls.find(c => c.url?.endsWith("/search")).body).query).toBe(probeThemes);
    expect(contentProbe({ noHit: true }).check.status).toBe("WARN");
    expect(contentProbe({ exit: 1 }).check.status).toBe("WARN");
    expect(contentProbe({ override: "session" }).check.status).toBe("WARN");
  });

  for (const options of [{ empty: true }, { unreadable: true }, { noThemes: true }, { offline: true }]) {
    test(`no derivable question skips without running the inlet: ${JSON.stringify(options)}`, () => {
      const result = contentProbe(options);
      expect(result.check.status).toBe("SKIP");
      expect(result.check.detail).toMatch(/empty|readable|offline/);
      expect(result.check.detail).not.toContain("\n");
      expect(result.calls.some(c => c.command === "bun")).toBe(false);
    });
  }

  test("explicit query wins even with no archive, without reading a header", () => {
    const result = contentProbe({ override: "specific archived topic", empty: true });
    expect(result.check.status).toBe("OK");
    expect(result.calls.find(c => c.command === "bun").args[1]).toBe("specific archived topic");
    expect(result.calls.some(c => c.url?.includes("/head?"))).toBe(false);
    expect(JSON.parse(result.calls.find(c => c.url?.endsWith("/search")).body).query).toBe("specific archived topic");
  });

  test("missing configured scripts fail before offline or unavailable-question skips", () => {
    for (const brain of [false, true]) {
      for (const unavailable of [{ offline: true }, { empty: true }, { unreadable: true }, { noThemes: true }]) {
        const result = contentProbe({ brain, missingScript: true, ...unavailable });
        expect(result.check.status).toBe("FAIL");
        expect(result.check.detail).toContain("missing");
        expect(result.calls.some(c => c.command === "bun")).toBe(false);
      }
    }
  });

  test("deliberately disabled or unconfigured workers retain their own skip reason", () => {
    for (const brainInlet of ["disabled", "unconfigured"] as const) {
      for (const unavailable of [{ offline: true }, { empty: true }]) {
        const result = contentProbe({ brain: true, brainInlet, missingScript: true, ...unavailable });
        expect(result.check.status).toBe("SKIP");
        expect(result.check.detail).toContain(brainInlet === "disabled" ? "disabled" : "no BRAIN_INLET_WORKER");
        expect(result.calls.some(c => c.command === "bun")).toBe(false);
      }
    }
  });

  test("an unreadable newest header falls back to the next readable session", () => {
    const result = contentProbe({ newestUnreadable: true });
    expect(result.check.status).toBe("OK");
    expect(result.calls.filter(c => c.url?.includes("/head?")).map(c => new URL(c.url).searchParams.get("filename"))).toEqual(["Session_25.md", "Session_24.md"]);
  });

  test("Brain probe spawns its own worker with that script's directory as cwd", () => {
    const result = contentProbe({ brain: true });
    expect(result.check.status).toBe("OK");
    const call = result.calls.find(c => c.command === "bun");
    expect(call.args).toEqual([result.worker, probeThemes]);
    expect(call.cwd).toBe(join(result.worker, ".."));
    expect(call.args[0]).not.toBe(result.fallback);
  });
});

describe("the system prompt on the Brain harness", () => {
  const promptEnv = "BRAIN_SYSTEM=$HOME/EMBERVY.md\nBRAIN_CLAUDE_CWD=$HOME\n";

  test("Brain's own prompt file is the one checked, and it is loaded once", () => {
    const home = house(promptEnv);
    writeFileSync(join(home, "EMBERVY.md"), "# Who I am\n");
    const report = doctor(home, { EMBERVY_HARNESS: "brain" });
    expect(find(report, "adapter.doc")?.label).toBe("EMBERVY.md present");
    expect(find(report, "adapter.doc")?.status).toBe("OK");
    expect(find(report, "adapter.once")?.status).toBe("OK");
  });

  test("a CLAUDE.md beside it is read by a pipe head as well: a warning that names both", () => {
    const home = house(promptEnv);
    writeFileSync(join(home, "EMBERVY.md"), "# Who I am\n");
    writeFileSync(join(home, "CLAUDE.md"), "# Who I was\n");
    const line = find(doctor(home, { EMBERVY_HARNESS: "brain" }), "adapter.once");
    expect(line?.status).toBe("WARN");
    expect(line?.detail).toBe("CLAUDE.md beside EMBERVY.md: a head reads both");
  });

  test("a missing prompt file fails and says Brain falls back to its built-in prompt", () => {
    const home = house(promptEnv);
    const line = find(doctor(home, { EMBERVY_HARNESS: "brain" }), "adapter.doc") as { status: string; label: string; fix?: string } | undefined;
    expect(line?.status).toBe("FAIL");
    expect(line?.label).toBe("EMBERVY.md present");
    expect(line?.fix).toContain("built-in prompt");
  });

  test("an older Brain house without BRAIN_SYSTEM keeps its CLAUDE.md check, with no second-file line", () => {
    const home = house("BRAIN_INLET=true\n");
    writeFileSync(join(home, "CLAUDE.md"), "# Who I am\n");
    const report = doctor(home, { EMBERVY_HARNESS: "brain" });
    expect(find(report, "adapter.doc")?.label).toBe("CLAUDE.md present");
    expect(find(report, "adapter.once")).toBeUndefined();
  });
});
