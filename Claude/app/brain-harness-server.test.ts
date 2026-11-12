import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An inbox-owning harness also owns commands and process control; the app must only deliver messages.
// Stubbed process commands and decoy processes expose any attempt to cross that boundary.

const INTERNAL = "internal-test-token-0123456789";
const PASSWORD = "test-password-not-real";
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

interface House {
  base: string;
  dataDir: string;
  homeDir: string;
  cookie: string;
  decoy: ReturnType<typeof Bun.spawn>;
  adapterHits: () => number;
  calls: () => string;
  message: (text: string) => Promise<{ status: number; body: any }>;
  get: (path: string, bearer?: boolean) => Promise<{ status: number; body: any }>;
  post: (path: string, body: unknown, bearer?: boolean) => Promise<{ status: number; body: any }>;
  jsonl: (name: string) => any[];
  decoyAlive: () => boolean;
  stop: () => Promise<void>;
}

import { startTestApp } from "./test-app-start";

async function until(condition: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error("test condition did not become true before its deadline");
}

async function startHouse(env: Record<string, string>): Promise<House> {
  const dir = mkdtempSync(join(tmpdir(), "brain-harness-"));
  const dataDir = join(dir, "data");
  const homeDir = join(dir, "embervy-home");
  const binDir = join(dir, "bin");
  const callsLog = join(dir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(homeDir, "logs"), { recursive: true });
  mkdirSync(join(homeDir, "state"), { recursive: true });
  writeFileSync(join(homeDir, ".env"), "EMBERVY_GPT_MODEL=gpt-5.6-terra\n");
  writeFileSync(
    join(homeDir, "state", "watchdog_state.json"),
    JSON.stringify({
      last_check_ts: new Date().toISOString(), tokens: 1234, percent: 12, warn_tokens: 700000, cut_tokens: 850000,
      session_file: "", warn_active: false, last_warn_ts: "", last_cut_ts: "", pid: 1,
    }),
  );

  // Service membership belongs to the fixture, not to the service running the test suite.
  writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "systemctl"), 0o755);
  for (const name of ["pgrep", "pkill", "setsid", "tmux"]) {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${name === "pgrep" ? 'cat "$STUB_PGREP_PIDS" 2>/dev/null\n' : ""}exit 0\n`);
    chmodSync(file, 0o755);
  }
  const decoyScript = join(dir, `process-fixture-${crypto.randomUUID()}.ts`);
  writeFileSync(decoyScript, 'await Bun.write(process.argv[2], "ready"); setInterval(() => {}, 1000);\n');
  const decoy = Bun.spawn([process.execPath, decoyScript, join(dir, "owned-ready")], { cwd: homeDir, stdout: "ignore", stderr: "ignore" });
  const foreign = Bun.spawn([process.execPath, decoyScript, join(dir, "foreign-ready")], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  await until(() => existsSync(join(dir, "owned-ready")) && existsSync(join(dir, "foreign-ready")));
  writeFileSync(join(dir, "pgrep-pids"), `${decoy.pid}\n${foreign.pid}\n`);

  let hits = 0;
  const adapter = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      hits++;
      const started = existsSync(callsLog) && readFileSync(callsLog, "utf8").includes("setsid");
      return Response.json({ ok: true, model: started ? "gpt-5.6-luna" : "gpt-5.6-terra" });
    },
  });

  const { base, proc: server, cookie } = await startTestApp({
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: dir,
      TMUX_TMPDIR: dir,
      STUB_LOG: callsLog,
      STUB_PGREP_PIDS: join(dir, "pgrep-pids"),
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: dataDir,
      EMBERVY_HOME: homeDir,
      WATCHDOG_STATE_PATH: join(homeDir, "state", "watchdog_state.json"),
      GPT_ADAPTER_PORT: String(adapter.port),
      EMBERVY_STRINGS_LOCAL: join(dir, "no-such-strings.local.json"),
      INTERNAL_API_TOKEN: INTERNAL,
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "harness-test-no-such-session",
      AGENT_LABEL: "Testagent",
      USER_LABEL: "Sam",
      ...env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  const call = async (method: string, path: string, body: unknown, bearer: boolean) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: bearer
        ? { "content-type": "application/json", authorization: `Bearer ${INTERNAL}` }
        : { ...viaTunnel, "content-type": "application/json", cookie },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const jsonl = (name: string): any[] => {
    const f = join(dataDir, name);
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const decoyAlive = () => { try { process.kill(decoy.pid, 0); return decoy.exitCode === null && decoy.signalCode === null; } catch { return false; } };

  return {
    base, dataDir, homeDir, cookie, decoy,
    adapterHits: () => hits,
    calls: () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8") : ""),
    message: (text) => call("POST", "/api/message", { text }, false),
    get: (path, bearer = false) => call("GET", path, undefined, bearer),
    post: (path, body, bearer = false) => call("POST", path, body, bearer),
    jsonl,
    decoyAlive,
    stop: async () => {
      server.kill();
      adapter.stop(true);
      expect(foreign.exitCode).toBe(null);
      expect(foreign.signalCode).toBe(null);
      foreign.kill();
      decoy.kill();
      await Promise.all([server.exited, foreign.exited, decoy.exited]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("named house model injection uses its socket for both commands", async () => {
  const house = await startHouse({ EMBERVY_SUBSTRATE: "claude", EMBERVY_TMUX_SOCKET: "house-two" });
  try {
    expect((await house.post("/api/internal/model", { model: "opus" }, true)).status).toBe(200);
    const calls = house.calls().split("\n").filter(line => line.startsWith("tmux "));
    expect(calls).toEqual([
      "tmux -L house-two send-keys -t harness-test-no-such-session /model opus Enter",
      "tmux -L house-two send-keys -t harness-test-no-such-session Enter",
    ]);
  } finally { await house.stop(); }
}, 15_000);

test("media proxy sends all routes to the configured video backend", async () => {
  const paths: string[] = [];
  const video = Bun.serve({ port: 0, hostname: "localhost", fetch(req) { paths.push(new URL(req.url).pathname); return new Response("media"); } });
  const house = await startHouse({ EMBERVY_VIDEO_PORT: String(video.port), EXTERNAL_PUSH_TOKEN: INTERNAL });
  try {
    for (const path of ["watch", "listen", "audio"]) {
      const response = await fetch(`${house.base}/api/external/${path}`, {
        method: "POST", headers: { authorization: `Bearer ${INTERNAL}`, "content-type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("media");
    }
    expect(paths).toEqual(["/watch", "/listen", "/audio"]);
  } finally { await house.stop(); video.stop(true); }
}, 15_000);

const BRAIN_COMMANDS = [
  "/status", "/heads", "/head claude", "/model x", "/model terra", "/effort high", "/move claude",
  "/respawn", "/exit", "/exit now", "/pins", "/unpin 3", "/help", "/somethingelse with args",
];

describe("Brain house (EMBERVY_HARNESS=brain) — GPT flags set on purpose, the worst case", () => {
  let house: House;
  beforeAll(async () => {
    house = await startHouse({ EMBERVY_HARNESS: "brain", EMBERVY_SUBSTRATE: "gpt", EMBERVY_BACKEND: "gpt" });
  }, 30_000);
  afterAll(() => house?.stop());

  test("every command Brain answers goes to the inbox as a normal message and is not answered by the app", async () => {
    for (const cmd of BRAIN_COMMANDS) {
      const r = await house.message(cmd);
      expect([cmd, r.status, r.body.ok, "slash" in r.body]).toEqual([cmd, 200, true, false]);
    }
    const inbox = house.jsonl("inbox.jsonl");
    expect(inbox.map((m) => m.text)).toEqual(BRAIN_COMMANDS);
    expect(inbox.every((m) => m.type === "text" && typeof m.id === "string")).toBe(true);
    expect(house.jsonl("outbox.jsonl")).toEqual([]);
  });

  test("/model x in particular: inbox yes, adapter never asked, nothing killed or started", async () => {
    const before = house.jsonl("inbox.jsonl").length;
    const r = await house.message("/model x");
    expect(r.body.slash).toBeUndefined();
    expect(house.jsonl("inbox.jsonl").length).toBe(before + 1);
    expect(house.jsonl("inbox.jsonl").at(-1).text).toBe("/model x");
    expect(house.adapterHits()).toBe(0);
    expect(house.calls()).toBe("");
    expect(house.decoyAlive()).toBe(true);
    expect(readFileSync(join(house.homeDir, ".env"), "utf8")).toBe("EMBERVY_GPT_MODEL=gpt-5.6-terra\n");
  });

  test("/watch is the one command the app still answers itself (it only reads the watchdog state file)", async () => {
    const before = house.jsonl("inbox.jsonl").length;
    const r = await house.message("/watch");
    expect(r.body.slash).toBe(true);
    expect(house.jsonl("inbox.jsonl").length).toBe(before);
    const answer = house.jsonl("outbox.jsonl").at(-1);
    expect(answer.text).toContain("Watchdog: alive");
    expect(answer.text).toContain("1,234 tokens");
    expect(answer.text).toContain("Thresholds: WARN 700,000 tokens, CUT 850,000 tokens");
    expect(answer.text).not.toContain("%");
    expect(answer.text).not.toContain("NaN");
    expect(answer.text).not.toContain("undefined");
  });

  test("/watch reads Brain's own watchdog state (no warn threshold, session_id): tokens, no NaN", async () => {
    writeFileSync(
      join(house.homeDir, "state", "watchdog_state.json"),
      JSON.stringify({
        last_check_ts: new Date().toISOString(), tokens: 5678, percent: 3, cut_tokens: 900000, session_id: "abc-123",
        warn_active: false, last_warn_ts: "", last_cut_ts: "", pid: 1,
      }),
    );
    expect((await house.message("/watch")).body.slash).toBe(true);
    const text = house.jsonl("outbox.jsonl").at(-1).text;
    expect(text).toContain("Watchdog: alive");
    expect(text).toContain("Context: 5,678 tokens");
    expect(text).not.toContain("%");
    expect(text).toContain("Cut threshold: 900,000 tokens");
    expect(text).toContain("Session: abc-123");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("/watch shows Claude Code thresholds against its known 1M window", async () => {
    writeFileSync(join(house.homeDir, "state", "watchdog_state.json"), JSON.stringify({
      last_check_ts: new Date().toISOString(), tokens: 1234, percent: 12, window: 1000000,
      warn_tokens: 700000, cut_tokens: 850000, session_file: "", warn_active: false,
      last_warn_ts: "", last_cut_ts: "", pid: 1,
    }));
    expect((await house.message("/watch")).body.slash).toBe(true);
    const text = house.jsonl("outbox.jsonl").at(-1).text;
    expect(text).toContain("Thresholds: WARN 70%, CUT 85%");
    expect(text).toContain(" / 1M tokens");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("/watch computes Brain's percentage from its window, not the recorded percent", async () => {
    writeFileSync(join(house.homeDir, "state", "watchdog_state.json"), JSON.stringify({
      last_check_ts: new Date().toISOString(), tokens: 5678, percent: 3, window: 262144,
      cut_tokens: 900000, session_id: "abc-123", warn_active: false,
      last_warn_ts: "", last_cut_ts: "", pid: 1,
    }));
    expect((await house.message("/watch")).body.slash).toBe(true);
    const text = house.jsonl("outbox.jsonl").at(-1).text;
    expect(text).toContain(`Context: 5,678 tokens (${Math.floor(5678 * 100 / 262144)}%) / 262,144 tokens`);
    expect(text).toContain("Cut threshold: 900,000 tokens");
    expect(text).toContain("Session: abc-123");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  });

  test("GET /api/gpt-model answers substrate brain (the settings page hides the GPT switcher) without asking the adapter", async () => {
    const r = await house.get("/api/gpt-model");
    expect(r).toEqual({ status: 200, body: { substrate: "brain" } });
    expect(house.adapterHits()).toBe(0);
  });

  test("the header dropdown hides itself: GET /api/internal/model is not switchable", async () => {
    const r = await house.get("/api/internal/model", true);
    expect(r).toEqual({ status: 200, body: { ok: true, model: null, substrate: "brain", switchable: false } });
  });

  test("POST /api/internal/model answers 409 with the reason — for engines, models and nonsense alike", async () => {
    for (const body of [{ model: "glm" }, { model: "kimi" }, { model: "claude" }, { model: "opus" }, { model: "nonsense" }, {}]) {
      const r = await house.post("/api/internal/model", body, true);
      expect([JSON.stringify(body), r.status]).toEqual([JSON.stringify(body), 409]);
      expect(r.body.error).toBe("The head is chosen inside Brain: send /head or /model in the chat.");
    }
    expect((await house.post("/api/internal/model", { model: "opus" }, false)).status).toBe(409);
    expect(existsSync(join(house.dataDir, "current_model"))).toBe(false);
  });

  test("nothing was killed, started or typed into during this whole run", () => {
    expect(house.calls()).toBe("");
    expect(house.decoyAlive()).toBe(true);
    expect(house.adapterHits()).toBe(0);
  });
});

describe("Brain house on a Claude head (EMBERVY_SUBSTRATE=claude): no tmux /model, no switch-backend.sh", () => {
  let house: House;
  beforeAll(async () => {
    house = await startHouse({ EMBERVY_HARNESS: "Brain", EMBERVY_SUBSTRATE: "claude" });
  }, 30_000);
  afterAll(() => house?.stop());

  test("/model, /exit and /respawn land in the inbox; the settings page hears substrate brain", async () => {
    for (const cmd of ["/model opus", "/exit", "/respawn"]) {
      const r = await house.message(cmd);
      expect([cmd, r.status, "slash" in r.body]).toEqual([cmd, 200, false]);
    }
    expect(house.jsonl("inbox.jsonl").map((m) => m.text)).toEqual(["/model opus", "/exit", "/respawn"]);
    expect((await house.get("/api/gpt-model")).body).toEqual({ substrate: "brain" });
  });

  test("POST /api/internal/model is 409 even for the engine names that would start switch-backend.sh", async () => {
    for (const model of ["glm", "kimi", "minimax", "claude", "opus", "sonnet"]) {
      expect((await house.post("/api/internal/model", { model }, true)).status).toBe(409);
    }
    expect((await house.get("/api/internal/model", true)).body).toEqual({ ok: true, model: null, substrate: "brain", switchable: false });
    expect(house.calls()).toBe("");
    expect(existsSync(join(house.dataDir, "current_model"))).toBe(false);
    expect(house.decoyAlive()).toBe(true);
  });
});

describe("no EMBERVY_HARNESS: today's Claude Code behaviour holds", () => {
  describe("GPT substrate (EMBERVY_HARNESS=claude-code is the same as absent)", () => {
    let house: House;
    beforeAll(async () => {
      house = await startHouse({ EMBERVY_HARNESS: "claude-code", EMBERVY_SUBSTRATE: "gpt", EMBERVY_BACKEND: "gpt" });
    }, 30_000);
    afterAll(() => house?.stop());

    test("GET /api/gpt-model reports the substrate and the adapter's model", async () => {
      expect((await house.get("/api/gpt-model")).body).toEqual({ substrate: "gpt", model: "gpt-5.6-terra" });
    });

    test("/model luna is intercepted: adapter replaced (old one killed, new one started), .env updated, answer in the outbox", async () => {
      expect(house.decoyAlive()).toBe(true);
      const r = await house.message("/model luna");
      expect(r.body.slash).toBe(true);
      expect(house.jsonl("inbox.jsonl")).toEqual([]);
      const calls = house.calls();
      expect(calls).toContain("pgrep -f chatgpt-oauth-adapter.ts");
      expect(calls).toContain("setsid bun");
      await until(() => !house.decoyAlive(), 3000);
      expect(house.decoyAlive()).toBe(false);
      expect(readFileSync(join(house.homeDir, ".env"), "utf8")).toContain("EMBERVY_GPT_MODEL=gpt-5.6-luna");
      expect(house.jsonl("outbox.jsonl").at(-1).text).toContain("Switched to gpt-5.6-luna");
    });

    test("/exit and any other command still go to the inbox; POST /api/internal/model keeps its old refusal", async () => {
      expect((await house.message("/exit")).body.slash).toBeUndefined();
      expect(house.jsonl("inbox.jsonl").map((m) => m.text)).toEqual(["/exit"]);
      const r = await house.post("/api/internal/model", { model: "glm" }, true);
      expect(r).toEqual({ status: 409, body: { error: "model switching is unavailable for this substrate" } });
    });
  });

  describe("Claude substrate", () => {
    let house: House;
    beforeAll(async () => {
      house = await startHouse({ EMBERVY_SUBSTRATE: "claude" });
    }, 30_000);
    afterAll(() => house?.stop());

    test("GET /api/gpt-model reports the substrate only; GET /api/internal/model is unchanged", async () => {
      expect((await house.get("/api/gpt-model")).body).toEqual({ substrate: "claude" });
      expect((await house.get("/api/internal/model", true)).body).toEqual({ ok: true, model: null });
    });

    test("/model is still intercepted (and explains itself); adapter and tmux stay untouched", async () => {
      const r = await house.message("/model opus");
      expect(r.body.slash).toBe(true);
      expect(house.jsonl("inbox.jsonl")).toEqual([]);
      expect(house.jsonl("outbox.jsonl").at(-1).text).toContain("only available on the GPT substrate");
      expect(house.calls()).toBe("");
    });

    test("POST /api/internal/model still starts switch-backend.sh for an engine and types /model into tmux for a model", async () => {
      const engine = await house.post("/api/internal/model", { model: "glm" }, true);
      expect(engine).toEqual({ status: 202, body: { ok: true, mode: "respawn", to: "glm" } });
      await until(() => house.calls().includes("switch-backend.sh"));
      expect(house.calls()).toContain("switch-backend.sh --to=glm");
      const model = await house.post("/api/internal/model", { model: "opus" }, true);
      expect(model.status).toBe(200);
      expect(house.calls()).toContain("tmux -L embervy send-keys -t harness-test-no-such-session /model opus Enter");
    });
  });
});
