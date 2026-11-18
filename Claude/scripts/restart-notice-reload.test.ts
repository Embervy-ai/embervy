import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
function shellFunction(name: string) {
  const body = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  if (!body) throw new Error(`Missing function: ${name}`);
  return body;
}
const functions = ["notify_runtime_swap", "prune_runtime_swaps", "queue_runtime_swap", "drain_runtime_swaps", "reload_loop_if_needed", "restore_loop_restart_state"].map(shellFunction).join("\n");
const head = source.slice(source.indexOf("while true; do\n  # No successor"), source.indexOf('\n  echo "$(date -Iseconds) loop: starting claude'));
const enqueue = source.slice(source.indexOf("  # Optional delivery must never prevent"), source.lastIndexOf("\ndone"));

function fixture(run: (box: ReturnType<typeof create>) => void) {
  const root = mkdtempSync(join(tmpdir(), "notice-reload-"));
  try { run(create(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}
function create(root: string) {
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/claude"), `#!/bin/bash
if [ "\${1:-}" = --version ]; then printf 'fixture-build\\n'; exit 0; fi
printf 'running:%s:%s:%s\\n' "$CODE" "$MODE" "$CRASH_HISTORY" >> "$EMBERVY_HOME/events"
`, { mode: 0o755 });
  const python = Bun.which("python3");
  if (!python) throw new Error("python3 is required");
  writeFileSync(join(root, "bin/python3"), `#!/bin/bash
for arg in "$@"; do
  case "$arg" in *private-bearer*|*private-mcp*) printf 'python argv leak\\n' > "$EMBERVY_HOME/leak";; esac
done
exec ${JSON.stringify(python)} "$@"
`, { mode: 0o755 });
  const common = `#!/bin/bash
set -eu
umask 022
export LOOP_PID=$$
LOG="$EMBERVY_HOME/loop.log"
APP_HOST=127.0.0.1; APP_PORT=3030
MODE=fresh; POST_EXIT_EXPORTED=1; CRASH_TIMES=(11 12); PASS_ARGS=()
read -r LOOP_SELF_HASH _ < <(md5sum "$0")
. "$AUTH_HELPER"
${functions}
date() { if [ "$1" = -Iseconds ]; then printf '2026-01-01T00:00:00+00:00\\n'; else command date "$@"; fi; }
restart_notice_effort() { printf '%s\\n' "$CODE"; }
restart_notice_mcps() { printf '%s\\n' "$EMBERVY_MCP_LIST"; }
loop_restart_pause() { printf 'pause:%s:%s\\n' "$1" "$2" >> "$EMBERVY_HOME/events"; }
sleep() { exit 71; }
`;
  const boundary = `${head}
  CODE="$CODE" MODE="$MODE" CRASH_HISTORY="\${CRASH_TIMES[*]}" claude --fixture-session
  break
done
`;
  // The receiver models the app's idempotent outbox acknowledgement, not delivery by the shell.
  writeFileSync(join(root, "bin/curl"), `#!/usr/bin/python3
import json, os, signal, subprocess, sys
from pathlib import Path
root=Path(os.environ['EMBERVY_HOME'])
for pid in (os.getpid(), os.getppid(), int(os.environ['LOOP_PID'])):
    args=Path('/proc/%s/cmdline' % pid).read_bytes()
    for secret in ('private-bearer', 'private-mcp'):
        if secret.encode() in args: (root/'leak').write_text(str(pid))
assert '@-' in sys.argv
assert '-fsS' in sys.argv
header=sys.argv[sys.argv.index('--header')+1]
assert header.startswith('@/dev/fd/')
assert Path(header[1:]).read_text() == 'Authorization: Bearer private-bearer\\n'
message=json.load(sys.stdin)
with (root/'attempts').open('a') as f: f.write(json.dumps(message)+'\\n')
if (root/'real-curl').exists():
    config=json.loads((root/'real-curl').read_text())
    args=sys.argv[1:]
    auth=root/'curl-header'
    auth.touch(mode=0o600)
    auth.write_text(Path(header[1:]).read_text())
    args[args.index('--header')+1]='@'+str(auth)
    args=[arg.replace('http://127.0.0.1:3030/', config['url']+'/') for arg in args]
    result=subprocess.run([config['curl'], *args], input=json.dumps(message).encode())
    sys.exit(result.returncode)
if (root/'reject').exists(): sys.exit(22)
path=root/'messages'
rows=[json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
if not any(row.get('id') and row.get('id')==message.get('id') for row in rows):
    with path.open('a') as f: f.write(json.dumps(message)+'\\n')
if (root/'interrupt-ack').exists():
    (root/'interrupt-ack').unlink()
    os.kill(int(os.environ['LOOP_PID']), signal.SIGKILL)
`, { mode: 0o755 });
  const successor = common + `CODE=new
MODE=fresh; POST_EXIT_EXPORTED=0
restore_loop_restart_state
printf 'loaded:new\\n' >> "$EMBERVY_HOME/events"
if [ -f "$EMBERVY_HOME/interrupt-load" ]; then
  rm "$EMBERVY_HOME/interrupt-load"
  kill -KILL $$
fi
` + boundary;
  writeFileSync(join(root, "successor"), successor);
  const script = join(root, "loop");
  const prepare = (kind: "same" | "hash" | "marker" | "invalid" | "exec-failure", count = 1) => {
    if (kind === "invalid") writeFileSync(join(root, "successor"), "if broken syntax\n");
    writeFileSync(script, common + (kind === "exec-failure" ? 'exec() { return 1; }\n' : '') + `CODE=old
for rc in ${count === 1 ? "143" : "143 137"}; do
  if [ "$rc" = 137 ]; then MODE=continue; POST_EXIT_EXPORTED=0; fi
${enqueue}
done
` + (kind === "same" ? "" : `cp "$EMBERVY_HOME/successor" "$0.next"\nmv "$0.next" "$0"\n`) + (kind === "marker" ? `read -r LOOP_SELF_HASH _ < <(md5sum "$0")\ntouch "$EMBERVY_HOME/state/loop_reload"\n` : "") + boundary);
  };
  const env = {
    PATH: `${root}/bin:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: root, EMBERVY_HOME: root,
    INTERNAL_API_TOKEN: "private-bearer", EMBERVY_MCP_LIST: "app,private-mcp",
    AUTH_HELPER: join(import.meta.dir, "../../shared/scripts/curl-auth.sh"),
  };
  const invoke = () => Bun.spawnSync(["bash", script], { env, timeout: 7000, stdout: "pipe", stderr: "pipe" });
  const invokeAsync = async () => {
    const proc = Bun.spawn(["bash", script], { env, timeout: 7000, stdout: "ignore", stderr: "pipe" });
    const exitCode = await proc.exited;
    expect(await new Response(proc.stderr).text()).toBe("");
    return exitCode;
  };
  const start = (kind: Parameters<typeof prepare>[0], count = 1) => { prepare(kind, count); return invoke(); };
  const rows = (file = "messages") => existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const pending = () => existsSync(join(root, "state/restart-notices")) && statSync(join(root, "state/restart-notices")).isDirectory()
    ? readdirSync(join(root, "state/restart-notices")).filter(name => name.endsWith(".pending")) : [];
  return { root, start, prepare, invoke, invokeAsync, rows, pending };
}

for (const kind of ["hash", "marker"] as const) test(`${kind} reload sends one notice from the replacement code`, () => fixture(box => {
  expect(head).toContain("reload_loop_if_needed");
  expect(head.indexOf("reload_loop_if_needed")).toBeLessThan(head.indexOf("drain_runtime_swaps"));
  expect(box.start(kind).exitCode).toBe(0);
  expect(box.rows()).toHaveLength(1);
  expect(box.rows()[0].text).toBe("Runtime restarted.\nReason: SIGTERM (Watchdog/Cutover)\nBuild: fixture-build\nEffort: new\nMCPs: app,private-mcp");
  expect(box.rows()[0].ts).toBe("2026-01-01T00:00:00+00:00");
  expect(readFileSync(join(box.root, "events"), "utf8")).toBe("loaded:new\npause:143:1\nrunning:new:fresh:11 12\n");
  expect(box.pending()).toEqual([]);
  expect(existsSync(join(box.root, "leak"))).toBe(false);
}));

test("without reload the notice text and post-export pause are unchanged", () => fixture(box => {
  expect(box.start("same").exitCode).toBe(0);
  expect(box.rows()).toHaveLength(1);
  expect(box.rows()[0].text).toBe("Runtime restarted.\nReason: SIGTERM (Watchdog/Cutover)\nBuild: fixture-build\nEffort: old\nMCPs: app,private-mcp");
  expect(readFileSync(join(box.root, "events"), "utf8")).toBe("pause:143:1\nrunning:old:fresh:11 12\n");
}));

test("death after exec preserves private pending facts and the next head sends once", () => fixture(box => {
  writeFileSync(join(box.root, "interrupt-load"), "");
  expect(box.start("hash").exitCode).not.toBe(0);
  expect(box.rows()).toEqual([]);
  const files = box.pending();
  expect(files).toHaveLength(1);
  const dir = join(box.root, "state/restart-notices");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, files[0]), "utf8").split("\0")).toEqual(["143", "2026-01-01T00:00:00+00:00", "fresh", "1", "11 12", ""]);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows()).toHaveLength(1);
  expect(box.rows("attempts")).toHaveLength(1);
  expect(box.pending()).toEqual([]);
}));

test("an interrupted acknowledgement retries the same id without a second message", () => fixture(box => {
  writeFileSync(join(box.root, "interrupt-ack"), "");
  expect(box.start("hash").exitCode).not.toBe(0);
  expect(box.pending()).toHaveLength(1);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows("attempts")).toHaveLength(2);
  expect(new Set(box.rows("attempts").map(row => row.id)).size).toBe(1);
  expect(box.rows()).toHaveLength(1);
}));

test("a failed exec leaves the notice pending for the next process", () => fixture(box => {
  expect(box.start("exec-failure").exitCode).toBe(71);
  expect(box.rows()).toEqual([]);
  expect(box.pending()).toHaveLength(1);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows()).toHaveLength(1);
  expect(box.rows()[0].text).toContain("Effort: new");
}));

test("a syntax-invalid replacement reports the code that remains running", () => fixture(box => {
  expect(box.start("invalid").exitCode).toBe(0);
  expect(box.rows()).toHaveLength(1);
  expect(box.rows()[0].text).toContain("Effort: old");
}));

test("an HTTP failure reaches the CLI boundary without sleeping and retries once per head", () => fixture(box => {
  writeFileSync(join(box.root, "reject"), "");
  expect(box.start("hash").exitCode).toBe(0);
  expect(box.rows()).toEqual([]);
  expect(box.pending()).toHaveLength(1);
  expect(box.rows("attempts")).toHaveLength(1);
  expect(readFileSync(join(box.root, "events"), "utf8")).toBe("loaded:new\nrunning:new:fresh:11 12\n");
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows("attempts")).toHaveLength(2);
  expect(box.pending()).toHaveLength(1);
  expect(readFileSync(join(box.root, "loop.log"), "utf8").match(/notify_runtime_swap curl failed/g)).toHaveLength(2);
  rmSync(join(box.root, "reject"));
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows()).toHaveLength(1);
  expect(box.rows("attempts")).toHaveLength(3);
  expect(new Set(box.rows("attempts").map(row => row.id)).size).toBe(1);
  expect(box.pending()).toHaveLength(0);
  expect(readFileSync(join(box.root, "events"), "utf8")).not.toContain("pause:");
}));

test("two consecutive restarts with equal timestamps each send one notice", () => fixture(box => {
  expect(box.start("hash").exitCode).toBe(0);
  expect(box.start("hash").exitCode).toBe(0);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows()).toHaveLength(2);
  expect(new Set(box.rows().map(row => row.id)).size).toBe(2);
  expect(new Set(box.rows().map(row => row.ts)).size).toBe(1);
  expect(box.rows("attempts")).toHaveLength(2);
}));

test("two queued restarts retain distinct identities and are each delivered once", () => fixture(box => {
  expect(box.start("hash", 2).exitCode).toBe(0);
  expect(box.rows("attempts")).toHaveLength(1);
  expect(box.pending()).toHaveLength(1);
  expect(readFileSync(join(box.root, "events"), "utf8")).toContain("running:new:continue:11 12\n");
  expect(box.invoke().exitCode).toBe(0);
  const rows = box.rows();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(row => row.id)).size).toBe(2);
  expect(rows[0].text).toContain("Reason: SIGTERM (Watchdog/Cutover)");
  expect(rows[1].text).toContain("Reason: SIGKILL (OOM?)");
  expect(readFileSync(join(box.root, "events"), "utf8")).not.toContain("pause:");
  expect(box.rows("attempts")).toHaveLength(2);
}));

for (const failure of ["unreachable", "http-error", "hang"] as const) {
  test(`real curl: ${failure} retains the notice and bounds every head`, async () => {
    const root = mkdtempSync(join(tmpdir(), "notice-network-"));
    let recover = false;
    const received: unknown[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        received.push(await request.json());
        if (recover) return new Response("ok");
        if (failure === "hang") return new Promise<Response>(() => {});
        return new Response("unavailable", { status: 503 });
      },
    });
    try {
      const box = create(root);
      const curl = Bun.which("curl");
      if (!curl) throw new Error("curl is required");
      writeFileSync(join(root, "real-curl"), JSON.stringify({ curl, url: server.url.origin }));
      if (failure === "unreachable") server.stop(true);
      box.prepare("hash");
      for (let head = 1; head <= 2; head++) {
        const started = performance.now();
        expect(await box.invokeAsync()).toBe(0);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(failure === "hang" ? 4500 : 2000);
        if (failure === "hang") expect(elapsed).toBeGreaterThan(2800);
        expect(box.rows("attempts")).toHaveLength(head);
        expect(box.pending()).toHaveLength(1);
        const events = readFileSync(join(root, "events"), "utf8");
        expect(events.match(/running:/g)).toHaveLength(head);
        expect(events).not.toContain("pause:");
      }
      expect(new Set(box.rows("attempts").map(row => row.id)).size).toBe(1);
      expect(readFileSync(join(root, "loop.log"), "utf8").match(/notify_runtime_swap curl failed/g)).toHaveLength(2);
      expect(received).toHaveLength(failure === "unreachable" ? 0 : 2);
      if (failure === "unreachable") rmSync(join(root, "real-curl"));
      recover = true;
      expect(await box.invokeAsync()).toBe(0);
      expect(box.pending()).toEqual([]);
      expect(box.rows("attempts")).toHaveLength(3);
      expect(new Set(box.rows("attempts").map(row => row.id)).size).toBe(1);
      expect(existsSync(join(root, "leak"))).toBe(false);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}

function seedNotice(root: string, name: string, ageSeconds: number) {
  const directory = join(root, "state/restart-notices");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, name + ".pending");
  writeFileSync(file, ["137", "2026-01-01T00:00:00+00:00", "continue", "0", "99", ""].join("\0"), { mode: 0o600 });
  const modified = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, modified, modified);
}

test("enqueue and head discard expired notices and retain only the ten newest", () => fixture(box => {
  seedNotice(box.root, "expired", 86460);
  for (let i = 0; i < 12; i++) seedNotice(box.root, `queued-${String(i).padStart(2, "0")}`, 120 - i);
  writeFileSync(join(box.root, "reject"), "");
  expect(box.start("hash").exitCode).toBe(0);
  expect(box.pending()).toHaveLength(10);
  for (const name of ["expired", "queued-00", "queued-01", "queued-02"]) {
    expect(box.pending()).not.toContain(name + ".pending");
  }
  for (let i = 3; i < 12; i++) expect(box.pending()).toContain(`queued-${String(i).padStart(2, "0")}.pending`);
  expect(box.rows("attempts")).toHaveLength(1);
  let log = readFileSync(join(box.root, "loop.log"), "utf8");
  expect(log.match(/older than one day/g)).toHaveLength(1);
  expect(log.match(/queue limit of ten/g)).toHaveLength(3);
  seedNotice(box.root, "expired-at-head", 86460);
  seedNotice(box.root, "overflow-at-head", 200);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.pending()).toHaveLength(10);
  expect(box.pending()).not.toContain("expired-at-head.pending");
  expect(box.pending()).not.toContain("overflow-at-head.pending");
  expect(box.rows("attempts")).toHaveLength(2);
  log = readFileSync(join(box.root, "loop.log"), "utf8");
  expect(log.match(/older than one day/g)).toHaveLength(2);
  expect(log.match(/queue limit of ten/g)).toHaveLength(4);
  expect(box.rows("attempts").every(row => !row.id.includes("expired") && !row.id.includes("overflow"))).toBe(true);
}));

test("a live backlog cannot overwrite the current mode, crash history or pause", () => fixture(box => {
  seedNotice(box.root, "000-older-crash", 60);
  expect(box.start("hash").exitCode).toBe(0);
  expect(box.rows("attempts")).toHaveLength(1);
  expect(box.rows()[0].id).toBe("claude-restart-000-older-crash.pending");
  expect(box.pending()).toHaveLength(1);
  expect(readFileSync(join(box.root, "events"), "utf8")).toBe("loaded:new\nrunning:new:fresh:11 12\n");
}));

test("an invalid pending record cannot block startup", () => fixture(box => {
  seedNotice(box.root, "000-invalid", 60);
  writeFileSync(join(box.root, "state/restart-notices/000-invalid.pending"), "incomplete");
  expect(box.start("hash").exitCode).toBe(0);
  expect(box.rows("attempts")).toEqual([]);
  expect(box.pending()).toHaveLength(1);
  expect(box.pending()).not.toContain("000-invalid.pending");
  expect(readFileSync(join(box.root, "loop.log"), "utf8")).toContain("discarded invalid restart notice 000-invalid.pending");
  expect(box.invoke().exitCode).toBe(0);
  expect(box.rows("attempts")).toHaveLength(1);
}));

test("an expired lone notice is removed without delivery or stale mode restoration", () => fixture(box => {
  writeFileSync(join(box.root, "interrupt-load"), "");
  expect(box.start("hash").exitCode).not.toBe(0);
  for (const name of box.pending()) rmSync(join(box.root, "state/restart-notices", name));
  seedNotice(box.root, "expired", 86460);
  expect(box.invoke().exitCode).toBe(0);
  expect(box.pending()).toEqual([]);
  expect(box.rows("attempts")).toEqual([]);
  expect(readFileSync(join(box.root, "events"), "utf8")).toContain("running:new:fresh:\n");
}));

for (const reject of [false, true]) test(`persistence failure sends directly once without waiting (rejected=${reject})`, () => fixture(box => {
  writeFileSync(join(box.root, "state/restart-notices"), "not a directory");
  if (reject) writeFileSync(join(box.root, "reject"), "");
  expect(box.start("same").exitCode).toBe(0);
  expect(box.rows("attempts")).toHaveLength(1);
  expect(box.rows()).toHaveLength(reject ? 0 : 1);
  expect(box.pending()).toEqual([]);
  expect(readFileSync(join(box.root, "events"), "utf8")).toBe("running:old:fresh:11 12\n");
  expect(readFileSync(join(box.root, "loop.log"), "utf8")).toContain("trying direct delivery once");
  expect(existsSync(join(box.root, "leak"))).toBe(false);
}));

test("failed atomic publication removes the temporary record before direct delivery", () => fixture(box => {
  writeFileSync(join(box.root, "bin/mv"), `#!/bin/bash
case "\${*: -1}" in *.pending) exit 1;; esac
exec /bin/mv "$@"
`, { mode: 0o755 });
  expect(box.start("same").exitCode).toBe(0);
  expect(readdirSync(join(box.root, "state/restart-notices"))).toEqual([]);
  expect(box.rows("attempts")).toHaveLength(1);
  expect(readFileSync(join(box.root, "events"), "utf8")).not.toContain("pause:");
}));
