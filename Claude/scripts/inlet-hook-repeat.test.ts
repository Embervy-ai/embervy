import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const INLET = join(import.meta.dir, "inlet.sh");
const PATH = `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`;
// Diagnose the real hook prerequisites, without installing or substituting any.
const missing = ["bash", "jq", "flock", "timeout", "python3", "mktemp", "find", "mv", "sha256sum", "awk"]
  .filter(command => !Bun.which(command, { PATH }));
test(`hook runtime prerequisites (missing: ${missing.join(", ") || "none"})`, () => {
  expect(missing).toEqual([]);
});

test("hook remains valid bash", () => {
  const result = Bun.spawnSync(["bash", "-n", INLET], { env: { PATH } });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

type Capture = { counter: string | null; directory: string | null; turn: string | null; future: boolean };
const fakeWorker = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const counter = process.env.INLET_COUNTER_FILE ?? null;
const directory = process.env.INLET_CHUNK_CACHE_DIR ?? null;
const turn = counter ? readFileSync(counter, "utf8").trim() : null;
const shown = directory && existsSync(directory + "/chunks.json")
  ? JSON.parse(readFileSync(directory + "/chunks.json", "utf8")).shown : [];
await Bun.sleep(Number(process.env.TEST_WORKER_DELAY ?? 0));
// Read again after the delay: concurrent invocations must not overwrite this snapshot.
if (counter && readFileSync(counter, "utf8").trim() !== turn) throw new Error("snapshot changed during worker");
appendFileSync(process.env.EMBERVY_HOME + "/calls.jsonl", JSON.stringify({counter, directory, turn,
  future: shown.some(entry => entry[1] > Number(turn))}) + "\\n");
console.log("FAKE-CONTEXT");
`;

async function withHome(action: (home: string) => Promise<void>, real = false) {
  const home = mkdtempSync(join(tmpdir(), "inlet-hook-repeat-"));
  mkdirSync(join(home, "Claude"));
  if (real) symlinkSync(import.meta.dir, join(home, "Claude/scripts"), "dir");
  else {
    mkdirSync(join(home, "Claude/scripts"));
    writeFileSync(join(home, "Claude/scripts/inlet-worker.ts"), fakeWorker);
  }
  try { await action(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

async function invoke(home: string, session: unknown = "session-A", env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", "-c", 'umask 000; exec bash "$1"', "inlet-test", INLET], {
    cwd: home,
    env: { PATH, HOME: home, EMBERVY_HOME: home, EMBERVY_TIMEZONE: "UTC", ...env },
    stdin: new Blob([JSON.stringify({ prompt: "storage decision", ...(session === null ? {} : { session_id: session }) })]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? "";
}

// Same launch-block isolation as inlet-worker.test.ts: exercise the real hook's
// worker boundary independently of its later clock/dedupe/output processing.
// Full-hook tests above/below remain strict and still expose missing prerequisites.
async function invokeWorkerStage(home: string, session: unknown = "session-A", env: Record<string, string> = {}) {
  mkdirSync(join(home, "logs"), { recursive: true });
  const launch = readFileSync(INLET, "utf8").match(/RESULT=\$\(timeout 25s bash[\s\S]*?\nWORKER\n\)/)?.[0];
  expect(launch).toBeDefined();
  const proc = Bun.spawn(["bash", "-c", launch + '\nprintf "%s" "$RESULT"'], {
    cwd: home,
    env: { PATH, HOME: home, EMBERVY_HOME: home, PROMPT: "storage decision", TRANSCRIPT: "",
      CHUNK_SESSION: typeof session === "string" ? session : "", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

function captures(home: string): Capture[] {
  return readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
const cacheRoot = (home: string) => join(home, "state/inlet-chunk-cache");
const globalCounter = (home: string) => join(home, "state/inlet-chunk-turn-counter");

test("worker receives both variables and the current zero-based turn; sessions keep private separate snapshots", async () => {
  await withHome(async home => {
    await invoke(home);
    const first = captures(home)[0];
    expect(first.directory).toBe(join(cacheRoot(home), "session-A"));
    expect(first.counter).toBe(join(first.directory!, "turn"));
    expect(first.turn).toBe("0");
    expect(statSync(cacheRoot(home)).mode & 0o777).toBe(0o700);
    expect(statSync(first.directory!).mode & 0o777).toBe(0o700);
    expect(statSync(first.counter!).mode & 0o777).toBe(0o600);
    await invoke(home);
    const second = captures(home)[1];
    expect(second.directory).toBe(first.directory);
    expect(second.counter).toBe(first.counter);
    expect(second.turn).toBe("1");
    writeFileSync(join(first.directory!, "chunks.json"), JSON.stringify({ version: 1, shown: [["old.md#0", 1]] }));
    const newSession = await invoke(home, "session-B");
    const third = captures(home)[2];
    expect(third.directory).toBe(join(cacheRoot(home), "session-B"));
    expect(third.counter).not.toBe(first.counter);
    expect(third.turn).toBe("2");
    expect(newSession).toContain("⏰");
    // The old clock counter still resets; only the repeat counter continues.
    expect(readFileSync(join(home, "state/inlet-turn-counter"), "utf8").trim()).toBe("1");
    await invoke(home, "session-A");
    const resumed = captures(home)[3];
    expect(resumed.directory).toBe(first.directory);
    expect(resumed.turn).toBe("3");
    expect(resumed.future).toBe(false);
    expect(readFileSync(globalCounter(home), "utf8").trim()).toBe("3");
    expect(readdirSync(first.directory!).filter(name => /\.[A-Za-z0-9]{6}$/.test(name))).toEqual([]);
  });
});

test("invalid or missing session IDs never expose repeat variables or create a chunk directory", async () => {
  await withHome(async home => {
    for (const session of [null, "", "a/b", "..", "../escape", "a..b", "two words", "\u00e9", "a\nb", "a".repeat(101), 123, {}]) {
      await invoke(home, session, {
        INLET_COUNTER_FILE: join(home, "inherited-counter"), INLET_CHUNK_CACHE_DIR: join(home, "inherited-cache"),
      });
      expect(captures(home).at(-1)).toEqual({ counter: null, directory: null, turn: null, future: false });
      expect(existsSync(cacheRoot(home))).toBe(false);
      expect(existsSync(globalCounter(home))).toBe(false);
      expect(existsSync(join(home, "inherited-cache"))).toBe(false);
    }
  });
});

test("ASCII letters, digits, hyphen and underscore are accepted up to 100 characters", async () => {
  await withHome(async home => {
    const session = "Az09_-" + "x".repeat(94);
    await invoke(home, session);
    expect(captures(home)[0].directory).toBe(join(cacheRoot(home), session));
  });
});

test("concurrent double triggers retain their own snapshots and monotonically reserve turns", async () => {
  await withHome(async home => {
    await Promise.all(Array.from({ length: 3 }, () => invoke(home, "session-A", { TEST_WORKER_DELAY: "100" })));
    expect(captures(home).map(call => call.turn)).toEqual(["0", "1", "2"]);
    expect(new Set(captures(home).map(call => call.directory)).size).toBe(1);
  });
});

test("missing or malformed clock state does not rewind the independent repeat counter", async () => {
  await withHome(async home => {
    await invoke(home);
    const clock = join(home, "state/inlet-turn-counter");
    rmSync(clock);
    expect(await invoke(home)).toContain("⏰");
    writeFileSync(clock, "broken");
    expect(await invoke(home)).toContain("⏰");
    expect(captures(home).map(call => call.turn)).toEqual(["0", "1", "2"]);
  });
});

for (const [scope, run] of [["full hook", invoke], ["isolated worker launch", invokeWorkerStage]] as const)
test(`seven-day cleanup (${scope}) removes only expired session directories, never symlink targets`, async () => {
  await withHome(async home => {
    const root = cacheRoot(home);
    const stale = join(root, "stale");
    const fresh = join(root, "fresh");
    const active = join(root, "session-A");
    const outside = join(home, "outside");
    for (const path of [stale, fresh, active, outside]) mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, "keep"), "untouched");
    writeFileSync(join(stale, "chunks.json"), "{}");
    symlinkSync(outside, join(stale, "nested-link"));
    symlinkSync(outside, join(root, "root-link"));
    writeFileSync(join(root, "not-a-session"), "keep");
    const old = new Date(Date.now() - 8 * 86_400_000);
    const recent = new Date(Date.now() - 6 * 86_400_000);
    for (const path of [stale, active, outside, join(root, "not-a-session")]) utimesSync(path, old, old);
    utimesSync(fresh, recent, recent);
    await run(home);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(join(root, "root-link"))).toBe(true);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
    expect(existsSync(join(root, "not-a-session"))).toBe(true);
  });
});

for (const [scope, run] of [["full hook", invoke], ["isolated worker launch", invokeWorkerStage]] as const)
for (const target of ["root", "session"]) test(`a symlink at the cache ${target} (${scope}) fails open without writing outside`, async () => {
  await withHome(async home => {
    const outside = join(home, "outside");
    mkdirSync(outside);
    mkdirSync(join(home, "state"));
    if (target === "root") symlinkSync(outside, cacheRoot(home));
    else {
      mkdirSync(cacheRoot(home));
      symlinkSync(outside, join(cacheRoot(home), "session-A"));
    }
    await run(home);
    expect(captures(home)[0].counter).toBeNull();
    expect(captures(home)[0].directory).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
  });
});

test("isolated worker launch: stable private snapshots, continuing turns and invalid-ID fail-open", async () => {
  await withHome(async home => {
    for (const session of ["session-A", "session-A", "session-B", "session-A"]) {
      expect(await invokeWorkerStage(home, session)).toContain("FAKE-CONTEXT");
    }
    const calls = captures(home);
    expect(calls.map(call => call.turn)).toEqual(["0", "1", "2", "3"]);
    expect(calls[0].directory).toBe(join(cacheRoot(home), "session-A"));
    expect(calls[0].counter).toBe(join(calls[0].directory!, "turn"));
    expect(calls[0].directory).toBe(calls[1].directory);
    expect(calls[0].directory).toBe(calls[3].directory);
    expect(calls[0].directory).not.toBe(calls[2].directory);
    expect(statSync(calls[0].directory!).mode & 0o777).toBe(0o700);
    expect(statSync(calls[0].counter!).mode & 0o777).toBe(0o600);
    writeFileSync(join(calls[0].directory!, "chunks.json"), JSON.stringify({ version: 1, shown: [["old.md#0", 3]] }));
    await Promise.all(Array.from({ length: 3 }, () => invokeWorkerStage(home, "session-A", { TEST_WORKER_DELAY: "100" })));
    expect(captures(home).slice(4).map(call => call.turn)).toEqual(["4", "5", "6"]);
    expect(captures(home).every(call => !call.future)).toBe(true);
    for (const session of ["a/b", "..", "", "a".repeat(101)]) {
      expect(await invokeWorkerStage(home, session, { INLET_COUNTER_FILE: "foreign", INLET_CHUNK_CACHE_DIR: "foreign" })).toContain("FAKE-CONTEXT");
      expect(captures(home).at(-1)).toEqual({ counter: null, directory: null, turn: null, future: false });
    }
    expect(readdirSync(cacheRoot(home)).sort()).toEqual(["session-A", "session-B"]);
    expect(readFileSync(globalCounter(home), "utf8").trim()).toBe("6");
  });
});

for (const [scope, run] of [["full hook", invoke], ["isolated hook worker launch", invokeWorkerStage]] as const)
test(`real worker (${scope}) with a local archive suppresses old chunks on the second turn and survives session switches`, async () => {
  const hits = Array.from({ length: 8 }, (_, index) => ({
    filename: `excerpt-${index}.md`, chunkIndex: 0, content: `archive evidence ${index}`,
    score: 0.95 - index * 0.04, sources: ["rerank"],
  }));
  let available = hits.slice(0, 5);
  let searches = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/search") return new Response("unexpected route", { status: 404 });
    expect((await request.json()).query).toBe("storage decision");
    searches++;
    return Response.json({ results: available });
  } });
  try {
    await withHome(async home => {
      const env = { RAG_URL: `http://127.0.0.1:${server.port}`, INLET_EXPAND: "0", INLET_TEMPORAL: "0", INLET_DIVERSITY: "0" };
      const first = await run(home, "session-A", env);
      expect(first).toContain("archive evidence 0");
      const saved = join(cacheRoot(home), "session-A/chunks.json");
      expect(JSON.parse(readFileSync(saved, "utf8")).shown).toHaveLength(5);
      available = hits.slice(0, 7);
      const second = await run(home, "session-A", env);
      expect(second).not.toContain("archive evidence 0");
      expect(second).toContain("archive evidence 5");
      expect(second).toContain("archive evidence 6");
      expect(second).toContain("## Chronicle (RAG)"); // Not merely hook whole-block dedupe.
      // Four excerpts, not five: an identical block would be dropped by the hook's own
      // whole-block dedupe, which is shared by the house and not what this test is about.
      available = hits.slice(0, 4);
      expect(await run(home, "session-B", env)).toContain("archive evidence 0");
      available = hits;
      const resumed = await run(home, "session-A", env);
      expect(resumed).not.toContain("archive evidence 0");
      expect(resumed).not.toContain("archive evidence 5");
      expect(resumed).toContain("archive evidence 7");
      const shown = JSON.parse(readFileSync(saved, "utf8")).shown;
      expect(shown).toContainEqual(["excerpt-0.md#0", 0]);
      expect(shown).toContainEqual(["excerpt-5.md#0", 1]);
      expect(shown).toContainEqual(["excerpt-7.md#0", 3]);
      expect(searches).toBe(4);
    }, true);
  } finally { server.stop(true); }
}, 30_000);
