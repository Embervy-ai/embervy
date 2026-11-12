// Validates model switches and coordinates adapter startup with durable selection.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validAdapterCacheKey, gptAdapterPort, HEAD_NAMES, resolveHead, resolveHeadChoice, type HeadName, type HeadSpec, type Transport } from "./heads";
import { MAX_LIVES_READ } from "./wake-bridge";

import { tr } from "./texts";
type Env = Record<string, string | undefined>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const MOVE_USAGE = "/move <head> [model] [bridge=N] [window=K] [effort=X]";
export const MAX_BRIDGE_SESSIONS = MAX_LIVES_READ;

export interface MoveRequest {
  name: HeadName;
  model?: string;
  bridgeSessions?: number;
  contextWindow?: number;
  effort?: string;
}

export interface HeadState {
  version: 1;
  head: HeadName;
  model: string;
  window: number;
  transport: Transport;
}

const knownHead = (name: unknown): name is HeadName => typeof name === "string" && (HEAD_NAMES as readonly string[]).includes(name);
const validModel = (model: unknown): model is string => typeof model === "string" && model.length > 0 && model.length <= 256
  && !/^[\-]/.test(model) && !/[\s\x00-\x1f\x7f=]/u.test(model);
const validWindow = (window: unknown): window is number => typeof window === "number" && Number.isSafeInteger(window) && window > 0;

export function parseWindow(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : match[2].toLowerCase() === "k" ? 1000 : 1);
  return validWindow(value) ? value : null;
}

export function parseMove(argument: string): Result<MoveRequest> {
  const [raw, ...parts] = argument.trim().split(/\s+/);
  const name = raw?.toLowerCase();
  if (!knownHead(name)) return { ok: false, error: tr`${tr(MOVE_USAGE)} — known heads: ${HEAD_NAMES.join(", ")}` };
  const request: MoveRequest = { name };
  for (const part of parts) {
    if (part.startsWith("bridge=")) {
      const value = part.slice(7);
      if (request.bridgeSessions !== undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_BRIDGE_SESSIONS) {
        return { ok: false, error: tr`bridge=N: specify an integer from 1 to ${MAX_BRIDGE_SESSIONS} once` };
      }
      request.bridgeSessions = Number(value);
    } else if (part.startsWith("window=")) {
      const value = parseWindow(part.slice(7));
      if (request.contextWindow !== undefined || value === null) return { ok: false, error: tr("window=K: specify a positive token window once, e.g. 250k, 1m or 500000") };
      request.contextWindow = value;
    } else if (part.startsWith("effort=")) {
      if (request.effort !== undefined || !/^[a-z][a-z0-9_-]{0,19}$/.test(part.slice(7))) return { ok: false, error: tr("effort=X: specify a valid effort level once") };
      request.effort = part.slice(7);
    } else if (part.includes("=") || request.model !== undefined || !validModel(part)) {
      return { ok: false, error: tr`invalid or extra argument — ${tr(MOVE_USAGE)}` };
    } else request.model = part;
  }
  return { ok: true, value: request };
}

// Unknown names and schemas must not silently select a different provider.
export function validateHeadState(value: unknown): Result<HeadState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "head state is not an object" };
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return { ok: false, error: "unknown head state version" };
  if (!knownHead(v.head)) return { ok: false, error: "unknown head in state file" };
  if (!validModel(v.model) || !validWindow(v.window)) return { ok: false, error: "invalid model or window in head state" };
  const expected = ["claude", "glm", "kimi"].includes(v.head) ? "pipe" : "api";
  if ((v.transport !== "pipe" && v.transport !== "api") || (v.head !== "gpt" && v.transport !== expected)) {
    return { ok: false, error: "invalid transport in head state" };
  }
  return { ok: true, value: { version: 1, head: v.head, model: v.model, window: v.window, transport: v.transport } };
}

export function headStateFor(head: HeadSpec): HeadState {
  const checked = validateHeadState({ version: 1, head: head.name, model: head.model, window: head.contextWindow, transport: head.transport });
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

export function prepareMove(argument: string, env: Env): Result<{ target: HeadSpec; state: HeadState; bridgeSessions?: number; effort?: string }> {
  const parsed = parseMove(argument);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const target = resolveHeadChoice(request.name, env, request);
  if (target.unavailable) return { ok: false, error: `head ${target.name}: ${target.unavailable}` };
  if (!env.BRAIN_RAG_URL?.trim() || !env.BRAIN_RAG_AUTH_TOKEN?.trim()) return { ok: false, error: tr("/move requires complete RAG configuration (BRAIN_RAG_URL and BRAIN_RAG_AUTH_TOKEN)") };
  try {
    return { ok: true, value: { target, state: headStateFor(target), bridgeSessions: request.bridgeSessions, ...(request.effort !== undefined ? { effort: request.effort } : {}) } };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}

export interface AdapterPaths { home: string; brainHome: string; logDir: string; bun?: string }
export interface AdapterStartPlan {
  unit: string;
  launchId: string;
  /** Captured from systemd at our start; never trusted from unit metadata. */
  invocation?: string;
  binary: string;
  script: string;
  cwd: string;
  logFile: string;
  env: { [key: string]: string; ADAPTER_PORT: string; ADAPTER_MODEL: string; ADAPTER_CACHE_KEY: string; CHATGPT_AUTH_FILE: string };
}
export interface AdapterContract { origin: string; port: number; identity: string; model: string }
export type AdapterProbe = { kind: "health"; httpOk: boolean; data: unknown } | { kind: "absent" } | { kind: "unknown"; reason: string };
export type AdapterAssessment = "ready" | "owned" | "foreign" | "absent" | "unknown";
export const adapterIdentity = (cacheKey: string): string => createHash("sha256").update(`gpt-adapter:${cacheKey}`).digest("hex").slice(0, 16);
export function adapterCacheKey(env: Env, _brainHome?: string): string {
  const key = env.BRAIN_GPT_CACHE_KEY;
  if (!validAdapterCacheKey(key)) throw new Error(tr("unavailable: BRAIN_GPT_CACHE_KEY is missing or invalid (set a resident-unique key; ASCII A-Z a-z 0-9 . _ -, 1–128 characters)"));
  return key;
}
export function adapterUnitName(identity: string): string {
  if (!/^[0-9a-f]{16}$/.test(identity)) throw new Error("invalid adapter identity");
  return `brain-gpt-adapter-${identity}.service`;
}
export interface AdapterUnitSnapshot {
  plan: AdapterStartPlan;
  invocation: string;
  active: boolean;
  ownsPort: boolean;
}
export interface HeadStateCommit {
  finalize?: () => void | Promise<void>;
  commit: () => void | Promise<void>;
  rollback: () => void | Promise<void>;
}

export function gptAdapterOrigin(head: HeadSpec): string {
  const url = new URL(head.endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("GPT adapter endpoint must be local http://127.0.0.1:<port>");
  return url.origin;
}
export function gptAdapterContract(head: HeadSpec, env: Env, paths: AdapterPaths): AdapterContract {
  const key = adapterCacheKey(env); 
  const port = Number(gptAdapterPort(env));
  const origin = gptAdapterOrigin(head);
  if (Number(new URL(origin).port || 80) !== port || !validModel(head.model)) throw new Error("GPT adapter endpoint/model does not match configuration");
  return { origin, port, identity: adapterIdentity(key), model: head.model };
}

// A port or model name alone cannot prove ownership of the process.
export function assessAdapter(probe: AdapterProbe, expected: AdapterContract): AdapterAssessment {
  if (probe.kind !== "health") return probe.kind;
  const h = probe.data as any;
  if (!h || h.backend !== "chatgpt-oauth" || h.identity !== expected.identity || h.port !== expected.port) return "foreign";
  return probe.httpOk && h.ok === true && h.model === expected.model ? "ready" : "owned";
}

export function adapterKnobs(env: Env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => /^ADAPTER_[A-Z0-9_]+$/.test(key) && value !== undefined && value.trim() !== "")) as Record<string, string>;
}

export function adapterProfileMismatches(actual: Env, desired: Env): string[] {
  const a: Env = { ...adapterKnobs(actual), CHATGPT_AUTH_FILE: actual.CHATGPT_AUTH_FILE };
  const b: Env = { ...adapterKnobs(desired), CHATGPT_AUTH_FILE: desired.CHATGPT_AUTH_FILE };
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]).sort();
}

export function adapterKnobMismatches(probe: AdapterProbe, plan: AdapterStartPlan): string[] {
  const h = probe.kind === "health" && probe.data && typeof probe.data === "object" ? probe.data as Record<string, unknown> : {};
  const e = adapterKnobs(plan.env);
  const expected: Record<string, unknown> = {
    effort: e.ADAPTER_EFFORT ?? null,
    verbosity: e.ADAPTER_VERBOSITY ?? null,
    reasoning_context: e.ADAPTER_REASONING_CONTEXT ?? null,
    reasoning_replay: e.ADAPTER_REASONING_REPLAY !== "0",
    web_search: e.ADAPTER_WEB_SEARCH === "1",
    native_web_search: e.ADAPTER_NATIVE_WEB_SEARCH === "1",
    turn_state_recovery: e.ADAPTER_TURN_STATE_RECOVERY === "1" ? {} : null,
  };
  return Object.entries(expected).filter(([field, value]) => {
    const actual = h[field];
    return field === "turn_state_recovery" && value !== null
      ? !(actual !== null && typeof actual === "object" && !Array.isArray(actual))
      : actual !== value;
  }).map(([field]) => field);
}

// The adapter ignores request model names, so switching requires changing its startup model.
export function gptAdapterStartPlan(head: HeadSpec, env: Env, paths: AdapterPaths): AdapterStartPlan {
  const expected = gptAdapterContract(head, env, paths);
  const script = env.BRAIN_GPT_ADAPTER?.trim();
  if (!script) throw new Error(tr("BRAIN_GPT_ADAPTER is not set (path to chatgpt-oauth adapter)"));
  const expand = (path: string) => path.startsWith("~/") ? join(paths.home, path.slice(2)) : path;
  const cwd = resolve(paths.brainHome);
  const knobs = adapterKnobs(env);
  if (head.transport === "pipe" && head.effort !== undefined) {
    if (head.effort === null) delete knobs.ADAPTER_EFFORT;
    else knobs.ADAPTER_EFFORT = head.effort === "max" ? "xhigh" : head.effort;
  }
  return {
    unit: adapterUnitName(expected.identity), launchId: randomUUID(), binary: paths.bun || "bun",
    script: resolve(cwd, expand(script)), cwd, logFile: resolve(paths.logDir, "chatgpt-oauth-adapter.log"),
    env: {
      ...knobs,
      ADAPTER_PORT: String(expected.port), ADAPTER_MODEL: expected.model,
      ADAPTER_CACHE_KEY: adapterCacheKey(env, cwd),
      CHATGPT_AUTH_FILE: expand(env.CHATGPT_AUTH_FILE?.trim() || join(paths.home, ".codex", "auth.json")),
    },
  };
}

export function adapterUnitArgs(plan: AdapterStartPlan, home: string): string[] {
  return ["--unit=" + plan.unit, "--collect", "--quiet", "--service-type=exec",
    "--description=Brain GPT adapter " + adapterIdentity(plan.env.ADAPTER_CACHE_KEY),
    "--property=Restart=no", "--property=KillMode=control-group", "--property=TimeoutStopSec=2s", "--property=SendSIGKILL=yes",
    "--property=WorkingDirectory=" + plan.cwd, "--property=StandardOutput=append:" + plan.logFile, "--property=StandardError=append:" + plan.logFile,
    "--setenv=HOME=" + home,
    ...Object.entries(plan.env).map(([key, value]) => `--setenv=${key}=${value}`),
    "--setenv=BRAIN_GPT_UNIT_PLAN=" + Buffer.from(JSON.stringify(plan)).toString("base64"),
    "--", plan.binary, plan.script];
}
export function adapterPlanFromUnit(environment: string, expected: AdapterContract): AdapterStartPlan {
  const encoded = /(?:^|\s)"?BRAIN_GPT_UNIT_PLAN=([A-Za-z0-9+/=]+)"?(?=\s|$)/.exec(environment)?.[1];
  if (!encoded) throw new Error(tr("Unit has no Brain snapshot — no takeover"));
  const plan = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as AdapterStartPlan;
  if (plan.unit !== adapterUnitName(expected.identity) || !plan.launchId || !validModel(plan.env?.ADAPTER_MODEL)
    || !validAdapterCacheKey(plan.env?.ADAPTER_CACHE_KEY) || adapterIdentity(plan.env.ADAPTER_CACHE_KEY) !== expected.identity
    || plan.env.ADAPTER_PORT !== String(expected.port)
    || [plan.script, plan.binary, plan.cwd, plan.logFile, plan.env.CHATGPT_AUTH_FILE].some((s) => typeof s !== "string" || !s || /[\x00-\x1f]/.test(s))) {
    throw new Error(tr("Unit snapshot does not match resident/port — no takeover"));
  }
  return plan;
}

export interface AdapterStartupIO {
  probe: (origin: string, timeoutMs: number) => Promise<AdapterProbe>;
  systemd: () => Promise<void>;
  inspect: (expected: AdapterContract) => Promise<AdapterUnitSnapshot | null>;
  start: (plan: AdapterStartPlan) => Promise<void>;
  validateStart?: (plan: AdapterStartPlan) => Promise<void>;
  report?: (message: string) => void;
  // Launch ownership prevents stopping a replacement process, even when health checks fail.
  stop: (plan: AdapterStartPlan) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}
export type AdapterReadyResult = Result<{ started: boolean }>;
const foreignAdapter = "foreign or old GPT adapter: backend=chatgpt-oauth, own identity and port not proven — no intervention";
export const LEGACY_ADAPTER = "Adapter is not running in its own systemd unit — no takeover";

// The caller must hold the gate through persistence and rollback to keep adapter and selection consistent.
export async function ensureGptAdapterReady(head: HeadSpec, env: Env, paths: AdapterPaths, io: AdapterStartupIO, state?: HeadStateCommit): Promise<AdapterReadyResult> {
  if (head.name !== "gpt") {
    try { await state?.finalize?.(); await state?.commit(); return { ok: true, value: { started: false } }; }
    catch (error) {
      try { await state?.rollback(); }
      catch (rollback) { return { ok: false, error: tr`${String(error)}; WARNING: state/finalizer rollback failed: ${String(rollback)}` }; }
      return { ok: false, error: tr`${String(error)}; state/transition rolled back` };
    }
  }
  let previous: AdapterUnitSnapshot | null = null;
  let candidate: AdapterStartPlan | undefined;
  let changed = false, attempted = false, committed = false;
  let expected: AdapterContract | undefined;
  let proofDetail = "";
  const proof = async (contract: AdapterContract, plan?: AdapterStartPlan): Promise<boolean> => {
    const probe = await io.probe(contract.origin, 2000);
    const observed = assessAdapter(probe, contract);
    if (observed === "foreign") throw new Error(tr(foreignAdapter));
    if (observed !== "ready") return false;
    const unit = await io.inspect(contract);
    if (!unit?.active || !unit.ownsPort || unit.plan.env.ADAPTER_MODEL !== contract.model
      || !unit.plan.invocation || unit.invocation !== unit.plan.invocation
      || (plan && (unit.plan.launchId !== plan.launchId || unit.invocation !== plan.invocation))) return false;
    const fields = adapterKnobMismatches(probe, unit.plan);
    proofDetail = fields.length ? tr`; health fields do not match unit plan (different/missing): ${fields.join(", ")}` : "";
    return fields.length === 0;
  };
  const waitReady = async (contract: AdapterContract, plan: AdapterStartPlan): Promise<void> => {
    for (let n = 0; n < 10; n++) {
      if (await proof(contract, plan)) return;
      const unit = await io.inspect(contract);
      if (!unit || !unit.active) break;
      if (n < 9) await io.sleep(1000);
    }
    throw new Error(tr`Unit not ready: ok/backend/port/identity/model and unit ownership must match${proofDetail}`);
  };
  try {
    expected = gptAdapterContract(head, env, paths); 
    await io.systemd();
    const first = await io.probe(expected.origin, 3000);
    const status = assessAdapter(first, expected);
    if (status === "foreign") throw new Error(tr(foreignAdapter));
    if (status === "unknown") throw new Error(tr("GPT adapter cannot be identified/reached — no intervention"));
    previous = await io.inspect(expected);
    if (previous && (!previous.plan.invocation || previous.invocation !== previous.plan.invocation)) throw new Error(tr("Unit invocation replaced or unproven — no intervention"));
    if ((status === "ready" || status === "owned") && (!previous?.active || !previous.ownsPort)) throw new Error(tr(LEGACY_ADAPTER));
    if (first.kind === "health" && previous && (first.data as any).model !== previous.plan.env.ADAPTER_MODEL) throw new Error(tr("Unit snapshot and health model disagree — no intervention"));
    const fields = previous && first.kind === "health" ? adapterKnobMismatches(first, previous.plan) : [];
    proofDetail = fields.length ? tr`; health fields do not match unit plan (different/missing): ${fields.join(", ")}` : "";
    if (fields.length) io.report?.(tr`GPT adapter not ready${proofDetail}; restarting own unit`);
    const desired = gptAdapterStartPlan(head, { ...env, BRAIN_GPT_ADAPTER: env.BRAIN_GPT_ADAPTER?.trim() || previous?.plan.script }, paths);
    const profile = previous ? adapterProfileMismatches(previous.plan.env, desired.env) : [];
    if (profile.length) io.report?.(tr`GPT adapter: desired profile differs from unit plan: ${profile.join(", ")}; replacing own unit`);
    if (status !== "ready" || fields.length || profile.length) {
      candidate = gptAdapterStartPlan(head, env, paths);
      await io.validateStart?.(candidate);
      if (previous) { changed = true; await io.stop(previous.plan); }
      if ((await io.probe(expected.origin, 2000)).kind !== "absent") throw new Error(tr("GPT port is not free — no start"));
      changed = true; attempted = true;
      await io.start(candidate);
      await waitReady(expected, candidate);
    }
    if (!await proof(expected, candidate ?? previous?.plan)) throw new Error(tr`GPT proof lost before finalization${proofDetail}`);
    if (state) { committed = true; await state.finalize?.(); await state.commit(); }
    // The adapter can die during commit; do not retain a selection whose startup failed.
    if (!await proof(expected, candidate ?? previous?.plan)) throw new Error(tr`GPT proof lost after state commit${proofDetail}`);
    return { ok: true, value: { started: attempted } };
  } catch (error) {
    const failures: string[] = [];
    let restored = false;
    if (changed && expected) {
      try {
        if (attempted && candidate) await io.stop(candidate); 
        if (previous) { 
          const oldContract = { ...expected, model: previous.plan.env.ADAPTER_MODEL };
          if (!await proof(oldContract, previous.plan)) {
            const current = await io.inspect(oldContract);
            if (current) await io.stop(previous.plan); 
            if ((await io.probe(oldContract.origin, 2000)).kind !== "absent") throw new Error(tr("Port not free during rollback"));
            const old = { ...previous.plan, launchId: randomUUID(), invocation: undefined };
            try { await io.start(old); await waitReady(oldContract, old); }
            catch (restoreError) {
              try { await io.stop(old); } catch (cleanup) { failures.push(tr`Rollback unit not cleaned up: ${(cleanup as Error).message}`); }
              throw restoreError;
            }
          }
          restored = true;
        }
      } catch (rollback) { failures.push(tr`Adapter rollback failed: ${(rollback as Error).message}`); }
    }
    if (committed && state) {
      try { await state.rollback(); }
      catch (rollback) { failures.push(tr`State rollback failed: ${(rollback as Error).message}`); }
    }
    const detail = failures.length ? tr`; WARNING: ${failures.join("; ")} — adapter/state not jointly confirmed`
      : restored ? tr("; rollback: previous adapter restored and verified, state unchanged/restored")
      : tr(changed ? "; own new unit cleaned up; state unchanged/restored" : "; no adapter intervention");
    return { ok: false, error: `GPT-Adapter: ${(error as Error).message}${detail}` };
  }
}

export function headStateCommit(file: string, value: HeadState): HeadStateCommit {
  return { commit: () => saveHeadState(file, value), rollback: snapshotFileBytes(file) };
}

export function snapshotFileBytes(file: string): () => void {
  let old: Buffer | null;
  try { old = readFileSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; old = null; }
  return () => {
      if (old === null) { rmSync(file, { force: true }); return; }
      const tmp = `${file}.rollback-${randomUUID()}`;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(tmp, old, { mode: 0o600, flag: "wx" }); renameSync(tmp, file);
      } finally { rmSync(tmp, { force: true }); }
  };
}

// Retain recovery results so late failures from one generation cannot trigger repeated starts.
export function createAdapterGate() {
  let tail: Promise<unknown> = Promise.resolve();
  let epoch = 0;
  const active = new Map<string, Promise<AdapterReadyResult>>();
  const recovered = new Map<number, Promise<AdapterReadyResult>>();
  const run = (key: string, operation: () => Promise<AdapterReadyResult>): Promise<AdapterReadyResult> => {
    const pending = active.get(key);
    if (pending) return pending;
    const task = tail.then(operation);
    tail = task.catch(() => {});
    active.set(key, task);
    void task.finally(() => { if (active.get(key) === task) active.delete(key); }).catch(() => {});
    return task;
  };
  return {
    epoch: () => epoch,
    run,
    recover: (generation: number, operation: () => Promise<AdapterReadyResult>): Promise<AdapterReadyResult> => {
      const previous = recovered.get(generation);
      if (previous) return previous;
      if (generation !== epoch) return Promise.resolve({ ok: false, error: "GPT recovery generation is stale — no further restart" });
      const task = run(`recovery:${generation}`, operation);
      recovered.set(generation, task);
      // Requests arriving during recovery share its epoch to avoid queuing another attempt.
      void task.finally(() => { if (epoch === generation) epoch++; }).catch(() => {});
      if (recovered.size > 64) recovered.delete(recovered.keys().next().value!);
      return task;
    },
  };
}

// The CLI exposes some API errors as text rather than HTTP status fields.
export function isGptConnectionFailure(error: unknown): boolean {
  const e = error as any;
  if (Number.isInteger(e?.status)) return e.status >= 500 && e.status <= 599;
  const text = String(e?.code ?? "") + " " + String(e?.message ?? error);
  if (/(?:HTTP|API Error:)\s*4\d\d\b/i.test(text)) return false;
  return /ECONNREFUSED|ECONNRESET|ECONNABORTED|ConnectionRefused|ConnectionClosed|EPIPE|socket[^\n]*(?:closed|hang up)|connection (?:closed|refused|reset|error)|unable to connect|fetch failed|(?:HTTP|API Error:)\s*5\d\d\b/i.test(text);
}

export interface LoadedHeadState {
  head: HeadSpec;
  source: "state" | "environment";
  status: "loaded" | "missing" | "invalid" | "unreadable";
  error?: string;
}

// Keep an unavailable selection rather than silently running another provider.
export function loadHeadState(file: string, env: Env): LoadedHeadState {
  const fallback = (status: LoadedHeadState["status"], error?: string): LoadedHeadState => ({ head: resolveHead(env.BRAIN_HEAD ?? "api", env), source: "environment", status, ...(error ? { error } : {}) });
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? fallback("missing") : fallback("unreadable", "cannot read head state file"); }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return fallback("invalid", "invalid head state JSON"); }
  const checked = validateHeadState(value);
  if (!checked.ok) return fallback("invalid", checked.error);
  const state = checked.value;
  return { head: resolveHeadChoice(state.head, env, { model: state.model, contextWindow: state.window, transport: state.transport }), source: "state", status: "loaded" };
}

// Propagate write failures so callers can refuse a switch before changing the running model.
export function saveHeadState(file: string, value: HeadState): void {
  const checked = validateHeadState(value);
  if (!checked.ok) throw new Error(checked.error);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(checked.value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}
