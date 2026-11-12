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
  const events: any[] = [], writes: any[] = [];
  let now = Date.now();
  const start = source.indexOf("// House question routes");
  const end = source.indexOf("async function captureFirstStartPane", start);
  expect(start).toBeGreaterThan(-1);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const fileFunctions = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync, existsSync: fs.existsSync, unlinkSync: fs.unlinkSync,
    renameSync: (from: string, to: string) => { writes.push({ mode: fs.statSync(from).mode & 0o777, value: JSON.parse(fs.readFileSync(from, "utf8")), to }); fs.renameSync(from, to); } };
  new Function("app", "EMBERVY_HOME_DIR", "join", "createHash", "INTERNAL_API_TOKEN", "bearerMatches", "isHumanSession", "broadcastToClients", "Date", ...Object.keys(fileFunctions), code)(
    app, dir, join, createHash, "test-internal", (value: string, token: string) => value === `Bearer ${token}`,
    async (c: any) => c.req.header("cookie") === "session=test", (event: any) => events.push(event), { now: () => now }, ...Object.values(fileFunctions),
  );
  const call = (path: string, body?: any, auth = "human") => app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(auth === "human" ? { cookie: "session=test" } : auth === "internal" ? { authorization: "Bearer test-internal" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { dir, call, events, writes, advance: (ms: number) => { now += ms; }, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
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

test("new starts clear old questions and invalid dialog payloads are rejected", async () => {
  const f = fixture();
  try {
    for (const q of [{ ...question, id: "bad" }, { ...question, text: "x\n".repeat(31) }, { ...question, options: [{ number: 1, label: "different" }] }]) expect((await f.call("/api/internal/house-question", { action: "pending", question: q }, "internal")).status).toBe(400);
    await f.call("/api/internal/house-question", { action: "pending", question }, "internal");
    await f.call("/api/internal/house-question", { action: "reset" }, "internal");
    expect((await (await f.call("/api/house-question")).json()).question).toBeNull();
  } finally { f.close(); }
});
