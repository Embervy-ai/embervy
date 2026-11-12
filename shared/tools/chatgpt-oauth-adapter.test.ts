import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ChatGPT adapter listens on 127.0.0.1 only, but the agent's own browser
// can run on the same server: a page there could send a simple POST
// (text/plain needs no preflight) and spend the subscription, or read answers
// after a DNS rebinding. Accept only local, non-browser requests: the adapter's
// own loopback Host, no Origin or cross-site fetch metadata, and JSON bodies.
// Invalid JSON keeps these tests from reaching the backend even if a guard fails.

import { adapterModels, callBackend, chatgptRouteHealth, officialRequest, refreshTokens, chatToResponsesInput, chatToResponsesTools, anthropicToResponsesInput, anthropicToResponsesTools, responsesToChatCompletion, responsesToAnthropic } from "./chatgpt-oauth-adapter";
import { OFFICIAL_RESOURCE, OFFICIAL_TOKEN, readOfficialResponse } from "../scripts/chatgpt-signin";
import { statSync } from "node:fs";

const ADAPTER = join(import.meta.dir, "chatgpt-oauth-adapter.ts");
let proc: ReturnType<typeof Bun.spawn>;
let port = 0;
let dir = "";

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const p = s.port;
  s.stop(true);
  return p;
}

/** One raw HTTP/1.1 request, so the Host header is exactly what we send. */
function raw(lines: string[], body = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([...lines, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body].join("\r\n"));
    });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve(Number(data.split(" ")[1])));
    socket.on("error", reject);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "adapter-guard-"));
  const auth = join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "not-a-token", refresh_token: "not-a-token", account_id: "acct" }, last_refresh: new Date().toISOString() }));
  port = await freePort();
  proc = Bun.spawn(["bun", "run", ADAPTER], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ADAPTER_PORT: String(port), CHATGPT_AUTH_FILE: auth, ADAPTER_MODEL: "test-model" },
    stdout: "ignore",
    stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await raw([`GET /health HTTP/1.1`, `Host: 127.0.0.1:${port}`])) === 200; } catch {}
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("adapter did not come up");
}, 30_000);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const NOT_JSON = "{this is not json";

function stream(events: any[]) {
  const wire = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
  return new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(wire);
    for (let n = 0; n < bytes.length; n += 7) controller.enqueue(bytes.slice(n, n + 7));
    controller.close();
  } }));
}

test("official requests remove unsupported fields, namespace tools, collect output and replay the exact call", async () => {
  const real = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "siwc-adapter-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({ tokens: { client_id: "issued-roundtrip", access_token: "mock", scopes: ["chatgpt.tokens.use.direct"] } }));
  const call = { id: "fc_one", type: "function_call", status: "completed", name: "read_note", namespace: "house", call_id: "call_one", arguments: '{"name":"note"}' };
  const requests: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe(`${OFFICIAL_RESOURCE}/responses`);
    // Without the session headers the route lands each turn on a different machine and the prompt cache stays cold.
    expect(init.headers).toEqual({ Authorization: "Bearer mock", "Content-Type": "application/json", "session-id": "session", "thread-id": "session" });
    requests.push(JSON.parse(init.body));
    return stream([{ type: "response.output_item.done", output_index: 0, item: requests.length === 1 ? call : { type: "message", role: "assistant", content: [{ type: "output_text", text: "note contents" }] } }, { type: "response.completed", response: { output: [], usage: { input_tokens: 10 } } }]);
  }) as typeof fetch;
  try {
    const kept = { reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"], text: { verbosity: "low" }, tool_choice: "auto", parallel_tool_calls: false, prompt_cache_key: "key" };
    const unsupported = "background conversation max_output_tokens max_tool_calls metadata moderation multi_agent prompt prompt_cache_retention safety_identifier temperature top_logprobs top_p truncation user previous_response_id".split(" ");
    const body = { model: "model", input: [{ type: "message", role: "system", content: "rules" }, { role: "user", content: "read the note" }], tools: [{ type: "function", name: "read_note", parameters: { type: "object", properties: {} } }, { type: "web_search" }, { type: "tool_search" }, { type: "file_search" }], ...Object.fromEntries(unsupported.map(k => [k, "forbidden"])), ...kept, store: true, stream: false };
    const first = await callBackend(body, "session", true, file);
    expect(first.output).toEqual([call]);
    const replay = { type: "function_call", name: call.name, call_id: call.call_id, arguments: call.arguments };
    const result = { type: "function_call_output", call_id: call.call_id, output: "note contents" };
    await callBackend({ ...body, input: [...body.input, replay, result] }, "session", true, file);
    for (const request of requests) {
      for (const key of unsupported) expect(request[key]).toBeUndefined();
      for (const [key, value] of Object.entries(kept)) expect(request[key]).toEqual(value);
      expect(request.store).toBe(false); expect(request.stream).toBe(true);
      expect(request.input[0].role).toBe("developer");
      expect(request.tools).toEqual([{ type: "web_search" }, { type: "namespace", name: "house", description: "Tools executed by the house.", tools: [body.tools[0]] }]);
    }
    expect(requests[1].input).toHaveLength(4);
    expect(requests[1].input[2]).toEqual(call); expect(requests[1].input[3]).toEqual(result);
    expect(officialRequest({ input: [replay] }).input[0].namespace).toBe("house");
  } finally { globalThis.fetch = real; rmSync(directory, { recursive: true, force: true }); }
});

test("both front-end dialects translate and replay official namespace calls over mocked HTTP", async () => {
  const real = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "siwc-fronts-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({ tokens: { client_id: "issued-fronts", access_token: "mock", scopes: ["chatgpt.tokens.use.direct"] } }));
  let count = 0;
  const call = { id: "fc_front", type: "function_call", status: "completed", name: "read_note", namespace: "house", call_id: "call_front", arguments: '{"name":"note"}' };
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe(`${OFFICIAL_RESOURCE}/responses`);
    const request = JSON.parse(init.body); count++;
    expect(request.tools[0].type).toBe("namespace"); expect(request.tools[0].tools[0].name).toBe("read_note");
    if (count % 2 === 0) {
      expect(request.input.find((i: any) => i.type === "function_call")).toEqual(call);
      expect(request.input.at(-1)).toEqual({ type: "function_call_output", call_id: call.call_id, output: "note contents" });
    }
    return stream([{ type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: { output: [] } }]);
  }) as typeof fetch;
  try {
    const user = { role: "user", content: "read the note" };
    const tools = chatToResponsesTools([{ type: "function", function: { name: "read_note", parameters: { type: "object", properties: {} } } }]);
    const first = await callBackend({ model: "model", ...chatToResponsesInput([user]), tools }, "", true, file);
    const assistant = responsesToChatCompletion(first, "model").choices[0].message;
    expect(assistant.tool_calls[0].function.name).toBe("read_note");
    await callBackend({ model: "model", ...chatToResponsesInput([user, assistant, { role: "tool", tool_call_id: call.call_id, content: "note contents" }]), tools }, "", true, file);
    const am: any = { messages: [user], tools: [{ name: "read_note", input_schema: { type: "object", properties: {} } }] };
    const atools = anthropicToResponsesTools(am.tools);
    const afirst = await callBackend({ model: "model", ...anthropicToResponsesInput(am), tools: atools }, "", true, file);
    const translated = responsesToAnthropic(afirst, "model");
    expect(translated.content[0].name).toBe("read_note");
    am.messages.push({ role: "assistant", content: translated.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.call_id, content: "note contents" }] });
    await callBackend({ model: "model", ...anthropicToResponsesInput(am), tools: atools }, "", true, file);
    expect(count).toBe(4);
  } finally { globalThis.fetch = real; rmSync(directory, { recursive: true, force: true }); }
});

test("official refresh uses issued client, rotates atomically, preserves identity and handles terminal errors", async () => {
  const real = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "siwc-refresh-"));
  const file = join(directory, "auth.json");
  const initial = { client_id: "issued", access_token: "old", refresh_token: "refresh-old", id_token: "retained", subject: "subject", ext_agent_host_id: "host", scopes: ["chatgpt.tokens.use.direct"], expires_at: 1 };
  writeFileSync(file, JSON.stringify({ tokens: initial }));
  let count = 0, mode = "ok";
  globalThis.fetch = (async (url: any, init: any) => {
    count++; expect(String(url)).toBe(OFFICIAL_TOKEN);
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body);
    expect(body.get("client_id")).toBe("issued"); expect(body.get("scope")).toBeNull(); expect(body.get("resource")).toBe(OFFICIAL_RESOURCE);
    expect(body.get("grant_type")).toBe("refresh_token");
    if (mode === "temporary") return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
    if (mode === "terminal") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "new", refresh_token: "refresh-new", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct", token_type: "Bearer" });
  }) as typeof fetch;
  try {
    await Promise.all([refreshTokens("old", file), refreshTokens("old", file)]);
    expect(count).toBe(1);
    const saved = JSON.parse(readFileSync(file, "utf8")).tokens;
    expect(saved.access_token).toBe("new"); expect(saved.refresh_token).toBe("refresh-new");
    expect(saved.client_id).toBe(initial.client_id); expect(saved.ext_agent_host_id).toBe(initial.ext_agent_host_id); expect(saved.id_token).toBe("retained");
    expect(saved.scopes).toEqual(["openid", "chatgpt.tokens.use.direct"]); expect(saved.expires_at).toBeGreaterThan(Date.now());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    mode = "temporary"; await expect(refreshTokens("new", file)).rejects.toThrow("503");
    expect(JSON.parse(readFileSync(file, "utf8")).tokens.access_token).toBe("new");
    mode = "terminal"; await expect(refreshTokens("new", file)).rejects.toThrow("sign_in_required");
    const cleared = JSON.parse(readFileSync(file, "utf8")).tokens;
    expect(cleared.access_token).toBe(""); expect(cleared.refresh_token).toBe(""); expect(cleared.id_token).toBe(""); expect(cleared.client_id).toBe("issued");
  } finally { globalThis.fetch = real; rmSync(directory, { recursive: true, force: true }); }
});

test("official inference refreshes near expiry and retries a rejected bearer only once", async () => {
  const real = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "siwc-renew-"));
  const file = join(directory, "auth.json");
  let mode = "expired", refreshes = 0, inferences = 0;
  const save = (expires_at: number) => writeFileSync(file, JSON.stringify({ tokens: { client_id: "issued", access_token: "old", refresh_token: "refresh", scopes: ["chatgpt.tokens.use.direct"], expires_at } }));
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url) === OFFICIAL_TOKEN) {
      refreshes++;
      expect(new URLSearchParams(init.body).get("client_id")).toBe("issued");
      return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
    }
    expect(String(url)).toBe(`${OFFICIAL_RESOURCE}/responses`); inferences++;
    if (mode === "rejected" && inferences === 1 || mode === "always-rejected") return Response.json({ detail: "rejected" }, { status: 401 });
    expect(init.headers.Authorization).toBe("Bearer new");
    return stream([{ type: "response.completed", response: { output: [] } }]);
  }) as typeof fetch;
  try {
    save(1);
    await callBackend({ model: "model", input: [] }, "", true, file);
    expect(refreshes).toBe(1); expect(inferences).toBe(1);
    mode = "rejected"; refreshes = inferences = 0; save(Date.now() + 3600000);
    await callBackend({ model: "model", input: [] }, "", true, file);
    expect(refreshes).toBe(1); expect(inferences).toBe(2);
    mode = "always-rejected"; refreshes = inferences = 0; save(Date.now() + 3600000);
    await expect(callBackend({ model: "model", input: [] }, "", true, file)).rejects.toThrow("401");
    expect(refreshes).toBe(1); expect(inferences).toBe(2);
  } finally { globalThis.fetch = real; rmSync(directory, { recursive: true, force: true }); }
});

test("legacy credentials keep the old wire request regardless of the route switch", async () => {
  const real = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "siwc-legacy-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({ tokens: { access_token: "mock", account_id: "account" } }));
  const body = { model: "model", input: [], prompt_cache_key: "key", reasoning: { effort: "high" }, stream: true, store: false };
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.body).toBe(JSON.stringify(body));
    expect(init.headers).toEqual({ Authorization: "Bearer mock", "chatgpt-account-id": "account", "Content-Type": "application/json", "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs", accept: "text/event-stream", "session-id": "legacy-session", "thread-id": "legacy-session" });
    return stream([{ type: "response.completed", response: { output: [] } }]);
  }) as typeof fetch;
  try {
    await callBackend(body, "legacy-session", true, file);
    for (const setting of ["codex", "unknown", ""]) expect(chatgptRouteHealth({}, setting)).toEqual({ route: "codex" });
    expect(chatgptRouteHealth({}, "official").notice).toBe("signed in the old way; sign in again to use the official route");
    expect(chatgptRouteHealth({ client_id: "issued" }, "official")).toEqual({ route: "official" });
    expect(chatgptRouteHealth({ client_id: "issued" }, "codex")).toEqual({ route: "official" });
  } finally { globalThis.fetch = real; rmSync(directory, { recursive: true, force: true }); }
});

test("model catalog filters visibility and uses ordered slugs", async () => {
  const real = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "siwc-models-"));
  const file = join(directory, "auth.json");
  writeFileSync(file, JSON.stringify({ tokens: { client_id: "issued", access_token: "mock" } }));
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe(`${OFFICIAL_RESOURCE}/models`); expect(init.headers.Authorization).toBe("Bearer mock");
    return Response.json({ models: [{ slug: "second", display_name: "Second", visibility: "list" }, { slug: "hidden", visibility: "hidden" }, { slug: "first", display_name: "First", visibility: "list" }] });
  }) as typeof fetch;
  try { expect((await adapterModels(file)).map(m => m.id)).toEqual(["second", "first"]); }
  finally { globalThis.fetch = real; rmSync(directory, { recursive: true, force: true }); }
});

test("doctor reads each house's route setting without needing adapter environment forwarding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "siwc-doctor-"));
  const authFile = join(directory, "auth.json");
  const brainEnv = join(directory, "brain.env");
  try {
    for (const harness of ["brain", "claude"]) for (const [setting, issued, notice] of [["official", false, true], ["codex", false, false], ["unknown", false, false], ["official", true, false]] as const) {
      writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "mock", ...(issued ? { client_id: "issued" } : {}) } }));
      const settings = `CHATGPT_ROUTE=${setting}\nCHATGPT_AUTH_FILE=${authFile}\n`;
      writeFileSync(join(directory, ".env"), `EMBERVY_HARNESS=${harness}\nEMBERVY_SUBSTRATE=${harness}\n${harness === "claude" ? settings : ""}`);
      writeFileSync(brainEnv, harness === "brain" ? settings : "");
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "embervy-doctor.ts"), "--offline", "--json"], {
        cwd: directory, env: { HOME: directory, PATH: process.env.PATH, EMBERVY_HOME: directory, BRAIN_ENV_FILE: brainEnv }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      await child.exited;
      const result = JSON.parse(output);
      const line = result.checks.find((c: any) => c.id === "chatgpt.route");
      expect(Boolean(line)).toBe(notice);
      if (notice) expect(line.detail).toBe("signed in the old way; sign in again to use the official route");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

test("official HTTP and stream errors retain status, code, parameter and request ID without leaking bodies", async () => {
  for (const status of [401, 403, 503]) {
    try { await readOfficialResponse(Response.json({ detail: "private diagnostic" }, { status, headers: { "x-request-id": "request" } })); throw new Error("Expected failure"); }
    catch (error: any) { expect(error.status).toBe(status); expect(error.requestId).toBe("request"); expect(error.upstream).toEqual({ detail: "[redacted]" }); expect(error.message).not.toContain("private diagnostic"); }
  }
  const codes: Record<string, number> = { subscription_sharing_user_not_eligible: 403, subscription_sharing_usage_limit_exceeded: 429, subscription_sharing_usage_unavailable: 503, subscription_sharing_unsupported_capability: 400, subscription_sharing_route_not_supported: 403, subscription_sharing_invalid_user: 401, chatpass_v2_scope_not_authorized: 403, chatpass_v2_invalid_authorization_context: 403, subscription_sharing_user_unavailable: 503 };
  for (const [code, status] of Object.entries(codes)) {
    try { await readOfficialResponse(stream([{ type: "response.failed", response: { error: { code, param: "tools" } } }])); throw new Error("Expected failure"); }
    catch (error: any) { expect(error.status).toBe(status); expect(error.code).toBe(code); expect(error.param).toBe("tools"); }
  }
  await expect(readOfficialResponse(stream([{ type: "response.incomplete" }]))).rejects.toThrow("response_incomplete");
  await expect(readOfficialResponse(stream([]))).rejects.toThrow("stream_interrupted");
});

describe("chatgpt-oauth-adapter: only local, non-browser clients", () => {
  test("its own loopback host passes", async () => {
    expect(await raw([`GET /health HTTP/1.1`, `Host: 127.0.0.1:${port}`])).toBe(200);
    expect(await raw([`GET /health HTTP/1.1`, `Host: localhost:${port}`])).toBe(200);
  });

  test("a foreign host (DNS rebinding) is refused", async () => {
    expect(await raw([`GET /health HTTP/1.1`, `Host: rebind.example:${port}`])).toBe(421);
  });

  test("a simple POST that is not JSON is refused before it is read", async () => {
    expect(await raw([`POST /v1/messages HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Type: text/plain"], NOT_JSON)).toBe(415);
  });

  test("a request a browser page sent is refused", async () => {
    expect(await raw([`POST /v1/chat/completions HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Type: application/json", "Origin: https://page.example"], NOT_JSON)).toBe(403);
    expect(await raw([`POST /v1/messages HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Content-Type: application/json", "Sec-Fetch-Site: cross-site"], NOT_JSON)).toBe(403);
  });

  test("a refreshed login is written whole: temp file, then rename, owner-only", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const refresh = src.slice(src.indexOf("async function refreshTokens"), src.indexOf("const turnState = new Map<string, string>();"));
    expect(refresh).not.toMatch(/writeFileSync\(AUTH_FILE/);
    expect(refresh).toContain("refreshStoredCredential(AUTH_FILE");
    expect(refresh).toContain("writePrivateJson(AUTH_FILE, a)");
  });
});

test("chat completions report the cached share of the prompt, so clients do not see every turn as cold", () => {
  const resp = { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1000, output_tokens: 5, total_tokens: 1005, input_tokens_details: { cached_tokens: 960 } } };
  expect(responsesToChatCompletion(resp, "model").usage.prompt_tokens_details).toEqual({ cached_tokens: 960 });
  expect(responsesToChatCompletion({ output: [], usage: { input_tokens: 10 } }, "model").usage.prompt_tokens_details).toEqual({ cached_tokens: 0 });
});
