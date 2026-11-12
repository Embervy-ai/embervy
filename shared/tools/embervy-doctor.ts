#!/usr/bin/env bun
/**
 * Checks service health, retrieval, local configuration and resource limits.
 * Reports failures and suggested fixes as text or JSON without applying repairs.
 */

import { existsSync, readFileSync, readdirSync, accessSync, constants, statSync } from "node:fs";
import * as nodeFs from "node:fs";
import { spawnSync } from "node:child_process";
import { release, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseEnv } from "../scripts/env-file";
import { chatgptAuthFile } from "../scripts/house-runtime";
import { envValue, reserveFile } from "../scripts/legacy-names";

// Cron and systemd may omit user-installed binaries from PATH.
{
  const home = process.env.HOME || "/root";
  const extra = [`${home}/.local/bin`, `${home}/.bun/bin`];
  const current = (process.env.PATH || "").split(":");
  process.env.PATH = [...current, ...extra.filter((p) => !current.includes(p))].join(":");
}


type Status = "OK" | "WARN" | "FAIL" | "SKIP";

interface Check {
  id: string;
  group: string;
  label: string;
  status: Status;
  detail?: string;       
  fix?: string;          
}

const checks: Check[] = [];

function add(c: Check) {
  if (process.argv.includes("--startup-child")) {
    c.detail ??= c.status === "OK" ? "passed" : "not checked";
    if (c.status !== "OK") c.fix ||= `Inspect ${c.id} in ${EMBERVY_HOME}/.env and Brain/brain.env; run the full doctor for details.`;
    console.log(JSON.stringify(c));
  }
  checks.push(c);
}


// Resolve the installation from the script because callers can start it from any directory.
function houseFromScript(): string {
  const candidate = resolve(import.meta.dir, "..", "..");
  return existsSync(resolve(candidate, "Brain")) || existsSync(resolve(candidate, "Claude")) ? candidate : "";
}
const EMBERVY_HOME = envValue("EMBERVY_HOME") || houseFromScript() || process.cwd();
const AGENT_PREFIX = (process.env.AGENT_PREFIX || process.env.SYNTH_PREFIX || "").toUpperCase();

const env: Record<string, string> = {};
const envSources: Record<string, string> = {};
function loadEnv(p: string) {
  if (!existsSync(p)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(p, "utf-8")))) {
    if (env[k] === undefined) {
      env[k] = v;
      envSources[k] = p;
    }
  }
}
loadEnv(`${EMBERVY_HOME}/.env`);
const APP_ENV_FILE = process.env.APP_ENV_FILE || `${EMBERVY_HOME}/Claude/app/.env`;
const appEnv = existsSync(APP_ENV_FILE) ? parseEnv(readFileSync(APP_ENV_FILE, "utf-8")) : {};
loadEnv(APP_ENV_FILE);

function readEnvSetting(name: string) {
  const names = AGENT_PREFIX ? [`${AGENT_PREFIX}_${name}`, name] : [name];
  for (const key of names) {
    if (env[key] !== undefined) return { value: env[key], name: key, source: envSources[key] };
    if (process.env[key] !== undefined) return { value: process.env[key] as string, name: key,
      source: `process environment (house configuration: ${EMBERVY_HOME}/.env)` };
  }
  return { value: "", name, source: `${EMBERVY_HOME}/.env` };
}

function readEnv(name: string): string {
  return readEnvSetting(name).value;
}

const EMBERVY_URL = readEnv("EMBERVY_URL");
const EMBERVY_API_KEY = readEnv("EMBERVY_API_KEY");
const RAG_URL = readEnv("RAG_URL");
const RAG_AUTH_TOKEN = readEnv("RAG_AUTH_TOKEN");
const SUBSTRATE = (readEnv("EMBERVY_SUBSTRATE") || "claude").toLowerCase();
const INLET_SCRIPT = readEnv("INLET_SCRIPT") || `${EMBERVY_HOME}/Claude/scripts/inlet-worker.ts`;
function resolveAdapterDoc(): string {
  const explicit = readEnv("ADAPTER_DOC");
  if (explicit) return explicit;
  if (BRAIN_HARNESS && BRAIN_ENV.BRAIN_SYSTEM?.trim()) return BRAIN_ENV.BRAIN_SYSTEM.trim();
  for (const candidate of [
    `${EMBERVY_HOME}/CLAUDE.md`,
    `${EMBERVY_HOME}/AGENTS.md`,
    `${EMBERVY_HOME}/brain-config.md`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return `${EMBERVY_HOME}/CLAUDE.md`; 
}

// Probe archive content, not boilerplate that the relevance gate rightly drops.
let DOCTOR_PROBE_QUERY = readEnv("DOCTOR_PROBE_QUERY").trim();
let probeSkipReason = "no question could be derived from the archive";
let archiveFiles: Array<{ name: string; uploaded: string }> = [];

// An empty archive has nothing to retrieve; that is not a service failure.
let ragFileCount: number | null = null;
let oldestArchiveUpload: number | null = null;
const archiveEmpty = () => ragFileCount === 0;
const NEWBORN_NOTE = "archive still empty — this fills up as you talk; not a defect on a fresh install";
// Few sessions may legitimately yield no hit, even for a content-based probe.
const YOUNG_ARCHIVE_FILES = 20;
const archiveYoung = () => ragFileCount !== null && ragFileCount < YOUNG_ARCHIVE_FILES;
const youngNote = () => `not checked — archive still young (${ragFileCount} files), the probe finds nothing to bring yet; not a defect`;

const BRAIN_HARNESS = readEnv("EMBERVY_HARNESS").toLowerCase() === "brain";
const BRAIN_ENV: Record<string, string> = (() => {
  const file = process.env.BRAIN_ENV_FILE?.trim() || `${EMBERVY_HOME}/Brain/brain.env`;
  try { return parseEnv(readFileSync(file, "utf-8")); } catch { return {}; }
})();


const offline = process.argv.includes("--offline");
const startup = process.argv.includes("--startup") || process.argv.includes("--startup-child");
const asJson = startup || process.argv.includes("--json");
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");


async function httpJson(url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep as text */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// Validate endpoint contracts so a proxy page or an error cannot prove service health.
function record(value: any): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function memoryHealth(body: any): boolean {
  return record(body) && !("error" in body) && typeof body.version === "string" && body.version.length > 0
    && (body.ok === true || (Number.isInteger(body.hot_count) && "daemon_last_run" in body));
}

function memoryTools(body: any): boolean {
  return record(body) && !("error" in body) && body.jsonrpc === "2.0" && body.id === 1
    && record(body.result) && !body.result.isError && Array.isArray(body.result.tools)
    && body.result.tools.every((tool: any) => record(tool) && typeof tool.name === "string"
      && typeof tool.description === "string" && record(tool.inputSchema));
}

const RAG_INDEX_HEAD = "RAG API\n";

function ragFiles(body: any): boolean {
  return record(body) && !("error" in body) && Array.isArray(body.files)
    && body.files.every((file: any) => record(file) && typeof file.name === "string"
      && Number.isFinite(file.size) && file.size >= 0 && typeof file.uploaded === "string"
      && Number.isFinite(Date.parse(file.uploaded)));
}

function present(v: string): string {
  if (!v) return "missing";
  return `present (length ${v.length})`;
}

function childOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    return String(value);
  }
  return "";
}

function childErrorCode(result: { error?: unknown }): string {
  const error = result.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? error.code : "";
}


const CLAUDE_CANARY_PROMPT = "Reply with exactly the single word: OK";
const CLAUDE_CANARY_TIMEOUT_MS = 45_000;
const CLAUDE_CANARY_IMPACT = "affects header enrichment and any claude -p automation";

async function checkGptAdapter() {
  const port = readEnv("GPT_ADAPTER_PORT") || "3041";
  const label = "GPT adapter canary";
  if (offline) return add({ id: "gpt-adapter", group: "GPT", label,
    status: "SKIP", detail: "not checked — offline" });
  try {
    const r = await httpJson(`http://127.0.0.1:${port}/health`);
    const body = (r.body || {}) as any;
    if (r.status === 200 && body.ok) {
      return add({ id: "gpt-adapter", group: "GPT", label,
        status: "OK", detail: "adapter answers; model call not checked" });
    }
    return add({ id: "gpt-adapter", group: "GPT", label,
      status: "FAIL", detail: `adapter on :${port} answered HTTP ${r.status}`,
      fix: "The loop starts the adapter — check the loop log and that bun resolves to an absolute path in the unit" });
  } catch (e: any) {
    return add({ id: "gpt-adapter", group: "GPT", label,
      status: "FAIL", detail: `adapter on :${port} unreachable (${e.message})`,
      fix: "Restart the loop (systemctl restart embervy-loop); it health-checks and starts the adapter" });
  }
}

function checkClaudeHeadless() {
  if (SUBSTRATE !== "claude") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "SKIP", detail: `active substrate is ${SUBSTRATE}; this install has its own canary` });
  }
  if (readEnv("EMBERVY_DOCTOR_SKIP_CANARY") === "1") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "SKIP", detail: "disabled by EMBERVY_DOCTOR_SKIP_CANARY=1" });
  }
  // Background checks must not repeatedly spend the subscription on model calls.
  if (process.env.EMBERVY_DOCTOR_BACKGROUND === "1") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "SKIP", detail: "not in the background run — it runs when you open the doctor" });
  }

  const versionResult = spawnSync("claude", ["--version"], {
    encoding: "utf-8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  if (childErrorCode(versionResult) === "ENOENT") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "FAIL", detail: "claude binary not found",
      fix: "Install Claude Code and ensure the claude binary is on PATH" });
  }
  const versionText = childOutput(versionResult.stdout || versionResult.stderr).trim();
  const build = versionText.split(/\r?\n/).find(Boolean)?.trim() || "unknown";

  // Disable servers and hooks so the probe cannot start a second bridge or spend its turn on startup work.
  // Disable persistence so repeated probes do not fill the shared temporary directory with session files.
  const canary = spawnSync("claude", ["-p", CLAUDE_CANARY_PROMPT, "--max-turns", "1", "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'], {
    cwd: tmpdir(),
    encoding: "utf-8",
    timeout: CLAUDE_CANARY_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const canaryError = childErrorCode(canary);
  if (canaryError === "ENOENT") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "FAIL", detail: "claude binary not found",
      fix: "Install Claude Code and ensure the claude binary is on PATH" });
  }
  if (canaryError === "ETIMEDOUT") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "WARN", detail: `headless canary timed out after 45 seconds on build ${build} — ${CLAUDE_CANARY_IMPACT}`,
      fix: "Run the canary prompt manually and inspect the Claude Code process" });
  }

  const output = childOutput(canary.stdout);
  if (canary.status === 0 && output.trim() === "OK") {
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "OK", detail: `claude -p answered on build ${build}` });
  }
  if (canary.status === 0) {
    const kind = output.trim() ? "garbled" : "empty";
    return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
      status: "WARN", detail: `headless output ${kind} on build ${build} — ${CLAUDE_CANARY_IMPACT}`,
      fix: "Inspect claude -p output handling; header enrichment and automation may be affected" });
  }

  return add({ id: "claude-headless", group: "Claude", label: "Claude headless canary",
    status: "WARN", detail: `headless canary exited ${canary.status ?? "without a status"} on build ${build} — ${CLAUDE_CANARY_IMPACT}`,
    fix: "Run the canary prompt manually and inspect the Claude Code error" });
}


async function checkMemoryUrl() {
  if (!EMBERVY_URL) {
    return add({ id: "memory.url", group: "Core", label: "EMBERVY_URL reachable",
      status: "FAIL", detail: "EMBERVY_URL not set",
      fix: `Set EMBERVY_URL in ${EMBERVY_HOME}/.env (e.g. https://embervy-memory.<account>.workers.dev)` });
  }
  if (offline) {
    return add({ id: "memory.url", group: "Core", label: "EMBERVY_URL reachable",
      status: "SKIP", detail: "not checked — offline" });
  }
  try {
    const r = await httpJson(`${EMBERVY_URL}/health`);
    if (r.status === 200 && memoryHealth(r.body)) {
      add({ id: "memory.url", group: "Core", label: "EMBERVY_URL reachable",
        status: "OK", detail: EMBERVY_URL });
    } else if (r.status === 200) {
      add({ id: "memory.url", group: "Core", label: "EMBERVY_URL reachable",
        status: "WARN", detail: "unexpected body, reachability not proven" });
    } else {
      add({ id: "memory.url", group: "Core", label: "EMBERVY_URL reachable",
        status: "FAIL", detail: `HTTP ${r.status}`,
        fix: "Worker down or wrong URL — try `wrangler deploy` in your memory worker dir" });
    }
  } catch (e: any) {
    add({ id: "memory.url", group: "Core", label: "EMBERVY_URL reachable",
      status: "FAIL", detail: e.message || String(e),
      fix: "Network/DNS — verify the URL and check worker status in the Cloudflare dashboard" });
  }
}

async function checkMemoryKey() {
  if (!EMBERVY_API_KEY) {
    return add({ id: "memory.key", group: "Core", label: "EMBERVY_API_KEY valid",
      status: "FAIL", detail: "missing",
      fix: `Set EMBERVY_API_KEY in ${EMBERVY_HOME}/.env; value must match the worker's wrangler secret` });
  }
  if (offline) {
    return add({ id: "memory.key", group: "Core", label: "EMBERVY_API_KEY valid",
      status: "SKIP", detail: "set, not checked — offline" });
  }
  if (!EMBERVY_URL) return add({ id: "memory.key", group: "Core", label: "EMBERVY_API_KEY valid",
    status: "SKIP", detail: "set, not checked — no URL" });
  try {
    const r = await httpJson(`${EMBERVY_URL}/mcp`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${EMBERVY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    if (r.status === 200 && memoryTools(r.body)) {
      add({ id: "memory.key", group: "Core", label: "EMBERVY_API_KEY valid",
        status: "OK", detail: present(EMBERVY_API_KEY) });
    } else {
      add({ id: "memory.key", group: "Core", label: "EMBERVY_API_KEY valid",
        status: "FAIL", detail: r.status === 200 ? "unexpected body, token not proven" : `HTTP ${r.status}`,
        fix: "Token mismatch — compare worker secret vs .env value" });
    }
  } catch (e: any) {
    add({ id: "memory.key", group: "Core", label: "EMBERVY_API_KEY valid",
      status: "FAIL", detail: e.message,
      fix: "Worker not responding — see EMBERVY_URL check above" });
  }
}

async function checkRagUrl() {
  if (!RAG_URL) {
    return add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
      status: "FAIL", detail: "RAG_URL not set",
      fix: `Set RAG_URL in ${EMBERVY_HOME}/.env (e.g. https://embervy-chronicle.<account>.workers.dev)` });
  }
  if (offline) {
    return add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
      status: "SKIP", detail: "not checked — offline" });
  }
  try {
    const r = await httpJson(`${RAG_URL}/`, {
      headers: { "Authorization": `Bearer ${RAG_AUTH_TOKEN}` },
    });
    if (r.status === 200 && typeof r.body === "string" && r.body.startsWith(RAG_INDEX_HEAD)) {
      add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
        status: "OK", detail: RAG_URL });
    } else if (r.status === 200) {
      add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
        status: "WARN", detail: "unexpected body, reachability not proven" });
    } else if (r.status === 500 && typeof r.body === "object" && (r.body as any)?.error?.includes("RAG_AUTH_TOKEN not configured")) {
      add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
        status: "FAIL", detail: "Worker reachable, but fail-closed (no RAG_AUTH_TOKEN secret)",
        fix: "wrangler secret put RAG_AUTH_TOKEN in the RAG worker's deploy folder" });
    } else {
      add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
        status: "FAIL", detail: `HTTP ${r.status}` });
    }
  } catch (e: any) {
    add({ id: "rag.url", group: "Core", label: "RAG_URL reachable",
      status: "FAIL", detail: e.message });
  }
}

async function checkRagToken() {
  if (!RAG_AUTH_TOKEN) {
    return add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
      status: "FAIL", detail: "missing",
      fix: `Set RAG_AUTH_TOKEN in ${EMBERVY_HOME}/.env; value must match the worker's wrangler secret` });
  }
  if (offline) {
    return add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
      status: "SKIP", detail: "set, not checked — offline" });
  }
  if (!RAG_URL) return add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
    status: "SKIP", detail: "set, not checked — no URL" });
  try {
    const r = await httpJson(`${RAG_URL}/list`, {
      headers: { "Authorization": `Bearer ${RAG_AUTH_TOKEN}` },
    });
    if (r.status === 200 && ragFiles(r.body)) {
      const entries = (r.body as any).files;
      archiveFiles = entries;
      const files = entries.length;
      const uploads = entries.map((file: any) => Date.parse(file.uploaded))
        .filter((time: number) => Number.isFinite(time) && time <= Date.now());
      oldestArchiveUpload = uploads.length ? Math.min(...uploads) : null;
      ragFileCount = files;
      add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
        status: "OK", detail: `${present(RAG_AUTH_TOKEN)}, ${files} files indexed` });
    } else if (r.status === 401) {
      add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
        status: "FAIL", detail: "HTTP 401 unauthorized",
        fix: "Token mismatch — compare worker secret vs .env value" });
    } else {
      add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
        status: "FAIL", detail: r.status === 200 ? "unexpected body, token not proven" : `HTTP ${r.status}` });
    }
  } catch (e: any) {
    add({ id: "rag.token", group: "Core", label: "RAG_AUTH_TOKEN valid",
      status: "FAIL", detail: e.message });
  }
}

async function checkMemoryNightly() {
  const report = (status: Status, detail: string) => add({ id: "memory.nightly", group: "Core",
    label: "Memory daemon and dream", status, detail,
    ...(status === "WARN" ? { fix: "Check the memory and dream worker cron configuration and logs." } : {}) });
  if (offline || !EMBERVY_URL || !EMBERVY_API_KEY) {
    return report("SKIP", `not checked — ${offline ? "offline mode" : "memory worker URL or key missing"}`);
  }
  try {
    const response = await httpJson(`${EMBERVY_URL.replace(/\/$/, "")}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${EMBERVY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "health", arguments: {} } }),
    });
    const rpc = response.body as any;
    if (response.status !== 200 || rpc?.error || rpc?.result?.isError) {
      return report("WARN", `not checked — memory health failed (HTTP ${response.status})`);
    }
    const text = (rpc?.result?.content || []).filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    const health = rpc?.result?.structuredContent || (fenced ? JSON.parse(fenced[1]) : null);
    if (!health || !["daemon_last_run", "daemon_last_ok", "dream_last_run"].every(key => key in health)) {
      return report("WARN", "not checked — memory health has no nightly run fields");
    }
    let installed: number | null = null;
    try {
      const state = JSON.parse(readFileSync(readEnv("INSTALL_STATE_FILE") || `${EMBERVY_HOME}/state.json`, "utf8"));
      const time = Date.parse(state.started_at);
      if (Number.isFinite(time) && time <= Date.now()) installed = time;
    } catch {  }
    const born = installed ?? oldestArchiveUpload;
    const windowMs = 26 * 60 * 60 * 1000;
    const warnings = Array.isArray(health.warnings) ? health.warnings.map(String) : [];
    let warn = false, unchecked = false;
    const dreamOff = /^(0|off|false|no)$/i.test(readEnv("EMBERVY_DREAM").trim());
    const details = (dreamOff ? ["daemon"] : ["daemon", "dream"]).map(kind => {
      const run = health[`${kind}_last_run`];
      const failed = kind === "daemon" && ((run && health.daemon_last_ok !== true)
        || warnings.some((message: string) => /daemon.*failed/i.test(message)));
      if (failed || String(run).toLowerCase().includes("failed")) {
        warn = true;
        return `${kind}: failed — ${warnings.join("; ") || String(run)}`;
      }
      if (run === null || run === "never") {
        if (born === null) { unchecked = true; return `${kind}: not checked — never; house age unknown`; }
        if (Date.now() - born < windowMs) return `${kind}: never — not due yet`;
        warn = true;
        return `${kind}: the nightly run has not happened yet`;
      }
      const time = Date.parse(run);
      if (!Number.isFinite(time) || time > Date.now()) {
        unchecked = true; return `${kind}: not checked — invalid last run timestamp`;
      }
      if (Date.now() - time <= windowMs) return `${kind}: successful run within 26 hours`;
      warn = true;
      return `${kind}: last successful run is older than 26 hours (${run})`;
    });
    if (dreamOff) details.push("dream: off by the house's choice (EMBERVY_DREAM=off)");
    report(warn ? "WARN" : unchecked ? "SKIP" : "OK", details.join("; "));
  } catch (error: any) {
    report("WARN", `not checked — cannot read memory health: ${error.message}`);
  }
}


async function checkUnauthRejected() {
  if (offline) {
    add({ id: "sec.memory_unauth", group: "Security", label: "Memory worker rejects unauth",
      status: "SKIP", detail: "not checked — offline" });
    add({ id: "sec.rag_unauth", group: "Security", label: "RAG rejects unauth",
      status: "SKIP", detail: "not checked — offline" });
    return;
  }
  // Do not follow redirects because the first answer must prove the auth gate.
  // Only an explicit authorization rejection proves the protected endpoint.
  if (EMBERVY_URL) {
    try {
      const r = await httpJson(`${EMBERVY_URL}/mcp`, {
        redirect: "manual",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      if (r.status === 200) {
        add({ id: "sec.memory_unauth", group: "Security", label: "Memory worker rejects unauth",
          status: "FAIL", detail: "HTTP 200 without Authorization — worker is fail-open!",
          fix: "Ensure EMBERVY_API_KEY is set as a wrangler secret; the worker must require it" });
      } else if (r.status === 401 || r.status === 403) {
        add({ id: "sec.memory_unauth", group: "Security", label: "Memory worker rejects unauth",
          status: "OK", detail: `unauth → HTTP ${r.status}` });
      } else {
        add({ id: "sec.memory_unauth", group: "Security", label: "Memory worker rejects unauth",
          status: "WARN", detail: `unexpected answer ${r.status}, auth not proven` });
      }
    } catch (e: any) {
      add({ id: "sec.memory_unauth", group: "Security", label: "Memory worker rejects unauth",
        status: "WARN", detail: `cannot probe: ${e.message}` });
    }
  }
  else add({ id: "sec.memory_unauth", group: "Security", label: "Memory worker rejects unauth",
    status: "SKIP", detail: "not checked — no URL" });
  // Probe the protected list route rather than public liveness.
  if (RAG_URL) {
    try {
      const r = await httpJson(`${RAG_URL}/list`, { redirect: "manual" });
      if (r.status === 200) {
        add({ id: "sec.rag_unauth", group: "Security", label: "RAG rejects unauth",
          status: "FAIL", detail: "HTTP 200 without Authorization — worker is fail-open!",
          fix: "Ensure RAG_AUTH_TOKEN is set as a wrangler secret; worker should fail-closed (500) without it" });
      } else if (r.status === 401 || r.status === 403) {
        add({ id: "sec.rag_unauth", group: "Security", label: "RAG rejects unauth",
          status: "OK", detail: `unauth → HTTP ${r.status}` });
      } else {
        add({ id: "sec.rag_unauth", group: "Security", label: "RAG rejects unauth",
          status: "WARN", detail: `unexpected answer ${r.status}, auth not proven` });
      }
    } catch (e: any) {
      add({ id: "sec.rag_unauth", group: "Security", label: "RAG rejects unauth",
        status: "WARN", detail: `cannot probe: ${e.message}` });
    }
  } else add({ id: "sec.rag_unauth", group: "Security", label: "RAG rejects unauth",
    status: "SKIP", detail: "not checked — no URL" });
}


async function deriveProbeQuery() {
  if (offline) { probeSkipReason = "not checked — offline"; return; }
  if (DOCTOR_PROBE_QUERY) return;
  if (archiveEmpty()) { probeSkipReason = "archive empty — no question to probe"; return; }
  if (!archiveFiles.length) { probeSkipReason = "archive unavailable — no question to probe"; return; }
  const sessions = archiveFiles.filter(file => /^.+_\d+(?:_part\d+)?\.md$/.test(file.name))
    .sort((a, b) => Date.parse(b.uploaded) - Date.parse(a.uploaded)
      || b.name.localeCompare(a.name, undefined, { numeric: true }));
  for (const file of sessions) {
    try {
      const r = await httpJson(`${RAG_URL}/head?filename=${encodeURIComponent(file.name)}&bytes=4000`, {
        headers: { "Authorization": `Bearer ${RAG_AUTH_TOKEN}` },
      });
      if (r.status !== 200 || !record(r.body) || typeof (r.body as any).head !== "string") continue;
      const themes = (r.body as any).head.match(/^THEMES[=:][ \t]*(.+)$/m)?.[1]?.trim();
      if (!themes || /^(—|–|-|placeholder\.?)$/i.test(themes)) continue;
      DOCTOR_PROBE_QUERY = themes.slice(0, 400);
      return;
    } catch { /* An older readable header can still provide a content probe. */ }
  }
  probeSkipReason = "no readable session header with usable THEMES — no question to probe";
}

async function checkRetrieval() {
  if (!DOCTOR_PROBE_QUERY && !offline && RAG_URL && RAG_AUTH_TOKEN) {
    for (const [id, label] of [["rag.hybrid", "Hybrid search"], ["rag.fts", "FTS5 (BM25) ready"], ["rag.rerank", "Reranker active"]]) {
      add({ id, group: "Retrieval", label, status: "SKIP", detail: probeSkipReason });
    }
    return;
  }
  if (offline || !RAG_URL || !RAG_AUTH_TOKEN) {
    add({ id: "rag.hybrid", group: "Retrieval", label: "Hybrid search",
      status: offline ? "SKIP" : "WARN",
      detail: offline ? "offline mode" : "skipped — RAG not reachable" });
    add({ id: "rag.fts", group: "Retrieval", label: "FTS5 (BM25) ready",
      status: offline ? "SKIP" : "WARN",
      detail: offline ? "offline mode" : "skipped" });
    add({ id: "rag.rerank", group: "Retrieval", label: "Reranker active",
      status: offline ? "SKIP" : "WARN",
      detail: offline ? "offline mode" : "skipped" });
    return;
  }
  try {
    // A cold reranker can take more than ten seconds without being broken.
    const hybridReq = () => httpJson(`${RAG_URL}/search`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${RAG_AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: DOCTOR_PROBE_QUERY, topK: 3, mode: "hybrid" }),
    }, 30_000);
    let r: Awaited<ReturnType<typeof httpJson>>;
    try { r = await hybridReq(); } catch { r = await hybridReq(); }
    if (r.status !== 200 || typeof r.body !== "object") {
      add({ id: "rag.hybrid", group: "Retrieval", label: "Hybrid search",
        status: "FAIL", detail: `HTTP ${r.status}` });
      return;
    }
    const body = r.body as any;
    const counts = body.counts || {};
    const reranked = body.reranked === true;
    const topSources: string[] = body.results?.[0]?.sources || [];

    add({ id: "rag.hybrid", group: "Retrieval", label: "Hybrid search",
      status: body.mode === "hybrid" ? "OK" : "WARN",
      detail: `mode=${body.mode}, counts: vector ${counts.vector}, bm25 ${counts.bm25}` });

    if (counts.bm25 > 0) {
      add({ id: "rag.fts", group: "Retrieval", label: "FTS5 (BM25) ready",
        status: "OK", detail: `${counts.bm25} BM25 hits` });
    } else {
      add({ id: "rag.fts", group: "Retrieval", label: "FTS5 (BM25) ready",
        status: archiveEmpty() ? "SKIP" : "WARN",
        detail: archiveEmpty()
          ? NEWBORN_NOTE
          : `0 BM25 hits for "${DOCTOR_PROBE_QUERY}" — index empty or probe content not indexed`,
        fix: archiveEmpty() ? undefined
          : "POST /fts-backfill (with cursor:null) to populate, or set DOCTOR_PROBE_QUERY to a known-existing term" });
    }

    if (reranked) {
      add({ id: "rag.rerank", group: "Retrieval", label: "Reranker active",
        status: "OK", detail: `top source: [${topSources.join(", ")}]` });
    } else {
      add({ id: "rag.rerank", group: "Retrieval", label: "Reranker active",
        status: archiveEmpty() ? "SKIP" : "WARN",
        detail: archiveEmpty()
          ? `${NEWBORN_NOTE} (nothing to rerank yet)`
          : "reranked:false in response — fallback active",
        fix: archiveEmpty() ? undefined
          : "Workers-AI bge-reranker-base transient issue — often self-healing on retry" });
    }
  } catch (e: any) {
    add({ id: "rag.hybrid", group: "Retrieval", label: "Hybrid search",
      status: "FAIL", detail: e.message });
  }
}


async function checkOpenRouterKey() {
  const base = { id: "inlet.openrouter-key", group: "Inlet", label: "OpenRouter key accepted" };
  const setting = readEnvSetting("OPENROUTER_API_KEY");
  if (!setting.value) return add({ ...base, status: "SKIP", detail: "OPENROUTER_API_KEY is unset — optional inlet classifier not configured" });
  if (offline) return add({ ...base, status: "SKIP", detail: "set, not checked — offline" });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    // Only the status proves acceptance; response bodies may contain credential metadata.
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      method: "GET", headers: { Authorization: `Bearer ${setting.value}` },
      signal: ctrl.signal, redirect: "error",
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 200) {
      add({ ...base, status: "OK", detail: "OpenRouter accepts the key (HTTP 200)" });
    } else if (response.status === 401 || response.status === 403) {
      add({ ...base, status: "WARN",
        detail: `OpenRouter rejects the key (HTTP ${response.status}), so the agent receives no automatic context; check ${setting.name} in ${setting.source}.`,
        fix: `Replace ${setting.name} in ${setting.source} with a valid OpenRouter key.` });
    } else {
      add({ ...base, status: "SKIP", detail: `key acceptance not checked — OpenRouter returned HTTP ${response.status}` });
    }
  } catch {
    // Request errors can echo authorization headers, so never print their raw text.
    add({ ...base, status: "SKIP", detail: ctrl.signal.aborted
      ? "key acceptance not checked — OpenRouter request timed out after 3 seconds"
      : "key acceptance not checked — network error reaching OpenRouter" });
  } finally {
    clearTimeout(timer);
  }
}

async function checkInlet() {
  if (BRAIN_HARNESS && (BRAIN_ENV.BRAIN_INLET ?? "").toLowerCase() === "false") {
    return add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
      status: "SKIP", detail: "inlet disabled in Brain's settings" });
  }
  if (BRAIN_HARNESS && !BRAIN_ENV.BRAIN_INLET_WORKER?.trim()) {
    return add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
      status: "SKIP", detail: "no BRAIN_INLET_WORKER — Brain uses plain search" });
  }
  const inletScript = BRAIN_HARNESS ? resolve(BRAIN_ENV.BRAIN_INLET_WORKER.trim()) : INLET_SCRIPT;
  if (!existsSync(inletScript)) {
    return add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
      status: "FAIL", detail: `${inletScript} missing`,
      fix: BRAIN_HARNESS
        ? "Inlet worker script missing — correct BRAIN_INLET_WORKER in Brain's settings"
        : "Inlet worker script missing — set INLET_SCRIPT or copy it from the release's Claude/scripts/" });
  }
  // A missing script is a configuration failure even when execution is not checked.
  if (offline || !DOCTOR_PROBE_QUERY) {
    return add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
      status: "SKIP", detail: offline ? "not checked — offline" : probeSkipReason });
  }
  try {
    // The child expects bare environment names even when this process uses a prefix.
    const res = spawnSync("bun", [inletScript, DOCTOR_PROBE_QUERY], {
      encoding: "utf-8",
      timeout: 30_000,
      ...(BRAIN_HARNESS ? { cwd: dirname(inletScript) } : {}),
      env: {
        ...process.env,
        ...env,
        ...(BRAIN_HARNESS ? BRAIN_ENV : {}),
        EMBERVY_URL,
        EMBERVY_API_KEY,
        RAG_URL,
        RAG_AUTH_TOKEN,
      },
    });
    const out = res.stdout || "";
    let payload = out;
    try {
      const envelope = JSON.parse(out);
      const inner = envelope?.hookSpecificOutput?.additionalContext;
      if (typeof inner === "string") payload = inner;
    } catch { /* Plain text needs no envelope. */ }
    // Headings and banners alone do not prove retrieval; require a filename, score and snippet.
    const hasContext = /^\[[^\]\r\n]+\] \((?:\d+%|RRF \d+\.\d+|context)(?: \[[^\]\r\n]+\])?(?:, [^\r\n)]+)?\)\r?\n\S/m.test(payload);
    if (res.status === 0 && hasContext) {
      add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
        status: "OK", detail: `${out.length} bytes, retrieved hit found` });
    } else if (res.status === 0 && (archiveEmpty() || archiveYoung())) {
      add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
        status: "SKIP", detail: archiveEmpty() ? NEWBORN_NOTE : youngNote() });
    } else {
      add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
        status: "WARN", detail: "inlet ran, no retrieved context seen",
        fix: "Run the inlet manually and inspect its output" });
    }
  } catch (e: any) {
    add({ id: "inlet", group: "Inlet", label: "Inlet returns context",
      status: "FAIL", detail: e.message });
  }
}


function checkMcp() {
  const report = (status: Status, detail: string) => add({ id: "mcp", group: "MCP",
    label: "House MCP servers", status, detail });
  if (offline && !BRAIN_HARNESS) return report("SKIP", "offline mode");
  let servers: Record<string, any>;
  try {
    servers = JSON.parse(readFileSync(`${EMBERVY_HOME}/.mcp.json`, "utf8")).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error();
  } catch {
    return report("WARN", "app, lore: missing or invalid .mcp.json");
  }
  const names = Object.keys(servers).filter(name => !name.startsWith("claude.ai "));
  const required = BRAIN_HARNESS ? [...new Set([...names, "app", "lore"])] : names;
  if (!required.length) return report("WARN", "No house servers configured in .mcp.json");
  const summarize = (states: Map<string, string>, source: string, good = "connected") => {
    const failed = required.filter(name => states.get(name) !== good);
    report(failed.length ? "WARN" : "OK",
      `${required.length - failed.length}/${required.length} ${good} (${source})` +
      (failed.length ? `; ${failed.map(name => `${name}: ${states.get(name) || "missing"}`).join(", ")}` : ""));
  };
  if (BRAIN_HARNESS) {
    let head = BRAIN_ENV.BRAIN_HEAD;
    try {
      const state = JSON.parse(readFileSync(BRAIN_ENV.BRAIN_HEAD_FILE || `${BRAIN_ENV.BRAIN_STATE_DIR || `${EMBERVY_HOME}/Brain/state`}/brain-head.json`, "utf8"));
      if (typeof state.head === "string") head = state.head;
    } catch { /* The configured first head applies before a selection is saved. */ }
    if (head === "claude") {
      try {
        const dir = BRAIN_ENV.BRAIN_LOG_DIR || `${EMBERVY_HOME}/Brain/logs`;
        const files = nodeFs.readdirSync(dir).filter(name => name.startsWith("session-") && name.endsWith(".jsonl"))
          .map(name => ({ path: `${dir}/${name}`, stat: statSync(`${dir}/${name}`) }))
          .filter(file => file.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        if (files.length) {
          const lines = readFileSync(files[0].path, "utf8").split("\n");
          for (let i = lines.length - 1; i >= 0; i--) {
            let event: any;
            try { event = JSON.parse(lines[i]); } catch { continue; }
            if (event.type !== "claude_pipe_init") continue;
            const states = new Map<string, string>();
            for (const server of Array.isArray(event.mcp_servers) ? event.mcp_servers : []) {
              if (typeof server?.name === "string" && !server.name.startsWith("claude.ai ")) {
                states.set(server.name, String(server.status || "unknown").toLowerCase());
              }
            }
            return summarize(states, "latest pipe initialization");
          }
        }
      } catch { /* No readable session yet. */ }
    }
    const states = new Map<string, string>();
    for (const name of required) {
      const server = servers[name];
      if (!server) continue;
      let ready = false;
      if (typeof server.url === "string") {
        try { ready = ["http:", "https:"].includes(new URL(server.url).protocol); } catch { /* Invalid URL. */ }
      } else if (typeof server.command === "string") {
        const cwd = server.cwd || EMBERVY_HOME;
        const paths = server.command.includes("/") ? [server.command.startsWith("/") ? server.command : `${cwd}/${server.command}`]
          : (process.env.PATH || "").split(":").map(dir => `${dir}/${server.command}`);
        ready = paths.some(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
        const args = Array.isArray(server.args) ? server.args : [];
        ready = ready && args.filter((arg: unknown) => typeof arg === "string" && (arg.startsWith("/") || arg.startsWith("./") || /\.(ts|js|mjs|py|sh)$/.test(arg)))
          .every((arg: string) => existsSync(arg.startsWith("/") ? arg : `${cwd}/${arg}`));
      }
      states.set(name, ready ? "configured" : "command or URL missing/invalid");
    }
    return summarize(states, "static configuration only", "configured");
  }
  // Subscription checks must not inherit an unrelated API credential.
  const spawnEnv = { ...process.env };
  delete spawnEnv.ANTHROPIC_API_KEY;
  spawnEnv.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  const settings = `${EMBERVY_HOME}/state/claude-settings.json`;
  const args = ["--setting-sources", "project,local",
    ...(existsSync(settings) ? ["--settings", settings] : []), "mcp", "list"];
  const res = spawnSync("claude", args, {
    cwd: EMBERVY_HOME, env: spawnEnv, encoding: "utf-8", timeout: 10_000,
  });
  const states = new Map<string, string>();
  for (const raw of (res.stdout || "").split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (line.startsWith("claude.ai ")) continue;
    const name = names.find(name => line.startsWith(`${name}:`));
    if (!name) continue;
    const status = line.slice(name.length + 1);
    states.set(name, /pending/i.test(status) ? "pending approval"
      : /failed|disconnected|not connected|✗/i.test(status) ? "failed"
      : /\bconnected\s*$/i.test(status) ? "connected" : "unknown");
  }
  summarize(states, res.error ? "CLI unavailable or timed out" : "house configuration");
}


function checkAdapter() {
  const routeSetting = BRAIN_HARNESS ? (BRAIN_ENV.CHATGPT_ROUTE ?? readEnv("CHATGPT_ROUTE")) : readEnv("CHATGPT_ROUTE");
  if (routeSetting === "official") {
    const path = BRAIN_HARNESS
      ? BRAIN_ENV.CHATGPT_AUTH_FILE || readEnv("CHATGPT_AUTH_FILE") || `${process.env.HOME || "/root"}/.codex/auth.json`
      : chatgptAuthFile({ ...process.env, EMBERVY_HOME, EMBERVY_TMUX_SOCKET: readEnv("EMBERVY_TMUX_SOCKET"), CHATGPT_AUTH_FILE: readEnv("CHATGPT_AUTH_FILE") });
    const authFile = path.startsWith("~/") ? `${process.env.HOME || "/root"}/${path.slice(2)}` : path;
    try {
      const tokens = JSON.parse(readFileSync(authFile, "utf8")).tokens;
      if (tokens?.access_token && !tokens.client_id) add({ id: "chatgpt.route", group: "GPT", label: "ChatGPT route",
        status: "WARN", detail: "signed in the old way; sign in again to use the official route",
        fix: "Complete ChatGPT sign-in again with CHATGPT_ROUTE=official; existing credentials keep their route until replaced." });
    } catch { /* Missing credentials are diagnosed by the existing connection checks. */ }
  }
  const adapterDoc = resolve(EMBERVY_HOME, resolveAdapterDoc());
  const docName = adapterDoc.split("/").pop() || adapterDoc;
  const brainPrompt = BRAIN_HARNESS && !readEnv("ADAPTER_DOC") && !!BRAIN_ENV.BRAIN_SYSTEM?.trim();
  if (existsSync(adapterDoc)) {
    const lines = readFileSync(adapterDoc, "utf-8").split("\n").length;
    add({ id: "adapter.doc", group: "Adapter", label: `${docName} present`,
      status: "OK", detail: `${lines} lines` });
  } else {
    add({ id: "adapter.doc", group: "Adapter", label: `${docName} present`,
      status: "FAIL", detail: "missing",
      fix: brainPrompt
        ? `${docName} not found — Brain wakes every head with its built-in prompt instead; restore it from a backup or run the installer's Finalize again`
        : `${docName} not found — set ADAPTER_DOC or copy it from the release's ${docName}.example` });
  }
  // The CLI also loads project instructions, which can duplicate the supplied system prompt.
  if (brainPrompt) {
    const cwd = BRAIN_ENV.BRAIN_CLAUDE_CWD?.trim() || EMBERVY_HOME;
    const beside = ["CLAUDE.md", "AGENTS.md"].filter((name) => existsSync(`${cwd}/${name}`) && `${cwd}/${name}` !== adapterDoc);
    if (beside.length) {
      add({ id: "adapter.once", group: "Adapter", label: "System prompt loaded once",
        status: "WARN", detail: `${beside.join(" and ")} beside ${docName}: a head reads both`,
        fix: `Move what is still needed from ${beside.join(" and ")} into ${docName}, delete ${beside.length > 1 ? "them" : "it"}, then restart Brain (/respawn)` });
    } else {
      add({ id: "adapter.once", group: "Adapter", label: "System prompt loaded once",
        status: "OK", detail: `${docName} only` });
    }
  }

  if (BRAIN_HARNESS) return checkBrainInlet();

  const customSettings = readEnv("INLET_HOOK_SETTINGS");
  const candidates = customSettings
    ? [customSettings]
    : [
        `${EMBERVY_HOME}/.claude/settings.json`,
        `${EMBERVY_HOME}/.claude/settings.local.json`,
      ];
  // User-level hooks can belong to another installation on the same account; require this installation's path.
  const userSettings = `${process.env.HOME || "/root"}/.claude/settings.json`;
  if (!customSettings && !candidates.includes(userSettings)) candidates.push(userSettings);
  let hookFound = false;
  let hookSource = "";
  for (const settings of candidates) {
    if (!existsSync(settings)) continue;
    try {
      const cfg = JSON.parse(readFileSync(settings, "utf-8"));
      const hooks = JSON.stringify(cfg.hooks?.UserPromptSubmit || "");
      const own = settings !== userSettings || customSettings || hooks.includes(`${EMBERVY_HOME}/`);
      if (hooks.includes("inlet") && own) {
        hookFound = true;
        hookSource = settings;
        break;
      }
    } catch { /* skip */ }
  }
  if (hookFound) {
    add({ id: "adapter.hook", group: "Adapter", label: "UserPromptSubmit inlet hook wired",
      status: "OK", detail: `registered in ${hookSource}` });
  } else {
    add({ id: "adapter.hook", group: "Adapter", label: "UserPromptSubmit inlet hook wired",
      status: "WARN", detail: "no inlet hook in any known settings.json",
      fix: `Add hooks.UserPromptSubmit → command pointing to your inlet script in ${candidates[0]}` });
  }
}

// Reuse the hook check ID so muting survives a harness change.
function checkBrainInlet() {
  const label = "Inlet wired (Brain runs it every turn)";
  if ((BRAIN_ENV.BRAIN_INLET ?? "").toLowerCase() === "false") {
    return add({ id: "adapter.hook", group: "Adapter", label,
      status: "SKIP", detail: "the inlet is switched off in Brain's settings (BRAIN_INLET=false)" });
  }
  const worker = BRAIN_ENV.BRAIN_INLET_WORKER || "";
  if (worker && existsSync(worker)) {
    return add({ id: "adapter.hook", group: "Adapter", label,
      status: "OK", detail: `BRAIN_INLET_WORKER → ${worker}` });
  }
  add({ id: "adapter.hook", group: "Adapter", label,
    status: "WARN",
    detail: worker ? `BRAIN_INLET_WORKER points to ${worker}, which does not exist` : "no BRAIN_INLET_WORKER in Brain's settings — Brain runs its plain search",
    fix: `Set BRAIN_INLET_WORKER=${EMBERVY_HOME}/Claude/scripts/inlet-worker.ts in Brain/brain.env, then restart Brain` });
}


function checkBrainNotes() {
  if (!BRAIN_HARNESS) return;
  const dir = BRAIN_ENV.BRAIN_NOTES_DIR?.trim();
  if (!dir) {
    add({ id: "brain.notes", group: "Adapter", label: "Brain notebook", status: "SKIP", detail: "BRAIN_NOTES_DIR is unset; this house still uses Claude Code's automatic memory." });
    return;
  }
  let valid = false;
  try { valid = dir.startsWith("/") && statSync(dir).isDirectory(); } catch {}
  add({ id: "brain.notes", group: "Adapter", label: "Brain notebook directory", status: valid ? "OK" : "FAIL", detail: dir,
    ...(!valid ? { fix: "Create the absolute directory named by BRAIN_NOTES_DIR in Brain/brain.env." } : {}) });
  if (valid) {
    let indexed = false;
    try { indexed = statSync(`${dir}/NOTES.md`).isFile(); } catch {}
    add({ id: "brain.notes.index", group: "Adapter", label: "Notebook index", status: indexed ? "OK" : "SKIP",
      detail: indexed ? `${dir}/NOTES.md` : "NOTES.md is missing; add an index with one line per note." });
  }
  // Subscription heads use the default account while engine heads can inherit a separate configuration.
  const home = BRAIN_ENV.HOME?.trim() || process.env.HOME || "/root";
  const configs = new Set([`${home}/.claude`, BRAIN_ENV.CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR].filter(Boolean));
  const cwd = BRAIN_ENV.BRAIN_CLAUDE_CWD?.trim() || `${EMBERVY_HOME}/Brain`;
  for (const [n, config] of [...configs].entries()) {
    const memory = `${config}/projects/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/memory`;
    try {
      if (!existsSync(memory)) continue;
      const notes = nodeFs.readdirSync(memory).filter(name => name !== "MEMORY.md");
      if (notes.length) add({ id: `brain.notes.legacy${n ? `.${n}` : ""}`, group: "Adapter", label: "Unread Claude Code notes", status: "WARN",
        detail: `${notes.length} entries remain in ${memory}; no head reads them with BRAIN_NOTES_DIR set.`,
        fix: `Back up and move these notes to ${dir} (normally notes/), merge MEMORY.md into NOTES.md, and resolve filename collisions without overwriting.` });
    } catch {
      add({ id: `brain.notes.legacy${n ? `.${n}` : ""}`, group: "Adapter", label: "Claude Code notes check", status: "WARN", detail: `Cannot inspect ${memory}.` });
    }
  }
}

function checkBridgeWritable() {
  const stateDir = readEnv("STATE_DIR") || `${EMBERVY_HOME}/state`;
  if (!existsSync(stateDir)) {
    return add({ id: "health.bridge", group: "Health", label: "State dir writable",
      status: "WARN", detail: `${stateDir} does not exist (yet)`,
      fix: `mkdir -p ${stateDir}` });
  }
  try {
    accessSync(stateDir, constants.W_OK);
    add({ id: "health.bridge", group: "Health", label: "State dir writable",
      status: "OK", detail: stateDir });
  } catch {
    add({ id: "health.bridge", group: "Health", label: "State dir writable",
      status: "FAIL", detail: `${stateDir} not writable`,
      fix: `Check ownership/permissions on ${stateDir}` });
  }
}

function checkWatchdog() {
  const log = readEnv("WATCHDOG_LOG") || `${EMBERVY_HOME}/logs/context_watchdog.log`;
  if (existsSync(log)) {
    add({ id: "health.watchdog", group: "Health", label: "Watchdog logging",
      status: "OK", detail: "watchdog log present" });
  } else if (readEnv("WATCHDOG_LOG")) {
    add({ id: "health.watchdog", group: "Health", label: "Watchdog logging",
      status: "WARN", detail: `${log} missing`,
      fix: "Check your watchdog service status" });
  }
}

// Root-reserved blocks are not available space.
const DISK_WARN_PCT = 80;
const DISK_FAIL_PCT = 92;
const DISK_RESERVE_FILE = reserveFile(existsSync); 

function checkDisk() {
  const label = "Disk space";
  const seen = new Set<number>();
  const rows: Array<{ mount: string; pct: number; freeGb: number }> = [];
  for (const path of ["/", EMBERVY_HOME]) {
    try {
      const dev = statSync(path).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      // Runtime lookup lets the other checks run when statfs is unavailable.
      const statfs = (nodeFs as any).statfsSync as ((p: string) => { blocks: number; bfree: number; bavail: number; bsize: number }) | undefined;
      if (!statfs) break;
      const fs = statfs(path);
      const used = (fs.blocks - fs.bfree) * fs.bsize;
      const avail = fs.bavail * fs.bsize;
      if (used + avail <= 0) continue;
      rows.push({ mount: path, pct: Math.ceil((used * 100) / (used + avail)), freeGb: avail / 1024 ** 3 });
    } catch { /* path missing or statfs unsupported — the other one may still answer */ }
  }
  if (rows.length === 0) {
    return add({ id: "health.disk", group: "Health", label, status: "SKIP", detail: "free space not readable on this system" });
  }
  const worst = Math.max(...rows.map((r) => r.pct));
  const status: Status = worst >= DISK_FAIL_PCT ? "FAIL" : worst >= DISK_WARN_PCT ? "WARN" : "OK";
  const detail = rows.map((r) => `${r.pct}% used on ${r.mount} (${r.freeGb.toFixed(1)} GB free)`).join("; ");
  const reserve = existsSync(DISK_RESERVE_FILE) ? `delete ${DISK_RESERVE_FILE} first (2 GB ballast kept for this), then ` : "";
  add({ id: "health.disk", group: "Health", label, status, detail,
    fix: status === "OK" ? undefined
      : `${reserve}clean up: old files in ${EMBERVY_HOME}/logs, \`journalctl --vacuum-size=200M\`, \`apt-get clean\`; \`du -xh -d 2 / 2>/dev/null | sort -h | tail -20\` shows what is big` });
}

function checkSwap() {
  const label = "Swap";
  let raw: string;
  try {
    raw = readFileSync("/proc/swaps", "utf-8");
  } catch {
    return add({ id: "health.swap", group: "Health", label, status: "SKIP", detail: "no /proc/swaps (not Linux)" });
  }
  // Header line, then "Filename Type Size(KiB) Used(KiB) Priority".
  const devices = raw.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && f[0]);
  if (devices.length === 0) {
    return add({ id: "health.swap", group: "Health", label, status: "WARN",
      detail: "no swap active — a memory spike kills processes instead of slowing them down",
      fix: "fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab (the installer's bootstrap.sh does this)" });
  }
  const gb = (kib: number) => (kib / 1024 ** 2).toFixed(1);
  const total = devices.reduce((n, f) => n + Number(f[2] || 0), 0);
  const used = devices.reduce((n, f) => n + Number(f[3] || 0), 0);
  add({ id: "health.swap", group: "Health", label, status: "OK",
    detail: `${gb(total)} GB (${devices.map((f) => f[0]).join(", ")}), ${gb(used)} GB in use` });
}

async function checkUnitMemory() {
  const bases = {
    oom_policy: { id: "health.oom_policy", group: "Health", label: "Loop OOM policy" },
    oom_kills: { id: "health.oom_kills", group: "Health", label: "Recent unit OOM kills" },
    restarts: { id: "health.restarts", group: "Health", label: "Unit restart count" },
  };
  let units: Array<{ role: string; name: string }>;
  try {
    const { collectFacts } = await import("./house-docs");
    units = collectFacts(EMBERVY_HOME).facts.units;
  } catch {
    for (const base of Object.values(bases)) add({ ...base, status: "SKIP", detail: "house units could not be read" });
    return;
  }
  if (!units.length) {
    for (const base of Object.values(bases)) add({ ...base, status: "SKIP", detail: "no house units available" });
    return;
  }
  const results: Record<keyof typeof bases, Check[]> = { oom_policy: [], oom_kills: [], restarts: [] };
  const options = { encoding: "utf8" as const, timeout: 5000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", SYSTEMD_PAGER: "cat", SYSTEMD_COLORS: "0" } };
  for (const unit of units) {
    const base = (kind: keyof typeof bases) => ({ ...bases[kind], id: `${bases[kind].id}.${unit.name}` });
    const hasProperties = !/\.(timer|socket)$/.test(unit.name);
    const checkPolicy = hasProperties && (unit.role === "brain" || unit.role === "loop");
    let properties: Record<string, string> = {};
    if (hasProperties) try {
      const result = spawnSync("systemctl", ["show", "-p", "LoadState", ...(checkPolicy ? ["-p", "OOMPolicy"] : []), "-p", "NRestarts", "--", unit.name], options);
      if (!result.error && result.status === 0) properties = parseEnv(result.stdout || "");
    } catch { /* An unavailable manager must not prevent the remaining checks. */ }
    const loaded = properties.LoadState === "loaded";
    if (checkPolicy) {
      const policy = properties.OOMPolicy;
      const readable = loaded && ["continue", "stop", "kill"].includes(policy);
      results.oom_policy.push({ ...base("oom_policy"), status: !readable ? "SKIP" : policy === "stop" ? "WARN" : "OK",
        detail: readable ? `${unit.name}: OOMPolicy=${policy}` : `${unit.name}: OOM policy unavailable`,
        ...(readable && policy === "stop" ? {
          fix: `Run \`systemctl edit ${unit.name}\` to add a drop-in containing:\n[Service]\nOOMPolicy=continue\nThen run \`systemctl daemon-reload\` and verify with \`systemctl show -p OOMPolicy ${unit.name}\`.`,
        } : {}) });
    }
    if (hasProperties) {
      const count = /^\d+$/.test(properties.NRestarts || "") ? Number(properties.NRestarts) : NaN;
      const readable = loaded && Number.isSafeInteger(count);
      results.restarts.push({ ...base("restarts"), status: !readable ? "SKIP" : count > 50 ? "WARN" : "OK",
        detail: readable ? `${unit.name}: ${count} restarts` : `${unit.name}: restart count unavailable`,
        ...(readable && count > 50 ? { fix: "Check this unit's configuration and resource use before restarting it again." } : {}) });
    }
    try {
      // Only manager messages identify OOM kills; application logs may contain private text or imitations.
      const result = spawnSync("journalctl", ["-u", unit.name, "--since", "7 days ago", "--no-pager", "-o", "cat", "_PID=1"], options);
      if (result.error || result.status !== 0 || result.stderr?.trim()) {
        results.oom_kills.push({ ...base("oom_kills"), status: "SKIP", detail: `${unit.name}: journal unavailable or incomplete` });
        continue;
      }
      const kills = (result.stdout || "").split("\n").filter(line => /\bkilled by the OOM killer\b/.test(line)).length;
      results.oom_kills.push({ ...base("oom_kills"), status: kills > 0 ? "WARN" : "OK",
        detail: `${unit.name}: ${kills} OOM kills in the last seven days`,
        ...(kills > 0 ? { fix: "Check this unit's memory use and the available memory and swap." } : {}) });
    } catch {
      results.oom_kills.push({ ...base("oom_kills"), status: "SKIP", detail: `${unit.name}: journal unavailable` });
    }
  }
  const summaries = {
    oom_policy: "OOM policy is continue or kill",
    oom_kills: "no OOM kills in the last seven days",
    restarts: "restart counts at or below 50",
  };
  for (const kind of Object.keys(bases) as Array<keyof typeof bases>) {
    const entries = results[kind];
    for (const entry of entries) if (entry.status !== "OK") add(entry);
    const checked = entries.filter(entry => entry.status !== "SKIP").length;
    if (!checked) {
      add({ ...bases[kind], status: "SKIP", detail: entries.length
        ? "no house units could be checked; see per-unit reasons"
        : kind === "oom_policy" ? "no house loop unit available" : "no eligible house units available" });
    } else if (!entries.some(entry => entry.status === "WARN")) {
      add({ ...bases[kind], status: "OK", detail: `${checked} house unit${checked === 1 ? "" : "s"}: ${summaries[kind]}` });
    }
  }
}

function checkReboot() {
  const base = { id: "health.reboot", group: "Health", label: "Server restart" };
  const marker = readEnv("REBOOT_REQUIRED_FILE") || "/var/run/reboot-required";
  const packagesFile = readEnv("REBOOT_REQUIRED_PKGS_FILE") || "/var/run/reboot-required.pkgs";
  const directory = dirname(marker);
  try {
    if (!statSync(directory).isDirectory()) throw new Error("not a directory");
    accessSync(directory, constants.R_OK | constants.X_OK);
  } catch {
    return add({ ...base, status: "SKIP", detail: "restart status directory is missing or unreadable" });
  }
  try {
    statSync(marker);
  } catch (error: any) {
    return add({ ...base, status: error.code === "ENOENT" ? "OK" : "SKIP",
      detail: error.code === "ENOENT" ? "no restart required" : "restart status is not readable" });
  }
  // A pending restart is not a fault: everything keeps running, so the check stays green.
  // As a warning it would read like a broken server, and an agent could take it as a task.
  const brainHouse = (readEnv("EMBERVY_HARNESS") || SUBSTRATE) === "brain";
  const person = (brainHouse ? BRAIN_ENV.BRAIN_USER_NAME : appEnv.USER_LABEL ?? readEnv("USER_LABEL"))?.trim() || "your person";
  let detail = `Running normally. A security update becomes active at the next server restart; nothing needs doing now, and only ${person} decides when.`;
  const short = (version: string) => /^\d+(?:\.\d+)*/.exec(version)?.[0] ?? version;
  try {
    const listed = readFileSync(packagesFile, "utf8").split(/\s+/).filter(Boolean);
    // Debian appends to this list and never removes a kernel that a later update
    // purged again, so a versioned kernel only counts while its image is in /boot.
    let bootImages: Set<string> | null = null;
    try { bootImages = new Set(readdirSync(readEnv("REBOOT_BOOT_DIR") || "/boot")); } catch { /* keep the list unfiltered */ }
    const running = release();
    const kernels: string[] = [];
    const packages: string[] = [];
    for (const name of listed) {
      const version = /^linux-image-(\d.*)$/.exec(name)?.[1];
      // The versionless kernel meta package adds nothing the kernel note does not say.
      if (!version && name.startsWith("linux-image-")) continue;
      if (!version) { packages.push(name); continue; }
      if (version === running || (bootImages && !bootImages.has(`vmlinuz-${version}`))) continue;
      if (!kernels.includes(version)) kernels.push(version);
    }
    const notes: string[] = [];
    if (kernels.length) {
      const newest = kernels.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1)!;
      notes.push(`system ${short(newest)} installed, ${short(running)} still running`);
    }
    if (packages.length) notes.push(`packages: ${packages.slice(0, 5).join(", ")}${packages.length > 5 ? `, ${packages.length - 5} more` : ""}`);
    if (notes.length) detail += ` (${notes.join("; ")})`;
  } catch { /* An unavailable package list must not hide a pending restart. */ }
  add({ ...base, status: "OK", detail });
}

async function checkDangerousDefaults() {
  type Sub = { label: string; ok: boolean; failDetail?: string; fix?: string };
  const subs: Sub[] = [];

  subs.push({
    label: "RAG_AUTH_TOKEN set",
    ok: !!RAG_AUTH_TOKEN,
    failDetail: "RAG_AUTH_TOKEN missing — RAG fails closed but other components break",
  });

  // App-local assignments are authoritative, including an explicitly empty value.
  // The root template may contain blank app-only keys without configuring the app.
  const appValue = (name: string) => {
    const key = AGENT_PREFIX && appEnv[`${AGENT_PREFIX}_${name}`] !== undefined
      ? `${AGENT_PREFIX}_${name}` : name;
    return appEnv[key] !== undefined ? appEnv[key] : readEnv(name);
  };
  const APP_PASSWORD = appValue("APP_PASSWORD");
  const APP_SESSION_SECRET = appValue("APP_SESSION_SECRET");

  const trivial = ["test", "password", "admin", "1234", ""];
  // Service state and the actual listener distinguish an absent app from an unprotected one.
  const unit = appValue("EMBERVY_APP_SERVICE") || "embervy-app";
  const service = spawnSync("systemctl", ["show", unit, "--property=LoadState", "--property=ActiveState"],
    { encoding: "utf8", timeout: 3000 });
  const serviceState = service.stdout || "";
  const active = /^ActiveState=(active|activating|reloading)$/m.test(serviceState);
  let answers = false, probeFailed = "";
  const host = appValue("EMBERVY_APP_HOST") || "127.0.0.1";
  const port = appValue("EMBERVY_APP_PORT") || "3030";
  try {
    const response = await httpJson(`http://${host.includes(":") ? `[${host}]` : host}:${port}/health`, {}, 1500);
    answers = response.status > 0;
  } catch (error: any) { probeFailed = error.message || String(error); }
  const installed = /^LoadState=loaded$/m.test(serviceState) || existsSync(`${EMBERVY_HOME}/Claude/app/server.ts`);
  if (!APP_PASSWORD && (active || answers)) {
    subs.push({ label: "APP_PASSWORD set", ok: false,
      failDetail: "APP_PASSWORD is empty while the house app is running",
      fix: `Set APP_PASSWORD and APP_SESSION_SECRET in ${APP_ENV_FILE}, then restart ${unit}.` });
  } else if (!APP_PASSWORD) {
    const absent = !installed && /^LoadState=not-found$/m.test(serviceState);
    add({ id: "health.app_password", group: "Health", label: "App password protection", status: "SKIP",
      detail: absent ? "not checked — no app layer installed or running"
        : `not checked — app is not answering; ${installed ? "installed but not running" : "service state unavailable"}; ${probeFailed}` });
  }
  if (APP_PASSWORD) {
    subs.push({
      label: "APP_PASSWORD non-trivial",
      ok: !trivial.includes(APP_PASSWORD),
      failDetail: "APP_PASSWORD is a trivial default",
    });
    const sLen = APP_SESSION_SECRET.length;
    subs.push({
      label: "APP_SESSION_SECRET length ≥ 32",
      ok: sLen >= 32,
      failDetail: `APP_SESSION_SECRET too short (${sLen} chars; ≥32 required when APP_PASSWORD is set)`,
    });
  }

  const placeholderHits: string[] = [];
  // API provisioning leaves templates untouched, so their placeholders do not indicate a broken deployment.
  let apiProvisioned = !!(readEnv("CLOUDFLARE_ACCOUNT_ID") || readEnv("CF_ACCOUNT_ID"))
    || (!!readEnv("EMBERVY_URL") && !!readEnv("RAG_URL"));
  if (!apiProvisioned) {
    try { apiProvisioned = !!JSON.parse(readFileSync(`${EMBERVY_HOME}/state.json`, "utf8"))?.cloudflare?.account_id; } catch {}
  }
  const wranglers = [
    `${EMBERVY_HOME}/shared/rag/wrangler.toml`,
    `${EMBERVY_HOME}/shared/memory/wrangler.toml`,
    `${EMBERVY_HOME}/rag/wrangler.toml`,
    `${EMBERVY_HOME}/rag-deploy/wrangler.toml`,
  ];
  for (const wt of wranglers) {
    if (apiProvisioned) break;
    if (!existsSync(wt)) continue;
    const c = readFileSync(wt, "utf-8");
    if (c.includes("YOUR_") || c.includes("<your-")) {
      placeholderHits.push(wt);
    }
  }
  subs.push({
    label: "No dangerous wrangler placeholders",
    ok: apiProvisioned || placeholderHits.length === 0,
    failDetail: `${placeholderHits.join(", ")} has unfilled placeholders`,
  });

  if (verbose) {
    for (const s of subs) {
      add({
        id: `health.defaults.${s.label.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`,
        group: "Health",
        label: s.label,
        status: s.ok ? "OK" : "FAIL",
        detail: s.ok ? undefined : s.failDetail,
        fix: s.ok ? undefined : s.fix || "See detail",
      });
    }
  } else {
    const failing = subs.filter(s => !s.ok);
    if (failing.length === 0) {
      add({ id: "health.defaults", group: "Health", label: "No dangerous defaults",
        status: "OK", detail: "all secrets & configs look filled (use --verbose for breakdown)" });
    } else {
      add({ id: "health.defaults", group: "Health", label: "No dangerous defaults",
        status: "FAIL",
        detail: failing.map(f => f.failDetail).join("; "),
        fix: failing.map(item => item.fix).filter(Boolean).join(" ") || "See detail; fix each item individually — use `--verbose` for breakdown" });
    }
  }
}


function checkIdentity() {
  const path = resolve(EMBERVY_HOME, resolveAdapterDoc());
  let valid = false;
  try { valid = statSync(path).isFile() && !!readFileSync(path, "utf8").trim(); } catch {}
  add({ id: "identity", group: "Identity", label: "Identity or system file is not empty", status: valid ? "OK" : "FAIL", detail: valid ? path : `${path} is missing or empty`, ...(!valid ? { fix: `Restore the identity file at ${path}, or correct ADAPTER_DOC / BRAIN_SYSTEM in the house settings.` } : {}) });
}
async function checkHear() {
  const url = readEnv("EMBERVY_HEAR_URL");
  const base = { id: "hear", group: "Hearing", label: "Hearing service answers" };
  if (!url || offline) return add({ ...base, status: "SKIP", detail: url ? "not checked — offline" : "EMBERVY_HEAR_URL is unset", fix: url ? "Run the doctor without --offline to check hearing." : "No repair needed; set EMBERVY_HEAR_URL in the app settings only if hearing is wanted." });
  try {
    // A health probe must not upload private audio or spend money on transcription.
    let probe = "";
    try {
      const health = await httpJson(new URL("/health", url).href, {}, 3000);
      if (health.status >= 200 && health.status < 300) probe = `/health answers HTTP ${health.status}`;
    } catch { /* fall back to the configured address */ }
    if (!probe) {
      const response = await httpJson(url, { method: "HEAD" }, 3000);
      // A service that only accepts POST may refuse HEAD with 405 or 501 and still be alive.
      if ((response.status < 200 || response.status >= 300) && response.status !== 405 && response.status !== 501) throw new Error(`HTTP ${response.status}`);
      probe = `service answers HTTP ${response.status}`;
    }
    add({ ...base, status: "OK", detail: `${probe}; transcription not checked` });
  } catch (error: any) {
    add({ ...base, status: "FAIL", detail: error.message, fix: "Check EMBERVY_HEAR_URL in the app settings, then inspect the hearing service at that address." });
  }
}
async function checkCapabilityList() {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const command = `bun ${quote(resolve(EMBERVY_HOME, "shared/tools/house-docs.ts"))} --home ${quote(EMBERVY_HOME)}`;
  const base = { id: "capabilities", group: "House", label: "Capability list matches configuration" };
  if (!existsSync(resolve(EMBERVY_HOME, "CAPABILITIES.md"))) {
    add({ ...base, status: "WARN", detail: "CAPABILITIES.md is missing", fix: `${command} --write` });
    return;
  }
  try {
    // A partial installation must still start its doctor if the renderer's dependencies are missing.
    const { checkCapabilitiesFile } = await import("./house-docs");
    const findings = checkCapabilitiesFile(EMBERVY_HOME);
    add({ ...base, status: findings.length ? "WARN" : "OK", detail: findings.length ? findings.join("; ") : "All known abilities match",
      ...(findings.length ? { fix: `${command} --capabilities; compare with CAPABILITIES.md and keep the agent's edits.` } : {}) });
  } catch {
    add({ ...base, status: "WARN", detail: "CAPABILITIES.md could not be compared with this house", fix: `${command} --capabilities; check the local file and configuration without replacing the agent's edits.` });
  }
}

function checkClaudeChannelSignIn() {
  const id = "claude.channel-signin", group = "App channel";
  const otherHead = [readEnv("EMBERVY_SUBSTRATE"), readEnv("EMBERVY_BACKEND")].some(value => value && value.toLowerCase() !== "claude");
  if (readEnv("EMBERVY_HARNESS").toLowerCase() !== "claude-code" || !otherHead) {
    add({ id, group, label: readEnv("EMBERVY_HARNESS").toLowerCase() === "claude-code"
      ? "Claude sign-in for another head: this house thinks with Claude, its own sign-in is checked by the canary"
      : "Claude sign-in for another head: this check is only for a Claude Code house with another head", status: "SKIP" });
    return;
  }
  let present = !!readEnv("CLAUDE_CODE_OAUTH_TOKEN");
  if (!present) {
    try {
      const config = readEnv("CLAUDE_CONFIG_DIR") || `${process.env.HOME || "/root"}/.claude`;
      const credentials = JSON.parse(readFileSync(`${config}/.credentials.json`, "utf8"));
      present = !!credentials && typeof credentials === "object" && !Array.isArray(credentials) && Object.hasOwn(credentials, "claudeAiOauth");
    } catch {}
  }
  add({ id, group, status: present ? "OK" : "FAIL", label: present
    ? "Claude sign-in present for the app channel"
    : "App messages cannot reach this agent: Claude Code has no Claude sign-in, and Anthropic opens its app channel only for a signed-in Claude account. Sign in with claude and /login." });
}

async function startupChecks() {
  checkClaudeChannelSignIn();
  checkIdentity();
  await checkCapabilityList();
  checkBridgeWritable();
  checkAdapter();
  // Startup must not spend model calls on a retrieval probe.
  const worker = BRAIN_HARNESS ? BRAIN_ENV.BRAIN_INLET_WORKER : INLET_SCRIPT;
  const disabled = BRAIN_HARNESS && BRAIN_ENV.BRAIN_INLET === "false";
  add({ id: "inlet", group: "Inlet", label: "Inlet worker available", status: disabled ? "SKIP" : worker && existsSync(resolve(EMBERVY_HOME, worker)) ? "OK" : "FAIL", detail: disabled ? "inlet disabled" : worker || "inlet worker is unset", fix: `Correct the inlet worker path in ${EMBERVY_HOME}/.env or Brain/brain.env.` });
  if (BRAIN_HARNESS) checkMcp();
  else {
    let valid = false;
    try { const servers = JSON.parse(readFileSync(`${EMBERVY_HOME}/.mcp.json`, "utf8")).mcpServers; valid = record(servers) && Object.keys(servers).length > 0; } catch {}
    add({ id: "mcp", group: "MCP", label: "House MCP configuration", status: valid ? "OK" : "FAIL", detail: valid ? "configured; live connections are checked by the full doctor" : "missing or invalid .mcp.json", fix: `Restore ${EMBERVY_HOME}/.mcp.json from the house configuration.` });
  }
  await Promise.all([checkMemoryUrl(), checkMemoryKey(), checkRagUrl(), checkRagToken(), checkHear(), checkOpenRouterKey()]);
}
function startupReport() {
  // A separate process keeps the deadline effective even if a check blocks the event loop.
  const child = spawnSync(process.execPath, [import.meta.path, "--startup-child", ...(offline ? ["--offline"] : [])], { encoding: "utf8", timeout: 19_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 });
  const entries: Check[] = [];
  for (const line of (child.stdout || "").split("\n")) {
    try { const c = JSON.parse(line); if (typeof c.id === "string" && typeof c.label === "string") entries.push(c); } catch {}
  }
  if (child.error || child.status !== 0) entries.push({ id: "startup", group: "Startup", label: "Startup checks completed", status: "FAIL", detail: childErrorCode(child) === "ETIMEDOUT" ? "overall startup deadline reached" : "startup check process failed", fix: `Run bun ${EMBERVY_HOME}/shared/tools/embervy-doctor.ts --json and inspect the first failing check.` });
  const summary = { pass: entries.filter(c => c.status === "OK").length, warn: entries.filter(c => c.status === "WARN").length, fail: entries.filter(c => c.status === "FAIL").length, skip: entries.filter(c => c.status === "SKIP").length };
  const result = summary.fail ? "FAIL" : summary.warn ? "PASS-WITH-WARN" : "PASS";
  console.log(JSON.stringify({ result, summary, checks: entries }, null, 2));
  process.exit(summary.fail ? 2 : summary.warn ? 1 : 0);
}
async function main() {
  if (process.argv.includes("--startup-child")) { await startupChecks(); return; }
  checkClaudeChannelSignIn();
  checkIdentity();
  await checkCapabilityList();
  await checkHear();
  await checkMemoryUrl();
  await checkMemoryKey();
  await checkRagUrl();
  await checkRagToken();
  await checkMemoryNightly();
  await checkUnauthRejected();
  await deriveProbeQuery();
  await checkRetrieval();
  await checkOpenRouterKey();
  await checkInlet();
  checkClaudeHeadless();
  if (SUBSTRATE === "gpt") await checkGptAdapter();
  checkMcp();

  checkAdapter();
  checkBrainNotes();
  checkBridgeWritable();
  checkWatchdog();
  checkDisk();
  checkSwap();
  await checkUnitMemory();
  checkReboot();
  await checkDangerousDefaults();

  const counts = {
    pass: checks.filter(c => c.status === "OK").length,
    warn: checks.filter(c => c.status === "WARN").length,
    fail: checks.filter(c => c.status === "FAIL").length,
    skip: checks.filter(c => c.status === "SKIP").length,
  };
  const result = counts.fail > 0 ? "FAIL"
              : counts.warn > 0 ? "PASS-WITH-WARN"
              : "PASS";

  if (asJson) {
    console.log(JSON.stringify({ result, summary: counts, checks }, null, 2));
  } else {
    const now = new Date();
    const stamp = now.toLocaleString("en-GB", { timeZone: "UTC" });
    console.log(`\nEmbervy Doctor — ${stamp} UTC${offline ? " (offline)" : ""}`);
    console.log("═".repeat(58));

    let lastGroup = "";
    for (const c of checks) {
      if (c.group !== lastGroup) {
        console.log(`\n${c.group}`);
        lastGroup = c.group;
      }
      const tag = c.status === "OK" ? "[OK]  "
                : c.status === "WARN" ? "[WARN]"
                : c.status === "SKIP" ? "[SKIP]"
                : "[FAIL]";
      const line = c.id === "claude.channel-signin" && c.status !== "SKIP"
        ? `${c.status === "OK" ? "PASS" : "FAIL"} ${c.label}`
        : `${tag} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`;
      console.log(line);
      if (c.fix && c.status !== "OK" && c.status !== "SKIP") {
        console.log(`       Fix: ${c.fix}`);
      }
    }

    const verdict = result === "FAIL" ? "FAIL"
                  : result === "PASS-WITH-WARN" ? "PASS WITH WARNINGS"
                  : archiveEmpty() ? "HEALTHY — NEWBORN"
                  : "PASS";
    const skipNote = counts.skip > 0 && archiveEmpty()
      ? `, ${counts.skip} waiting for content` : counts.skip > 0 ? `, ${counts.skip} skip` : "";
    console.log(`\nResult: ${verdict} (${counts.pass} checks passed, ${counts.warn} warn, ${counts.fail} fail${skipNote})`);
    if (verdict === "HEALTHY — NEWBORN") {
      console.log("       Nothing is wrong: the archive is still empty and fills up as you talk.");
    }
  }

  const statusFile = readEnv("DOCTOR_STATUS_FILE");
  if (statusFile) {
    try {
      await Bun.write(statusFile, JSON.stringify({
        state: counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "ok",
        summary: counts,
        result,
        checks,
        checked_at: new Date().toISOString(),
      }, null, 2));
    } catch (e: any) {
      console.error(`doctor: failed to write status file: ${e.message}`);
    }
  }

  process.exit(counts.fail > 0 ? 2 : counts.warn > 0 ? 1 : 0);
}

if (process.argv.includes("--startup")) startupReport();
main().catch(err => {
  console.error("doctor crashed:", err);
  process.exit(2);
});
