// Queries model catalogs and supported effort levels without running a model turn.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export type CatalogReadMode = "cached" | "refresh" | "memory";
export const CATALOG_TTL_MS = 6 * 3_600_000;
export type CatalogFailureClass = "auth" | "network" | "http" | "unavailable";
export interface CatalogFailure { kind: CatalogFailureClass; status?: number }
export interface CatalogState {
  updatedAt: number | null;
  ttlMs: number;
  stale: boolean;
  lastFailure: CatalogFailure | null;
}
export type CatalogStates = Partial<Record<string, CatalogState>>;
type FailureReporter = (failure: CatalogFailure) => void;
interface ProbeOptions { timeoutMs?: number; fetchImpl?: typeof fetch; onFailure?: FailureReporter }

// Copy only closed diagnostic fields, never exceptions, response bodies, or credentials.
function safeFailure(failure: CatalogFailure): CatalogFailure {
  const kind = ["auth", "network", "http", "unavailable"].includes(failure.kind) ? failure.kind : "unavailable";
  const status = failure.status;
  return { kind, ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}) };
}

/** Shared by menu and terminal reads so refresh limits cannot be bypassed by switching callers. */
export class ModelCatalogCache {
  private readonly entries = new Map<string, { at: number; models: ModelInfo[] }>();
  private readonly running = new Map<string, Promise<ModelInfo[] | null>>();
  private readonly failures = new Map<string, CatalogFailure>();
  private lastRefreshAt: number | null = null;
  private lastUpdatedAt: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly log: (event: Record<string, unknown>) => void = () => {},
  ) {}

  get updatedAt(): number | null { return this.lastUpdatedAt; }

  readMode(refresh = false): CatalogReadMode {
    if (!refresh) return "cached";
    const at = this.now();
    if (this.lastRefreshAt !== null && at - this.lastRefreshAt < 10_000) return "memory";
    // Reserve before any probe awaits so concurrent callers share the same limit.
    this.lastRefreshAt = at;
    this.log({ type: "head_models_refresh" });
    return "refresh";
  }

  peek(key: string): ModelInfo[] | null { return this.entries.get(key)?.models ?? null; }

  state(key: string): CatalogState {
    const updatedAt = this.entries.get(key)?.at ?? null;
    const failure = this.failures.get(key);
    return { updatedAt, ttlMs: CATALOG_TTL_MS, stale: updatedAt === null || this.now() - updatedAt >= CATALOG_TTL_MS,
      lastFailure: failure ? { ...failure } : null };
  }

  async get(key: string, probe: (fail: FailureReporter) => Promise<ModelInfo[] | null>, mode: CatalogReadMode = "cached"): Promise<ModelInfo[] | null> {
    const hit = this.entries.get(key);
    if (mode === "cached" && hit && this.now() - hit.at < CATALOG_TTL_MS) return hit.models;
    const running = this.running.get(key);
    if (running) return running;
    // A throttled refresh must not turn an expired or missing entry into another probe.
    if (mode === "memory") return hit?.models ?? null;
    let failure: CatalogFailure = { kind: "unavailable" };
    const failed = () => {
      this.failures.set(key, failure);
      return hit?.models ?? null;
    };
    const promise = Promise.resolve().then(() => probe((value) => { failure = safeFailure(value); })).then((models) => {
      if (!models?.length) return failed();
      const at = this.now();
      this.entries.set(key, { at, models });
      this.failures.delete(key);
      this.lastUpdatedAt = at;
      return models;
    }).catch(failed).finally(() => {
      if (this.running.get(key) === promise) this.running.delete(key);
    });
    this.running.set(key, promise);
    return promise;
  }
}

export function modelsFromInitLine(line: string, requestId: string): ModelInfo[] | null {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return null; }
  if (msg?.type !== "control_response") return null;
  const response = msg.response ?? {};
  if (response.request_id && response.request_id !== requestId) return null;
  const inner = response.response ?? response;
  const models = Array.isArray(inner?.models) ? inner.models : null;
  if (!models) return null;
  return models
    .filter((m: any) => typeof m?.value === "string" && m.value)
    .map((m: any) => {
      const levels = Array.isArray(m.supportedEffortLevels)
        ? m.supportedEffortLevels.filter((l: unknown) => typeof l === "string" && /^[a-z][a-z0-9_-]{0,19}$/.test(l))
        : null;
      return {
        id: m.value,
        label: typeof m.displayName === "string" && m.displayName ? m.displayName : m.value,
        ...(typeof m.description === "string" ? { description: m.description } : {}),
        ...(typeof m.resolvedModel === "string" && m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
        ...(typeof m.supportsEffort === "boolean" ? { supportsEffort: m.supportsEffort } : {}),
        ...(levels ? { supportedEffortLevels: levels } : {}),
      };
    });
}

export async function probeClaudeModels(opts: { bin?: string; env: Record<string, string | undefined>; timeoutMs?: number }): Promise<ModelInfo[] | null> {
  const requestId = `models-${Date.now()}`;
  const env: Record<string, string> = {};
  // Catalog probes must not inherit unrelated credentials or provider overrides.
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === "string" && /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|XDG_CONFIG_HOME|XDG_CACHE_HOME|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|HTTPS_PROXY|HTTP_PROXY|NO_PROXY)$/.test(k)) env[k] = v;
  }
  // Subscription login only; a stray API key would make print mode bill the API.
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[k];
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const cwd = mkdtempSync(join(tmpdir(), "brain-models-"));
    proc = Bun.spawn([opts.bin || "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'], {
      cwd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    const running = proc;
    const reader = (running.stdout as ReadableStream<Uint8Array>).getReader();
    // A child may keep stdout open after the process dies, so a timeout must also cancel reading.
    timer = setTimeout(() => {
      try { running.kill("SIGKILL"); } catch { /* gone */ }
      void reader.cancel().catch(() => {});
    }, opts.timeoutMs ?? 20_000);
    (running.stdin as any).write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
    await (running.stdin as any).flush?.();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const models = line ? modelsFromInitLine(line, requestId) : null;
        if (models) return models;
      }
    }
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    try { (proc?.stdin as any)?.end?.(); } catch { /* closed */ }
    try { proc?.kill("SIGTERM"); } catch { /* gone */ }
  }
}


/** Chat models only: xAI lists image and video models in the same catalog. */
const NOT_CHAT = /(^|-)(imagine|image|video|embed|embedding|tts|whisper)(-|$)/i;

export function modelsFromListBody(body: unknown): ModelInfo[] | null {
  const data = (body as any)?.data;
  if (!Array.isArray(data)) return null;
  return data
    .filter((m: any) => typeof m?.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,119}$/.test(m.id) && !NOT_CHAT.test(m.id))
    .map((m: any) => {
      const label = typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 60) : m.id;
      const te = m.think_efforts;
      const levels = te && typeof te === "object" && te.support === true && Array.isArray(te.valid_efforts)
        ? te.valid_efforts.filter((l: unknown) => typeof l === "string" && /^[a-z][a-z0-9_-]{0,19}$/.test(l))
        : "think_efforts" in m ? [] : null;
      return {
        id: m.id,
        label,
        ...(levels ? { supportsEffort: levels.length > 0, ...(levels.length ? { supportedEffortLevels: levels } : {}) } : {}),
      };
    });
}

export function modelsListRequest(head: { name: string; endpoint: string; apiKey: string; unavailable: string | null }): { url: string; token: string } | null {
  if (head.unavailable || !head.apiKey) return null;
  if (head.name === "grok" && /\/chat\/completions$/.test(head.endpoint)) return { url: head.endpoint.replace(/\/chat\/completions$/, "/models"), token: head.apiKey };
  if (head.name === "kimi" && /^https:\/\//.test(head.endpoint)) return { url: `${head.endpoint.replace(/\/+$/, "")}/v1/models`, token: head.apiKey };
  return null;
}

async function probeHttpModels(url: string, headers: Record<string, string>, parse: (body: unknown) => ModelInfo[] | null, opts: ProbeOptions): Promise<ModelInfo[] | null> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  } catch {
    opts.onFailure?.({ kind: "network" });
    return null;
  }
  if (!res.ok) {
    opts.onFailure?.({ kind: res.status === 401 || res.status === 403 ? "auth" : "http", status: res.status });
    return null;
  }
  try {
    const models = parse(await res.json());
    if (models?.length) return models;
  } catch { /* Invalid catalog bodies are not diagnostics. */ }
  opts.onFailure?.({ kind: "unavailable", status: res.status });
  return null;
}

export async function probeListModels(request: { url: string; token: string }, opts: ProbeOptions = {}): Promise<ModelInfo[] | null> {
  return probeHttpModels(request.url, { authorization: `Bearer ${request.token}`, accept: "application/json" }, modelsFromListBody, opts);
}

// A low client version silently hides newer models; the high value avoids that filter.
// The adapter owns token rotation, so catalog probes never refresh credentials.
export const GPT_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=99.0.0";

export function modelsFromGptBody(body: unknown): ModelInfo[] | null {
  const models = (body as any)?.models;
  if (!Array.isArray(models)) return null;
  return models
    .filter((m: any) => m?.visibility === "list" && typeof m.slug === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(m.slug))
    .map((m: any) => {
      const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels
        .map((v: any) => typeof v === "string" ? v : v?.effort)
        .filter((v: unknown) => typeof v === "string" && /^[a-z][a-z0-9_-]{0,19}$/.test(v)) : null;
      return {
        id: m.slug,
        label: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 60).replace(/-(?=[A-Za-z][^-]*$)/, " ") : m.slug,
        ...(levels ? { supportsEffort: levels.length > 0, supportedEffortLevels: levels } : {}),
      };
    });
}

export async function probeGptModels(authFile: string, opts: ProbeOptions = {}): Promise<ModelInfo[] | null> {
  let tok: any;
  try {
    const raw = JSON.parse(readFileSync(authFile, "utf8"));
    tok = raw?.tokens ?? raw;
    if (typeof tok?.access_token !== "string" || !tok.access_token || typeof tok?.account_id !== "string" || !tok.account_id) throw new Error();
  } catch {
    opts.onFailure?.({ kind: "auth" });
    return null;
  }
  return probeHttpModels(GPT_MODELS_URL, {
    authorization: `Bearer ${tok.access_token}`, "chatgpt-account-id": tok.account_id,
    "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs", accept: "application/json",
  }, modelsFromGptBody, opts);
}
