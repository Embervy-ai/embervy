import { expect, spyOn, test } from "bun:test";
import worker from "../src/index";
import { fakeEnv, TOKEN } from "./fake-env";

const auth = { Authorization: `Bearer ${TOKEN}` };
const url = "https://rag.test";

for (const value of ["1e400", "Infinity", "NaN", "-1", "0.5", "9007199254740992", "bad", ""]) {
  test(`numeric queries reject unsafe values without storage access: ${value}`, async () => {
    for (const [route, field] of [["/edges?pending=1", "offset"], ["/edges?pending=1", "limit"],
      ["/files?from=2026-01-01&to=2026-01-02", "facts"], ["/files?from=2026-01-01&to=2026-01-02", "limit"],
      ["/head?filename=test.md", "bytes"], ["/chunk?filename=test.md", "index"]]) {
      const response = await worker.fetch(new Request(`${url}${route}&${field}=${encodeURIComponent(value)}`, { headers: auth }), { RAG_AUTH_TOKEN: TOKEN } as any);
      expect(response.status).toBe(400);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });
}

for (const path of ["/edges?pending=1&limit=201", "/edges?pending=1&confirmed=2", "/head?filename=test.md&bytes=4001",
  "/files?from=2026-01-01&to=2026-01-02&facts=13", "/files?from=2026-01-01&to=2026-01-02&limit=501",
  "/chunk?filename=test.md&index=1000000", "/edges?pending=1&offset=0&offset=1e400"]) {
  test(`numeric query bounds: ${path}`, async () => {
    expect((await worker.fetch(new Request(url + path, { headers: auth }), { RAG_AUTH_TOKEN: TOKEN } as any)).status).toBe(400);
  });
}

test("valid edge pagination retains its shape and rejected-edge filter", async () => {
  const env = fakeEnv();
  const response = await worker.fetch(new Request(url + "/edges?confirmed=-1&offset=0&limit=200", { headers: auth }), env as any);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ edges: [], offset: 0, limit: 200 });
  env.FTS.db.close();
});

for (const declared of [undefined, "1", String(10 * 1024 * 1024 + 64 * 1024 + 1)]) {
  test(`upload caps the stream before multipart parsing: declared ${declared}`, async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    const request = new Request(url + "/upload", { method: "POST", headers: {
      ...auth, "Content-Type": "multipart/form-data; boundary=test", ...(declared ? { "Content-Length": declared } : {}),
    }, body });
    const response = await worker.fetch(request, { RAG_AUTH_TOKEN: TOKEN } as any);
    expect(response.status).toBe(413);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(cancelled).toBe(true);
  });
}

test("malformed multipart and a string file part are client errors", async () => {
  for (const body of ["not multipart", (() => { const form = new FormData(); form.set("file", "not a file"); return form; })()]) {
    const response = await worker.fetch(new Request(url + "/upload", { method: "POST", headers: auth, body }), { RAG_AUTH_TOKEN: TOKEN } as any);
    expect(response.status).toBe(400);
  }
});

for (const phase of ["prepare", "cleanup", "finalize"]) {
  test(`deletion logs but does not return errors during ${phase}`, async () => {
    const secret = "private-upstream-body-marker";
    const env = fakeEnv();
    env.FTS.db.exec("CREATE TABLE rag_deletions (filename TEXT PRIMARY KEY, plan TEXT NOT NULL)");
    env.FTS.db.run("INSERT INTO rag_deletions VALUES (?, ?)", ["test.md", JSON.stringify({ keys: ["originals/test.md"], vectorIds: [] })]);
    const prepare = env.FTS.prepare.bind(env.FTS);
    if (phase === "cleanup") env.R2.delete = async () => { throw new Error(secret); };
    else env.FTS.prepare = sql => {
      if (sql.startsWith(phase === "prepare" ? "CREATE TABLE IF NOT EXISTS rag_deletions" : "DELETE FROM rag_deletions")) throw new Error(secret);
      return prepare(sql);
    };
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await worker.fetch(new Request(url + "/delete", { method: "POST", headers: auth, body: JSON.stringify({ filename: "test.md" }) }), env as any);
      expect(response.status).toBe(500);
      const result = await response.json() as any;
      expect(result).toMatchObject({ success: false, partial: true });
      expect(Array.isArray(result.completed)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(log.mock.calls.some(call => call.some(value => String(value).includes(secret)))).toBe(true);
    } finally { log.mockRestore(); env.FTS.db.close(); }
  });
}
