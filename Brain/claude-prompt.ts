/** Automatic, cost-free Claude Code prompt capture. No host-network fallback.
 * The CLI, including --version, and the loopback catcher share a fresh Linux
 * network/PID namespace. Missing isolation means built-in rules, not a live call.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

type Log = (event: Record<string, unknown>) => void;
export interface Capture { system: unknown; tools: unknown[] }
export interface NetworkProof { isolation: "linux-network-namespace"; distinct_namespace: true; interfaces: string[]; external_connect: string }
export interface PromptResult { version: string; text: string; sections: string[]; captured_chars: number; filtered_chars: number; tool_count: number; duration_ms: number; cached: boolean; proof: NetworkProof }

// Exact headings, not a substring search. Unknown child headings do NOT inherit
// a parent's allow status; identity/git/style chapters are never selected.
export const TOOL_SECTION_HEADINGS = [
  "Tool use", "Tool usage policy", "Using your tools", "Tool usage",
  "Task Management", "Tasks", "Session-specific guidance", "Agents", "Subagents", "Using agents",
  "Agent usage", "Background tasks", "Background commands",
] as const;
const allowedHeadings = new Set(TOOL_SECTION_HEADINGS.map((s) => s.toLowerCase()));
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const FILTER_REVISION = 2;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const validProof = (proof: any): proof is NetworkProof => proof?.isolation === "linux-network-namespace"
  && proof.distinct_namespace === true && Array.isArray(proof.interfaces) && proof.interfaces.length === 1 && proof.interfaces[0] === "lo"
  && proof.external_connect === "ENETUNREACH";

export function systemText(system: unknown): string {
  if (typeof system === "string" && system.trim()) return system;
  if (!Array.isArray(system)) throw new Error("missing system prompt");
  const texts = system.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text);
  if (!texts.join("").trim()) throw new Error("empty system prompt");
  return texts.join("\n\n");
}

/** No machine paths, clock or environment block in cached/fixture material. */
export function normalizeCaptureText(text: string, home: string): string {
  return text.replaceAll(home, "<CAPTURE_HOME>")
    .replace(/^x-anthropic-billing-header:.*\n*/gm, "")
    .replace(/^# Environment\n[\s\S]*?(?=^# |(?![\s\S]))/gm, "# Environment\n[capture environment omitted]\n\n")
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/g, "[capture token budget omitted]")
    .replace(/<env>[\s\S]*?<\/env>/gi, "<env>[capture environment omitted]</env>")
    .replace(/<environment>[\s\S]*?<\/environment>/gi, "<environment>[capture environment omitted]</environment>")
    .replace(/^(?:Working directory|Primary working directory|Additional working directories|Platform|OS Version|OS version|Shell|Is directory a git repo|Today's date|Current date):.*$/gm, "[capture environment omitted]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>");
}

export function filterToolSections(prompt: string): { text: string; sections: string[] } {
  const selected: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;
  const ancestors: Array<{ level: number; title: string }> = [];
  const forbiddenParent = /\b(?:git|github|identity|persona|tone|style|formatting|output|environment|system)\b|context management|doing tasks|identit\u00e4t/i;
  let fence: string | null = null;
  for (const line of prompt.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      if (current) current.lines.push(line);
      continue;
    }
    const heading = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = heading[1].trim(), level = /^#+/.exec(line)![0].length;
      while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
      current = allowedHeadings.has(title.toLowerCase()) && !ancestors.some((h) => forbiddenParent.test(h.title)) ? { title, lines: [] } : null;
      ancestors.push({ level, title });
      if (current) selected.push(current);
    } else if (current) current.lines.push(line);
  }
  const sections: string[] = [], parts: string[] = [];
  for (const section of selected) {
    // A selected section can still contain a git/identity/style paragraph.
    // Drop whole paragraphs, not fragments of those instructions.
    const body = section.lines.join("\n").split(/\n\s*\n/)
      .filter((p) => !/\b(?:git|github|Claude|Anthropic)\b|terminal formatting|output formatting|<env>|<environment>/i.test(p))
      .join("\n\n").trim();
    if (!body) continue;
    sections.push(section.title);
    parts.push(`## ${section.title}\n${body}`);
  }
  return { text: parts.join("\n\n"), sections };
}

/** Allowlist, never {...process.env}: no account, OAuth, cloud, proxy, project,
 * MCP or telemetry configuration/credentials can leak into the capture child. */
export function captureEnvironment(home: string, baseUrl?: string): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
    TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, "claude"),
    ANTHROPIC_API_KEY: "sk-ant-local-prompt-capture-not-a-key", ANTHROPIC_AUTH_TOKEN: "local-prompt-capture-not-a-token",
    ANTHROPIC_BASE_URL: baseUrl ?? "http://127.0.0.1:9",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", LANG: "C.UTF-8", TERM: "dumb",
  };
}

/** Bounded/drained output. Timeout cleanup owns a private process group; the
 * PID namespace's init death also kills descendants that made their own group. */
async function runCommand(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number, detached = false): Promise<string> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), { env, cwd, detached, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", failure: Error | null = null;
    const kill = () => {
      if (detached && proc.pid) { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ } }
      else proc.kill("SIGKILL");
    };
    process.once("exit", kill);
    const timer = setTimeout(() => { failure = new Error("capture command timeout"); kill(); }, timeoutMs);
    proc.stdout!.on("data", (chunk) => {
      out += chunk.toString();
      if (out.length > MAX_CAPTURE_BYTES) { out = out.slice(0, MAX_CAPTURE_BYTES); failure = new Error("capture output limit"); kill(); }
    });
    proc.stderr!.on("data", (chunk) => { err = (err + chunk.toString()).slice(-2000); });
    proc.on("error", (error) => { clearTimeout(timer); process.off("exit", kill); reject(error); });
    proc.on("close", (code) => {
      clearTimeout(timer); process.off("exit", kill);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`capture command exited ${code}: ${err.trim()}`));
      else resolve(out);
    });
  });
}

function responseEvents(model: string): string {
  const event = (type: string, fields: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  return event("message_start", { message: { id: "msg_local_capture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } })
    + event("content_block_stop", { index: 0 })
    + event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
    + event("message_stop", {});
}

/** The catcher never proxies a request, follows a URL or runs a tool. */
export function startPromptCatcher() {
  const captures: Capture[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: MAX_CAPTURE_BYTES,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({ method: req.method, path });
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      if (path === "/v1/messages/count_tokens") return Response.json({ input_tokens: 1 });
      if (path !== "/v1/messages" || captures.length >= 8) return new Response("not found", { status: 404 });
      let body: any;
      try { body = await req.json(); systemText(body.system); } catch { return new Response("invalid message", { status: 400 }); }
      captures.push({ system: body.system, tools: Array.isArray(body.tools) ? body.tools : [] });
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(responseEvents(String(body.model ?? "local-capture")))); controller.close(); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    },
  });
  return { server, captures, requests, url: `http://127.0.0.1:${server.port}` };
}

async function proveIsolation(parentNamespace: string, home: string): Promise<NetworkProof> {
  if (!parentNamespace || readlinkSync("/proc/self/ns/net") === parentNamespace) throw new Error("network namespace isolation missing");
  const interfaces = readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).filter((l) => l.includes(":"))
    .map((l) => l.split(":")[0].trim());
  if (interfaces.length !== 1 || interfaces[0] !== "lo") throw new Error("capture namespace has a non-loopback interface");
  // Bring up lo using stdlib only (no dependency on iproute2, no host interface).
  // Use the kernel errno directly: Bun's net shim can report ECONNREFUSED for
  // ENETUNREACH. TEST-NET-1 is not a provider; only lo exists, so no packet leaves.
  const external = (await runCommand(["python3", "-c", "import socket,fcntl,struct,errno; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); fcntl.ioctl(s.fileno(),0x8914,struct.pack('16sh',b'lo',1)); p=socket.socket(); p.settimeout(1); print(errno.errorcode.get(p.connect_ex(('192.0.2.1',443)),'UNEXPECTED'))"], captureEnvironment(home), home, 3000)).trim();
  if (external !== "ENETUNREACH") throw new Error(`unexpected egress proof: ${external}`);
  return { isolation: "linux-network-namespace", distinct_namespace: true, interfaces, external_connect: external };
}

export function safeVersion(output: string): string {
  const version = /^(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/.exec(output.trim())?.[1];
  if (!version) throw new Error("unrecognized claude --version output");
  return version;
}

export function readCachedCapture(directory: string, version: string): Capture | null {
  try {
    if (safeVersion(version) !== version) return null;
    const meta = JSON.parse(readFileSync(join(directory, `${version}.meta.json`), "utf8"));
    const text = readFileSync(join(directory, `${version}.txt`), "utf8");
    const tools = readFileSync(join(directory, `${version}.tools.json`), "utf8");
    if (meta.version !== version || meta.system_sha256 !== digest(text) || meta.tools_sha256 !== digest(tools)
      || !validProof(meta.proof)) return null;
    const parsedTools = JSON.parse(tools);
    return Array.isArray(parsedTools) ? { system: text, tools: parsedTools } : null;
  } catch { return null; }
}

function atomicFile(path: string, text: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export function writeCapturedPrompt(directory: string, version: string, capture: Capture, proof: NetworkProof): void {
  if (safeVersion(version) !== version) throw new Error("invalid cache version");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const text = systemText(capture.system), tools = JSON.stringify(capture.tools, null, 2);
  atomicFile(join(directory, `${version}.txt`), text);
  atomicFile(join(directory, `${version}.tools.json`), tools);
  // Commit marker last. Interrupted/competing writers cannot validate a mixed pair.
  atomicFile(join(directory, `${version}.meta.json`), JSON.stringify({ version, system_sha256: digest(text), tools_sha256: digest(tools), proof }, null, 2));
}

async function captureWorker(binary: string, directory: string, home: string, parentNamespace: string): Promise<PromptResult> {
  const start = Date.now();
  const proof = await proveIsolation(parentNamespace, home);
  const version = safeVersion(await runCommand([binary, "--version"], captureEnvironment(home), home, 5000));
  let capture = readCachedCapture(directory, version);
  const cached = Boolean(capture);
  if (!capture) {
    const catcher = startPromptCatcher();
    try {
      await runCommand([binary, "-p", "ok", "--model", "sonnet", "--max-turns", "1", "--no-session-persistence",
        "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-prompts", "none"],
        captureEnvironment(home, catcher.url), home, 15000);
      if (!catcher.captures.length) throw new Error("CLI sent no Messages request");
      // Warmup/classifier requests may precede the full prompt: take the richest.
      capture = catcher.captures.reduce((a, b) => systemText(a.system).length >= systemText(b.system).length ? a : b);
      capture = { system: normalizeCaptureText(systemText(capture.system), home), tools: capture.tools.map((tool) =>
        JSON.parse(JSON.stringify(tool), (_key, value) => typeof value === "string" ? normalizeCaptureText(value, home) : value)) };
    } finally { catcher.server.stop(true); }
    const afterVersion = safeVersion(await runCommand([binary, "--version"], captureEnvironment(home), home, 5000));
    if (afterVersion !== version) throw new Error("claude updated during capture; result not cached");
    writeCapturedPrompt(directory, version, capture, proof);
  }
  const raw = systemText(capture.system), filtered = filterToolSections(raw);
  return { version, text: filtered.text, sections: filtered.sections, captured_chars: raw.length,
    filtered_chars: filtered.text.length, tool_count: capture.tools.length, duration_ms: Date.now() - start, cached, proof };
}

export function rulesFromCapture(result: PromptResult, log: Log): string | null {
  const { text, ...details } = result;
  log({ type: "claude_prompt_capture", ...details });
  if (!text) {
    log({ type: "claude_prompt_filter_empty", version: result.version, captured_chars: result.captured_chars });
    return null;
  }
  return text;
}

const memo = new Map<string, { fingerprint: string; result: Promise<string | null> }>();
export async function loadClaudeToolRules(env: Record<string, string | undefined>, log: Log): Promise<string | null> {
  const binName = env.BRAIN_CLAUDE_BIN || "claude", state = env.BRAIN_STATE_DIR;
  if (!state) { log({ type: "claude_prompt_capture_failed", reason: "BRAIN_STATE_DIR missing" }); return null; }
  let binary: string, fingerprint: string;
  try {
    const found = binName.includes("/") ? resolve(binName) : Bun.which(binName, { PATH: env.PATH ?? process.env.PATH });
    if (!found) throw new Error("claude binary not found");
    binary = realpathSync(found);
    const stat = statSync(binary);
    fingerprint = `${binary}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${FILTER_REVISION}`;
  } catch (error) { log({ type: "claude_prompt_capture_failed", reason: String(error) }); return null; }
  const directory = join(resolve(state), "claude-prompt"), key = `${directory}:${binName}`;
  const previous = memo.get(key);
  if (previous?.fingerprint === fingerprint) return previous.result;
  const result = (async () => {
    let home: string | undefined;
    try {
      if (process.platform !== "linux") throw new Error("capture requires Linux network namespaces");
      home = mkdtempSync(join(tmpdir(), "brain-claude-prompt-"));
      const stdout = await runCommand(["unshare", "--user", "--map-root-user", "--net", "--pid", "--fork", "--kill-child=SIGKILL",
        process.execPath, import.meta.path, "--capture-worker", binary, directory, home, readlinkSync("/proc/self/ns/net")], captureEnvironment(home), home, 25000, true);
      const result = JSON.parse(stdout) as PromptResult;
      if (typeof result.text !== "string" || !validProof(result.proof)) throw new Error("invalid capture worker response");
      return rulesFromCapture(result, log);
    } catch (error) {
      log({ type: "claude_prompt_capture_failed", reason: String(error) });
      return null;
    } finally { if (home) rmSync(home, { recursive: true, force: true }); }
  })();
  memo.set(key, { fingerprint, result });
  return result;
}

if (import.meta.main) {
  if (process.argv[2] !== "--capture-worker" || process.argv.length !== 7) {
    console.error("Internal isolated capture worker; use loadClaudeToolRules from Brain."); process.exit(2);
  }
  // Independent of the resident's lifetime. As PID-namespace init, exiting here
  // also kills a CLI descendant that detached or kept an output pipe open.
  const watchdog = setTimeout(() => process.exit(124), 23000);
  watchdog.unref();
  try { console.log(JSON.stringify(await captureWorker(process.argv[3], process.argv[4], process.argv[5], process.argv[6]))); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { clearTimeout(watchdog); }
}
