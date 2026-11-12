import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRunner } from "./claude-signin";

const repo = join(import.meta.dir, "../..");
const helper = join(import.meta.dir, "curl-auth.sh");
const fake = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
header = ''
if '--header' in args:
    name = args[args.index('--header') + 1]
    if name.startswith('@'):
        with open(name[1:]) as source: header = source.read()
body = sys.stdin.read() if '@-' in args else ''
record = {'args': args, 'cmdline': open('/proc/self/cmdline', 'rb').read().decode(), 'header': header, 'body': body}
with open(os.environ['CAPTURE'], 'a') as output: output.write(json.dumps(record) + '\\n')
if any('openrouter.ai' in arg for arg in args):
    print(json.dumps({'choices': [{'message': {'content': 'REPLY'}}]}))
elif any(arg.endswith('/list') for arg in args):
    sys.stdout.write(json.dumps({'files': []}) + '\\n200')
elif any(arg.endswith('/upload') for arg in args):
    sys.stdout.write(json.dumps({'success': True}) + '\\n200')
else:
    print('{}')
sys.exit(int(os.environ.get('CURL_EXIT', '0')))
`;

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "curl-private-"));
  const bin = join(home, "bin"), capture = join(home, "capture.jsonl");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), fake, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, EMBERVY_HOME: home, CAPTURE: capture };
  const records = () => readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { home, env, records };
}

test("the sign-in runner transports credentials on stdin rather than argv", async () => {
  const result = await localRunner.run(["python3", "-c", "import json,sys; print(json.dumps({'args':sys.argv[1:], 'input':sys.stdin.read()}))"], { stdin: "PRIVATE-code", timeoutMs: 1000 });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out)).toEqual({ args: [], input: "PRIVATE-code" });
});

test("curl bearer uses an anonymous header pipe, preserves stdin and propagates failures", () => {
  const f = fixture();
  try {
    const token = 'PRIVATE-token-with-"quotes"-and-\\slashes';
    for (const exit of ["0", "22"]) {
      const result = Bun.spawnSync(["bash", "-c", '. "$1"; embervy_curl_bearer "$TOKEN" --data-binary @- http://unused', "test", helper], {
        env: { ...f.env, TOKEN: token, CURL_EXIT: exit }, stdin: Buffer.from("private payload\n"), stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(Number(exit));
      const record = f.records().at(-1);
      expect(record.header).toBe(`Authorization: Bearer ${token}\n`);
      expect(record.body).toBe("private payload\n");
      expect(record.cmdline).not.toContain(token);
      expect(record.args.join(" ")).not.toContain(token);
      expect(record.args[record.args.indexOf("--header") + 1]).toStartWith("@/dev/fd/");
    }
    const empty = Bun.spawnSync(["bash", "-c", '. "$1"; embervy_curl_bearer "" http://unused', "test", helper], { env: f.env, stdout: "pipe", stderr: "pipe" });
    expect(empty.exitCode).toBe(0);
    expect(f.records().at(-1).header).toBe("");
    const before = f.records().length;
    const invalid = Bun.spawnSync(["bash", "-c", '. "$1"; embervy_curl_bearer "$TOKEN" http://unused', "test", helper], {
      env: { ...f.env, TOKEN: "private\nInjected: header" }, stdout: "pipe", stderr: "pipe",
    });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr.toString()).toBe("Invalid bearer header\n");
    expect(f.records()).toHaveLength(before);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("reply gateway keeps both classifier and internal bearer out of real child argv", () => {
  const f = fixture();
  try {
    const transcript = join(f.home, "main.jsonl");
    writeFileSync(transcript, [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", uuid: "test-turn", message: { content: [{ type: "text", text: "private reply" }] } },
    ].map(row => JSON.stringify(row)).join("\n"));
    const result = Bun.spawnSync(["bash", join(import.meta.dir, "reply-gateway.sh")], {
      env: { ...f.env, GW_SOURCE: "poll", OPENROUTER_API_KEY: "PRIVATE-openrouter", INTERNAL_API_TOKEN: "PRIVATE-internal" },
      stdin: Buffer.from(JSON.stringify({ transcript_path: transcript })), stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const records = f.records();
    expect(records).toHaveLength(2);
    expect(records.map(record => record.header)).toEqual(["Authorization: Bearer PRIVATE-openrouter\n", "Authorization: Bearer PRIVATE-internal\n"]);
    expect(records.every(record => !record.cmdline.includes("PRIVATE"))).toBe(true);
    expect(JSON.parse(records[1].body).text).toBe("private reply");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("Python archive upload inherits a private header descriptor rather than passing the token", () => {
  const f = fixture();
  try {
    const file = join(f.home, "Session_1.md");
    writeFileSync(file, "# Export\n\nOwn text\n");
    const result = Bun.spawnSync(["bash", join(import.meta.dir, "smart_upload.sh"), file], {
      env: { ...f.env, RAG_URL: "http://unused", RAG_AUTH_TOKEN: "PRIVATE-rag" }, stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(f.records().length).toBeGreaterThanOrEqual(2);
    for (const record of f.records()) {
      expect(record.header).toBe("Authorization: Bearer PRIVATE-rag\n");
      expect(record.cmdline).not.toContain("PRIVATE-rag");
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

test("installation examples never place bearer headers directly in curl argv", () => {
  const guide = readFileSync(join(repo, "INSTALL.md"), "utf8");
  expect(guide).not.toMatch(/-H\s+"Authorization: Bearer/);
  expect(guide).toContain("--header @<(printf 'Authorization: Bearer %s\\n'");
});

test("shell family callers have valid syntax and use the private-header helper", () => {
  for (const file of ["Claude/scripts/loop-dialog.sh", "Claude/scripts/context_watchdog.sh", "Claude/scripts/start-claude-loop.sh", "Claude/scripts/session-to-rag.sh", "shared/scripts/reply-gateway.sh"]) {
    const path = join(repo, file), source = readFileSync(path, "utf8");
    expect(Bun.spawnSync(["bash", "-n", path]).exitCode).toBe(0);
    expect(source).toContain("/curl-auth.sh");
    expect(source).toContain("embervy_curl_bearer");
    expect(source).not.toMatch(/-H\s+"Authorization: Bearer/);
  }
});
