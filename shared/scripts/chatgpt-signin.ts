// Signs in to a ChatGPT subscription using PKCE and a pasted callback URL.
// No local callback listener runs; the browser's failed redirect still carries the authorization code.

import { readFileSync } from "node:fs";
import { withCredentialLock, writePrivateJson } from "./credential-store";
import { chatgptAuthFile } from "./house-runtime";

export const OFFICIAL_AUTHORIZE = "https://auth.openai.com/api/accounts/authorize";
export const OFFICIAL_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
export const OFFICIAL_RESOURCE = "https://api.openai.com/v1";
export const OFFICIAL_RESPONSES = `${OFFICIAL_RESOURCE}/responses`;
export const OFFICIAL_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export function chatgptRoute(value = process.env.CHATGPT_ROUTE): "official" | "codex" {
  return value === "official" ? "official" : "codex";
}

// The sidecar belongs to the host, not to imported account credentials.
export async function ensureChatGptHostId(authFile = chatgptAuthFile()): Promise<string> {
  const path = `${authFile}.host.json`;
  return withCredentialLock(path, async () => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")).ext_agent_host_id;
      if (!validHostId(value)) throw new Error("Invalid saved ChatGPT host ID");
      return value;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const value = `urn:uuid:${crypto.randomUUID()}`;
    await writePrivateJson(path, { ext_agent_host_id: value });
    return value;
  });
}
function validHostId(value: unknown): value is string {
  return typeof value === "string" && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Codex-compatible parameters preserve the default subscription login.
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const BACKEND = "https://chatgpt.com/backend-api/codex/responses";

export const DEFAULT_CHATGPT_MODEL = "gpt-5.6-terra";

export interface ChatGptSignInAttempt {
  signInUrl: string;
  codeVerifier: string;
  state: string;
  route?: "official" | "codex";
  nonce?: string;
  hostId?: string;
  clientId?: string;
  subject?: string;
  expiresAt?: number;
  consumed?: boolean;
  authFile?: string;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export async function startChatGptSignIn(options: { route?: string; authFile?: string; hostId?: string; registration?: ChatGptTokens } = {}): Promise<ChatGptSignInAttempt> {
  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  if (chatgptRoute(options.route) === "official") {
    const authFile = options.authFile ?? chatgptAuthFile();
    const hostId = options.hostId ?? await ensureChatGptHostId(authFile);
    if (!validHostId(hostId)) throw new Error("ChatGPT host ID must be a UUID URI");
    let saved = options.registration;
    if (!saved) {
      try { saved = JSON.parse(readFileSync(authFile, "utf8")).tokens; }
      catch (error: any) { if (error.code !== "ENOENT") throw new Error("Cannot read ChatGPT registration"); }
    }
    const clientId = saved?.client_id;
    if (clientId === "dynamic_agent_client") throw new Error("Invalid saved ChatGPT client ID");
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(24)));
    const u = new URL(OFFICIAL_AUTHORIZE);
    u.search = new URLSearchParams({
      response_type: "code", client_id: clientId || "dynamic_agent_client",
      redirect_uri: REDIRECT_URI, scope: OFFICIAL_SCOPES, resource: OFFICIAL_RESOURCE,
      ext_agent_host_id: hostId, code_challenge: challenge, code_challenge_method: "S256", state, nonce,
      ...(!clientId ? { agent_name_hint: "Embervy" } : {}),
    }).toString();
    // Account selection remains visible; retained ID tokens are never sent back to the app UI.
    return { signInUrl: u.toString(), codeVerifier: verifier, state, nonce, hostId, clientId,
      subject: clientId ? saved?.subject : undefined, route: "official", authFile, expiresAt: Date.now() + 10 * 60_000 };
  }
  const u = new URL(OAUTH_AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", OAUTH_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("id_token_add_organizations", "true");
  u.searchParams.set("codex_cli_simplified_flow", "true");
  u.searchParams.set("originator", "codex_cli_rs");
  return { signInUrl: u.toString(), codeVerifier: verifier, state };
}

function jwtClaims(jwt: string): any {
  const payload = jwt.split(".")[1] ?? "";
  const pad = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(pad, "base64").toString("utf-8"));
}

export interface ChatGptTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id: string;
  client_id?: string;
  ext_agent_host_id?: string;
  issuer?: string;
  subject?: string;
  email?: string;
  scopes?: string[];
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  earliest_refresh_at?: number;
  saved_at?: string;
  plan_usage_enabled?: boolean;
}

export function tokenRequestBody(code: string, attempt: ChatGptSignInAttempt): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: attempt.codeVerifier,
  }).toString();
}

export function tokenExchangeError(status: number, body: string): string {
  let reason = "";
  try { reason = String(JSON.parse(body)?.error?.code ?? JSON.parse(body)?.error ?? ""); } catch { /* not JSON */ }
  if (!/^[a-z0-9_]{1,100}$/.test(reason)) reason = "";
  if (status === 400 || status === 401) {
    return `ChatGPT did not accept the sign-in code. It is valid only for a few minutes and only once: ask for a new sign-in link, sign in, and paste the new address right away. (OpenAI: HTTP ${status}${reason ? ` ${reason}` : ""})`;
  }
  return `token exchange failed: HTTP ${status}`;
}

export async function exchangeChatGptCode(pasted: string, attempt: ChatGptSignInAttempt): Promise<ChatGptTokens> {
  if (attempt.route === "official") return exchangeOfficialCode(pasted, attempt);
  let code = pasted.trim();
  if (code.includes("://") || code.includes("?")) {
    const url = new URL(code.startsWith("http") ? code : `http://x/?${code.split("?").pop()}`);
    const urlState = url.searchParams.get("state");
    if (urlState && urlState !== attempt.state) throw new Error("state mismatch — please restart the sign-in and use the newest link");
    const c = url.searchParams.get("code");
    if (!c) throw new Error("no sign-in code in the pasted address — paste the whole address the browser ended on (it starts with http://127.0.0.1:1455/…)");
    code = c;
  }
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(code, attempt),
  });
  if (!res.ok) throw new Error(tokenExchangeError(res.status, await res.text()));
  const t = (await res.json()) as any;
  if (!t.access_token || !t.refresh_token) throw new Error("token exchange answered without access/refresh token");
  const claims = t.id_token ? jwtClaims(t.id_token) : {};
  const auth = claims["https://api.openai.com/auth"] ?? {};
  const account_id = auth.chatgpt_account_id ?? auth.account_id ?? "";
  if (!account_id) throw new Error("could not read the ChatGPT account id from the sign-in result — is this account on a ChatGPT subscription (Plus or better)?");
  return { id_token: t.id_token ?? "", access_token: t.access_token, refresh_token: t.refresh_token, account_id };
}

const ISSUER = "https://auth.openai.com";
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
let keyCache: { keys: any[]; until: number } | undefined;

export async function verifyChatGptIdToken(token: string, clientId: string, nonce: string): Promise<any> {
  try {
    if (!clientId || clientId === "dynamic_agent_client" || typeof nonce !== "string" || !nonce) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) throw new Error();
    async function loadKeys() {
      const discovery = await fetch(DISCOVERY, { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!discovery.ok) throw new Error();
      const d: any = await discovery.json();
      if (d.issuer !== ISSUER || d.jwks_uri !== JWKS || d.authorization_endpoint !== OFFICIAL_AUTHORIZE || d.token_endpoint !== OFFICIAL_TOKEN) throw new Error();
      const response = await fetch(JWKS, { signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (!response.ok) throw new Error();
      const body: any = await response.json();
      if (!Array.isArray(body.keys)) throw new Error();
      keyCache = { keys: body.keys, until: Date.now() + 60 * 60_000 };
    }
    let fetched = false;
    if (!keyCache || keyCache.until <= Date.now()) { await loadKeys(); fetched = true; }
    if (!keyCache!.keys.some(k => k.kid === header.kid) && !fetched) await loadKeys();
    const matches = keyCache!.keys.filter(k => k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig") && (!k.alg || k.alg === "RS256"));
    if (matches.length !== 1) throw new Error();
    const key = await crypto.subtle.importKey("jwk", matches[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(parts[2]!, "base64url"), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
    const claims = jwtClaims(token);
    const now = Date.now() / 1000;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audiences.includes(clientId) || claims.nonce !== nonce ||
        !Number.isFinite(claims.exp) || claims.exp <= now - 5 ||
        !Number.isFinite(claims.iat) || claims.iat > now + 5 ||
        (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 5)) ||
        typeof claims.sub !== "string" || !claims.sub.trim() ||
        (claims.sid !== undefined && (typeof claims.sid !== "string" || !claims.sid.trim()))) throw new Error();
    return claims;
  } catch { throw new Error("ChatGPT identity verification failed; start a new sign-in"); }
}

async function exchangeOfficialCode(pasted: string, attempt: ChatGptSignInAttempt): Promise<ChatGptTokens> {
  if (attempt.consumed || !attempt.expiresAt || attempt.expiresAt <= Date.now()) throw new Error("ChatGPT sign-in expired or already used; start again");
  attempt.consumed = true;
  let url: URL;
  try { url = new URL(pasted.trim()); } catch { throw new Error("Paste the complete loopback redirect URL"); }
  const redirect = new URL(REDIRECT_URI);
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== attempt.state) throw new Error("ChatGPT callback or state mismatch; start again");
  if (url.searchParams.has("error")) throw new Error("ChatGPT authorization was declined; start again to enable plan usage");
  const issued = url.searchParams.get("client_id");
  if (url.searchParams.getAll("client_id").length > 1 || (attempt.clientId && issued && issued !== attempt.clientId)) throw new Error("ChatGPT registration mismatch");
  const clientId = attempt.clientId || issued;
  if (!clientId || clientId === "dynamic_agent_client") throw new Error("ChatGPT registration did not return an issued client ID");
  attempt.clientId = clientId;
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.getAll("code").length !== 1) throw new Error("No unique sign-in code in the redirect URL");
  const res = await fetch(OFFICIAL_TOKEN, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId,
      redirect_uri: REDIRECT_URI, code_verifier: attempt.codeVerifier, resource: OFFICIAL_RESOURCE }).toString(),
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!res.ok) throw new Error(`ChatGPT token exchange failed (HTTP ${res.status}); start a new sign-in`);
  const t: any = await res.json();
  if (typeof t?.id_token !== "string" || typeof t.scope !== "string") throw new Error("Incomplete ChatGPT token response");
  const claims = await verifyChatGptIdToken(t.id_token, clientId, attempt.nonce!);
  if (attempt.subject && claims.sub !== attempt.subject) throw new Error("ChatGPT account identity changed; registration was not replaced");
  const scopes = t.scope.split(/\s+/).filter(Boolean);
  const planEnabled = scopes.includes("chatgpt.tokens.use.direct");
  if (planEnabled && (typeof t.access_token !== "string" || !t.access_token || typeof t.refresh_token !== "string" || !t.refresh_token || !Number.isFinite(t.expires_in) || t.expires_in <= 0 || t.token_type?.toLowerCase() !== "bearer")) throw new Error("Incomplete ChatGPT plan token response");
  return { access_token: typeof t.access_token === "string" ? t.access_token : "", refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "", id_token: t.id_token,
    account_id: "", client_id: clientId, ext_agent_host_id: attempt.hostId, issuer: claims.iss, subject: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined, scopes, token_type: t.token_type,
    expires_in: t.expires_in, expires_at: Number.isFinite(t.expires_in) ? Date.now() + t.expires_in * 1000 : undefined, earliest_refresh_at: t.earliest_refresh_at,
    saved_at: new Date().toISOString(), plan_usage_enabled: planEnabled };
}

export async function chatgptModels(accessToken: string): Promise<Array<{ slug: string; display_name: string }>> {
  const res = await fetch(`${OFFICIAL_RESOURCE}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new ChatGptRouteError(res.status, "model_catalog_unavailable");
  const data: any = await res.json();
  if (!Array.isArray(data.models)) throw new Error("Invalid ChatGPT model catalog");
  return data.models.filter((m: any) => m.visibility === "list" && typeof m.slug === "string")
    .map((m: any) => ({ slug: m.slug, display_name: typeof m.display_name === "string" ? m.display_name : m.slug }));
}

const ERROR_STATUS: Record<string, number> = {
  subscription_sharing_user_not_eligible: 403, subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503, subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403, subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403, chatpass_v2_invalid_authorization_context: 403,
  subscription_sharing_user_unavailable: 503,
};
export class ChatGptRouteError extends Error {
  upstream?: unknown;
  constructor(public status: number, public code = "official_route_error", public param?: string, public requestId?: string) {
    super(`ChatGPT status ${status}: ${code}` + (code === "invalid_client" ? "; fix the issued client configuration" : code === "sign_in_required" ? "; sign in again with the saved registration" : code === "subscription_sharing_user_not_eligible" ? "; plan usage is unavailable for this user or workspace; do not repeat OAuth" : code === "subscription_sharing_route_not_supported" ? "; check the HTTP method and public Responses endpoint" : code === "chatpass_v2_scope_not_authorized" || code === "chatpass_v2_invalid_authorization_context" ? "; check the client and granted plan permissions" : status === 429 ? "; pause plan requests and check https://chatgpt.com/settings/usage" : status === 503 ? "; retry later with bounded backoff" : status === 401 ? "; check sign-in and granted plan permission" : status === 403 ? "; check account policy and route permissions" : status === 400 ? "; remove the unsupported request capability" : ""));
  }
}
export function officialRouteError(status: number, body: any, requestId?: string): ChatGptRouteError {
  const code = typeof body?.error?.code === "string" && /^[a-z0-9_]{1,100}$/.test(body.error.code) ? body.error.code : "official_route_error";
  const param = typeof body?.error?.param === "string" && /^[a-zA-Z0-9_.\[\]]{1,100}$/.test(body.error.param) ? body.error.param : undefined;
  const error = new ChatGptRouteError(status || ERROR_STATUS[code] || 502, code, param, requestId);
  // Preserve diagnostic envelope shape, never untrusted text that might echo credentials.
  function shape(value: any, depth = 0): any {
    if (depth > 8) return "[redacted]";
    if (Array.isArray(value)) return value.map(v => shape(v, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
    return typeof value === "string" ? "[redacted]" : value;
  }
  error.upstream = shape(body);
  return error;
}
export async function readOfficialResponse(res: Response): Promise<any> {
  const requestId = res.headers.get("x-request-id") ?? res.headers.get("openai-request-id") ?? undefined;
  if (!res.ok) throw officialRouteError(res.status, await res.json().catch(() => null), requestId);
  if (!res.body) throw new ChatGptRouteError(502, "stream_missing");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [];
  const items = new Map<number, any>();
  function event(): any {
    if (!data.length) return;
    const raw = data.join("\n"); data = [];
    if (raw === "[DONE]") return;
    let e: any;
    try { e = JSON.parse(raw); } catch { throw new ChatGptRouteError(502, "invalid_stream_event"); }
    if (e.type === "response.output_item.done" && e.item) items.set(e.output_index ?? items.size, e.item);
    if (e.type === "response.failed" || e.type === "error") throw officialRouteError(0, e.response ?? e, requestId);
    if (e.type === "response.incomplete") throw new ChatGptRouteError(502, "response_incomplete", undefined, requestId);
    if (e.type === "response.completed") {
      if (!e.response) throw new ChatGptRouteError(502, "invalid_completed_event");
      return { ...e.response, output: items.size ? [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item) : e.response.output ?? [] };
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (!line) { const completed = event(); if (completed) return completed; }
      }
      if (done) break;
    }
    throw new ChatGptRouteError(502, "stream_interrupted", undefined, requestId);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// A valid login may lack access to the chosen model, so probe that model before accepting the setup.
export async function probeChatGpt(tokens: ChatGptTokens, model = DEFAULT_CHATGPT_MODEL): Promise<{ ok: boolean; detail: string }> {
  if (tokens.client_id) {
    if (!tokens.scopes?.includes("chatgpt.tokens.use.direct")) return { ok: false, detail: "Signed in, but ChatGPT plan usage is disabled; authorize plan usage before inference" };
    try {
      const models = await chatgptModels(tokens.access_token);
      if (!models.some(m => m.slug === model)) return { ok: false, detail: "The selected model is not in this account's visible ChatGPT model catalog" };
      const res = await fetch(OFFICIAL_RESPONSES, {
        method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions: "Reply with the single word: ok", input: [{ role: "user", content: "ok?" }], store: false, stream: true }),
        redirect: "error",
      });
      await readOfficialResponse(res);
      return { ok: true, detail: `ChatGPT subscription answers (${model}, official route)` };
    } catch (error) { return { ok: false, detail: error instanceof ChatGptRouteError ? error.message : "ChatGPT official probe failed" }; }
  }
  const res = await fetch(BACKEND, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "chatgpt-account-id": tokens.account_id,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      instructions: "Reply with the single word: ok",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ok?" }] }],
      stream: true,
      store: false,
      reasoning: { effort: "low" },
    }),
  });
  if (!res.ok) return { ok: false, detail: `subscription backend HTTP ${res.status}` };
  // HTTP success alone does not prove generation succeeded; the stream must confirm completion.
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (buf.includes("response.completed")) return { ok: true, detail: `ChatGPT subscription answers (${model})` };
    if (buf.includes("response.failed")) return { ok: false, detail: "backend refused the probe" };
  }
  return { ok: false, detail: "probe stream ended without completion" };
}

export function chatgptAuthJson(tokens: ChatGptTokens, now = new Date()): string {
  return JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, last_refresh: now.toISOString() }, null, 2);
}

export const GPT_HEAD_ENV_KEYS = [
  "BRAIN_GPT_TRANSPORT", "BRAIN_GPT_MODEL", "BRAIN_GPT_CONTEXT", "BRAIN_GPT_WATCHDOG_WARN", "BRAIN_GPT_WATCHDOG_CUT",
  "GPT_ADAPTER_PORT", "BRAIN_GPT_ADAPTER_PORT", "BRAIN_GPT_CACHE_KEY", "BRAIN_GPT_ADAPTER", "CHATGPT_AUTH_FILE",
  "ADAPTER_EFFORT", "ADAPTER_NATIVE_WEB_SEARCH",
];

export function gptHeadEnvLines(
  existing: Record<string, string | undefined>,
  o: { home: string; authFile: string; cacheKey: string; model?: string },
): string[] {
  const want: Array<[string, string]> = [
    ["BRAIN_GPT_TRANSPORT", "pipe"],
    ["BRAIN_GPT_MODEL", o.model ?? "gpt-5.6-sol"],
    ["BRAIN_GPT_CONTEXT", "1000000"],
    ["BRAIN_GPT_WATCHDOG_WARN", "200000"],
    ["BRAIN_GPT_WATCHDOG_CUT", "220000"],
    ["GPT_ADAPTER_PORT", "3042"],
    ["BRAIN_GPT_CACHE_KEY", o.cacheKey],
    ["BRAIN_GPT_ADAPTER", `${o.home}/shared/tools/chatgpt-oauth-adapter.ts`],
    ["CHATGPT_AUTH_FILE", o.authFile],
    ["ADAPTER_EFFORT", "high"],
    ["ADAPTER_NATIVE_WEB_SEARCH", "1"],
  ];
  const has = (k: string) => typeof existing[k] === "string" && existing[k]!.trim() !== "";
  // The port may also stand under its alias; a second one would compete.
  const missing = want.filter(([k]) => !has(k) && !(k === "GPT_ADAPTER_PORT" && has("BRAIN_GPT_ADAPTER_PORT")));
  if (!missing.length) return [];
  return [
    "",
    "# ChatGPT head, prepared from the app for a later switch (a ChatGPT login is on this server).",
    "# Window = what the model can hold; warn/cut = cost. Raise them here at any time, no cut needed.",
    ...missing.map(([k, v]) => `${k}=${v}`),
  ];
}
