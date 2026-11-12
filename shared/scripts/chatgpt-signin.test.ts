import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureChatGptHostId, chatgptRoute } from "./chatgpt-signin";
import { writePrivateText } from "./credential-store";

test("host identity is created once, private, and independent of imported credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siwc-host-"));
  const file = join(dir, "auth.json");
  try {
    const ids = await Promise.all([ensureChatGptHostId(file), ensureChatGptHostId(file)]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(statSync(`${file}.host.json`).mode & 0o777).toBe(0o600);
    writeFileSync(file, JSON.stringify({ tokens: { ext_agent_host_id: "imported-host" } }));
    expect(await ensureChatGptHostId(file)).toBe(ids[0]);
    const imported = await startChatGptSignIn({ route: "official", authFile: file });
    expect(new URL(imported.signInUrl).searchParams.get("ext_agent_host_id")).toBe(ids[0]);
    expect(await ensureChatGptHostId(join(dir, "other-house.json"))).not.toBe(ids[0]);
    expect(chatgptRoute("official")).toBe("official");
    expect(chatgptRoute("codex")).toBe("codex");
    expect(chatgptRoute("unknown")).toBe("codex");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
import { chatgptAuthJson, gptHeadEnvLines, REDIRECT_URI, startChatGptSignIn, tokenExchangeError, tokenRequestBody } from "./chatgpt-signin";

import { exchangeChatGptCode, OFFICIAL_SCOPES, OFFICIAL_TOKEN, OFFICIAL_RESOURCE, OFFICIAL_AUTHORIZE, probeChatGpt, verifyChatGptIdToken } from "./chatgpt-signin";

const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const officialAttempt = () => startChatGptSignIn({ route: "official", hostId, registration: {} as any });
const encoded = (value: any) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("official authorization has the documented parameters and fresh PKCE, state and nonce", async () => {
  const a = await officialAttempt(), b = await officialAttempt();
  const p = new URL(a.signInUrl).searchParams;
  expect(new URL(a.signInUrl).origin + new URL(a.signInUrl).pathname).toBe(OFFICIAL_AUTHORIZE);
  expect(Object.fromEntries(p)).toEqual({ response_type: "code", client_id: "dynamic_agent_client", redirect_uri: REDIRECT_URI,
    scope: OFFICIAL_SCOPES, resource: OFFICIAL_RESOURCE, ext_agent_host_id: hostId, agent_name_hint: "Embervy",
    code_challenge: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a.codeVerifier))).toString("base64url"),
    code_challenge_method: "S256", state: a.state, nonce: a.nonce! });
  expect(a.state).not.toBe(b.state); expect(a.nonce).not.toBe(b.nonce); expect(a.codeVerifier).not.toBe(b.codeVerifier);
  for (const route of ["codex", "unknown"]) {
    const legacy = await startChatGptSignIn({ route });
    const query = Object.fromEntries(new URL(legacy.signInUrl).searchParams);
    expect(query.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(query.scope).toBe("openid profile email offline_access");
    expect(query.nonce).toBeUndefined(); expect(query.resource).toBeUndefined(); expect(query.agent_name_hint).toBeUndefined();
    expect(Object.keys(query)).toHaveLength(10);
  }
});

test("official exchange verifies RS256 identity, caches and rotates JWKS, stores issued registration and rejects unsafe callbacks", async () => {
  const real = globalThis.fetch;
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  let kid = "first", keyReads = 0, exchanges = 0, grantedScope = OFFICIAL_SCOPES;
  const now = Math.floor(Date.now() / 1000);
  let claims: any;
  async function signed(overrides: any = {}, signingKid = kid) {
    const input = `${encoded({ alg: "RS256", kid: signingKid })}.${encoded({ ...claims, ...overrides })}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  }
  let tokenBody: URLSearchParams | undefined;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith("openid-configuration")) return Response.json({ issuer: "https://auth.openai.com", jwks_uri: "https://auth.openai.com/.well-known/jwks.json", authorization_endpoint: OFFICIAL_AUTHORIZE, token_endpoint: OFFICIAL_TOKEN });
    if (url.endsWith("jwks.json")) { keyReads++; return Response.json({ keys: [{ ...jwk, kid, alg: "RS256" }] }); }
    if (url === OFFICIAL_TOKEN) {
      exchanges++; tokenBody = new URLSearchParams(init.body);
      expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      return Response.json({ ...(grantedScope.includes("chatgpt.tokens.use.direct") ? { access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer" } : {}), id_token: await signed(), scope: grantedScope });
    }
    throw new Error("Unexpected mocked HTTP request");
  }) as typeof fetch;
  try {
    const a = await officialAttempt();
    claims = { iss: "https://auth.openai.com", aud: ["oaiapp_test"], sub: "subject", nonce: a.nonce, exp: now + 3600, iat: now, email: "user@example.org" };
    const pasted = `${REDIRECT_URI}?code=test-code&state=${a.state}&client_id=oaiapp_test`;
    const tokens = await exchangeChatGptCode(pasted, a);
    expect(Object.fromEntries(tokenBody!)).toEqual({ grant_type: "authorization_code", code: "test-code", client_id: "oaiapp_test", redirect_uri: REDIRECT_URI, code_verifier: a.codeVerifier, resource: OFFICIAL_RESOURCE });
    const stored = JSON.parse(chatgptAuthJson(tokens)).tokens;
    expect(stored.client_id).toBe("oaiapp_test"); expect(stored.subject).toBe("subject");
    expect(stored.ext_agent_host_id).toBe(hostId); expect(stored.scopes).toContain("chatgpt.tokens.use.direct");
    expect(stored.expires_at).toBeGreaterThan(Date.now()); expect(stored.id_token).toBeTruthy(); expect(stored.plan_usage_enabled).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "siwc-store-"));
    try {
      const file = join(directory, "auth.json");
      await writePrivateText(file, chatgptAuthJson(tokens));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, "utf8")).tokens).toEqual(stored);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    await expect(exchangeChatGptCode(pasted, a)).rejects.toThrow("already used");
    const again = await startChatGptSignIn({ route: "official", hostId, registration: tokens });
    const p = new URL(again.signInUrl).searchParams;
    expect(p.get("client_id")).toBe("oaiapp_test"); expect(p.has("agent_name_hint")).toBe(false);
    await verifyChatGptIdToken(await signed(), "oaiapp_test", a.nonce!); expect(keyReads).toBe(1);
    kid = "rotated";
    await verifyChatGptIdToken(await signed(), "oaiapp_test", a.nonce!); expect(keyReads).toBe(2);
    for (const overrides of [{ iss: "wrong" }, { aud: "wrong" }, { exp: now - 60 }, { nonce: "wrong" }, { sub: "" }, { iat: undefined }, { sid: "" }]) {
      await expect(verifyChatGptIdToken(await signed(overrides), "oaiapp_test", a.nonce!)).rejects.toThrow("identity verification failed");
    }
    const bad = (await signed()).split("."); bad[1] = encoded({ ...claims, sub: "tampered" });
    await expect(verifyChatGptIdToken(bad.join("."), "oaiapp_test", a.nonce!)).rejects.toThrow("identity verification failed");
    for (const suffix of ["?code=x&client_id=oaiapp_test", "?code=x&state=wrong&client_id=oaiapp_test", `?error=access_denied&state=${again.state}`, `?code=x&state=${again.state}&client_id=other`]) {
      await expect(exchangeChatGptCode(REDIRECT_URI + suffix, { ...again })).rejects.toThrow();
    }
    expect(exchanges).toBe(1);
    const fresh = await officialAttempt();
    await expect(exchangeChatGptCode(`${REDIRECT_URI}?code=x&state=${fresh.state}`, fresh)).rejects.toThrow("issued client ID");
    const returning = await startChatGptSignIn({ route: "official", hostId, registration: tokens });
    claims.nonce = returning.nonce;
    expect((await exchangeChatGptCode(`${REDIRECT_URI}?code=x&state=${returning.state}`, returning)).client_id).toBe("oaiapp_test");
    const wrongIdentity = await startChatGptSignIn({ route: "official", hostId, registration: tokens });
    claims.nonce = wrongIdentity.nonce; claims.sub = "another-subject";
    await expect(exchangeChatGptCode(`${REDIRECT_URI}?code=x&state=${wrongIdentity.state}`, wrongIdentity)).rejects.toThrow("identity changed");
    const disabled = await officialAttempt(); claims.nonce = disabled.nonce; grantedScope = "openid email profile";
    const signedIn = await exchangeChatGptCode(`${REDIRECT_URI}?code=x&state=${disabled.state}&client_id=oaiapp_test`, disabled);
    expect(signedIn.plan_usage_enabled).toBe(false); expect(signedIn.subject).toBe("another-subject");
    const expired = await officialAttempt(); expired.expiresAt = 1;
    await expect(exchangeChatGptCode(`${REDIRECT_URI}?code=x&state=${expired.state}`, expired)).rejects.toThrow("expired");
  } finally { globalThis.fetch = real; }
});

test("official probe lists visible slugs, requires plan permission and waits for completed inference", async () => {
  const real = globalThis.fetch;
  let mode = "completed", calls = 0;
  const tokens: any = { client_id: "issued", access_token: "mock", scopes: ["chatgpt.tokens.use.direct"] };
  globalThis.fetch = (async (url: any, init: any) => {
    calls++;
    expect(init.headers.Authorization).toBe("Bearer mock");
    if (String(url).endsWith("/models")) return Response.json({ models: [{ slug: "hidden", visibility: "hide" }, { slug: "model", display_name: "Model", visibility: "list" }] });
    expect(String(url)).toBe(`${OFFICIAL_RESOURCE}/responses`);
    const b = JSON.parse(init.body); expect(b.store).toBe(false); expect(b.stream).toBe(true); expect(b.model).toBe("model");
    const e = mode === "completed" ? { type: "response.completed", response: { output: [] } } : { type: `response.${mode}`, response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } };
    return new Response(`data: ${JSON.stringify(e)}\n\n`);
  }) as typeof fetch;
  try {
    expect((await probeChatGpt({ ...tokens, scopes: [] }, "model")).ok).toBe(false); expect(calls).toBe(0);
    expect((await probeChatGpt(tokens, "hidden")).ok).toBe(false);
    expect((await probeChatGpt(tokens, "model")).ok).toBe(true);
    mode = "failed"; expect((await probeChatGpt(tokens, "model")).detail).toContain("429");
    mode = "incomplete"; expect((await probeChatGpt(tokens, "model")).ok).toBe(false);
  } finally { globalThis.fetch = real; }
});

test("the legacy probe preserves its endpoint, headers and request body", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers).toEqual({ Authorization: "Bearer mock", "chatgpt-account-id": "account", "Content-Type": "application/json", "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs", accept: "text/event-stream" });
    expect(JSON.parse(init.body)).toEqual({ model: "model", instructions: "Reply with the single word: ok", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ok?" }] }], stream: true, store: false, reasoning: { effort: "low" } });
    return new Response('event: response.completed\ndata: {}\n\n');
  }) as typeof fetch;
  try { expect((await probeChatGpt({ access_token: "mock", account_id: "account", id_token: "", refresh_token: "" }, "model")).ok).toBe(true); }
  finally { globalThis.fetch = real; }
});

describe("the sign-in requests match the Codex CLI's", () => {
  test("authorize: loopback redirect, Codex's extra parameters, PKCE S256, no connector scopes", async () => {
    const a = await startChatGptSignIn();
    const u = new URL(a.signInUrl);
    expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
    expect(u.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(u.searchParams.get("scope")).not.toContain("connectors");
    expect(u.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(u.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(a.state);
  });

  test("token: form-encoded, the same redirect as the authorize step", async () => {
    const a = await startChatGptSignIn();
    const body = new URLSearchParams(tokenRequestBody("ac_x+y/z", a));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code", code: "ac_x+y/z", redirect_uri: REDIRECT_URI,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann", code_verifier: a.codeVerifier,
    });
  });

  test("a refused code says what to do, with OpenAI's code at the end", () => {
    const msg = tokenExchangeError(400, JSON.stringify({ error: { message: "Invalid request. Please try again later.", code: "token_exchange_user_error" } }));
    expect(msg).toContain("ask for a new sign-in link");
    expect(msg).toContain("(OpenAI: HTTP 400 token_exchange_user_error)");
    expect(tokenExchangeError(401, "not json")).toContain("(OpenAI: HTTP 401)");
    expect(tokenExchangeError(503, "down")).toBe("token exchange failed: HTTP 503");
  });
});

describe("ChatGPT head settings for a Brain that started on Claude", () => {
  const o = { home: "/opt/embervy", authFile: "/opt/embervy/Brain/state/chatgpt-auth.json", cacheKey: "embervy-abc" };

  test("a file without a ChatGPT head gains every setting, with the adapter and auth file of this house", () => {
    const lines = gptHeadEnvLines({}, o);
    expect(lines).toContain("BRAIN_GPT_CACHE_KEY=embervy-abc");
    expect(lines).toContain("BRAIN_GPT_ADAPTER=/opt/embervy/shared/tools/chatgpt-oauth-adapter.ts");
    expect(lines).toContain("CHATGPT_AUTH_FILE=/opt/embervy/Brain/state/chatgpt-auth.json");
    expect(lines).toContain("GPT_ADAPTER_PORT=3042");
    expect(lines).toContain("BRAIN_GPT_TRANSPORT=pipe");
    expect(lines.filter((l) => /^[A-Z_]+=$/.test(l))).toEqual([]);
  });

  test("an existing identity is never replaced; the port alias counts as a port", () => {
    const lines = gptHeadEnvLines({ BRAIN_GPT_CACHE_KEY: "kept", BRAIN_GPT_ADAPTER_PORT: "3050", BRAIN_GPT_MODEL: "gpt-x" }, o);
    expect(lines.some((l) => l.startsWith("BRAIN_GPT_CACHE_KEY="))).toBe(false);
    expect(lines.some((l) => l.startsWith("GPT_ADAPTER_PORT="))).toBe(false);
    expect(lines.some((l) => l.startsWith("BRAIN_GPT_MODEL="))).toBe(false);
  });

  test("a complete file gets nothing", () => {
    const full = Object.fromEntries(gptHeadEnvLines({}, o).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => l.split("=") as [string, string]));
    expect(gptHeadEnvLines(full, o)).toEqual([]);
  });

  test("the auth file has the adapter's shape", () => {
    const json = JSON.parse(chatgptAuthJson({ id_token: "i", access_token: "a", refresh_token: "r", account_id: "acc" }, new Date("2026-10-09T12:00:00Z")));
    expect(json).toEqual({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "i", access_token: "a", refresh_token: "r", account_id: "acc" }, last_refresh: "2026-10-09T12:00:00.000Z" });
  });
});
