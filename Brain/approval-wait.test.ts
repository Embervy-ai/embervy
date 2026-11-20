import { expect, test } from "bun:test";
import { callControl } from "./brain-mcp";
import { startAuthenticatedControlEndpoint } from "./control-endpoint";
import { askApproval, approvalFailure, ApprovalWaits } from "./app-channel";
import { callTimeoutMs, deadlineFetch } from "./brain-mcp";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool } from "./brain";

// Scale only the transport's idle limit; the application deadline remains independent.
test("approval survives the transport idle limit and a later approval runs the action", async () => {
  let elapsed = 0;
  let ran = false;
  const appFetch = (async (url: string) => {
    if (url.endsWith("/ask")) return Response.json({ id: "card" });
    return Response.json({ status: elapsed > 300_000 ? "allow" : "pending" });
  }) as typeof fetch;
  const transport = (async (_url: unknown, init: any) => {
    const result = await askApproval({ baseUrl: "http://app", token: "", fetchImpl: appFetch,
      sleep: async () => {
        elapsed += 60_000;
        if (elapsed >= 300_000 && init.timeout !== false) throw new Error("The operation timed out");
      },
    }, "Action", "Details");
    return Response.json({ ok: true, text: JSON.stringify({ behavior: result.decision === "allow" ? "allow" : "deny" }) });
  }) as typeof fetch;
  const result = await callControl("approve", { tool_name: "Bash" }, transport);
  if (JSON.parse(result.text).behavior === "allow") ran = true;
  expect(ran).toBe(true);
  expect(elapsed).toBeGreaterThan(300_000);
});

test("control endpoint does not impose a shorter server idle deadline", () => {
  let options: any;
  startAuthenticatedControlEndpoint({ token: "test-token-123456789", port: 0,
    serve: (value) => { options = value; return {}; }, handle: async () => ({ ok: true }),
  });
  expect(options.idleTimeout).toBe(0);
});

function cardFixture(poll: () => Response | Promise<Response>, extra: Record<string, unknown> = {}) {
  const closed: string[] = [];
  const events: any[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    if (url.endsWith("/ask")) return Response.json({ id: "card", ...extra });
    if (url.endsWith("/decide")) {
      expect(init.signal.aborted).toBe(false);
      closed.push(JSON.parse(init.body).decision);
      return Response.json({ status: "expired" });
    }
    return poll();
  }) as typeof fetch;
  return { closed, events, opts: { baseUrl: "http://app", token: "t", fetchImpl, onEnd: (e: any) => events.push(e) } };
}

test("the app deadline expires the card, denies permission and records duration without input", async () => {
  let now = 1000;
  let polls = 0;
  const f = cardFixture(() => { polls++; return Response.json({ status: "pending" }); }, { expiresAt: 1100 });
  const result = await askApproval({ ...f.opts, now: () => now, pollMs: 30, sleep: async (ms) => { now += ms; } }, "Action", "private command");
  expect(result).toEqual({ decision: "expired", outcome: "expired", id: "card" });
  expect(f.closed).toEqual(["expired"]);
  expect(f.events).toEqual([{ type: "approval_decision", decision: "expired", outcome: "expired", wait_ms: 100, card_id: "card", closure: "expired" }]);
  expect(JSON.stringify(f.events)).not.toContain("private command");
  expect(polls).toBe(3);
  expect(approvalFailure(result.outcome)).toContain("no approval response within");
});

test("a card can outlive the fallback deadline and still receive approval", async () => {
  let now = 0;
  const f = cardFixture(() => Response.json({ status: "allow" }), { expiresAt: 2_000_000 });
  const result = await askApproval({ ...f.opts, now: () => now, sleep: async () => { now = 1_850_000; } }, "Action", "Details");
  expect(result.decision).toBe("allow");
  expect(f.closed).toEqual([]);
});

test("an unknown decision from the app closes the card and denies rather than timing out", async () => {
  const f = cardFixture(() => Response.json({ status: "unknown" }));
  const result = await askApproval({ ...f.opts, sleep: async () => {} }, "Action", "Details");
  expect(result.outcome).toBe("invalid");
  expect(result.decision).toBe("error");
  expect(approvalFailure(result.outcome)).toBe("invalid approval response");
  expect(f.closed).toEqual(["expired"]);
  expect(f.events[0]).toMatchObject({ outcome: "invalid", wait_ms: expect.any(Number) });
});

// The app restarts while cards wait; a poll it cannot answer must not decide for the person.
for (const [label, broken] of [
  ["a thrown connection error", () => { throw new Error("ECONNRESET"); }],
  ["an unreadable body", () => new Response("not json")],
  ["a server error", () => Response.json({ decision: "allow" }, { status: 500 })],
] as const) {
  test(`${label} on a poll is not a decision: a later approval still counts`, async () => {
    let polls = 0;
    const f = cardFixture(() => (++polls <= 3 ? broken() : Response.json({ decision: "allow" })));
    const result = await askApproval({ ...f.opts, sleep: async () => {} }, "Action", "Details");
    expect(polls).toBe(4);
    expect(result.outcome).toBe("allow");
    expect(f.closed).toEqual([]);
  });

  test(`${label} on every poll ends at the card deadline, closed and denied`, async () => {
    let clock = 1000;
    const f = cardFixture(() => broken());
    const result = await askApproval({ ...f.opts, now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 10_000, pollMs: 3000 }, "Action", "Details");
    expect(result.outcome).toBe("expired");
    expect(result.decision).toBe("expired");
    expect(f.closed).toEqual(["expired"]);
  });
}

test("shutdown drains pending cards and prevents new cards", async () => {
  const f = cardFixture(() => Response.json({ status: "pending" }));
  const waits = new ApprovalWaits();
  const result = waits.ask(f.opts, "Action", "Details");
  await Bun.sleep(10);
  await waits.stop();
  expect((await result).outcome).toBe("shutdown");
  expect(f.closed).toEqual(["expired"]);
  expect(f.events[0]).toMatchObject({ outcome: "shutdown", closure: "expired" });
  expect((await waits.ask(f.opts, "Action", "Details")).id).toBeNull();
});

test("caller cancellation during creation still closes the returned card", async () => {
  const controller = new AbortController();
  const f = cardFixture(() => Response.json({ status: "pending" }));
  const fetchImpl = (async (url: any, init: any) => {
    const response = await f.opts.fetchImpl(url, init);
    if (String(url).endsWith("/ask")) controller.abort();
    return response;
  }) as typeof fetch;
  const result = await askApproval({ ...f.opts, fetchImpl, signal: controller.signal }, "Action", "Details");
  expect(result.outcome).toBe("disconnected");
  expect(f.closed).toEqual(["expired"]);
});

test("an unreachable control listener denies immediately with the established wording and a log event", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const url = server.url.toString();
  server.stop(true);
  const events: any[] = [];
  const transport = ((_: any, init: any) => fetch(url, init)) as typeof fetch;
  const result = await callControl("approve", { input: { command: "private command" } }, transport, { log: e => events.push(e) });
  expect(JSON.parse(result.text).behavior).toBe("deny");
  expect(JSON.parse(result.text).message).toStartWith("approval endpoint unreachable:");
  expect(result.isError).toBe(false);
  expect(events[0].outcome).toBe("unreachable");
  expect(events[0].wait_ms).toBeLessThan(1000);
  expect(JSON.stringify(events)).not.toContain("private command");
});

test("malformed control responses fail closed and are not called unreachable", async () => {
  for (const response of [new Response("broken"), Response.json({ ok: true, text: '{"behavior":"maybe"}' }), Response.json({ ok: false }, { status: 403 })]) {
    const events: any[] = [];
    const result = await callControl("approve", {}, (async () => response) as typeof fetch, { log: e => events.push(e) });
    expect(JSON.parse(result.text)).toEqual({ behavior: "deny", message: "invalid approval response" });
    expect(events[0].outcome).toBe("invalid");
  }
});

test("real HTTP response survives a shortened server idle limit", async () => {
  const token = "test-token-123456789";
  const server: any = startAuthenticatedControlEndpoint({ token, port: 0,
    serve: options => Bun.serve({ ...options, idleTimeout: options.idleTimeout ?? 1 }),
    handle: async () => { await Bun.sleep(1300); return { ok: true, text: "done" }; },
  });
  try {
    const response = await fetch(`${server.url}tool`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "web_fetch" }), timeout: false });
    expect(await response.json()).toEqual({ ok: true, text: "done" });
  } finally { server.stop(true); }
});

test("long web transport budgets cover configured fetch and both browser stages", () => {
  expect(callTimeoutMs("web_fetch", {})).toBe(230_000);
  expect(callTimeoutMs("web_fetch", { BRAIN_WEB_FETCH_TIMEOUT_MS: "600000", BRAIN_WEB_BROWSER_TIMEOUT_MS: "400000" })).toBe(1_410_000);
  expect(callTimeoutMs("web_search", { BRAIN_WEB_SEARCH_TIMEOUT_MS: "600000" })).toBe(610_000);
});

test("web fetch keeps its application signal while disabling the runtime idle limit", async () => {
  const previous = globalThis.fetch;
  let seen: any;
  const controller = new AbortController();
  globalThis.fetch = (async (_url: any, init: any) => { seen = init; return new Response("ok"); }) as typeof fetch;
  try {
    await deadlineFetch("http://fixture", { signal: controller.signal });
    expect(seen.timeout).toBe(false);
    expect(seen.signal).toBe(controller.signal);
  } finally { globalThis.fetch = previous; }
});

test("API app tools receive the human-wait budget instead of the generic MCP limit", async () => {
  const seen: number[] = [];
  const client = { alive: () => true, callTool: async (_tool: string, _args: unknown, ms: number) => { seen.push(ms); return "done"; } };
  const state = { mcpClients: new Map([["app", client], ["other", client]]) } as any;
  expect(await dispatchTool("mcp__app__house_question", {}, state)).toBe("done");
  expect(await dispatchTool("mcp__other__query", {}, state)).toBe("done");
  expect(seen).toEqual([1_900_000, 600_000]);
});

test("a late allow cannot revive an expired wait", async () => {
  let now = 0;
  const f = cardFixture(() => { now = 101; return Response.json({ decision: "allow" }); });
  const result = await askApproval({ ...f.opts, timeoutMs: 100, now: () => now, sleep: async () => { now = 50; } }, "Action", "Details");
  expect(result.decision).toBe("expired");
  expect(f.closed).toEqual(["expired"]);
});

test("failed cleanup is bounded and recorded rather than claimed as delivered", async () => {
  const f = cardFixture(() => Response.json({ status: "pending" }));
  let attempts = 0;
  const fetchImpl = (async (url: any, init: any) => {
    if (String(url).endsWith("/decide")) { attempts++; return new Response("unavailable", { status: 503 }); }
    return f.opts.fetchImpl(url, init);
  }) as typeof fetch;
  const result = await askApproval({ ...f.opts, fetchImpl, timeoutMs: 0 }, "Action", "Details");
  expect(result.decision).toBe("expired");
  expect(attempts).toBe(2);
  expect(f.events[0].closure).toBe("failed");
});

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= end) throw new Error("fixture deadline exceeded");
    await Bun.sleep(10);
  }
}

for (const ending of ["expired", "disconnected", "shutdown"] as const) {
  test(`running Brain closes a card and writes the session event on ${ending}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "approval-wait-"));
    const logs = join(root, "logs");
    mkdirSync(logs);
    let created = false;
    const closed: string[] = [];
    const app = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/ask")) { created = true; return Response.json({ id: "card", expiresAt: Date.now() + (ending === "expired" ? 100 : 60_000) }); }
      if (path.endsWith("/decide")) { closed.push((await request.json() as any).decision); return Response.json({ status: "expired" }); }
      return Response.json({ status: "pending" });
    } });
    const portProbe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = portProbe.port;
    portProbe.stop(true);
    const token = "test-token-123456789";
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "brain.ts")], {
      cwd: root, stdin: "pipe", stdout: "ignore", stderr: "ignore",
      env: { PATH: process.env.PATH, HOME: root, BRAIN_NO_ENV_FILE: "1", BRAIN_STERILE: "1",
        BRAIN_HEAD: "api", BRAIN_INLET: "false", BRAIN_SENSE: "off", BRAIN_CACHE_PING: "off",
        BRAIN_CONTROL_TOKEN: token, BRAIN_CONTROL_PORT: String(port), BRAIN_APP_URL: app.url.toString(),
        BRAIN_LOG_DIR: logs, BRAIN_STATE_DIR: join(root, "state"), BRAIN_BRIDGE_FILE: join(root, "bridge.md"),
        BRAIN_SESSION_ARCHIVE_DIR: join(root, "sessions"), BRAIN_IDLE_TICK_MS: "200",
      },
    });
    const events = () => readdirSync(logs).filter(f => f.startsWith("session-") && f.endsWith(".jsonl")).flatMap(f => readFileSync(join(logs, f), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
    const controller = new AbortController();
    let pending: Promise<any> | undefined;
    try {
      await until(() => events().some(e => e.type === "control_server_started"));
      pending = fetch(`http://127.0.0.1:${port}/tool`, { method: "POST", headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "approve", args: { tool_name: "Bash", input: { command: "private command" } } }), signal: controller.signal, timeout: false,
      }).then(r => r.json()).catch(() => null);
      await until(() => created);
      if (ending === "disconnected") controller.abort();
      if (ending === "shutdown") proc.kill("SIGTERM");
      await until(() => events().some(e => e.type === "approval_decision"));
      const event = events().find(e => e.type === "approval_decision");
      expect(event).toMatchObject({ outcome: ending, wait_ms: expect.any(Number), closure: "expired", via: "pipe" });
      expect(JSON.stringify(event)).not.toContain("private command");
      expect(closed).toEqual(["expired"]);
      if (ending === "expired") expect(JSON.parse((await pending).text).behavior).toBe("deny");
    } finally {
      controller.abort();
      if (proc.exitCode === null) proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
      await proc.exited;
      clearTimeout(timer);
      await pending;
      app.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
}
