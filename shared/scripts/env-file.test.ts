import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envGet, envLine, envValueProblem, EnvValueError, formatEnvValue, parseEnv, parseEnvLine } from "./env-file";

// The house .env is written once (installer, envLine) and read by systemd,
// Bun's .env loader, the shell scripts (env-file.sh) and TypeScript tools
// (parseEnv). Round-trip values byte for byte through the real readers;
// execution canaries verify that shell syntax remains data.

const HERE = import.meta.dir; // shared/scripts
const REPO = join(HERE, "..", "..");
const LIB = join(HERE, "env-file.sh");
const BUN = process.execPath;
const scratch = mkdtempSync(join(tmpdir(), "env-file-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const canaryDir = join(scratch, "canaries");
mkdirSync(canaryDir);

const canary = (name: string) => join(canaryDir, name);
const AUDIT_VALUES = [
  "abc$UNSET_AUDIT_VARIABLE",
  "abc$AUDIT_MISSING",
  "New York",
  "St. John's",
  "abc$(printf audit-executed)xyz",
  `$(touch ${canary("dollar-paren")})`,
  `\`touch ${canary("backtick")}\``,
  `x;touch ${canary("semicolon")}`,
  `it's $(touch ${canary("mixed")}) "quoted"`,
  "a\\b",
  "C:\\Users\\agent\\x",
  "#hash",
  "a #b",
  "a#b",
  "x=y=z",
  "=lead",
  "pa ss word",
  " lead blank",
  "trail blank ",
  '"quoted"',
  `it's "x" $5`,
  "$HOME",
  "${HOME}",
  "$",
  "end$",
  "\\$",
  "a\\nb",
  "Ærøskøbing",
  "São Paulo ✨",
  "",
  "plain-token_123",
  "a;b",
  ";x",
  "100%",
  "~/x",
  "a!b&c|d<e>f",
  "a*b?[c]{d,e}",
  "'",
  "''",
  "\\",
];

// A fixed-seed fuzz over the characters every reader treats specially.
function fuzzValues(n: number): string[] {
  let seed = 0x5eed1234;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = ["a", "b", "n", "t", "$", "'", '"', "\\", "`", "#", " ", "=", ";", "(", ")", "{", "}", "!", "*", "&", "|", "<", ">", "~", "-", "/", ":", "é", "1"];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = Math.floor(rnd() * 10);
    let s = "";
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    out.push(s);
  }
  return out;
}

const VALUES = [...AUDIT_VALUES, ...fuzzValues(600)];
const accepted: { key: string; value: string }[] = [];
const refused: string[] = [];
for (const value of VALUES) {
  if (envValueProblem(value) === undefined) accepted.push({ key: `K${String(accepted.length).padStart(4, "0")}`, value });
  else refused.push(value);
}
const envText = accepted.map(({ key, value }) => envLine(key, value)).join("\n") + "\n";
const envDir = join(scratch, "house");
mkdirSync(envDir);
const envPath = join(envDir, ".env");
writeFileSync(envPath, envText);

/** Run bash with the shared reader; the script prints KEY\0VALUE\0 pairs. */
function bash(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", script, "_", LIB, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
function pairs(nulText: string): Record<string, string> {
  const parts = nulText.split("\0");
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
  return out;
}
const expected = Object.fromEntries(accepted.map(({ key, value }) => [key, value]));

describe("writer: one format, refusals are explicit", () => {
  test("every audit value the audit named is accepted and written", () => {
    for (const v of ["abc$UNSET_AUDIT_VARIABLE", "New York", "St. John's", "abc$(printf audit-executed)xyz", "a\\b", "#hash", "x=y=z", "`id`"]) {
      expect(envValueProblem(v)).toBeUndefined();
    }
  });
  test("simple values stay bare, so old readers and hand edits see what they always saw", () => {
    expect(envLine("TOKEN", "sk-abc_123.def/ghi+jk=")).toBe("TOKEN=sk-abc_123.def/ghi+jk=");
    expect(envLine("EMPTY", "")).toBe("EMPTY=");
    expect(envLine("PLACE", "New York")).toBe("PLACE='New York'");
    expect(envLine("PLACE", "St. John's")).toBe(`PLACE="St. John's"`);
    expect(envLine("PW", "abc$X")).toBe(`PW="abc\\$X"`);
  });
  test("a line break or control character is refused, never stripped", () => {
    for (const v of ["a\nb", "a\rb", "a\tb", "a\0b"]) {
      expect(() => formatEnvValue(v)).toThrow(EnvValueError);
    }
  });
  test("refused values name the reason; the fuzz refuses only the documented mix", () => {
    expect(refused.length).toBeGreaterThan(0);
    for (const v of refused) {
      const why = envValueProblem(v)!;
      expect(why).toBeTruthy();
      // Refused means: a " or \ AND a ' or $, a backslash at the end, or a control character — never anything simpler.
      expect(/[\x00-\x1f\x7f]/.test(v) || v.endsWith("\\") || (/["\\]/.test(v) && /['$]/.test(v))).toBe(true);
    }
    expect(accepted.length).toBeGreaterThan(VALUES.length / 2);
  });
  test("invalid keys are refused", () => {
    expect(() => envLine("1BAD", "x")).toThrow(EnvValueError);
    expect(() => envLine("A-B", "x")).toThrow(EnvValueError);
    expect(() => envLine("x[$(id)]", "x")).toThrow(EnvValueError);
  });
});

describe("roundtrip: writer → every real reader gets the same bytes", () => {
  test("TypeScript parseEnv / envGet", () => {
    expect(parseEnv(envText)).toEqual(expected);
    expect(envGet(envText, "K0001")).toBe(accepted[1].value);
  });

  test("bash reader (env-file.sh) under set -euo pipefail", () => {
    const r = bash('set -euo pipefail; . "$1"; embervy_env_load "$2"; shift 2; for k in "$@"; do printf "%s\\0%s\\0" "$k" "${!k}"; done', [envPath, ...accepted.map((a) => a.key)]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(pairs(r.out)).toEqual(expected);
  });

  test("bash reader -x exports to children; without -x nothing new is exported", () => {
    const k = accepted[4].key; // "New York"... any key works
    const withX = bash(`set -eu; . "$1"; embervy_env_load -x "$2"; printenv ${k}`, [envPath]);
    expect(withX.out).toBe(`${expected[k]}\n`);
    const withoutX = bash(`set -u; . "$1"; embervy_env_load "$2"; printenv ${k} || echo NOT-EXPORTED`, [envPath]);
    expect(withoutX.out).toBe("NOT-EXPORTED\n");
  });

  test("Bun's own .env loader (a bun process started in the folder)", () => {
    const probe = join(scratch, "bun-probe.ts");
    writeFileSync(probe, 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^K\\d{4}$/.test(k)))));\n');
    const r = Bun.spawnSync([BUN, probe], { cwd: envDir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual(expected);
  });

  // systemd itself, through a transient unit. Opt-in (EMBERVY_TEST_SYSTEMD=1):
  // it needs root and a running systemd, and starts a real (harmless) unit.
  const systemdOk = process.env.EMBERVY_TEST_SYSTEMD === "1" && process.getuid?.() === 0 && existsSync("/run/systemd/system");
  test.skipIf(!systemdOk)("systemd EnvironmentFile= (EMBERVY_TEST_SYSTEMD=1)", () => {
    const r = Bun.spawnSync(["systemd-run", "--quiet", "--wait", "--pipe", "--collect", `--property=EnvironmentFile=${envPath}`, "/usr/bin/env", "-0"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const got: Record<string, string> = {};
    for (const entry of r.stdout.toString().split("\0")) {
      const i = entry.indexOf("=");
      if (i > 0 && /^K\d{4}$/.test(entry.slice(0, i))) got[entry.slice(0, i)] = entry.slice(i + 1);
    }
    expect(got).toEqual(expected);
  });
});

describe("hand-edited lines: the TypeScript and the bash reading agree", () => {
  const lines = [
    "PLAIN=value",
    "  INDENTED = spaced value   ",
    "export EXPORTED=yes",
    "COMMENTED=800000          # a comment like .env.example's",
    "HASH_IN_WORD=a#b",
    "EMPTY_WITH_COMMENT=                  # nothing",
    "SQ='lit $HOME \\n'",
    'DQ="esc \\" \\\\ \\` \\$ keep \\n"',
    "CONCAT='a'\"b\"c",
    "BACKSLASH=a\\ b\\$c",
    "QUOTE_MID=it's \"x\"",
    "CRLF=windows\r",
    "#COMMENTED_OUT=1",
    "; also a comment",
    "NOEQUALS",
    "1BAD=x",
    "SQ_OPEN='never closed",
    'DQ_OPEN="never closed',
    "AFTER_OPEN=still read",
    "LAST=first",
    "LAST=second",
  ];
  const text = lines.join("\n") + "\n";
  const file = join(scratch, "hand.env");
  writeFileSync(file, text);

  test("TypeScript reading", () => {
    expect(parseEnv(text)).toEqual({
      PLAIN: "value",
      INDENTED: "spaced value",
      EXPORTED: "yes",
      COMMENTED: "800000",
      HASH_IN_WORD: "a#b",
      EMPTY_WITH_COMMENT: "",
      SQ: "lit $HOME \\n",
      DQ: 'esc " \\ ` $ keep \\n',
      CONCAT: "abc",
      BACKSLASH: "a b$c",
      QUOTE_MID: `it's "x"`,
      CRLF: "windows",
      AFTER_OPEN: "still read",
      LAST: "second",
    });
    expect(parseEnvLine("SQ_OPEN='x")).toEqual({ key: "SQ_OPEN", unterminated: true });
  });

  test("bash reading is identical; an open quote is reported by key, never by value", () => {
    const r = bash('set -euo pipefail; . "$1"; cb() { printf "%s\\0%s\\0" "$1" "$2"; }; embervy_env_each "$2" cb', [file]);
    expect(r.code).toBe(0);
    expect(pairs(r.out)).toEqual(parseEnv(text));
    expect(r.err).toContain("SQ_OPEN");
    expect(r.err).toContain("DQ_OPEN");
    expect(r.err).not.toContain("never closed");
  });

  test("shell settings and readonly names are not taken from the file; the reader survives", () => {
    const f = join(scratch, "shell.env");
    writeFileSync(f, "IFS=x\nBASH_ENV=/tmp/evil\nUID=12345\nSAFE=ok\n");
    const r = bash('set -euo pipefail; . "$1"; embervy_env_load "$2"; printf "%s|%s|%s|%s" "$SAFE" "${BASH_ENV:-unset}" "$UID" "${#IFS}"', [f]);
    expect(r.code).toBe(0);
    const [safe, bashEnv, uid, ifsLen] = r.out.split("|");
    expect(safe).toBe("ok");
    expect(bashEnv).toBe("unset");
    expect(uid).not.toBe("12345");
    expect(ifsLen).toBe("3");
    expect(r.err).toContain("IFS");
  });

  test("a file in the OLD unquoted format is read as data too (nothing runs, no unbound variable)", () => {
    const f = join(scratch, "old.env");
    writeFileSync(f, [
      "APP_PASSWORD=abc$UNSET_AUDIT_VARIABLE",
      "EMBERVY_WEATHER_PLACE=New York",
      `MAILBOX_APP_PASSWORD=abc$(touch ${canary("old-format")})xyz`,
      "",
    ].join("\n"));
    const r = bash('set -euo pipefail; . "$1"; embervy_env_load "$2"; printf "%s\\0%s\\0%s\\0" "$APP_PASSWORD" "$EMBERVY_WEATHER_PLACE" "$MAILBOX_APP_PASSWORD"', [f]);
    expect(r.code).toBe(0);
    expect(r.out.split("\0").slice(0, 3)).toEqual(["abc$UNSET_AUDIT_VARIABLE", "New York", `abc$(touch ${canary("old-format")})xyz`]);
    expect(existsSync(canary("old-format"))).toBe(false);
  });
});

// ── The real consumers: watchdog, reply gateway, inlet ────────────────────
const hostileToken = `tok$(touch ${canary("token")})'x' #w\\z`;
const hostileEnv = () => [
  "# Generated by embervy-init — do not commit.",
  envLine("APP_PASSWORD", "abc$UNSET_AUDIT_VARIABLE"),
  envLine("INTERNAL_API_TOKEN", hostileToken),
  envLine("EMBERVY_WEATHER_PLACE", "St. John's"),
  envLine("EMBERVY_TIME_LABEL", "New York"),
  envLine("MAILBOX_APP_PASSWORD", `p\`touch ${canary("mail")}\`w`),
  "",
].join("\n");

/** A local app stand-in that records the broadcasts it gets. */
function recorder() {
  const seen: { auth: string | null; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push({ auth: req.headers.get("authorization"), body: await req.json().catch(() => null) });
      return new Response("ok");
    },
  });
  return { seen, port: String(server.port), stop: () => server.stop(true) };
}

async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(100);
  }
  return fn();
}

describe("the real consumers read the installer's file as data", () => {
  test("context_watchdog.sh (set -u) keeps running and sends the exact token", async () => {
    const home = mkdtempSync(join(scratch, "wd-"));
    mkdirSync(join(home, "Claude", "scripts"), { recursive: true });
    copyFileSync(join(REPO, "Claude", "scripts", "latest_main_session.py"), join(home, "Claude", "scripts", "latest_main_session.py"));
    writeFileSync(join(home, ".env"), hostileEnv());
    const sessions = join(home, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "s.jsonl"), JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 500 } } }) + "\n");
    const marker = `env-file-test-alive-${process.pid}-${Date.now()}`;
    // Started in the house, as the loop starts Claude: the watchdog only counts its own house's processes.
    const alive = Bun.spawn(["bash", "-c", `for i in $(seq 1 20); do sleep 1; done #${marker}`], { cwd: home, stdout: "ignore", stderr: "ignore" });
    const app = recorder();
    const wd = Bun.spawn(["bash", join(REPO, "Claude", "scripts", "context_watchdog.sh")], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        EMBERVY_HOME: home,
        CLAUDE_PROJECT_DIR: sessions,
        CLAUDE_PROCESS_PATTERN: marker,
        WATCHDOG_CHECK_INTERVAL: "1",
        WATCHDOG_WARN_TOKENS: "100",
        WATCHDOG_CUT_TOKENS: "99999999",
        EMBERVY_APP_HOST: "127.0.0.1",
        EMBERVY_APP_PORT: app.port,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await until(() => app.seen.length > 0, 10_000)).toBe(true);
      expect(app.seen[0].auth).toBe(`Bearer ${hostileToken}`);
      await Bun.sleep(1500);
      expect(wd.exitCode).toBeNull(); // still running after the warn and further ticks
      expect(existsSync(join(home, "state", "watchdog_state.json"))).toBe(true);
    } finally {
      wd.kill();
      await wd.exited;
      alive.kill();
      app.stop();
    }
    const stderr = await new Response(wd.stderr).text();
    expect(stderr).not.toContain("unbound variable");
    expect(stderr).not.toContain("command not found");
  }, 20_000);

  test("reply-gateway.sh sends with the exact token from the file", async () => {
    const home = mkdtempSync(join(scratch, "gw-"));
    writeFileSync(join(home, ".env"), hostileEnv());
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", uuid: "u-1", message: { role: "assistant", content: [{ type: "text", text: "Hi there, the user is answered." }] } }),
      "",
    ].join("\n"));
    const app = recorder();
    try {
      const gw = Bun.spawn(["bash", join(REPO, "shared", "scripts", "reply-gateway.sh")], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          EMBERVY_HOME: home,
          APP_DIR: home,
          GW_SOURCE: "poll",
          EMBERVY_APP_HOST: "127.0.0.1",
          EMBERVY_APP_PORT: app.port,
        },
        stdin: new Blob([JSON.stringify({ transcript_path: transcript })]),
        stdout: "pipe",
        stderr: "pipe",
      });
      await gw.exited;
      expect(app.seen.length).toBe(1);
      expect(app.seen[0].auth).toBe(`Bearer ${hostileToken}`);
      expect(app.seen[0].body?.text).toBe("Hi there, the user is answered.");
    } finally {
      app.stop();
    }
  }, 20_000);

  test("inlet.sh exports the values unchanged to its bun worker", async () => {
    const home = mkdtempSync(join(scratch, "inlet-"));
    mkdirSync(join(home, "Claude", "scripts"), { recursive: true });
    writeFileSync(join(home, ".env"), hostileEnv());
    writeFileSync(
      join(home, "Claude", "scripts", "inlet-worker.ts"),
      'import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n' +
        'const keys = ["APP_PASSWORD", "INTERNAL_API_TOKEN", "EMBERVY_WEATHER_PLACE", "EMBERVY_TIME_LABEL", "MAILBOX_APP_PASSWORD"];\n' +
        'writeFileSync(join(import.meta.dir, "..", "..", "seen.json"), JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))));\n',
    );
    const proc = Bun.spawn(["bash", join(REPO, "Claude", "scripts", "inlet.sh")], {
      env: { PATH: `${dirname(BUN)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, EMBERVY_HOME: home, EMBERVY_TIMEZONE: "UTC" },
      stdin: new Blob([JSON.stringify({ prompt: "hello", session_id: "s-1" })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "seen.json"), "utf8"))).toEqual({
      APP_PASSWORD: "abc$UNSET_AUDIT_VARIABLE",
      INTERNAL_API_TOKEN: hostileToken,
      EMBERVY_WEATHER_PLACE: "St. John's",
      EMBERVY_TIME_LABEL: "New York",
      MAILBOX_APP_PASSWORD: `p\`touch ${canary("mail")}\`w`,
    });
  }, 20_000);

  test("no product script under Claude/scripts or shared/scripts sources a .env any more", () => {
    for (const dir of ["Claude/scripts", "shared/scripts"]) {
      for (const f of readdirSync(join(REPO, dir)).filter((x) => x.endsWith(".sh"))) {
        const src = readFileSync(join(REPO, dir, f), "utf8");
        expect({ f, hit: /(^|[;&|\s])(source|\.)\s+["']?[^\s"']*\.env\b/m.test(src) }).toEqual({ f, hit: false });
      }
    }
  });
});

// Last, after every reader and consumer above has run.
test("nothing in any value ran: no canary file exists", () => {
  expect(readdirSync(canaryDir)).toEqual([]);
});
