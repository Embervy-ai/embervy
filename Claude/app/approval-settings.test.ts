import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ApprovalSettingsStore, approvalChange, proposedSettings, loosens } from "./approval-settings";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rule = { label: "publishes", tool: "bash", field: "command", pattern: "git push" };
test("approval changes validate patterns and classify mixed changes conservatively", () => {
  const current = { level: "important" as const, extra: [rule], updated_at: new Date().toISOString(), updated_by: "person" as const };
  expect(loosens(current, proposedSettings(current, approvalChange({ level: "all", reason: "ask first" })))).toBe(false);
  expect(loosens(current, proposedSettings(current, approvalChange({ level: "all", remove: [rule], reason: "mixed" })))).toBe(true);
  for (const input of [{ level: "sometimes", reason: "x" }, { add: [{ ...rule, pattern: "[" }], reason: "x" }, { level: "none" }, { remove: ["publishes"], reason: "x" }, { level: ["none"], reason: "x" }, { level: {}, reason: "x" }]) expect(() => approvalChange(input)).toThrow();
});

test("outside edits yield one notice, own writes none, and do not revert", () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-settings-"));
  try {
    const path = join(dir, "approval-settings.json"), notices: string[] = [];
    const store = new ApprovalSettingsStore(path, (old, next) => notices.push(`${old.level}:${next?.level}`));
    expect(store.read().level).toBe("important");
    store.write({ ...store.read(), level: "all" }, "person");
    expect(notices).toEqual([]);
    writeFileSync(path, JSON.stringify({ ...store.read(), level: "none" }));
    expect(store.read().level).toBe("none");
    store.read(); store.read();
    expect(notices).toEqual(["all:none"]);
    expect(JSON.parse(readFileSync(path, "utf8")).level).toBe("none");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outside removal and invalid levels are noticed once without recreating the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-settings-invalid-"));
  try {
    const path = join(dir, "approval-settings.json"), notices: unknown[] = [];
    const store = new ApprovalSettingsStore(path, (old, next) => notices.push([old.level, next?.level]));
    const original = store.read();
    writeFileSync(path, JSON.stringify({ ...original, level: ["none"] }));
    expect(() => store.read()).toThrow();
    expect(() => store.read()).toThrow();
    expect(notices).toHaveLength(1);
    store.write(original, "person");
    rmSync(path);
    expect(() => store.read()).toThrow();
    expect(() => store.read()).toThrow();
    expect(notices).toHaveLength(2);
    expect(() => readFileSync(path)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function approvalGear(fetch: (...args: any[]) => Promise<any>) {
  const nodes: Record<string, any> = {};
  for (const id of ["approval-level", "approval-settings-status", "approval-settings-section", "approval-patterns", "approval-extra"]) {
    const classes = new Set(["hidden"]);
    nodes[id] = { value: "important", disabled: true, textContent: "", classes, classList: {
      remove: (name: string) => classes.delete(name),
      toggle: (name: string, hidden: boolean) => hidden ? classes.add(name) : classes.delete(name),
    }, addEventListener: (_event: string, handler: () => Promise<void>) => { nodes[id].change = handler; } };
  }
  const source = readFileSync(join(import.meta.dir, "public/settings.js"), "utf8");
  const code = source.slice(source.indexOf("(async function setupApprovals()"), source.indexOf("// Consent is server-owned"));
  return { nodes, ready: runInNewContext(code, { $: (id: string) => nodes[id], t: (key: string) => key, fetch }) as Promise<void> };
}

test("gear shows important patterns and saves a changed level immediately", async () => {
  const writes: unknown[] = [];
  const { nodes, ready } = approvalGear(async (_url, init) => {
    if (init.method === "POST") writes.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ level: init.method === "POST" ? "all" : "important", extra: [] }) };
  });
  await ready;
  expect(nodes["approval-settings-section"].classes.has("hidden")).toBe(false);
  expect(nodes["approval-patterns"].classes.has("hidden")).toBe(false);
  expect(nodes["approval-level"].disabled).toBe(false);
  nodes["approval-level"].value = "all";
  await nodes["approval-level"].change();
  expect(writes).toEqual([{ level: "all" }]);
  expect(nodes["approval-patterns"].classes.has("hidden")).toBe(true);
  expect(nodes["approval-level"].disabled).toBe(false);
});

test("gear keeps a load failure visible without enabling an unknown level", async () => {
  const { nodes, ready } = approvalGear(async () => { throw new Error("offline"); });
  await ready;
  expect(nodes["approval-settings-section"].classes.has("hidden")).toBe(false);
  expect(nodes["approval-settings-status"].textContent).toBe("approvalSettings.loadFailed");
  expect(nodes["approval-level"].disabled).toBe(true);
});

test("gear settings and agent requests keep human consent on the only loosening path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-settings-server-"));
  const data = join(dir, "data"); mkdirSync(data);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = listener.port; listener.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir, EMBERVY_HOME: dir, EMBERVY_HARNESS: "brain", EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), INTERNAL_API_TOKEN: "test-token", APP_PASSWORD: "password", APP_SESSION_SECRET: "session-test", EMBERVY_TERMINAL_PANEL: "0" }, stdout: "ignore", stderr: "pipe" });
  const agent = { authorization: "Bearer test-token" };
  const call = (path: string, headers: Record<string, string>, body?: unknown) => fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const file = join(data, "approval-settings.json");
  const client = new Client({ name: "approval-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "mcp.ts")], cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, EMBERVY_HARNESS: "brain", EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), INTERNAL_API_TOKEN: "test-token" }, stderr: "ignore" });
  try {
    let ready = false;
    for (let n = 0; n < 100 && !ready; n++) { try { ready = (await fetch(base + "/health")).ok; } catch {} if (!ready) await Bun.sleep(50); }
    if (!ready) throw new Error("server startup failed");
    const login = await call("/api/auth", {}, { password: "password" });
    const human = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    expect((await (await call("/api/approval-settings", human)).json() as any).level).toBe("important");
    expect((await (await call("/settings.html", human)).text())).toContain('id="approval-level"');
    expect((await call("/api/approval-settings", agent, { level: "none" })).status).toBe(403);
    const request = async (body: unknown) => (await (await call("/api/internal/approval-settings", agent, body)).json()) as any;
    await client.connect(transport);
    expect((await client.listTools()).tools.some(tool => tool.name === "approval_settings")).toBe(true);
    const result = await client.callTool({ name: "approval_settings", arguments: { level: "all", add: [rule], reason: "ask before changes" } });
    expect(result.isError).not.toBe(true);
    const stricter = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(stricter.settings.level).toBe("all");
    expect(stricter.id).toBeUndefined();
    const pending = await request({ level: "none", reason: "requested" });
    const unchanged = readFileSync(file, "utf8");
    expect(pending.status).toBe("pending");
    expect((await call(`/api/approval/${pending.id}/decide`, agent, { decision: "allow" })).status).toBe(403);
    await call(`/api/approval/${pending.id}/decide`, human, { decision: "deny" });
    expect(readFileSync(file, "utf8")).toBe(unchanged);
    const remove = await request({ remove: [rule], reason: "remove this pattern" });
    expect(remove.status).toBe("pending");
    await call(`/api/approval/${remove.id}/decide`, human, { decision: "allow" });
    expect(JSON.parse(readFileSync(file, "utf8")).extra).toEqual([]);
    const allow = await request({ level: "none", reason: "requested" });
    await call(`/api/approval/${allow.id}/decide`, human, { decision: "allow" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ level: "none", updated_by: "agent" });
    await call("/api/approval-settings", human, { level: "all" });
    const stale = await request({ level: "none", reason: "old request" });
    await call("/api/approval-settings", human, { level: "important" });
    await call(`/api/approval/${stale.id}/decide`, human, { decision: "allow" });
    expect(JSON.parse(readFileSync(file, "utf8")).level).toBe("important");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), level: "all" }));
    await call("/api/approval-settings", human); await call("/api/approval-settings", human);
    await Bun.sleep(1200);
    const history = await (await call("/api/messages", human)).json() as any[];
    expect(history.filter(row => row.text?.includes("changed outside the app"))).toHaveLength(1);
  } finally { await client.close(); await transport.close(); server.kill(); await server.exited; rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
