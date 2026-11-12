import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, prefixedToolName, splitPrefixedToolName, StdioMcpClient } from "./mcp-stdio";

// A tiny stdio MCP server that behaves like the app MCP for one tool and
// also pushes a channel notification (which the client must ignore).
const FAKE_SERVER = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
    if (m.method === "initialize") { out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }); out({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: "ignored" } }); }
    else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "reply", description: "Send a reply", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
    else if (m.method === "tools/call") {
      if (m.params.name === "reply") out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "sent:" + m.params.arguments.text + ":" + (process.env.FAKE_ENV || "") }] } });
      else out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "no such tool" }], isError: true } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("mcp-stdio: names", () => {
  test("Claude-Code tool names round-trip", () => {
    expect(prefixedToolName("app", "reply")).toBe("mcp__app__reply");
    expect(splitPrefixedToolName("mcp__app__voice_reply")).toEqual({ server: "app", tool: "voice_reply" });
    expect(splitPrefixedToolName("reply")).toBeNull();
  });
});

describe("mcp-stdio: config", () => {
  test("reads .mcp.json stdio servers, skips http, filters by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpcfg-"));
    const path = join(dir, ".mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: {
      "app": { command: "bun", args: ["app/mcp.ts"], env: { A: 1 } },
      remote: { type: "http", url: "https://x" },
      other: { command: "node", args: ["o.js"] },
    } }));
    const all = loadMcpConfig(path);
    expect(Object.keys(all).sort()).toEqual(["app", "other"]);
    expect(all["app"]).toEqual({ command: "bun", args: ["app/mcp.ts"], env: { A: "1" }, cwd: dir });
    expect(Object.keys(loadMcpConfig(path, ["app"]))).toEqual(["app"]);
    expect(loadMcpConfig(join(dir, "missing.json"))).toEqual({});
  });
});

describe("mcp-stdio: client against a fake stdio server", () => {
  test("initialize, list tools, call a tool, ignore notifications, pass env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpsrv-"));
    const script = join(dir, "server.js");
    writeFileSync(script, FAKE_SERVER);
    const events: any[] = [];
    const client = new StdioMcpClient("fakeapp", { command: process.execPath, args: [script], env: { FAKE_ENV: "e1" }, cwd: dir }, (e) => events.push(e));
    try {
      await client.start(10_000);
      expect(client.tools.map((t) => t.name)).toEqual(["reply"]);
      expect(await client.callTool("reply", { text: "Hallo" })).toBe("sent:Hallo:e1");
      expect(await client.callTool("nope", {})).toBe("error: no such tool");
      expect(events.some((e) => e.type === "mcp_stdio_started")).toBe(true);
    } finally {
      client.stop();
    }
  }, 20_000);
});
