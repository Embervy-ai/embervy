import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adoptLegacyEnv, appToolNames, currentEnvName, loreToolNames, envValue, houseHome, isBrainSubturn, legacyEnvName, MEMORY_REF_RE, reserveFile,
  HOME_DIR, MEMORY_IMAGE_PATH, MEMORY_VIDEO_PATH, SESSION_COOKIE,
} from "./legacy-names";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..");
const LIB = join(HERE, "env-file.sh");
const scratch = mkdtempSync(join(tmpdir(), "names-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const PATH = process.env.PATH ?? "/usr/bin:/bin";

function bash(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", script, "_", LIB, ...args], { env: { PATH, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("shared runtime names", () => {
  test("environment keys are read exactly, including empty values", () => {
    expect(envValue("EMBERVY_TIMEZONE", { EMBERVY_TIMEZONE: "UTC", TIMEZONE: "other" })).toBe("UTC");
    expect(envValue("EMBERVY_X", { EMBERVY_X: "", X: "other" })).toBe("");
    expect(envValue("EMBERVY_X", { X: "other" })).toBeUndefined();
    expect(envValue("RAG_URL", { RAG_URL: "r" })).toBe("r");
    const reads: string[] = [];
    const env = new Proxy({}, { get: (_target, key) => { reads.push(String(key)); return undefined; } });
    expect(envValue("EMBERVY_APP_PORT", env)).toBeUndefined();
    expect(reads).toEqual(["EMBERVY_APP_PORT"]);
    for (const key of ["EMBERVY_TIMEZONE", "EMBERVY_APP_PORT", "BRAIN_MEMORY_URL", "RAG_URL"]) {
      expect(legacyEnvName(key)).toBeUndefined();
      expect(currentEnvName(key)).toBeUndefined();
    }
  });

  test("the configured home or the default is independent of filesystem contents", () => {
    expect(houseHome({ EMBERVY_HOME: "/srv/x" })).toBe("/srv/x");
    for (const env of [{}, { EMBERVY_HOME: "" }]) {
      expect(houseHome(env, () => true)).toBe(HOME_DIR);
      expect(houseHome(env, () => false)).toBe("/opt/embervy");
    }
    expect(reserveFile(() => true)).toBe("/var/lib/embervy/reserve.img");
    expect(reserveFile(() => false)).toBe("/var/lib/embervy/reserve.img");
  });

  test("subturns, tools, references, media and sessions use supported names", () => {
    expect(isBrainSubturn({ EMBERVY_BRAIN_SUBTURN: "1" })).toBe(true);
    expect(isBrainSubturn({ EMBERVY_BRAIN_SUBTURN: "0" })).toBe(false);
    expect(isBrainSubturn({})).toBe(false);
    expect(appToolNames("reply")).toEqual(["mcp__app__reply"]);
    expect(loreToolNames("wake")).toEqual(["mcp__lore__wake", "mcp__memory__wake"]);
    for (const ref of ["memory:0", "memory:42", "memory:999999999"]) expect(MEMORY_REF_RE.test(ref)).toBe(true);
    for (const ref of ["other:42", "memory:1000000000", "memory:42x", "memory:"]) expect(MEMORY_REF_RE.test(ref)).toBe(false);
    expect([MEMORY_IMAGE_PATH, MEMORY_VIDEO_PATH, SESSION_COOKIE]).toEqual(["/api/memory-image", "/api/memory-video", "embervy_session"]);
  });

  test("environment adoption preserves explicit settings and does not create keys", () => {
    const env = Object.freeze({
      BRAIN_MEMORY_URL: "https://memory.example", BRAIN_MEMORY_API_KEY: "",
      EMBERVY_TIMEZONE: "UTC", EMBERVY_GPT_MODEL: "model", BRAIN_CACHE_PING: "on", constructor: "x",
    });
    const expected = { ...env };
    adoptLegacyEnv(env);
    expect(env).toEqual(expected);
    const aliases = join(REPO, "Brain", "aliases.ts");
    const r = Bun.spawnSync(["bun", "-e", `import { ALIASES } from ${JSON.stringify(aliases)}; const e = { BRAIN_MEMORY_URL: "u" }; ALIASES.env(e); console.log(JSON.stringify(e))`], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual({ BRAIN_MEMORY_URL: "u" });
  });
});

describe("shell runtime names through env-file.sh", () => {
  test("inherited settings remain exported under their exact keys", () => {
    const r = bash('set -euo pipefail; . "$1"; printf "%s|%s|%s" "$EMBERVY_HOME" "$EMBERVY_KEEP" "$(printenv EMBERVY_HOME)"', [], { EMBERVY_HOME: "/srv/house", EMBERVY_KEEP: "value" });
    expect(r).toEqual({ code: 0, out: "/srv/house|value|/srv/house", err: "" });
  });

  test("file settings retain exact keys and explicit empty values, exporting only with -x", () => {
    const f = join(scratch, "house.env");
    writeFileSync(f, "EMBERVY_A=value-a\nEMBERVY_B=\nPLAIN=p\n");
    const r = bash('set -euo pipefail; . "$1"; embervy_env_load -x "$2"; printf "%s|%s|%s|%s" "$EMBERVY_A" "$EMBERVY_B" "$PLAIN" "$(printenv EMBERVY_A)"', [f]);
    expect(r).toEqual({ code: 0, out: "value-a||p|value-a", err: "" });
    expect(bash('set -u; . "$1"; embervy_env_load "$2"; printenv EMBERVY_A || echo NOT-EXPORTED', [f]).out).toBe("NOT-EXPORTED\n");
  });

  test("subturn detection and tool defaults agree with TypeScript", () => {
    expect(bash('. "$1"; embervy_is_subturn && echo yes || echo no', [], { EMBERVY_BRAIN_SUBTURN: "1" }).out).toBe("yes\n");
    expect(bash('. "$1"; embervy_is_subturn && echo yes || echo no', [], { EMBERVY_BRAIN_SUBTURN: "0" }).out).toBe("no\n");
    expect(bash('. "$1"; embervy_is_subturn && echo yes || echo no').out).toBe("no\n");
    expect(bash('. "$1"; echo "$REPLY_TOOL_NAMES"').out.trim().split(",")).toEqual(["mcp__app__reply", "mcp__app__send"]);
    expect(bash('. "$1"; echo "$EMAIL_TOOL_NAMES"').out.trim()).toBe("mcp__app__email");
    expect(bash('. "$1"; echo "$REPLY_TOOL_NAMES|$EMAIL_TOOL_NAMES"', [], { REPLY_TOOL_NAMES: "custom", EMAIL_TOOL_NAMES: "mail" }).out).toBe("custom|mail\n");
    expect(bash('. "$1"; embervy_home_default; embervy_unit_name app').out).toBe("/opt/embervy\nembervy-app.service\n");
  });

  test("the app server name does not depend on MCP file contents", () => {
    const f = join(scratch, "mcp.json");
    for (const json of ['{"mcpServers":{"app":{},"memory":{}}}', '{"mcpServers":{"lore":{}}}', "invalid", null]) {
      if (json === null) rmSync(f, { force: true }); else writeFileSync(f, json);
      expect(bash('. "$1"; embervy_app_server_name "$2"', [f]).out).toBe("app\n");
    }
  });
});

function recorder() {
  const seen: { auth: string | null; body: any }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) { seen.push({ auth: req.headers.get("authorization"), body: await req.json().catch(() => null) }); return new Response("ok"); },
  });
  return { seen, port: String(server.port), stop: () => server.stop(true) };
}

describe("runtime consumers with current settings", () => {
  test("reply-gateway.sh recognizes successful app replies and sends other output to the configured app", async () => {
    const app = recorder();
    try {
      const run = async (tool: string, label: string) => {
        const home = mkdtempSync(join(scratch, `gw-${label}-`));
        writeFileSync(join(home, ".env"), "INTERNAL_API_TOKEN=test-token\n");
        const transcript = join(home, "t.jsonl");
        writeFileSync(transcript, [
          { type: "user", message: { role: "user", content: "hi" } },
          { type: "assistant", uuid: "a-1", message: { content: [{ type: "tool_use", id: "t1", name: tool, input: { text: "Hello" } }] } },
          { type: "user", uuid: "r-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "Sent" }] }] } },
          { type: "assistant", uuid: "a-2", message: { content: [{ type: "text", text: "a terminal note" }] } },
        ].map((e) => JSON.stringify(e)).join("\n") + "\n");
        const gw = Bun.spawn(["bash", join(HERE, "reply-gateway.sh")], {
          env: { PATH, HOME: home, EMBERVY_HOME: home, APP_DIR: home, GW_SOURCE: "hook", EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: app.port },
          stdin: new Blob([JSON.stringify({ transcript_path: transcript })]), stdout: "ignore", stderr: "ignore",
        });
        expect(await gw.exited).toBe(0);
        return readFileSync(join(home, "logs", "reply-gateway.jsonl"), "utf8");
      };
      expect(await run("mcp__app__reply", "app")).toContain("SKIP:replied");
      expect(app.seen).toHaveLength(0);
      expect(await run("mcp__unknown__reply", "foreign")).toContain('"decision":"sent"');
      expect(app.seen).toHaveLength(1);
      expect(app.seen[0].auth).toBe("Bearer test-token");
    } finally { app.stop(); }
  }, 30_000);

  test("inlet.sh stays silent during Brain subturns and otherwise finds the configured worker", () => {
    const home = mkdtempSync(join(scratch, "inlet-"));
    mkdirSync(join(home, "Claude", "scripts"), { recursive: true });
    writeFileSync(join(home, "Claude", "scripts", "inlet-worker.ts"), 'console.log("FAKE-CONTEXT " + process.env.EMBERVY_TIMEZONE);\n');
    const inlet = (extra: Record<string, string>) => {
      const p = Bun.spawnSync(["bash", join(REPO, "Claude", "scripts", "inlet.sh")], {
        env: { PATH: `${dirname(process.execPath)}:${PATH}`, HOME: home, EMBERVY_HOME: home, EMBERVY_TIMEZONE: "UTC", ...extra },
        stdin: new Blob([JSON.stringify({ prompt: "hello", session_id: "s" })]), stdout: "pipe", stderr: "pipe",
      });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    expect(inlet({ EMBERVY_BRAIN_SUBTURN: "1" })).toEqual({ code: 0, out: "", err: "" });
    expect(existsSync(join(home, "state"))).toBe(false);
    const r = inlet({});
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toContain("FAKE-CONTEXT UTC");
  }, 30_000);

  test("the doctor reads current memory settings through its primary entry point", () => {
    const home = mkdtempSync(join(scratch, "doctor-"));
    writeFileSync(join(home, ".env"), "EMBERVY_URL=https://memory.example.invalid\nEMBERVY_API_KEY=test-key\n");
    const run = Bun.spawnSync(["bun", join(REPO, "shared", "tools", "embervy-doctor.ts"), "--offline", "--json"], {
      cwd: home, env: { PATH, HOME: home, EMBERVY_HOME: home, EMBERVY_SUBSTRATE: "brain", EMBERVY_DOCTOR_SKIP_CANARY: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const report = JSON.parse(run.stdout.toString());
    const check = (id: string) => report.checks.find((c: any) => c.id === id);
    expect(check("memory.url")).toMatchObject({ status: "SKIP", detail: "not checked — offline" });
    expect(check("memory.key")).toMatchObject({ status: "SKIP", detail: "set, not checked — offline" });
  }, 30_000);

  test("browse.py uses current browser settings", () => {
    const code = "import json,sys; sys.path.insert(0, sys.argv[1]); import browse; print(json.dumps(browse.paths({'EMBERVY_HOME': '/srv/house', 'EMBERVY_BROWSER_PORT': '4111', 'EMBERVY_BROWSER_UA': 'ua'})))";
    const r = Bun.spawnSync(["python3", "-B", "-c", code, join(REPO, "shared", "tools", "browser")], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout.toString());
    expect(p.home).toBe("/srv/house");
    expect(p.port).toBe(4111);
    expect(p.user_agent).toBe("ua");
    expect(p.browser_home).toBe("/srv/house/state/browser");
  });
});
