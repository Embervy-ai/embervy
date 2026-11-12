/**
 * mcp-stdio.ts — minimal stdio MCP client for the API heads.
 *
 * API heads need the same tools as the pipe head, so Brain
 * starts the stdio servers the house `.mcp.json` names and offers
 * their tools as `mcp__<server>__<tool>` — the exact names Claude Code uses,
 * so transcripts, bridge extraction (assistantSpeechText reads `text`) and
 * RAG export see the same shapes on every head.
 *
 * Protocol subset: initialize → notifications/initialized → tools/list,
 * tools/call; newline-delimited JSON-RPC 2.0 over stdio. Server-initiated
 * requests get an empty result (ping) or method-not-found; notifications
 * (e.g. notifications/claude/channel) are ignored — Brain reads the app
 * inbox itself (app-channel.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Subprocess } from "bun";

export interface StdioServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolDef { name: string; description?: string; inputSchema?: Record<string, unknown> }

/** Read a Claude-Code style .mcp.json: {mcpServers:{name:{command,args,env}}}; http servers are skipped. */
export function loadMcpConfig(path: string, only?: string[]): Record<string, StdioServerSpec> {
  if (!path || !existsSync(path)) return {};
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  const servers = parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {};
  const out: Record<string, StdioServerSpec> = {};
  for (const [name, spec] of Object.entries<any>(servers)) {
    if (only && only.length && !only.includes(name)) continue;
    if (!spec || typeof spec.command !== "string") continue;
    if (spec.type && spec.type !== "stdio") continue;
    out[name] = {
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      env: spec.env && typeof spec.env === "object" ? Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, String(v)])) : undefined,
      cwd: typeof spec.cwd === "string" ? spec.cwd : dirname(path),
    };
  }
  return out;
}

/** Tool name as Claude Code shows it. */
export function prefixedToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function splitPrefixedToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : null;
}

export class StdioMcpClient {
  private proc: Subprocess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  tools: McpToolDef[] = [];

  constructor(readonly name: string, private spec: StdioServerSpec, private log: (e: Record<string, unknown>) => void = () => {}) {}

  async start(timeoutMs = 20_000): Promise<void> {
    this.proc = Bun.spawn([this.spec.command, ...(this.spec.args ?? [])], {
      cwd: this.spec.cwd,
      env: { ...(process.env as Record<string, string>), ...(this.spec.env ?? {}) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    void this.pump();
    void this.drainStderr();
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "brain", version: "1.0.0" },
    }, timeoutMs);
    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {}, timeoutMs);
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    this.log({ type: "mcp_stdio_started", server: this.name, tools: this.tools.map((t) => t.name) });
  }

  alive(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  async callTool(tool: string, args: Record<string, unknown>, timeoutMs = 600_000): Promise<string> {
    const result = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs);
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((part: any) => typeof part?.text === "string" ? part.text : JSON.stringify(part)).join("\n");
    return result?.isError ? `error: ${text}` : text;
  }

  stop(): void {
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error("mcp client stopped")); }
    this.pending.clear();
    try { (this.proc?.stdin as any)?.end?.(); } catch { /* ignore */ }
    try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this.proc = null;
  }

  private write(message: Record<string, unknown>): void {
    const sink = this.proc?.stdin as any;
    if (!sink) throw new Error(`mcp server ${this.name} not running`);
    sink.write(JSON.stringify(message) + "\n");
    if (typeof sink.flush === "function") sink.flush();
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${this.name} ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  private handleLine(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message && typeof message.id === "number" && this.pending.has(message.id) && ("result" in message || "error" in message)) {
      const entry = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`mcp ${this.name}: ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
      return;
    }
    if (message && message.method && message.id !== undefined) {
      // server → client request
      if (message.method === "ping") this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      else this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not supported by brain client: ${message.method}` } });
    }
    // notifications are ignored on purpose
  }

  private async pump(): Promise<void> {
    const reader = (this.proc!.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch { /* process gone */ }
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error(`mcp server ${this.name} exited`)); }
    this.pending.clear();
    this.log({ type: "mcp_stdio_exited", server: this.name });
  }

  private async drainStderr(): Promise<void> {
    try {
      const reader = (this.proc!.stderr as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* ignore */ }
  }
}
