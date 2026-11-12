import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingUploads } from "./pending-uploads";

const root = mkdtempSync(join(tmpdir(), "schnitt-schneller-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const brainPath = join(import.meta.dir, "brain.ts");
const pendingPath = join(import.meta.dir, "pending-uploads.ts");
const ledgerPath = join(import.meta.dir, "archive-ledger.ts");

function sandbox() {
  const dir = mkdtempSync(join(root, "case-"));
  for (const name of ["logs", "state", "sessions", "park"]) mkdirSync(join(dir, name));
  writeFileSync(join(dir, "system.md"), "You are a test assistant.");
  writeFileSync(join(dir, "state", "archive-ledger.jsonl"), "");
  return dir;
}

// Each process has fresh module constants and caches, just like a restart.
async function run(dir: string, code: string, extra: Record<string, string> = {}) {
  const script = `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { archiveSession, retryPendingUploads, makeInitialState, runTurn, takeTurnItem } from ${JSON.stringify(brainPath)};
    import { readPendingUploads } from ${JSON.stringify(pendingPath)};
    import { readArchiveLedger } from ${JSON.stringify(ledgerPath)};
    const dir = process.cwd();
    const archive = join(dir, "sessions", "Fixture_7.md");
    const pendingFile = join(dir, "state", "pending_uploads.jsonl");
    const ledgerFile = join(dir, "state", "archive-ledger.jsonl");
    const uploadedFile = join(dir, "uploaded_sessions");
    const parkFile = join(dir, "park", "Fixture_7.md");
    const trace = [], uploads = [], deletions = [], requests = [];
    let headerCalls = 0, workerCalls = 0;
    const text = (file) => existsSync(file) ? readFileSync(file, "utf8") : "";
    const receipts = () => [...readArchiveLedger(ledgerFile).values()];
    const snapshot = () => ({ trace, uploads, deletions, requests, headerCalls, workerCalls,
      pending: readPendingUploads(pendingFile), receipts: receipts(),
      local: text(archive), parked: text(parkFile), uploadedLedger: text(uploadedFile) });
    const output = (value = snapshot()) => console.log("RESULT:" + JSON.stringify(value));
    Bun.serve = () => { throw new Error("Listeners are forbidden"); };
    Bun.spawn = (args) => {
      if (args[0] === "fixture-header") {
        headerCalls++;
        trace.push("header");
        const mode = process.env.HEADER_MODE;
        if (mode === "throw") throw new Error("Header spawn failed");
        if (mode === "fail") writeFileSync(args[1], "Broken output");
        else if (mode !== "invalid") writeFileSync(args[1], text(args[1]).replace("THEMES=—", "THEMES=Fixture"));
        return { exited: Promise.resolve(mode === "fail" ? 2 : 0), kill() {} };
      }
      if (args[0] === "bun" && args[1] === "fixture-inlet") {
        workerCalls++;
        return { exited: Promise.resolve(0), exitCode: 0,
          stdout: new Response("Retrieved fixture context").body,
          stderr: new Response("").body, kill() {} };
      }
      throw new Error("Unexpected process: " + JSON.stringify(args));
    };
    globalThis.fetch = async (url, options) => {
      if (String(url) === "https://fixture.invalid/upload") {
        trace.push("upload");
        const file = options.body.get("file");
        uploads.push({ name: file.name, content: await file.text(), local: text(archive),
          pending: readPendingUploads(pendingFile), parked: text(parkFile),
          uploadedLedger: text(uploadedFile), receipts: receipts() });
        return new Response("fixture", { status: Number(process.env.UPLOAD_STATUS || 200) });
      }
      if (String(url) === "https://fixture.invalid/delete") {
        trace.push("delete");
        deletions.push({ filename: JSON.parse(options.body).filename, receipts: receipts(),
          uploadedLedger: text(uploadedFile), parked: text(parkFile) });
        return new Response("deleted");
      }
      if (String(url) === "https://fixture.invalid/model") {
        requests.push(JSON.parse(options.body));
        return Response.json({ model: "fixture-model", choices: [{ message: { role: "assistant", content: "Fixture answer" } }],
          usage: { prompt_tokens: 20, completion_tokens: 3 } });
      }
      throw new Error("Unexpected fetch: " + url);
    };
    ${code}
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, BRAIN_NO_ENV_FILE: "1", BRAIN_STERILE: "1",
      BRAIN_SYSTEM: join(dir, "system.md"), BRAIN_LOG_DIR: join(dir, "logs"), BRAIN_STATE_DIR: join(dir, "state"),
      BRAIN_SESSION_ARCHIVE_DIR: join(dir, "sessions"), BRAIN_ARCHIVE_PARK_DIR: join(dir, "park"),
      BRAIN_UPLOAD_LEDGER: join(dir, "uploaded_sessions"), BRAIN_SESSION_NAME: "Fixture_7",
      BRAIN_HEADER_ENRICH_CMD: "fixture-header", BRAIN_RAG_URL: "https://fixture.invalid", BRAIN_RAG_AUTH_TOKEN: "fixture",
      BRAIN_HEAD: "api", BRAIN_ENDPOINT: "https://fixture.invalid/model", BRAIN_MODEL: "fixture-model",
      BRAIN_INLET_WORKER: "fixture-inlet", BRAIN_SENSE: "off", BRAIN_LIVE_VIEW: "off", ...extra,
    }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const result = stdout.split("\n").find((line) => line.startsWith("RESULT:"));
    expect(result).toBeDefined();
    return JSON.parse(result!.slice(7));
  } finally { clearTimeout(timer); }
}

function archiveCode(reason = "SIGTERM", strict = false, deferred = true) {
  return `
    const state = makeInitialState([]);
    state.history = [{ role: "user", content: "Keep this conversation." }, {
      role: "assistant", content: "Saved answer.",
      tool_calls: [{ id: "reply", type: "function", function: { name: "reply", arguments: JSON.stringify({ text: "Saved answer." }) } }],
    }];
    state.liveSegmentNames = ["Fixture_live01.md"];
    await archiveSession(state, ${JSON.stringify(reason)}, ${strict}, ${deferred});
    output();
  `;
}

function expectCompleted(result: any, enriched = true) {
  expect(result.local).toContain(enriched ? "THEMES=Fixture" : "THEMES=—");
  expect(result.uploads).toHaveLength(1);
  const upload = result.uploads[0];
  expect(upload.name).toBe("Fixture_7.md");
  expect(upload.content).toBe(result.local);
  expect(upload.local).toBe(result.local);
  expect(upload.parked).toBe("");
  expect(upload.uploadedLedger).toBe("");
  expect(upload.receipts[0].uploaded_at).toBeNull();
  expect(result.parked).toBe(result.local);
  expect(result.uploadedLedger).toContain(":Fixture_7\n");
  expect(result.receipts[0].uploaded_at).toBeTruthy();
  expect(result.pending).toEqual([]);
  expect(result.trace).toEqual(["header", "upload", "delete"]);
  expect(result.deletions).toHaveLength(1);
  expect(result.deletions[0].filename).toBe("Fixture_live01.md");
  expect(result.deletions[0].receipts[0].uploaded_at).toBeTruthy();
  expect(result.deletions[0].uploadedLedger).toContain(":Fixture_7\n");
  expect(result.deletions[0].parked).toBe(result.local);
  expect(result.local).toContain("Keep this conversation.");
  expect(result.local).toContain("Saved answer.");
}

test("a deferred cut leaves the basic header and pending enrichment for a fresh process", async () => {
  const dir = sandbox();
  const before = await run(dir, archiveCode());
  expect(before.headerCalls).toBe(0);
  expect(before.trace).toEqual([]);
  expect(before.uploads).toEqual([]);
  expect(before.local).toContain("THEMES=—");
  expect(before.parked).toBe("");
  expect(before.uploadedLedger).toBe("");
  expect(before.pending).toHaveLength(1);
  expect(before.pending[0]).toMatchObject({ deferred: true, headerPending: true, segments: ["Fixture_live01.md"] });
  expect(before.receipts[0].uploaded_at).toBeNull();
  const after = await run(dir, "await retryPendingUploads(); output();");
  expectCompleted(after);
  expect(after.headerCalls).toBe(1);
  expect(after.uploads[0].pending[0].headerPending).toBe(false);
  expect(after.uploads[0].pending[0].since).toBe(before.pending[0].since);
  expect(after.receipts[0].session).toBe(before.receipts[0].session);
});

for (const mode of ["fail", "invalid", "throw"]) {
  test(`deferred enrichment failure (${mode}) still uploads the basic archive`, async () => {
    const dir = sandbox();
    const before = await run(dir, archiveCode());
    const after = await run(dir, "await retryPendingUploads(); output();", { HEADER_MODE: mode });
    expectCompleted(after, false);
    expect(after.local).toBe(before.local);
  });
}

test("a failed upload retains live segments and retries the persisted header without another enrichment", async () => {
  const dir = sandbox();
  await run(dir, archiveCode());
  const failed = await run(dir, "await retryPendingUploads(); output();", { UPLOAD_STATUS: "503" });
  expect(failed.trace).toEqual(["header", "upload"]);
  expect(failed.pending[0].headerPending).toBe(false);
  expect(failed.pending[0].segments).toEqual(["Fixture_live01.md"]);
  expect(failed.receipts[0].uploaded_at).toBeNull();
  expect(failed.parked).toBe("");
  expect(failed.uploadedLedger).toBe("");
  const retried = await run(dir, "await retryPendingUploads(); output();");
  expect(retried.headerCalls).toBe(0);
  expect(retried.trace).toEqual(["upload", "delete"]);
  expect(retried.uploads[0].content).toBe(failed.local);
  expect(retried.pending).toEqual([]);
});

for (const [reason, strict, deferred] of [["jump", false, false], ["stop", false, false], ["move", true, false], ["move", true, true]] as const) {
  test(`immediate ${reason} (strict=${strict}, requested defer=${deferred}) keeps enrichment before upload`, async () => {
    expectCompleted(await run(sandbox(), archiveCode(reason, strict, deferred)));
  });
}

test("legacy pending entries without a header marker do not run enrichment", async () => {
  const dir = sandbox();
  await run(dir, archiveCode());
  const file = join(dir, "state", "pending_uploads.jsonl");
  const entries = readPendingUploads(file).map((entry) => {
    const { headerPending, ...legacy } = entry as typeof entry & { headerPending?: boolean };
    return legacy;
  });
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const result = await run(dir, "await retryPendingUploads(); output();");
  expect(result.headerCalls).toBe(0);
  expect(result.trace).toEqual(["upload", "delete"]);
  expect(result.uploads[0].content).toContain("THEMES=—");
  expect(result.pending).toEqual([]);
});

test("the queued greeting bypasses the inlet worker, while person and other internal turns still call it", async () => {
  const source = readFileSync(brainPath, "utf8");
  const greeting = source.match(/queue\.push\((\{[^\n]*text: GREET_PROMPT[^\n]*\})\);/);
  expect(greeting).not.toBeNull();
  const options = source.match(/runTurn\(state, item\.text, inletOn, (\{[^\n]+\})\);/);
  expect(options).not.toBeNull();
  // Evaluate the production queue entry and forwarding expression so losing either marker fails this test.
  const result = await run(sandbox(), `
    const GREET_PROMPT = "Start greeting";
    const queue = [${greeting![1]}];
    let item = takeTurnItem(queue);
    const state = makeInitialState([]);
    state.wakeLoaded = true;
    await runTurn(state, item.text, true, ${options![1]});
    const greetingCalls = workerCalls;
    item = { kind: "user", source: "terminal", text: "A person asks a question" };
    await runTurn(state, item.text, true, ${options![1]});
    const personCalls = workerCalls;
    item = { kind: "internal", source: "internal", text: "Another internal turn" };
    await runTurn(state, item.text, true, ${options![1]});
    output({ ...snapshot(), greetingCalls, personCalls });
  `);
  expect(result.greetingCalls).toBe(0);
  expect(result.personCalls).toBe(1);
  expect(result.workerCalls).toBe(2);
  expect(result.requests).toHaveLength(3);
  expect(JSON.stringify(result.requests[0])).not.toContain("Retrieved fixture context");
  expect(JSON.stringify(result.requests[1])).toContain("Retrieved fixture context");
});
