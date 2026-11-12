import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "brain-first-life-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sandbox() {
  const dir = mkdtempSync(join(root, "case-"));
  const state = join(dir, "state"), logs = join(dir, "logs");
  mkdirSync(state);
  mkdirSync(logs);
  const bridge = join(state, "bridge.md"), system = join(dir, "system.md");
  writeFileSync(system, "A local test runtime.");
  return { dir, state, logs, bridge, system };
}
type Box = ReturnType<typeof sandbox>;

const unrelated = { id: "fixture", label: "Local check", detail: "Still reported.", fix: "Keep this message." };

async function startup(box: Box, currentLogs = false) {
  const script = `
    import { makeInitialState, runTurn, logEvent } from ${JSON.stringify(join(import.meta.dir, "brain.ts"))};
    import { writeFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    globalThis.fetch = () => { throw new Error("Unexpected network call"); };
    const state = makeInitialState([]);
    state.head = { name: "api", transport: "api", model: "fixture", unavailable: "offline fixture" };
    if (${currentLogs}) {
      logEvent({ type: "session_started" });
      const file = readdirSync(process.env.BRAIN_LOG_DIR).find(file => file.startsWith("session-"));
      writeFileSync(join(process.env.BRAIN_LOG_DIR, file.replace("session-", "conversation-")), "");
    }
    try { await runTurn(state, "Local input", false); }
    catch (error) { if (error.message !== "head api unavailable: offline fixture") throw error; }
    if (!state.wakeLoaded) throw new Error("Startup did not finish");
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: box.dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: box.dir,
      BRAIN_NO_ENV_FILE: "1", BRAIN_STERILE: "1", BRAIN_LANG: "en",
      BRAIN_STATE_DIR: box.state, BRAIN_LOG_DIR: box.logs, BRAIN_BRIDGE_FILE: box.bridge,
      BRAIN_SYSTEM: box.system, BRAIN_SESSION_ARCHIVE_DIR: join(box.dir, "sessions"),
      BRAIN_UPLOAD_LEDGER: join(box.state, "uploaded_sessions"),
      BRAIN_SENSE: "off", BRAIN_INLET: "off", BRAIN_WEB_BROWSER: "off",
      BRAIN_DOCTOR_CMD: `printf '%s' '${JSON.stringify({ checks: [{ status: "WARN", ...unrelated }] })}'`,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  try {
    const [status, out, error] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ status, out, error }).toEqual({ status: 0, out: "", error: "" });
    const events = readdirSync(box.logs).filter(file => /^session-.+\.jsonl$/.test(file))
      .flatMap(file => readFileSync(join(box.logs, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
    const check = events.find(event => event.type === "house_check");
    expect(check).toBeDefined();
    const notices = Object.values(check).find(Array.isArray) as Array<{ id: string; label: string; detail: string; fix: string }>;
    expect(notices).toContainEqual(unrelated);
    expect(notices).toContainEqual({
      id: "wake", label: "Wake memory is unavailable",
      detail: "The agent starts without its current memory snapshot.",
      fix: "Restore the wake tool in the memory service; check BRAIN_MEMORY_URL and BRAIN_MEMORY_API_KEY.",
    });
    return notices.filter(notice => notice.id === "bridge");
  } finally { clearTimeout(timer); }
}

function expectedBridge(box: Box) {
  return [{ id: "bridge", label: "Conversation bridge is unavailable",
    detail: "The agent cannot see the end of its previous conversation at this start.",
    fix: `Check BRAIN_BRIDGE_FILE (${box.bridge}) and restore the previous conversation bridge.` }];
}

function receipt(box: Box) {
  return { session: "earlier", name: "Session_1", path: join(box.dir, "sessions", "Session_1.md"), archived_at: null, uploaded_at: null };
}

const evidence: Array<[string, (box: Box) => void]> = [
  ["archive receipt", box => writeFileSync(join(box.state, "archive-ledger.jsonl"), JSON.stringify(receipt(box)) + "\n")],
  ["archived session marker", box => writeFileSync(join(box.state, "archived_sessions.txt"), "earlier\n")],
  ["pending upload", box => {
    // The queue must count even after ledger migration has already completed.
    writeFileSync(join(box.state, "archive-ledger.jsonl"), "");
    writeFileSync(join(box.state, "pending_uploads.jsonl"), JSON.stringify({ ...receipt(box), since: "" }) + "\n");
  }],
  ["used bridge", box => writeFileSync(box.bridge.replace(/\.md$/, ".used.md"), "Previous conversation.")],
  ["earlier session log", box => writeFileSync(join(box.logs, "session-1-earlier.jsonl"), "")],
  ["earlier conversation log", box => writeFileSync(join(box.logs, "conversation-1-earlier.jsonl"), "")],
  ["legacy upload record", box => writeFileSync(join(box.state, "uploaded_sessions"), "conversation-earlier.jsonl:1:1:Session_1\n")],
  ["archive event", box => writeFileSync(join(box.logs, "session-earlier.jsonl"), JSON.stringify({ type: "session_archived", ...receipt(box) }) + "\n")],
];

test("empty state and log directories need no bridge", async () => {
  expect(await startup(sandbox())).toEqual([]);
});

test("current session logs alone need no bridge", async () => {
  expect(await startup(sandbox(), true)).toEqual([]);
});

for (const [label, prepare] of evidence) {
  test(`${label} keeps the missing bridge warning`, async () => {
    const box = sandbox();
    prepare(box);
    expect(await startup(box)).toEqual(expectedBridge(box));
  });
}

test("empty markers and unrelated log files need no bridge", async () => {
  const box = sandbox();
  for (const file of ["archive-ledger.jsonl", "archived_sessions.txt", "pending_uploads.jsonl", "uploaded_sessions"]) {
    writeFileSync(join(box.state, file), "\n");
  }
  writeFileSync(join(box.logs, "usage.jsonl"), "");
  expect(await startup(box)).toEqual([]);
});

for (const file of ["archive-ledger.jsonl", "archived_sessions.txt", "pending_uploads.jsonl", "bridge.used.md", "uploaded_sessions"]) {
  test(`unreadable ${file} does not interrupt startup or imply an earlier life`, async () => {
    const box = sandbox();
    // A directory fails reads even when the test runner can bypass file permissions.
    mkdirSync(join(box.state, file));
    expect(await startup(box)).toEqual([]);
  });
}

test("an unreadable archive ledger does not hide other evidence", async () => {
  const box = sandbox();
  mkdirSync(join(box.state, "archive-ledger.jsonl"));
  writeFileSync(join(box.state, "archived_sessions.txt"), "earlier\n");
  expect(await startup(box)).toEqual(expectedBridge(box));
});

test("a loaded bridge needs no warning", async () => {
  const box = sandbox();
  writeFileSync(box.bridge, "Previous conversation.");
  expect(await startup(box)).toEqual([]);
});
