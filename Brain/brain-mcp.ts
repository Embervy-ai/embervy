// Exposes local control tools through a stdio MCP proxy.

import { STATUS_TOOL_ACCOUNT_WORD } from "./account";
import { tr } from "./texts";
import { webToolDefs } from "./web-tools";

const CONTROL_URL = `http://127.0.0.1:${process.env.BRAIN_CONTROL_PORT ?? "3910"}/tool`;
const CONTROL_TOKEN = process.env.BRAIN_CONTROL_TOKEN;

export const TOOLS = [
  { name: "pins", get description() { return tr("List active pins."); }, inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "pin", get description() { return tr("Pin a note to yourself: agreements such as a date tonight survive cuts and head switches. TTL default end_of_day, max 20 pins."); }, inputSchema: { type: "object", properties: { text: { type: "string" }, ttl: { type: "string", get description() { return tr("e.g. end_of_day, eod, 2h, 45m, YYYY-MM-DD HH:MM"); } } }, required: ["text"] } },
  { name: "unpin", get description() { return tr("Remove a pin by id."); }, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "status", get description() { return tr`Your state: head, model (ordered/served), effort, window, cut threshold, ${tr(STATUS_TOOL_ACCOUNT_WORD)}drift.`; }, inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "effort", get description() { return tr("View or set your reasoning effort: low | medium | high | xhigh | max | default (= model default). Raise it before a difficult task, then lower it again. Applies from the next model call, even during a turn; no restart, history stays, as does the cache on Opus 5.5. Persists across cuts and restarts. Without level: current state."); }, inputSchema: { type: "object", properties: { level: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "default"] } }, additionalProperties: false } },
  { name: "approve", get description() { return tr("Permission prompt tool (called by Claude Code, not manually): presents an approval card in the app and waits for the person's decision."); }, inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name"] } },
];

export function toolsFor(env: Record<string, string | undefined> = process.env): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  const web = new Set((env.BRAIN_MCP_WEB_TOOLS ?? "").split(",").map((name) => name.trim()));
  const defs = webToolDefs({ search: web.has("web_search"), fetch: web.has("web_fetch"), render: env.BRAIN_MCP_WEB_RENDER === "1" });
  return [...TOOLS, ...defs.map((def) => ({ name: def.function.name, description: def.function.description, inputSchema: def.function.parameters }))];
}

// Approval waits for a person; web rendering may need to start a browser first.
export function callTimeoutMs(name: string): number {
  if (name === "approve") return 1_800_000;
  if (name === "web_fetch") return 150_000;
  if (name === "web_search") return 60_000;
  return 30_000;
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export async function callControl(name: string, args: unknown, fetchImpl: typeof fetch = fetch): Promise<{ text: string; isError: boolean }> {
  try {
    const res = await fetchImpl(CONTROL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(CONTROL_TOKEN ? { authorization: `Bearer ${CONTROL_TOKEN}` } : {}),
      },
      body: JSON.stringify({ name, args }),
      signal: AbortSignal.timeout(callTimeoutMs(name)),
    });
    const body: any = await res.json().catch(() => null);
    if (body?.ok && typeof body.text === "string") return { text: body.text, isError: false };
    return { text: `error: ${body?.error ?? `HTTP ${res.status}`}`, isError: true };
  } catch (err: any) {
    if (name === "approve") {
      // An unreachable approval service must deny permission rather than leave the decision open.
      return { text: JSON.stringify({ behavior: "deny", message: `approval endpoint unreachable: ${err?.message ?? err}` }), isError: false };
    }
    return { text: tr`error: Brain endpoint unreachable (${err?.message ?? err}) — is Brain running?`, isError: true };
  }
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "brain", version: "1.0.0" },
    });
    return;
  }
  if (String(method ?? "").startsWith("notifications/")) return;
  if (method === "ping") { reply(id, {}); return; }
  if (method === "tools/list") { reply(id, { tools: toolsFor() }); return; }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const { text, isError } = await callControl(name, params?.arguments ?? {});
    reply(id, { content: [{ type: "text", text }], isError });
    return;
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

if (import.meta.main) {
  let buffer = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { void handle(JSON.parse(line)); } catch { /* broken line: ignore */ }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
