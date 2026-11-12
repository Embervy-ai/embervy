#!/usr/bin/env bun
/**
 * Serves OpenAI and Anthropic clients through the ChatGPT subscription API.
 * Handles OAuth refresh, request translation and cache continuity.
 */

import { readFileSync } from "fs";
import { chatgptModels, chatgptRoute, ChatGptRouteError, officialRouteError, OFFICIAL_TOKEN, OFFICIAL_RESOURCE, OFFICIAL_RESPONSES, readOfficialResponse, type ChatGptTokens } from "../scripts/chatgpt-signin";
import { refreshStoredCredential, writePrivateJson } from "../scripts/credential-store";
import { homedir } from "os";
import { createHash } from "crypto";

const PORT = parseInt(process.env.ADAPTER_PORT ?? "3041", 10);
const AUTH_FILE = process.env.CHATGPT_AUTH_FILE ?? `${homedir()}/.codex/auth.json`;
const MODEL = process.env.ADAPTER_MODEL ?? "gpt-5.6-terra";
const CACHE_KEY = process.env.ADAPTER_CACHE_KEY ?? `embervy-${MODEL}`;
const IDENTITY = createHash("sha256").update(`gpt-adapter:${CACHE_KEY}`).digest("hex").slice(0, 16);
function servedModel(resp: any): string {
  const m = typeof resp?.model === "string" ? resp.model.trim() : "";
  return m || MODEL;
}
const EFFORT = process.env.ADAPTER_EFFORT || "";
const VERBOSITY = process.env.ADAPTER_VERBOSITY || "";
const REASONING_CONTEXT = process.env.ADAPTER_REASONING_CONTEXT || "";
const BACKEND = "https://chatgpt.com/backend-api/codex/responses";

function applyReasoningKnobs(body: any, effort: string): void {
  if (effort) body.reasoning = { ...(body.reasoning ?? {}), effort };
  if (REASONING_CONTEXT) body.reasoning = { ...(body.reasoning ?? {}), context: REASONING_CONTEXT };
  if (VERBOSITY) body.text = { ...(body.text ?? {}), verbosity: VERBOSITY };
}
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

function loadTokens(authFile = AUTH_FILE): ChatGptTokens {
  const a = JSON.parse(readFileSync(authFile, "utf-8"));
  return a.tokens;
}

export async function refreshTokens(rejectedAccessToken: string, authFile = AUTH_FILE): Promise<void> {
  if (loadTokens(authFile).client_id) return refreshOfficialTokens(rejectedAccessToken, authFile);
  return refreshStoredCredential(AUTH_FILE, async () => {
    const a = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    if (a.tokens.access_token !== rejectedAccessToken) return;
    // Shared refresh tokens rotate; reusing an old token can trigger reuse detection.
    const lastRefresh = Date.parse(a.last_refresh ?? "");
    if (Number.isFinite(lastRefresh) && Date.now() - lastRefresh < 60_000) return;
    const signal = AbortSignal.timeout(30_000);
    let res: Response;
    let t: any;
    try {
      res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: a.tokens.refresh_token,
          scope: "openid profile email",
        }),
        signal,
      });
      if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status} ${await res.text()}`);
      t = await res.json();
    } catch (cause) {
      if (signal.aborted) throw new Error("token refresh timed out after 30000 ms; retry the request", { cause });
      throw cause;
    }
    a.tokens.access_token = t.access_token;
    if (t.refresh_token) a.tokens.refresh_token = t.refresh_token;
    a.last_refresh = new Date().toISOString();
    await writePrivateJson(AUTH_FILE, a);
    console.log(`[adapter] OAuth token refreshed (${a.last_refresh})`);
  });
}


async function refreshOfficialTokens(rejectedAccessToken: string, authFile: string): Promise<void> {
  return refreshStoredCredential(authFile, async () => {
    const a = JSON.parse(readFileSync(authFile, "utf8"));
    if (a.tokens.access_token !== rejectedAccessToken) return;
    if (!a.tokens.client_id || a.tokens.client_id === "dynamic_agent_client") throw new ChatGptRouteError(401, "invalid_client");
    if (!a.tokens.refresh_token) throw new ChatGptRouteError(401, "sign_in_required");
    const res = await fetch(OFFICIAL_TOKEN, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: a.tokens.client_id,
        refresh_token: a.tokens.refresh_token, resource: OFFICIAL_RESOURCE }).toString(),
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const t: any = await res.json().catch(() => null);
    if (!res.ok) {
      const code = typeof t?.error === "string" ? t.error : t?.error?.code;
      if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(code)) {
        a.tokens.access_token = ""; a.tokens.refresh_token = ""; a.tokens.id_token = "";
        await writePrivateJson(authFile, a);
        throw new ChatGptRouteError(401, "sign_in_required");
      }
      throw officialRouteError(res.status, { error: { code } });
    }
    if (!t?.access_token || !t.refresh_token || !Number.isFinite(t.expires_in) || t.expires_in <= 0 || (t.scope !== undefined && typeof t.scope !== "string")) throw new ChatGptRouteError(502, "invalid_refresh_response");
    const scopes = t.scope === undefined ? a.tokens.scopes : t.scope.split(/\s+/).filter(Boolean);
    a.tokens = { ...a.tokens, access_token: t.access_token, refresh_token: t.refresh_token,
      id_token: t.id_token || a.tokens.id_token, expires_in: t.expires_in, expires_at: Date.now() + t.expires_in * 1000,
      earliest_refresh_at: t.earliest_refresh_at, scopes, token_type: t.token_type || a.tokens.token_type,
      saved_at: new Date().toISOString(), plan_usage_enabled: scopes?.includes("chatgpt.tokens.use.direct") === true };
    a.last_refresh = a.tokens.saved_at;
    await writePrivateJson(authFile, a);
  });
}

export function chatgptRouteHealth(tokens: Pick<ChatGptTokens, "client_id">, setting = process.env.CHATGPT_ROUTE) {
  return { route: tokens.client_id ? "official" : "codex",
    ...(chatgptRoute(setting) === "official" && !tokens.client_id ? { notice: "signed in the old way; sign in again to use the official route" } : {}) };
}
function routeHealth() {
  try { return chatgptRouteHealth(loadTokens()); } catch { return { route: "unconfigured" }; }
}

const officialCalls = new Map<string, any>();
export function officialRequest(body: any, clientId = ""): any {
  // Only fields this route accepts reach it; the preview's unsupported fields never do.
  const input = (body.input ?? []).map((item: any) => {
    if (item.type === "message" && item.role === "system") return { ...item, role: "developer" };
    if (item.type !== "function_call") return item;
    return officialCalls.get(`${clientId}:${item.call_id}`) ?? { ...item, namespace: item.namespace || "house" };
  });
  const functions = (body.tools ?? []).filter((t: any) => t.type === "function" || t.type === "custom").map(({ strict, defer_loading, ...t }: any) => t);
  const tools = (body.tools ?? []).filter((t: any) => t.type === "web_search" || t.type === "namespace");
  if (functions.length) tools.push({ type: "namespace", name: "house", description: "Tools executed by the house.", tools: functions });
  // Not on the preview's unsupported list and accepted by the route: effort, encrypted reasoning, verbosity, tool control, cache key.
  const kept = Object.fromEntries(["reasoning", "include", "text", "tool_choice", "parallel_tool_calls", "prompt_cache_key"]
    .filter(k => body[k] !== undefined).map(k => [k, body[k]]));
  return { model: body.model, ...(body.instructions !== undefined ? { instructions: body.instructions } : {}), input,
    ...(tools.length ? { tools } : {}), ...kept, store: false, stream: true };
}

export async function adapterModels(authFile = AUTH_FILE): Promise<any[]> {
  const tokens = loadTokens(authFile);
  if (!tokens.client_id) return [{ id: MODEL, object: "model", owned_by: "openai" }];
  if (tokens.expires_at && tokens.expires_at <= Date.now() + 30_000) await refreshTokens(tokens.access_token, authFile);
  return (await chatgptModels(loadTokens(authFile).access_token)).map(m => ({ id: m.slug, object: "model", owned_by: "openai", display_name: m.display_name }));
}

// The turn-state token keeps each conversation on its warm backend route.
const turnState = new Map<string, string>();
let quota: { used_percent: number | null; reset_at: string | null; window_minutes: number | null; plan: string | null; seen_at: string | null } =
  { used_percent: null, reset_at: null, window_minutes: null, plan: null, seen_at: null };
function readQuota(res: Response): void {
  const used = res.headers.get("x-codex-primary-used-percent");
  if (used === null) return;
  const resetAt = res.headers.get("x-codex-primary-reset-at");
  quota = {
    used_percent: Number(used),
    reset_at: resetAt ? new Date(Number(resetAt) * 1000).toISOString() : null,
    window_minutes: Number(res.headers.get("x-codex-primary-window-minutes") ?? "") || null,
    plan: res.headers.get("x-codex-plan-type"),
    seen_at: new Date().toISOString(),
  };
}

export async function callBackend(body: any, sessionId = "", retry = true, authFile = AUTH_FILE): Promise<any> {
  let tok = loadTokens(authFile);
  if (tok.client_id) {
    if (tok.client_id === "dynamic_agent_client") throw new ChatGptRouteError(401, "invalid_client");
    if (tok.expires_at && tok.expires_at <= Date.now() + 30_000) { await refreshTokens(tok.access_token, authFile); tok = loadTokens(authFile); }
    if (!tok.access_token) throw new ChatGptRouteError(401, "sign_in_required");
    if (!tok.scopes?.includes("chatgpt.tokens.use.direct")) throw new ChatGptRouteError(403, "chatpass_v2_scope_not_authorized");
    const res = await fetch(OFFICIAL_RESPONSES, {
      // The session headers keep a conversation on the machine that holds its prompt cache; without them almost every turn is cold.
      method: "POST", headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json",
        ...(sessionId ? { "session-id": sessionId, "thread-id": sessionId } : {}) },
      body: JSON.stringify(officialRequest(body, tok.client_id)), redirect: "error",
    });
    if (res.status === 401 && retry) {
      await res.body?.cancel();
      await refreshTokens(tok.access_token, authFile);
      return callBackend(body, sessionId, false, authFile);
    }
    const completed = await readOfficialResponse(res);
    for (const item of completed.output ?? []) if (item.type === "function_call") {
      officialCalls.set(`${tok.client_id}:${item.call_id}`, item);
      if (officialCalls.size > 10000) officialCalls.delete(officialCalls.keys().next().value!);
    }
    return completed;
  }
  const sticky = sessionId ? turnState.get(sessionId) : undefined;
  const res = await fetch(BACKEND, {
    method: "POST",
    headers: {
      ...(sticky ? { "x-codex-turn-state": sticky } : {}),
      Authorization: `Bearer ${tok.access_token}`,
      "chatgpt-account-id": tok.account_id,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      accept: "text/event-stream",
      // Keep session-id and thread-id stable per conversation because cache
      // affinity depends on session headers, not prompt_cache_key alone.
      ...(sessionId ? { "session-id": sessionId, "thread-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const nextState = res.headers.get("x-codex-turn-state");
  if (nextState && sessionId) turnState.set(sessionId, nextState);
  readQuota(res);
  if (res.status === 401 && retry) {
    await refreshTokens(tok.access_token);
    return callBackend(body, sessionId, false);
  }
  if (!res.ok) throw new Error(`backend HTTP ${res.status}: ${await res.text()}`);

  // This backend sends finished items separately from response.completed's empty output.
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let completed: any = null;
  const items: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const e = JSON.parse(line.slice(5));
        if (e.type === "response.output_item.done" && e.item) items.push(e.item);
        if (e.type === "response.completed") completed = e.response;
        if (e.type === "response.failed") throw new Error(`backend response.failed: ${JSON.stringify(e).slice(0, 400)}`);
      } catch (err) { if (err instanceof Error && err.message.startsWith("backend")) throw err; }
    }
    if (completed) break;
  }
  if (!completed) throw new Error("stream ended without response.completed");
  if (!(completed.output ?? []).length) completed.output = items;
  return completed;
}

// Hashes let diagnostics compare prefixes without logging request content.
const h = (v: unknown) => createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 10);
interface Fingerprint { session: string; instr: string; tools: string; toolCount: number; items: string[]; chars: number[]; kinds: string[] }
let lastMain: Fingerprint | null = null;
function fingerprint(body: any, session = ""): Fingerprint {
  const input: any[] = body.input ?? [];
  return {
    session,
    instr: h(body.instructions ?? ""),
    tools: h(body.tools ?? []),
    toolCount: (body.tools ?? []).length,
    items: input.map((it) => h(it)),
    chars: input.map((it) => JSON.stringify(it).length),
    kinds: input.map((it) => `${it.role ?? ""}${it.role ? "/" : ""}${it.type ?? ""}`),
  };
}
// Side calls (titles, summaries) are tiny and have their own prefix.
function isMainCall(fp: Fingerprint, totalTokens: number): boolean {
  return fp.items.length >= 4 || totalTokens > 20000;
}
function commonPrefix(prev: Fingerprint, fp: Fingerprint): number {
  let i = 0;
  while (i < prev.items.length && i < fp.items.length && prev.items[i] === fp.items[i]) i++;
  return i;
}
function cacheDiag(fp: Fingerprint, usage: any): string {
  const total = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  let line = `[cache-diag] in=${total} cached=${cached} (${total ? Math.round((100 * cached) / total) : 0}%) items=${fp.items.length} reasoning=${fp.kinds.filter((k) => k === "reasoning").length} tools=${fp.toolCount} t=${new Date().toISOString().slice(11, 19)}${quota.used_percent !== null ? ` quota=${quota.used_percent}%` : ""}`;
  // Side calls must not overwrite the fingerprint of the main conversation.
  const isMain = isMainCall(fp, total);
  if (!isMain) return line + " side-call";
  const prev = lastMain;
  lastMain = fp;
  if (!prev) return line + " first";
  if (prev.instr !== fp.instr) line += " INSTRUCTIONS-CHANGED";
  if (prev.tools !== fp.tools) line += ` TOOLS-CHANGED(${prev.toolCount}->${fp.toolCount})`;
  const i = commonPrefix(prev, fp);
  const commonChars = fp.chars.slice(0, i).reduce((a, b) => a + b, 0);
  line += ` common=${i}/${prev.items.length} (~${Math.round(commonChars / 4000)}k tok)`;
  if (i < prev.items.length) line += ` HISTORY-REWRITTEN at #${i} (${fp.kinds[i] ?? "end"}; was ${prev.kinds[i]})`;
  return line;
}

// Log native search usage only when offered, with count and time but no
// queries, URLs or results to avoid exposing request content.
function searchDiag(resp: any, body: any): string | null {
  if (!(body.tools ?? []).some((t: any) => t?.type === "web_search")) return null;
  const n = (resp.output ?? []).filter((it: any) => it?.type === "web_search_call").length;
  return `[search-diag] web_search_call=${n} t=${new Date().toISOString().slice(11, 19)}`;
}

// A sticky token can pin a conversation to a cold route despite an unchanged prefix.
const TURN_STATE_RECOVERY = process.env.ADAPTER_TURN_STATE_RECOVERY === "1";
const COLD_PCT = 10;
interface CacheVerdict { main: boolean; cold: boolean; clean: boolean; reason: string; pct: number }
interface RecoveryState { streak: number; pending: boolean; rotationNeeded: boolean }
const recovery = new Map<string, RecoveryState>();

function cacheVerdict(prev: Fingerprint | null, fp: Fingerprint, usage: any, adapterEvent: boolean): CacheVerdict {
  const total = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const pct = total ? (100 * cached) / total : 0;
  const main = isMainCall(fp, total);
  const v = (clean: boolean, reason: string): CacheVerdict => ({ main, cold: pct < COLD_PCT, clean, reason, pct });
  if (!main) return v(false, "side-call");
  if (adapterEvent) return v(false, "adapter-event");
  if (!prev) return v(false, "first-call");
  if (prev.session !== fp.session) return v(false, "other-session");
  if (prev.instr !== fp.instr) return v(false, "instructions-changed");
  if (prev.tools !== fp.tools) return v(false, "tools-changed");
  if (commonPrefix(prev, fp) !== prev.items.length) return v(false, "prefix-changed");
  return v(true, "clean");
}

function recoveryStep(st: RecoveryState, v: CacheVerdict): { clear: boolean; log: string | null } {
  if (!v.main) return { clear: false, log: null };
  const pct = `cached=${Math.round(v.pct)}%`;
  if (st.pending) {
    st.pending = false;
    st.streak = 0;
    if (!v.clean) return { clear: false, log: `inconclusive reason=${v.reason}` };
    if (!v.cold) return { clear: false, log: `warm ${pct}` };
    st.rotationNeeded = true;
    return { clear: false, log: `still-cold ${pct} session-key-rotation-needed` };
  }
  if (!v.cold) {
    st.streak = 0;
    if (!st.rotationNeeded) return { clear: false, log: null };
    st.rotationNeeded = false;
    return { clear: false, log: `marker-cleared warm ${pct}` };
  }
  if (!v.clean) { st.streak = 0; return { clear: false, log: null }; }
  if (st.rotationNeeded) return { clear: false, log: null };
  st.streak++;
  if (st.streak < 2) return { clear: false, log: null };
  st.streak = 0;
  st.pending = true;
  return { clear: true, log: null };
}

function turnStateRecovery(sessionId: string, v: CacheVerdict): void {
  if (!TURN_STATE_RECOVERY || !sessionId) return;
  let st = recovery.get(sessionId);
  if (!st) { st = { streak: 0, pending: false, rotationNeeded: false }; recovery.set(sessionId, st); }
  const step = recoveryStep(st, v);
  const t = new Date().toISOString().slice(11, 19);
  if (step.clear) {
    const had = turnState.delete(sessionId);
    console.log(`[turn-state-recovery] cleared session=${h(sessionId).slice(0, 8)} turn-state=${had ? "present" : "absent"} after=2-clean-cold t=${t}`);
  } else if (step.log) {
    console.log(`[turn-state-recovery] ${step.log} session=${h(sessionId).slice(0, 8)} t=${t}`);
  }
}

const REPLAY = (process.env.ADAPTER_REASONING_REPLAY ?? "1") !== "0";
const WEB_SEARCH = process.env.ADAPTER_WEB_SEARCH === "1";
// Set this before a conversation starts to keep its tool prefix stable.
const NATIVE_WEB_SEARCH = process.env.ADAPTER_NATIVE_WEB_SEARCH === "1";
let replayDisabled = false;
function sessionIdFor(seed: string): string {
  const x = createHash("sha1").update(seed).digest("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
}
// Anthropic messages cannot carry reasoning items, but replay needs them to match the cached prefix.
const reasoningStore = new Map<string, any[]>();
function ctxOf(item: any): string {
  if (!item) return "start";
  if (item.type === "function_call_output") return `o:${item.call_id}`;
  if (item.type === "function_call") return `c:${item.call_id}`;
  if (item.type === "message") {
    const text = (Array.isArray(item.content) ? item.content : []).map((c: any) => c.text ?? "").join("\n");
    return `m:${item.role}:${h(text)}`;
  }
  return `x:${h(item)}`;
}
function lastNonReasoning(input: any[]): any {
  for (let i = (input?.length ?? 0) - 1; i >= 0; i -= 1) if (input[i]?.type !== "reasoning") return input[i];
  return undefined;
}
// Position distinguishes repeated identical turns; context and text remain usable after a window cut.
const countNR = (input: any[]) => (input ?? []).reduce((n, it) => n + (it?.type === "reasoning" ? 0 : 1), 0);
function rememberReasoning(output: any[], requestInput: any[] = []): void {
  let pending: any[] = [];
  let ctx = ctxOf(lastNonReasoning(requestInput));
  let pos = countNR(requestInput);
  for (const item of output ?? []) {
    if (item.type === "reasoning") {
      if (item.encrypted_content) pending.push({ type: "reasoning", id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content });
      continue;
    }
    let key = "";
    if (item.type === "function_call") key = `call:${item.call_id}`;
    else if (item.type === "message") key = `msg:${h((item.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("\n"))}`;
    if (key && pending.length) {
      reasoningStore.set(`${pos}|${ctx}|${key}`, pending);
      if (!reasoningStore.has(`${ctx}|${key}`)) reasoningStore.set(`${ctx}|${key}`, pending); // Keep fallback entries stable so replay does not rewrite earlier turns.
      if (!reasoningStore.has(key)) reasoningStore.set(key, pending);                         
      if (reasoningStore.size > 20000) reasoningStore.delete(reasoningStore.keys().next().value as string);
    }
    pending = [];
    ctx = ctxOf(item);
    pos += 1;
  }
}
function recallReasoning(key: string, input: any[] = []): any[] {
  if (!REPLAY || replayDisabled) return [];
  const ctx = ctxOf(lastNonReasoning(input));
  return reasoningStore.get(`${countNR(input)}|${ctx}|${key}`)
    ?? reasoningStore.get(`${ctx}|${key}`)
    ?? reasoningStore.get(key)
    ?? [];
}

export function chatToResponsesInput(messages: any[]): { instructions: string; input: any[] } {
  const systemParts: string[] = [];
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("\n")
        : String(m.content ?? ""));
      continue;
    }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: String(m.content ?? "") });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) {
        input.push(...recallReasoning(`msg:${h(String(m.content))}`, input));
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: String(m.content) }] });
      }
      for (const tc of m.tool_calls) {
        input.push(...recallReasoning(`call:${tc.id}`, input));
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
      }
      continue;
    }
    const text = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("\n") : "";
    if (m.role === "assistant" && text) input.push(...recallReasoning(`msg:${h(text)}`, input));
    input.push({
      type: "message", role: m.role,
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text }],
    });
  }
  const instructions = systemParts.length ? systemParts.join("\n\n") : "You are a helpful assistant.";
  return { instructions, input };
}

export function chatToResponsesTools(tools: any[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description ?? "",
    parameters: t.function?.parameters ?? t.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

function withBuiltinSearch(tools: any[] | undefined): any[] | undefined {
  if (!WEB_SEARCH) return tools;
  if ((tools ?? []).some((t) => t.name === "web_search")) return tools;
  return [...(tools ?? []), { type: "web_search" }];
}

// Clients cannot render the backend's private-use citation marks; sources travel separately.
export function stripCitationMarks(text: string): string {
  if (!/[-]/.test(text)) return text;
  return text
    .replace(/( ?)([^]*)([^]*)?/g, (_m, space: string, kind: string, args: string | undefined) => {
      if (kind !== "entity") return "";
      try {
        const name = JSON.parse((args ?? "").replace(/^/, ""))?.[1];
        return typeof name === "string" && name ? space + name : "";
      } catch { return ""; }
    })
    .replace(/[-]/g, "");
}

export function stripCitationMarksDeep(value: unknown): unknown {
  if (typeof value === "string") return stripCitationMarks(value);
  if (Array.isArray(value)) return value.map(stripCitationMarksDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripCitationMarksDeep(v)]));
  return value;
}

export function stripCitationMarksFromArguments(args: string | undefined): string {
  const raw = args ?? "{}";
  if (!/[\uE200-\uE202]|\\u[eE]20[0-2]/.test(raw)) return raw;
  try { return JSON.stringify(stripCitationMarksDeep(JSON.parse(raw))); } catch { return raw; }
}

export function responsesToChatCompletion(resp: any, model: string): any {
  let text = "";
  const toolCalls: any[] = [];
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const p of item.content ?? []) if (p.type === "output_text") text += stripCitationMarks(p.text);
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id, type: "function",
        function: { name: item.name, arguments: stripCitationMarksFromArguments(item.arguments) },
      });
    }
  }
  const u = resp.usage ?? {};
  return {
    id: resp.id ?? `adapter-${Date.now()}`,
    object: "chat.completion",
    model: servedModel(resp),
    choices: [{
      index: 0,
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content: text || (toolCalls.length ? null : ""),
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
    }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      // Clients read the cache share here; without it every turn looks uncached.
      prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
    },
  };
}


function anthropicTextOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

export function anthropicToResponsesInput(body: any): { instructions: string; input: any[] } {
  const instructions = typeof body.system === "string"
    ? body.system
    : Array.isArray(body.system) ? body.system.map((b: any) => b.text ?? "").join("\n") : "You are a helpful assistant.";
  const input: any[] = [];
  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    const texts = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (m.role === "assistant") {
      if (texts) {
        input.push(...recallReasoning(`msg:${h(texts)}`, input));
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: texts }] });
      }
      for (const b of blocks) if (b.type === "tool_use") {
        input.push(...recallReasoning(`call:${b.id}`, input));
        input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
    } else {
      // The backend accepts only strings in tool results, so images follow in a user message.
      const toImagePart = (img: any): any | null => {
        const src = img?.source ?? {};
        if (src.type === "base64" && src.data) return { type: "input_image", image_url: `data:${src.media_type ?? "image/png"};base64,${src.data}` };
        if (src.type === "url" && src.url) return { type: "input_image", image_url: src.url };
        return null;
      };
      for (const b of blocks) if (b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : anthropicTextOf(b.content);
        const imgs = Array.isArray(b.content) ? b.content.filter((c: any) => c.type === "image").map(toImagePart).filter(Boolean) : [];
        input.push({ type: "function_call_output", call_id: b.tool_use_id, output: out || (imgs.length ? "[image attached below]" : "") });
        if (imgs.length) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "[image returned by the tool call above]" }, ...imgs] });
      }
      const parts: any[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) parts.push({ type: "input_text", text: b.text });
        else if (b.type === "image") { const im = toImagePart(b); if (im) parts.push(im); }
      }
      if (parts.some((x) => x.type === "input_image")) input.push({ type: "message", role: "user", content: parts });
      else if (texts) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: texts }] });
    }
  }
  return { instructions, input };
}

function withNativeSearch(tools: any[] | undefined): any[] | undefined {
  if (!NATIVE_WEB_SEARCH) return tools;
  if ((tools ?? []).some((t) => t.type === "web_search")) return tools;
  return [...(tools ?? []), { type: "web_search" }];
}

export function anthropicToResponsesTools(tools: any[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => isAnthropicWebSearch(t)
    // Clients do not execute server search tools, so this must use the backend's built-in search.
    ? { type: "web_search" }
    : {
      type: "function",
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
      strict: false,
    });
}

const isAnthropicWebSearch = (t: any) => typeof t?.type === "string" && t.type.startsWith("web_search_");

function webSearchBlocks(item: any, titles: Map<string, string>): any[] {
  const a = item.action ?? {};
  const query = a.query ?? (Array.isArray(a.queries) ? a.queries[0] : "") ?? "";
  const id = `srvtoolu_${String(item.id ?? Date.now()).replace(/[^A-Za-z0-9]/g, "").slice(-24)}`;
  const seen = new Set<string>();
  const results: any[] = [];
  for (const s of a.sources ?? []) {
    const u = String(s?.url ?? "");
    if (!u || seen.has(u)) continue;
    seen.add(u);
    let title = titles.get(u.replace(/[?&]utm_source=openai$/, "")) ?? "";
    if (!title) { try { const p = new URL(u); title = p.hostname + p.pathname; } catch { title = u; } }
    results.push({ type: "web_search_result", url: u, title, encrypted_content: "", page_age: null });
  }
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query } },
    { type: "web_search_tool_result", tool_use_id: id, content: results },
  ];
}

export function responsesToAnthropic(resp: any, model: string): any {
  const content: any[] = [];
  // Page titles only arrive on the citations of the answer text; collect them
  // first so the search results can carry them.
  const titles = new Map<string, string>();
  for (const item of resp.output ?? []) if (item.type === "message") {
    for (const p of item.content ?? []) for (const an of p.annotations ?? []) {
      if (an.type === "url_citation" && an.url && an.title) titles.set(String(an.url).replace(/[?&]utm_source=openai$/, ""), an.title);
    }
  }
  for (const item of resp.output ?? []) {
    if (item.type === "web_search_call") content.push(...webSearchBlocks(item, titles));
    if (item.type === "message") {
      let text = "";
      for (const p of item.content ?? []) if (p.type === "output_text") text += stripCitationMarks(p.text);
      if (text) content.push({ type: "text", text });
    }
    if (item.type === "function_call") {
      let input: any = {};
      try { input = stripCitationMarksDeep(JSON.parse(item.arguments || "{}")); } catch { input = {}; }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }
  const hasTool = content.some((b) => b.type === "tool_use");
  const u = resp.usage ?? {};
  return {
    id: resp.id ?? `adapter-${Date.now()}`,
    type: "message",
    role: "assistant",
    model: servedModel(resp), 
    content,
    stop_reason: hasTool ? "tool_use" : "end_turn",
    stop_sequence: null,
    // Anthropic counts cached input separately; leaving it in the total would count it twice.
    usage: (() => {
      const total = u.input_tokens ?? 0;
      const cached = typeof u.input_tokens_details?.cached_tokens === "number" ? u.input_tokens_details.cached_tokens : 0;
      return {
        input_tokens: Math.max(0, total - cached),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
        output_tokens: u.output_tokens ?? 0,
      };
    })(),
  };
}

function anthropicSse(msg: any): Response {
  const ev = (event: string, data: any) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = "";
  out += ev("message_start", {
    type: "message_start",
    message: {
      ...msg,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: msg.usage.input_tokens,
        cache_read_input_tokens: msg.usage.cache_read_input_tokens,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
        output_tokens: 0,
      },
    },
  });
  msg.content.forEach((block: any, i: number) => {
    if (block.type === "text") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === "server_tool_use") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: { type: "server_tool_use", id: block.id, name: block.name, input: {} } });
      out += ev("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === "web_search_tool_result") {
      out += ev("content_block_start", { type: "content_block_start", index: i, content_block: block });
    }
    out += ev("content_block_stop", { type: "content_block_stop", index: i });
  });
  out += ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  out += ev("message_stop", { type: "message_stop" });
  return new Response(out, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

// Loopback alone cannot block local browser pages from spending the subscription or reading
// responses through DNS rebinding. Check Host, browser headers and JSON content type as well.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
function refused(req: Request): Response | null {
  if (!LOCAL_HOSTS.has((req.headers.get("host") ?? "").toLowerCase())) {
    return Response.json({ error: { message: "this adapter answers only on its own loopback address" } }, { status: 421 });
  }
  const site = req.headers.get("sec-fetch-site");
  if (req.headers.get("origin") !== null || (site !== null && site !== "none")) {
    return Response.json({ error: { message: "requests from web pages are not accepted" } }, { status: 403 });
  }
  if (req.method === "POST" && !/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return Response.json({ error: { message: "POST bodies must be application/json" } }, { status: 415 });
  }
  return null;
}

if (import.meta.main) Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  // Reasoning can take several minutes before the backend returns an answer.
  idleTimeout: 0,
  async fetch(req) {
    const refusal = refused(req);
    if (refusal) return refusal;
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, ...routeHealth(), backend: "chatgpt-oauth", model: MODEL, identity: IDENTITY, port: PORT, effort: EFFORT || null, verbosity: VERBOSITY || null, reasoning_context: REASONING_CONTEXT || null, reasoning_replay: REPLAY, web_search: WEB_SEARCH, native_web_search: NATIVE_WEB_SEARCH, quota, sticky_sessions: turnState.size, turn_state_recovery: TURN_STATE_RECOVERY ? { rotation_needed: [...recovery.values()].filter((r) => r.rotationNeeded).length, pending: [...recovery.values()].filter((r) => r.pending).length } : null });

    try {
      if (url.pathname === "/v1/models" && req.method === "GET") return Response.json({ object: "list", data: await adapterModels() });
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const cc = (await req.json()) as any;
        const { instructions, input } = chatToResponsesInput(cc.messages ?? []);
        const body: any = {
          model: MODEL, instructions, input,
          tools: withBuiltinSearch(chatToResponsesTools(cc.tools)),
          stream: true, store: false,
          prompt_cache_key: typeof cc.user === "string" && cc.user ? cc.user : CACHE_KEY,
        };
        applyReasoningKnobs(body, cc.reasoning_effort || EFFORT);
        if (REPLAY && !replayDisabled) body.include = ["reasoning.encrypted_content"];
        if ((body.tools ?? []).some((t: any) => t.type === "web_search")) body.include = [...(body.include ?? []), "web_search_call.action.sources"];
        const sessionId = sessionIdFor(String(body.prompt_cache_key));
        const fp = fingerprint(body, sessionId);
        let resp: any;
        let replayRetried = false;
        try {
          resp = await callBackend(body, sessionId);
        } catch (err) {
          if (REPLAY && !replayDisabled && /HTTP 400/.test(String(err))) {
            console.log(`[adapter] reasoning replay rejected, disabling: ${String(err).slice(0, 300)}`);
            replayDisabled = true;
            body.include = (body.include ?? []).filter((x: string) => x !== "reasoning.encrypted_content");
            if (!body.include.length) delete body.include;
            body.input = (body.input as any[]).filter((it) => it.type !== "reasoning");
            replayRetried = true;
            resp = await callBackend(body, sessionId);
          } else throw err;
        }
        try { rememberReasoning(resp.output ?? [], body.input as any[]); } catch { /* never break a turn */ }
        const prevMain = lastMain;
        try { console.log(cacheDiag(fp, resp.usage)); } catch { /* diagnostics must never break a turn */ }
        try { turnStateRecovery(sessionId, cacheVerdict(prevMain, fp, resp.usage, replayRetried)); } catch { /* never break a turn */ }
        try { const s = searchDiag(resp, body); if (s) console.log(s); } catch { /* same */ }
        return Response.json(responsesToChatCompletion(resp, MODEL));
      }

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const am = (await req.json()) as any;
        const { instructions, input } = anthropicToResponsesInput(am);
        const body: any = {
          model: MODEL, instructions, input,
          tools: withNativeSearch(anthropicToResponsesTools(am.tools)),
          stream: true, store: false,
          // Stable key so identical prefixes route to the same cache.
          prompt_cache_key: CACHE_KEY,
        };
        applyReasoningKnobs(body, EFFORT);
        if (REPLAY && !replayDisabled) body.include = ["reasoning.encrypted_content"];
        if (NATIVE_WEB_SEARCH || (am.tools ?? []).some(isAnthropicWebSearch)) body.include = [...(body.include ?? []), "web_search_call.action.sources"];
        const sessionId = sessionIdFor(String(am.metadata?.user_id ?? CACHE_KEY));
        const fp = fingerprint(body, sessionId);
        let resp: any;
        let replayRetried = false;
        try {
          resp = await callBackend(body, sessionId);
        } catch (err) {
          if (REPLAY && !replayDisabled && /HTTP 400/.test(String(err))) {
            console.log(`[adapter] reasoning replay rejected, disabling: ${String(err).slice(0, 300)}`);
            replayDisabled = true;
            body.include = (body.include ?? []).filter((x: string) => x !== "reasoning.encrypted_content");
            if (!body.include.length) delete body.include;
            body.input = (body.input as any[]).filter((it) => it.type !== "reasoning");
            replayRetried = true;
            resp = await callBackend(body, sessionId);
          } else throw err;
        }
        try { rememberReasoning(resp.output ?? [], body.input as any[]); } catch { /* never break a turn */ }
        const prevMain = lastMain;
        try { console.log(cacheDiag(fp, resp.usage)); } catch { /* diagnostics must never break a turn */ }
        try { turnStateRecovery(sessionId, cacheVerdict(prevMain, fp, resp.usage, replayRetried)); } catch { /* never break a turn */ }
        try { const s = searchDiag(resp, body); if (s) console.log(s); } catch { /* same */ }
        const msg = responsesToAnthropic(resp, am.model ?? MODEL);
        return am.stream ? anthropicSse(msg) : Response.json(msg);
      }

      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
        const am = (await req.json()) as any;
        const rough = Math.ceil(JSON.stringify(am.messages ?? "").length / 4)
          + Math.ceil(JSON.stringify(am.system ?? "").length / 4)
          + Math.ceil(JSON.stringify(am.tools ?? "").length / 4);
        return Response.json({ input_tokens: rough });
      }

      return new Response("not found", { status: 404 });
    } catch (err: any) {
      const official = err instanceof ChatGptRouteError;
      const message = String(err?.message || err);
      console.error(`[adapter] ${message}`);
      const status = official ? err.status : 502;
      const details = official ? { code: err.code, param: err.param, request_id: err.requestId, upstream: err.upstream } : {};
      if (url.pathname.startsWith("/v1/messages")) {
        const type = status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error" : status === 400 ? "invalid_request_error" : "api_error";
        return Response.json({ type: "error", error: { type, message, ...details } }, { status });
      }
      return Response.json({ error: { message, ...details } }, { status });
    }
  },
});
if (import.meta.main) console.log(`[adapter] ChatGPT OAuth adapter on 127.0.0.1:${PORT} — /v1/chat/completions + /v1/messages; route selected by saved credentials (${MODEL})`);
