import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const source = fs.readFileSync(join(import.meta.dir, "server.ts"), "utf8");
const text = "Choose a style?\n1. Short\n2. Detailed";
const question = { id: createHash("sha256").update(text).digest("hex"), text, options: [{ number: 1, label: "Short" }, { number: 2, label: "Detailed" }] };
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "house-question-"));
  // Exercise the route handlers without starting a service or loading its environment.
  const routes = new Map<string, (c: any) => Promise<Response>>();
  const app = {
    get: (path: string, handler: any) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: any) => routes.set(`POST ${path}`, handler),
    request: async (path: string, init: RequestInit) => {
      const request = new Request(`http://localhost${path}`, init);
      const headers = new Headers();
      const handler = routes.get(`${request.method} ${path}`);
      if (!handler) throw new Error(`Missing route: ${path}`);
      return handler({
        req: { header: (name: string) => request.headers.get(name), json: () => request.json() },
        header: (name: string, value: string) => headers.set(name, value),
        json: (body: unknown, status = 200) => Response.json(body, { status, headers }),
      });
    },
  };
  const events: any[] = [], writes: any[] = [], pushes: any[] = [];
  let now = Date.now();
  const start = source.indexOf("// House question routes");
  const end = source.indexOf("async function captureFirstStartPane", start);
  expect(start).toBeGreaterThan(-1);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const fileFunctions = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, unlinkSync: fs.unlinkSync,
    renameSync: (from: string, to: string) => { writes.push({ mode: fs.statSync(from).mode & 0o777, value: JSON.parse(fs.readFileSync(from, "utf8")), to }); fs.renameSync(from, to); } };
  new Function("app", "EMBERVY_HOME_DIR", "join", "createHash", "INTERNAL_API_TOKEN", "bearerMatches", "isHumanSession", "broadcastToClients", "sendPushToAll", "S", "Date", ...Object.keys(fileFunctions), code)(
    app, dir, join, createHash, "test-internal", (value: string, token: string) => value === `Bearer ${token}`,
    async (c: any) => ["session=test", "session=second"].includes(c.req.header("cookie")), (event: any) => events.push(event), async (...args: any[]) => { pushes.push(args); }, (key: string) => key, { now: () => now }, ...Object.values(fileFunctions),
  );
  const call = (path: string, body?: any, auth = "human") => app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(auth === "human" ? { cookie: "session=test" } : auth === "second" ? { cookie: "session=second" } : auth === "internal" ? { authorization: "Bearer test-internal" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { dir, call, events, writes, pushes, advance: (ms: number) => { now += ms; }, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("house question internal route requires its bearer and answer requires a human session", async () => {
  const f = fixture();
  try {
    for (const auth of ["none", "human"]) expect((await f.call("/api/internal/house-question", { action: "pending", question }, auth)).status).toBe(401);
    expect((await f.call("/api/internal/house-question", { action: "pending", question }, "internal")).status).toBe(200);
    for (const auth of ["none", "internal"]) expect((await f.call("/api/house-question/answer", { id: question.id, number: 1 }, auth)).status).toBe(401);
    expect((await f.call("/api/house-question", undefined, "none")).status).toBe(401);
    expect(await (await f.call("/api/house-question")).json()).toMatchObject({ question });
  } finally { f.close(); }
});

test("house question answers validate stored options and use private atomic state files", async () => {
  const f = fixture();
  try {
    await f.call("/api/internal/house-question", { action: "pending", question }, "internal");
    for (const body of [{ id: "old", number: 1 }, { id: question.id, number: 3 }, { id: question.id, number: "1" }, { id: question.id, number: "1; exit" }]) expect((await f.call("/api/house-question/answer", body)).status).toBe(409);
    expect(fs.existsSync(join(f.dir, "state/house-question-answer.json"))).toBe(false);
    expect((await f.call("/api/house-question/answer", { id: question.id, number: 2 })).status).toBe(200);
    const file = join(f.dir, "state/house-question-answer.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ id: question.id, number: 2 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(f.writes.every(w => w.mode === 0o600)).toBe(true);
    expect(f.writes.some(w => w.to === file)).toBe(true);
    expect(fs.readdirSync(join(f.dir, "state")).some(name => name.endsWith(".tmp"))).toBe(false);
    expect((await f.call("/api/house-question/answer", { id: question.id, number: 1 })).status).toBe(409);
    await f.call("/api/internal/house-question", { action: "resolved", id: "old" }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).not.toBeNull();
    await f.call("/api/internal/house-question", { action: "resolved", id: question.id }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(f.events.at(-1).type).toBe("house-question");
  } finally { f.close(); }
});

test("Enter questions require empty options and a literal true flag", async () => {
  const f = fixture();
  const text = "Press Enter to continue";
  const enterQuestion = { id: createHash("sha256").update(text).digest("hex"), text, options: [], enter: true };
  try {
    for (const q of [
      { ...question, enter: true }, { ...question, enter: false },
      { ...question, enter: "true" }, { ...question, enter: null },
      { ...enterQuestion, options: question.options },
      { ...enterQuestion, enter: false }, { ...enterQuestion, enter: "true" },
      { ...question, options: [], enter: true },
    ]) expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(400);
    expect((await f.call("/api/internal/house-question", { action: "pending", question: enterQuestion }, "internal")).status).toBe(200);
    expect((await (await f.call("/api/house-question")).json()).question).toMatchObject(enterQuestion);
    for (const body of [
      { id: "old", enter: true }, { id: enterQuestion.id },
      { id: enterQuestion.id, enter: false }, { id: enterQuestion.id, enter: "true" },
      { id: enterQuestion.id, number: 1 }, { id: enterQuestion.id, enter: true, number: 1 },
      { id: enterQuestion.id, enter: true, text: "unsafe" },
    ]) expect((await f.call("/api/house-question/answer", body)).status).toBe(409);
    expect(f.writes.filter(w => w.to.endsWith("house-question-answer.json"))).toHaveLength(0);
    expect((await f.call("/api/house-question/answer", { id: enterQuestion.id, enter: true })).status).toBe(200);
    const file = join(f.dir, "state/house-question-answer.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ id: enterQuestion.id, enter: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await f.call("/api/house-question/answer", { id: enterQuestion.id, enter: true })).status).toBe(409);
    await f.call("/api/internal/house-question", { action: "pending", question }, "internal");
    for (const body of [{ id: question.id, enter: true }, { id: question.id, enter: true, number: 1 }]) {
      expect((await f.call("/api/house-question/answer", body)).status).toBe(409);
    }
    const fallbackText = "Choose the text style";
    const fallback = { id: createHash("sha256").update(fallbackText).digest("hex"), text: fallbackText, options: [] };
    expect((await f.call("/api/internal/house-question", { action: "pending", question: fallback }, "internal")).status).toBe(200);
    expect((await f.call("/api/house-question/answer", { id: fallback.id, enter: true })).status).toBe(409);
  } finally { f.close(); }
});

test("read-only unknown screens preserve visible numbered text but reject every answer", async () => {
  const f = fixture();
  const text = "May this house borrow a moon?\n1. Perhaps\nPress any key\nYour agent is waiting in its terminal; open TUI at the top and inspect it.";
  const q = { id: createHash("sha256").update(text).digest("hex"), text, options: [], readonly: true };
  try {
    expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(200);
    expect((await (await f.call("/api/house-question")).json()).question).toMatchObject(q);
    for (const body of [{ id: q.id }, { id: q.id, number: 1 }, { id: q.id, enter: true }]) {
      expect((await f.call("/api/house-question/answer", body)).status).toBe(409);
    }
    expect(fs.existsSync(join(f.dir, "state/house-question-answer.json"))).toBe(false);
    for (const invalid of [
      { ...q, readonly: false }, { ...q, readonly: "true" }, { ...q, enter: true },
      { ...question, readonly: true }, { ...q, text: "x\n".repeat(31) }, { ...q, text: "x".repeat(12001) },
    ]) expect((await f.call("/api/internal/house-question", { action: "pending", question: invalid }, "internal")).status).toBe(400);
    await f.call("/api/internal/house-question", { action: "resolved", id: q.id }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
  } finally { f.close(); }
});

test("expired questions close and cannot receive an answer", async () => {
  const f = fixture();
  try {
    await f.call("/api/internal/house-question", { action: "pending", question }, "internal");
    f.advance(86400000);
    expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
    expect((await f.call("/api/house-question/answer", { id: question.id, number: 1 })).status).toBe(409);
  } finally { f.close(); }
});

test("a start question open beyond a day expires on the server without producing terminal input", async () => {
  for (const access of ["read", "answer"]) {
    const f = fixture();
    const q = { ...question, instance: "start-process:1" };
    try {
      expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(200);
      f.advance(86400001);
      // Both a browser refresh and a direct stale-card answer must enforce expiry.
      if (access === "read") expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
      expect((await f.call("/api/house-question/answer", { id: q.id, instance: q.instance, number: 1 })).status).toBe(409);
      expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
      expect(fs.existsSync(join(f.dir, "state/house-question.json"))).toBe(false);
      expect(fs.existsSync(join(f.dir, "state/house-question-answer.json"))).toBe(false);
      expect(f.writes.filter(w => w.to.endsWith("house-question-answer.json"))).toHaveLength(0);
      expect(f.pushes).toHaveLength(1);
    } finally { f.close(); }
  }
});

test("permission instances bind answers, closes, retries and the twenty-four-hour limit", async () => {
  const f = fixture();
  const q = { ...question, permission: true, instance: "process-one:1" };
  try {
    for (const instance of [undefined, "", "invalid", 1, "x:0", "x:1\n"]) {
      expect((await f.call("/api/internal/house-question", { action: "pending", question: { ...q, instance } }, "internal")).status).toBe(400);
    }
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    const first = (await (await f.call("/api/house-question")).json()).question;
    expect(first.instance).toBe(q.instance);
    f.advance(5000);
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question.expiresAt).toBe(first.expiresAt);
    for (const instance of [undefined, "process-one:2", "previous-process:1"]) {
      expect((await f.call("/api/house-question/answer", { id: q.id, instance, number: 1 })).status).toBe(409);
    }
    f.advance(86400000);
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
    expect((await f.call("/api/house-question/answer", { id: q.id, instance: q.instance, number: 1 })).status).toBe(409);
    for (const instance of ["process-one:2", "process-two:1"]) {
      await f.call("/api/internal/house-question", { action: "pending", question: { ...q, instance } }, "internal");
      await f.call("/api/internal/house-question", { action: "resolved", id: q.id, instance: q.instance }, "internal");
      expect((await (await f.call("/api/house-question")).json()).question.instance).toBe(instance);
      expect((await f.call("/api/house-question/answer", { id: q.id, instance: q.instance, number: 1 })).status).toBe(409);
    }
  } finally { f.close(); }
});

test("concurrent human sessions can claim an instance only once, even after file consumption", async () => {
  const f = fixture();
  const q = { ...question, instance: "process-one:1" };
  try {
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    const answer = { id: q.id, instance: q.instance, number: 2 };
    const responses = await Promise.all([f.call("/api/house-question/answer", answer), f.call("/api/house-question/answer", answer, "second")]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(JSON.parse(fs.readFileSync(join(f.dir, "state/house-question-answer.json"), "utf8"))).toEqual(answer);
    fs.unlinkSync(join(f.dir, "state/house-question-answer.json"));
    expect((await f.call("/api/house-question/answer", answer, "second")).status).toBe(409);
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    expect((await (await f.call("/api/house-question")).json()).submitted).toBe(true);
    await f.call("/api/internal/house-question", { action: "pending", question: { ...q, instance: "process-one:2" } }, "internal");
    expect((await (await f.call("/api/house-question")).json()).submitted).toBe(false);
    expect((await f.call("/api/house-question/answer", answer)).status).toBe(409);
  } finally { f.close(); }
});

const autoPane = fs.readFileSync(join(import.meta.dir, "test-fixtures/panes/auto-mode-confirmation.txt"), "utf8");
function autoQuestion(time = "1:30", pane = autoPane.replace("1:30", time)) {
  const result = Bun.spawnSync(["bash", "-c", 'source "$1"; loop_dialog_question "$PANE" permission', "fixture", join(import.meta.dir, "../scripts/loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin", PANE: pane }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return { ...JSON.parse(result.stdout.toString()), instance: "auto-process:1" };
}

test("compact fixture text and exact card limits pass the unchanged internal route", async () => {
  const original = autoQuestion();
  const context = "Probe attempt 3: same command, unchanged";
  const padding = 12000 - original.text.length;
  const panes = [
    autoPane,
    autoPane.replace(context, context + "\n Context".repeat(30 - original.text.split("\n").length)),
    autoPane.replace(context, context + "x".repeat(padding)),
    autoPane.replace(context, context + "😀".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2)),
  ];
  for (const [index, pane] of panes.entries()) {
    const f = fixture();
    try {
      const q = autoQuestion("1:30", pane);
      expect(q.permission).toBe(true);
      expect(q.text.split("\n").slice(-3)).toEqual(["1. Yes", "2. Yes, and don't ask again for: curl *", "3. No"]);
      expect(q.id).toBe(createHash("sha256").update(q.text).digest("hex"));
      if (index === 1) expect(q.text.split("\n")).toHaveLength(30);
      if (index >= 2) expect(q.text.length).toBe(12000);
      expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(200);
      expect((await (await f.call("/api/house-question")).json()).question).toMatchObject(q);
      // Even a correctly hashed text must retain the exact choices on its buttons.
      const text = q.text.replace("2. Yes, and don't ask again for: curl *", "2. Yes, only once");
      const mismatched = { ...q, text, id: createHash("sha256").update(text).digest("hex") };
      expect((await f.call("/api/internal/house-question", { action: "pending", question: mismatched }, "internal")).status).toBe(400);
      expect((await f.call("/api/internal/house-question", { action: "pending", question: { ...q, id: "0".repeat(64) } }, "internal")).status).toBe(400);
    } finally { f.close(); }
  }
});

test("auto-mode deadlines reach the card and countdown retries do not push again", async () => {
  const f = fixture();
  try {
    const q = autoQuestion();
    expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(200);
    expect(f.pushes).toHaveLength(1);
    expect(f.pushes[0]).toEqual(["houseQuestion.heading", q.text]);
    const first = (await (await f.call("/api/house-question")).json()).question;
    expect(first).toMatchObject(q);
    const next = autoQuestion("1:24");
    expect(next.id).toBe(q.id);
    await f.call("/api/internal/house-question", { action: "pending", question: next }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).toEqual(first);
    expect(f.pushes).toHaveLength(1);
    for (const deadlineAt of ["later", -1, null, 1.5]) {
      expect((await f.call("/api/internal/house-question", { action: "pending", question: { ...q, deadlineAt } }, "internal")).status).toBe(400);
    }
  } finally { f.close(); }
});

for (const end of ["resolved", "deadline", "replacement", "reset"]) test(`unanswered permission remains closed in history after ${end} and never publishes an answer`, async () => {
  const f = fixture();
  try {
    const q = autoQuestion();
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    if (end === "deadline") f.advance(100000);
    else if (end === "replacement") await f.call("/api/internal/house-question", { action: "pending", question: { ...q, instance: "auto-process:2" } }, "internal");
    else await f.call("/api/internal/house-question", { action: end, id: q.id, instance: q.instance }, "internal");
    const data = await (await f.call("/api/house-question")).json();
    expect(data.history).toHaveLength(1);
    expect(data.history[0]).toMatchObject({ ...q, closed: true });
    expect(data.history[0].answerLabel).toBeUndefined();
    if (end !== "replacement") expect(data.question).toBeNull();
    for (const auth of ["human", "second"]) {
      expect((await f.call("/api/house-question/answer", { id: q.id, instance: q.instance, number: 1 }, auth)).status).toBe(409);
    }
    expect(f.writes.filter(w => w.to.endsWith("house-question-answer.json"))).toHaveLength(0);
    expect(fs.existsSync(join(f.dir, "state/house-question-answer.json"))).toBe(false);
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    const again = await (await f.call("/api/house-question")).json();
    expect(again.history).toEqual(data.history);
    expect(again.question).toEqual(data.question);
    expect(JSON.parse(fs.readFileSync(join(f.dir, "state/house-question-history.json"), "utf8"))).toEqual(data.history);
  } finally { f.close(); }
});

test("answered permission history retains the literal choice without accepting another answer", async () => {
  const f = fixture();
  try {
    const q = autoQuestion();
    await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal");
    const answer = { id: q.id, instance: q.instance, number: 2 };
    expect((await f.call("/api/house-question/answer", answer)).status).toBe(200);
    await f.call("/api/internal/house-question", { action: "resolved", id: q.id, instance: q.instance }, "internal");
    const data = await (await f.call("/api/house-question")).json();
    expect(data.question).toBeNull();
    expect(data.history[0]).toMatchObject({ closed: true, submitted: true, answerLabel: "Yes, and don't ask again for: curl *" });
    expect((await f.call("/api/house-question/answer", answer)).status).toBe(409);
    expect(fs.existsSync(join(f.dir, "state/house-question-answer.json"))).toBe(false);
    expect(f.pushes).toHaveLength(1);
  } finally { f.close(); }
});

test("new starts clear old questions and invalid dialog payloads are rejected", async () => {
  const f = fixture();
  try {
    for (const q of [{ ...question, id: "bad" }, { ...question, text: "x\n".repeat(31) }, { ...question, options: [{ number: 1, label: "different" }] }]) expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(400);
    await f.call("/api/internal/house-question", { action: "pending", question }, "internal");
    await f.call("/api/internal/house-question", { action: "reset" }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
  } finally { f.close(); }
});
