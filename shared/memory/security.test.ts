import { expect, test } from "bun:test";
import worker from "./src/index";
import dreamWorker from "./dream-worker/src/index";

test("dream operational errors do not return the upstream exception", async () => {
  const fetcher = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("private dream upstream marker"); }) as typeof fetch;
  try {
    const response = await dreamWorker.fetch(new Request("https://dream.test/dream", {
      method: "POST", headers: { Authorization: "Bearer test" },
    }), { DREAM_AUTH_TOKEN: "test", OPENROUTER_API_KEY: "test", RAG: { fetch: async () => Response.json({ results: [] }) } } as any);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "dream failed" });
  } finally { globalThis.fetch = fetcher; }
});

const token = "offline-test-token";

async function callTool(env: any, name: string, args: any) {
  const response = await worker.fetch(new Request("https://memory.example/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), { ...env, EMBERVY_API_KEY: token });
  return response.json() as Promise<any>;
}

for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "text/html", "constructor", ""]) {
  test(`stored image MIME is constrained: ${mime}`, async () => {
    const env: any = { PUBLIC_IMAGES: "true", DB: { prepare(sql: string) {
      return { bind() { return this; }, first: async () => sql.includes("images_data")
        ? { data: btoa("<svg onload='alert(1)'/>"), mime_type: mime } : { id: 1 } };
    } } };
    const response = await worker.fetch(new Request("https://memory.example/images/1"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) ? mime : "application/octet-stream");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
}

for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon", "text/html"]) {
  test(`keep validates data URI types before storage: ${mime}`, async () => {
    const stored: any[][] = [];
    const env = { DB: { prepare(sql: string) {
      let values: any[] = [];
      return { bind(...args: any[]) { values = args; return this; }, first: async () => null,
        run: async () => { if (sql.includes("images_data")) stored.push(values); return { meta: { last_row_id: 1 } }; } };
    } } };
    const result = await callTool(env, "keep", { image_data: `data:${mime};base64,aGk=`, description: "test image" });
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
    if (allowed) {
      expect(result.result.isError).not.toBe(true);
      expect(stored[0].slice(1, 3)).toEqual(["aGk=", mime]);
    } else {
      expect(JSON.stringify(result)).toContain("unsupported image type");
      expect(stored).toEqual([]);
    }
  });
}


for (const source of ["constructor", "__proto__", "toString", "touch", "membrane-used", "membrane-injected", "membrane-distracting"]) {
  test(`touch uses only own counter names and bounded binds: ${source}`, async () => {
    let updated = 0;
    const env: any = { EMBERVY_API_KEY: token, DB: { prepare(sql: string) {
      let ids: any[] = [];
      return { bind(...values: any[]) { ids = values; expect(ids.length).toBeLessThanOrEqual(90); return this; },
        all: async () => ({ results: ["used_count", "last_used_at", "injected_count", "last_injected_at", "distracting_count", "salience"].map(name => ({ name })) }),
        run: async () => {
          if (sql.startsWith("UPDATE")) {
            expect(sql).not.toContain("function");
            expect(sql).toContain(source.startsWith("membrane-") ? source === "membrane-used" ? "used_count" : source === "membrane-injected" ? "injected_count" : "distracting_count" : "access_count");
            updated += ids.length;
          }
          return { meta: { changes: ids.length } };
        } };
    } } };
    const response = await worker.fetch(new Request("https://memory.example/touch", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: Array.from({ length: 200 }, (_, i) => i + 1), source }),
    }), env);
    expect(response.status).toBe(200);
    expect((await response.json() as any).touched).toBe(200);
    expect(updated).toBe(200);
  });
}

test("graph binds all hot and archive IDs, including hostile stored values, in bounded chunks", async () => {
  const hostile = "1) OR 1=1 --";
  const ids = [...Array.from({ length: 205 }, (_, i) => i + 1), hostile];
  const calls: { sql: string; values: any[] }[] = [];
  const env: any = { EMBERVY_API_KEY: token, DB: { prepare(sql: string) {
    let values: any[] = [];
    return { bind(...args: any[]) { values = args; expect(args.length).toBeLessThanOrEqual(90); return this; },
      run: async () => ({}), all: async () => {
        expect(sql).not.toContain(hostile);
        if (sql.includes("FROM event_edges")) return { results: ids.map(id => ({ from_event: id, to_event: id })) };
        if (sql.includes("WHERE id IN")) {
          calls.push({ sql, values });
          expect((sql.match(/\?/g) || []).length).toBe(values.length);
          return { results: values.filter(id => typeof id === "number" && (sql.includes("events_hot") ? id % 2 === 1 : id % 2 === 0)).map(id => ({ id })) };
        }
        return { results: [] };
      } };
  } } };
  const response = await worker.fetch(new Request("https://memory.example/graph", { headers: { Authorization: `Bearer ${token}` } }), env);
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(Object.keys(body).sort()).toEqual(["edges", "entities", "events", "relations"]);
  expect(body.events).toHaveLength(205);
  expect(calls.filter(call => call.sql.includes("events_hot"))).toHaveLength(3);
  expect(calls.filter(call => call.sql.includes("events_archive"))).toHaveLength(2);
});

test("health is liveness only and never reads D1, including with credentials", async () => {
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${token}`]) {
    const env: any = { EMBERVY_API_KEY: token, DB: { prepare() { throw new Error("D1 must not be read"); } } };
    const response = await worker.fetch(new Request("https://memory.example/health", {
      headers: authorization ? { Authorization: authorization } : {},
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(Object.keys(body).sort()).toEqual(["ok", "version"]);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  }
});

test("MCP health requires the bearer token and retains detail", async () => {
  let reads = 0;
  const env: any = { EMBERVY_API_KEY: token, DB: { prepare() {
    reads++;
    return { first: async () => null };
  } } };
  for (const authorized of [false, true]) {
    const response = await worker.fetch(new Request("https://memory.example/mcp", {
      method: "POST", headers: authorized ? { Authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health", arguments: {} } }),
    }), env);
    expect(response.status).toBe(authorized ? 200 : 401);
    expect(reads).toBe(authorized ? 6 : 0);
    if (authorized) expect(await response.text()).toContain("hot_count");
  }
});
