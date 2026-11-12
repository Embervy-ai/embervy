import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshStoredCredential, withCredentialLock, writePrivateJson } from "../scripts/credential-store";
import { loadTokenCache, refreshToken, saveTokenCache } from "../mail/graph";
import { rotateFeedToken, envGet } from "../calendar/feed-token";
import * as signin from "../scripts/chatgpt-signin";

const source = readFileSync(join(import.meta.dir, "chatgpt-oauth-adapter.ts"), "utf8");
function adapter(path: string, fetch: typeof globalThis.fetch, signals: Pick<typeof AbortSignal, "timeout"> = AbortSignal) {
  // The slice is evaluated as a function body, so module exports become plain declarations.
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(source.indexOf("function loadTokens"), source.indexOf("// Hashes let diagnostics"))).replace(/^export /gm, "");
  const official = ["chatgptModels", "chatgptRoute", "ChatGptRouteError", "officialRouteError", "OFFICIAL_TOKEN", "OFFICIAL_RESOURCE", "OFFICIAL_RESPONSES", "readOfficialResponse"] as const;
  return new Function("AUTH_FILE", "readFileSync", "refreshStoredCredential", "writePrivateJson", "fetch", "OAUTH_TOKEN_URL", "OAUTH_CLIENT_ID", "BACKEND", "AbortSignal", "MODEL", ...official, code + "; return { callBackend, refreshTokens };")(
    path, readFileSync, refreshStoredCredential, writePrivateJson, fetch, "https://test/token", "client", "https://test/backend", signals, "model", ...official.map(k => (signin as any)[k]));
}

for (const kind of ["adapter", "graph"]) {
  for (const stale of [false, true]) {
    test(`${kind}: parallel refresh, ${stale ? "leftover lock file" : "shared promise"}, private replacement`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "credential-refresh-"));
      const path = join(dir, "auth.json");
      const original = globalThis.fetch;
      try {
        let requests = 0;
        const used: string[] = [];
        const old = { access_token: "old", refresh_token: "refresh-old", expires_at: 0 };
        if (kind === "adapter") writeFileSync(path, JSON.stringify({ tokens: { ...old, account_id: "account" }, last_refresh: "2000-01-01" }), { mode: 0o644 });
        else { await saveTokenCache(path, old); }
        if (stale) {
          writeFileSync(path + ".lock", "stale");
          utimesSync(path + ".lock", new Date(0), new Date(0));
        }
        const mock = (async (url: any, init: any) => {
          if (String(url).endsWith("/token")) {
            requests++;
            const body = kind === "adapter" ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
            expect(body.refresh_token).toBe("refresh-old");
            await Bun.sleep(40);
            return Response.json({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600 });
          }
          const auth = init.headers.Authorization;
          if (auth === "Bearer old") { await Bun.sleep(10); return new Response("expired", { status: 401 }); }
          used.push(auth);
          return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n');
        }) as typeof fetch;
        if (kind === "adapter") {
          const api = adapter(path, mock);
          await Promise.all(Array.from({ length: 8 }, () => api.callBackend({ input: [] })));
          expect(used).toEqual(Array(8).fill("Bearer new"));
          await api.refreshTokens("old");
          expect(JSON.parse(readFileSync(path, "utf8")).tokens.refresh_token).toBe("refresh-new");
        } else {
          globalThis.fetch = mock;
          const results = await Promise.all(Array.from({ length: 8 }, () => refreshToken("client", path, old)));
          expect(results.every((value) => value.access_token === "new" && value.refresh_token === "refresh-new")).toBe(true);
          await refreshToken("client", path, old);
          expect((await loadTokenCache(path))!.refresh_token).toBe("refresh-new");
        }
        expect(requests).toBe(1);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(existsSync(path + ".lock")).toBe(true);
      } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

for (const kind of ["adapter", "graph", "feed"]) {
  test(`${kind}: re-reads after waiting for another writer`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "credential-reread-"));
    const path = join(dir, "auth.json");
    const original = globalThis.fetch;
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((done) => { acquired = done; });
    const hold = new Promise<void>((done) => { release = done; });
    let lock: Promise<void> | undefined;
    try {
      const old = { access_token: "old", refresh_token: "old-refresh", expires_at: 0 };
      if (kind === "feed") writeFileSync(path, "CALENDAR_FEED_TOKEN=old\nKEEP=value\n");
      else await writePrivateJson(path, kind === "adapter" ? { tokens: old } : old);
      lock = withCredentialLock(path, async () => { acquired(); await hold; });
      await ready;
      const refuse = (async () => { throw new Error("must not spend a refreshed token"); }) as typeof fetch;
      globalThis.fetch = refuse;
      const waiting = kind === "adapter" ? adapter(path, refuse).refreshTokens("old") : kind === "graph" ? refreshToken("client", path, old) : rotateFeedToken(path);
      await Bun.sleep(50);
      if (kind === "feed") writeFileSync(path, "CALENDAR_FEED_TOKEN=other-process\nKEEP=updated\n");
      else await writePrivateJson(path, kind === "adapter" ? { tokens: { ...old, access_token: "other-process" } } : { ...old, access_token: "other-process" });
      release(); await lock;
      const result = await waiting;
      if (kind === "graph") expect(result.access_token).toBe("other-process");
      if (kind === "feed") { expect(result.token).toBe("other-process"); expect(envGet(result.text, "KEEP")).toBe("updated"); }
      expect(existsSync(path + ".lock")).toBe(true);
    } finally { release?.(); await lock; globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const stale of [false, true]) {
  test(`feed rotation: concurrent callers and private replacement, stale=${stale}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "feed-rotation-"));
    const path = join(dir, ".env");
    try {
      writeFileSync(path, "CALENDAR_FEED_TOKEN=old\nKEEP=value\n", { mode: 0o644 });
      if (stale) { writeFileSync(path + ".lock", ""); utimesSync(path + ".lock", new Date(0), new Date(0)); }
      const results = await Promise.all(Array.from({ length: 8 }, () => rotateFeedToken(path)));
      expect(new Set(results.map((r) => r.token)).size).toBe(1);
      expect(results[0].token).toMatch(/^[a-f0-9]{64}$/);
      expect(envGet(readFileSync(path, "utf8"), "KEEP")).toBe("value");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(path + ".lock")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("refresh failures release the lock and permit retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-failure-"));
  const path = join(dir, "auth.json");
  try {
    const fail = () => refreshStoredCredential(path, async () => { await Bun.sleep(10); throw new Error("refused"); });
    const a = fail(), b = fail();
    expect(a).toBe(b);
    expect((await Promise.allSettled([a, b])).every((r) => r.status === "rejected")).toBe(true);
    expect(existsSync(path + ".lock")).toBe(true);
    expect(await refreshStoredCredential(path, async () => 42)).toBe(42);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("separate processes serialize and re-read the shared credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-process-"));
  const path = join(dir, "auth.json");
  const worker = join(dir, "worker.ts");
  try {
    await writePrivateJson(path, { access_token: "old" });
    writeFileSync(worker, `import { refreshStoredCredential, writePrivateJson } from ${JSON.stringify(join(import.meta.dir, "../scripts/credential-store.ts"))};
import { readFileSync, appendFileSync } from "node:fs";
await refreshStoredCredential(${JSON.stringify(path)}, async () => {
 const current = JSON.parse(readFileSync(${JSON.stringify(path)}, "utf8"));
 if (current.access_token !== "old") return;
 appendFileSync(${JSON.stringify(join(dir, "requests"))}, "request\\n");
 await Bun.sleep(100);
 await writePrivateJson(${JSON.stringify(path)}, { access_token: "new" });
});
if (JSON.parse(readFileSync(${JSON.stringify(path)}, "utf8")).access_token !== "new") process.exit(1);
`);
    const processes = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, worker], { stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(processes.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
    expect(readFileSync(join(dir, "requests"), "utf8")).toBe("request\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const credentialStore = join(import.meta.dir, "../scripts/credential-store.ts");
function lockWorker(path: string, body: string, before = "") {
  return Bun.spawn([process.execPath, "--eval", `
import { withCredentialLock } from ${JSON.stringify(credentialStore)};
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
${before}
await withCredentialLock(${JSON.stringify(path)}, async () => { ${body} });
`], { stdout: "ignore", stderr: "pipe" });
}
type Worker = ReturnType<typeof lockWorker>;
async function workerDone(worker: Worker) {
  const code = await worker.exited;
  expect(await new Response(worker.stderr).text()).toBe("");
  expect(code).toBe(0);
}
async function stopWorkers(workers: Worker[]) {
  for (const worker of workers) { if (worker.exitCode === null) worker.kill("SIGKILL"); }
  await Promise.all(workers.map((worker) => worker.exited));
}
async function waitForFile(path: string) {
  const deadline = performance.now() + 3000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`Worker did not create ${path}`);
    await Bun.sleep(10);
  }
}

test("independent processes never have more than one active lock holder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-holders-"));
  const path = join(dir, "auth.json");
  const counter = join(dir, "counter"), events = join(dir, "events"), start = join(dir, "start");
  const workers: Worker[] = [];
  try {
    writeFileSync(counter, "0");
    for (let i = 0; i < 6; i++) {
      workers.push(lockWorker(path, `
for (let round = 0; round < 3; round++) {
  const active = Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
  writeFileSync(${JSON.stringify(counter)}, String(active));
  appendFileSync(${JSON.stringify(events)}, "+1\\n");
  if (active !== 1) throw new Error("overlapping holders");
  await Bun.sleep(30);
  writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) - 1));
  appendFileSync(${JSON.stringify(events)}, "-1\\n");
}`, `writeFileSync(${JSON.stringify(join(dir, "ready-" + i))}, "");
while (!existsSync(${JSON.stringify(start)})) await Bun.sleep(5);`));
    }
    await Promise.all(workers.map((_, i) => waitForFile(join(dir, "ready-" + i))));
    writeFileSync(start, "");
    await Promise.all(workers.map(workerDone));
    let active = 0, maximum = 0;
    const changes = readFileSync(events, "utf8").trim().split("\n").map(Number);
    expect(changes).toHaveLength(36);
    for (const change of changes) { active += change; maximum = Math.max(maximum, active); expect(active).toBeGreaterThanOrEqual(0); }
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("0");
    expect(statSync(path + ".lock").mode & 0o777).toBe(0o600);
  } finally { await stopWorkers(workers); rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

test("SIGKILL releases the kernel lock immediately without replacing its inode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-killed-"));
  const path = join(dir, "auth.json"), ready = join(dir, "held");
  const workers: Worker[] = [];
  try {
    const holder = lockWorker(path, `writeFileSync(${JSON.stringify(ready)}, ""); await Bun.sleep(60_000);`);
    workers.push(holder);
    await waitForFile(ready);
    const inode = statSync(path + ".lock").ino;
    holder.kill("SIGKILL");
    await holder.exited;
    expect(holder.signalCode).toBe("SIGKILL");
    await expect(withCredentialLock(path, async () => 42, 1000)).resolves.toBe(42);
    expect(statSync(path + ".lock").ino).toBe(inode);
  } finally { await stopWorkers(workers); rmSync(dir, { recursive: true, force: true }); }
});

test("a slow holder keeps a waiting process out even when the lock mtime is old", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-slow-"));
  const path = join(dir, "auth.json"), held = join(dir, "held"), release = join(dir, "release");
  const waiting = join(dir, "waiting"), entered = join(dir, "entered");
  const workers: Worker[] = [];
  try {
    const holder = lockWorker(path, `writeFileSync(${JSON.stringify(held)}, ""); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);`);
    workers.push(holder);
    await waitForFile(held);
    const inode = statSync(path + ".lock").ino;
    utimesSync(path + ".lock", new Date(0), new Date(0));
    const second = lockWorker(path, `writeFileSync(${JSON.stringify(entered)}, "");`, `writeFileSync(${JSON.stringify(waiting)}, "");`);
    workers.push(second);
    await waitForFile(waiting);
    await Bun.sleep(150);
    expect(existsSync(entered)).toBe(false);
    writeFileSync(release, "");
    await Promise.all(workers.map(workerDone));
    expect(existsSync(entered)).toBe(true);
    expect(statSync(path + ".lock").ino).toBe(inode);
  } finally { await stopWorkers(workers); rmSync(dir, { recursive: true, force: true }); }
});

test("the wait limit names the lock and a timed-out descriptor cannot retain it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-limit-"));
  const path = join(dir, "auth.json"), held = join(dir, "held"), release = join(dir, "release");
  const workers: Worker[] = [];
  try {
    workers.push(lockWorker(path, `writeFileSync(${JSON.stringify(held)}, ""); while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(5);`));
    await waitForFile(held);
    let entered = false;
    await expect(withCredentialLock(path, async () => { entered = true; }, 40)).rejects.toThrow(`Timed out waiting for credential lock ${path}.lock after 40 ms`);
    expect(entered).toBe(false);
    writeFileSync(release, "");
    await workerDone(workers[0]);
    await expect(withCredentialLock(path, async () => 42, 1000)).resolves.toBe(42);
  } finally { await stopWorkers(workers); rmSync(dir, { recursive: true, force: true }); }
});

test("an existing fresh or old protocol lock is opened without deletion or delay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-leftover-"));
  const path = join(dir, "auth.json");
  try {
    writeFileSync(path + ".lock", "old-owner", { mode: 0o600 });
    const inode = statSync(path + ".lock").ino;
    for (const age of [new Date(), new Date(0)]) {
      utimesSync(path + ".lock", age, age);
      await expect(withCredentialLock(path, async () => 42, 1000)).resolves.toBe(42);
      expect(statSync(path + ".lock").ino).toBe(inode);
      expect(readFileSync(path + ".lock", "utf8")).toBe("old-owner");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsupported platforms fail on the first lock attempt without a file fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-platform-"));
  const path = join(dir, "auth.json");
  const workers: Worker[] = [];
  try {
    const worker = Bun.spawn([process.execPath, "--eval", `
import { withCredentialLock } from ${JSON.stringify(credentialStore)};
Object.defineProperty(process, "platform", { value: "darwin" });
try { await withCredentialLock(${JSON.stringify(path)}, async () => { throw new Error("entered"); }); process.exit(1); }
catch (error) { if (!/Linux.*Bun.*flock.*no file-lock fallback/.test(error.message)) throw error; }
`], { stdout: "ignore", stderr: "pipe" });
    workers.push(worker);
    await workerDone(worker);
    expect(existsSync(path + ".lock")).toBe(false);
  } finally { await stopWorkers(workers); rmSync(dir, { recursive: true, force: true }); }
});

for (const phase of ["request", "body"]) {
  test(`adapter: aborts a hanging token ${phase} and permits retry`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "credential-timeout-"));
    const path = join(dir, "auth.json");
    try {
      const old = { tokens: { access_token: "old", refresh_token: "refresh-old", account_id: "account" } };
      await writePrivateJson(path, old);
      let aborted = false;
      const hanging = (async (_url: any, init: RequestInit) => {
        const signal = init.signal!;
        const pending = new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
          if (signal.aborted) { aborted = true; reject(signal.reason); }
        });
        return phase === "request" ? await pending : { ok: true, json: () => pending } as Response;
      }) as typeof fetch;
      const api = adapter(path, hanging, { timeout(ms) { expect(ms).toBe(30_000); return AbortSignal.timeout(20); } });
      await expect(api.refreshTokens("old")).rejects.toThrow(/token refresh timed out.*retry/);
      expect(aborted).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(old);
      const success = (async () => Response.json({ access_token: "new", refresh_token: "refresh-new" })) as typeof fetch;
      await adapter(path, success).refreshTokens("old");
      expect(JSON.parse(readFileSync(path, "utf8")).tokens.refresh_token).toBe("refresh-new");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
