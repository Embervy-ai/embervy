import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBackend, chatToResponsesInput, isImageTurn, requestDiagnosticJson } from "./chatgpt-oauth-adapter.ts";

const url = "data:image/png;base64,PRIVATE_IMAGE_BYTES";
const image = { type: "image_url", image_url: { url } };
const text = (value: string) => ({ type: "text", text: value });

describe("Chat Completions incoming images", () => {
  test("text and image remain in order in the same user message", () => {
    const messages = [{ role: "user", content: [text("Describe this."), image] }];
    const before = JSON.stringify(messages);
    expect(chatToResponsesInput(messages)).toEqual({
      instructions: "You are a helpful assistant.",
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "Describe this." },
        { type: "input_image", image_url: url },
      ] }],
    });
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("image-first, interleaved text, empty text and multiple images retain their order", () => {
    const remote = "https://example.invalid/picture.png";
    const { input } = chatToResponsesInput([{ role: "user", content: [image, text(""), text("Compare."),
      { type: "image_url", image_url: { url: remote } }, text("After.")] }]);
    expect(input[0].content).toEqual([
      { type: "input_image", image_url: url }, { type: "input_text", text: "" },
      { type: "input_text", text: "Compare." }, { type: "input_image", image_url: remote },
      { type: "input_text", text: "After." },
    ]);
  });

  test("an image-only message is not flattened to empty text", () => {
    expect(chatToResponsesInput([{ role: "user", content: [image] }]).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_image", image_url: url }] },
    ]);
  });

  // Literal pre-change JSON, not an expectation calculated with the new converter.
  test("byte regression: string content keeps the historical output", () => {
    expect(JSON.stringify(chatToResponsesInput([{ role: "user", content: "  Été\nworld!  " }]))).toBe(
      '{"instructions":"You are a helpful assistant.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"  Été\\nworld!  "}]}]}',
    );
  });

  test("byte regression: text-only list keeps the historical newline-joined output", () => {
    expect(JSON.stringify(chatToResponsesInput([{ role: "user", content: [text(" first "), text(""), text("last\nline")] }]))).toBe(
      '{"instructions":"You are a helpful assistant.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":" first \\n\\nlast\\nline"}]}]}',
    );
  });

  test("other text roles retain their existing representations", () => {
    expect(chatToResponsesInput([
      { role: "system", content: [text("Rule"), text("two")] },
      { role: "assistant", content: [text("A"), text("B")] },
      { role: "assistant", content: "Calling", tool_calls: [{ id: "c", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c", content: "result" },
    ])).toEqual({ instructions: "Rule\ntwo", input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "A\nB" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Calling" }] },
      { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "result" },
    ] });
  });

  for (const role of ["system", "assistant", "tool", "developer"]) {
    test(`rejects image parts in ${role} rather than losing them`, () => {
      expect(() => chatToResponsesInput([{ role, content: [text("Before"), image] }])).toThrow("only in user messages");
    });
  }

  test("rejects an assistant image before the tool-call branch", () => {
    expect(() => chatToResponsesInput([{ role: "assistant", content: [image],
      tool_calls: [{ id: "c", function: { name: "f" } }] }])).toThrow("only in user messages");
  });

  test("malformed image URLs fail clearly without echoing the payload", () => {
    for (const image_url of [undefined, null, url, {}, { url: "" }, { url: "  " }, { url: 42 }]) {
      expect(() => chatToResponsesInput([{ role: "user", content: [{ type: "image_url", image_url }] }]))
        .toThrow("require image_url: { url: <non-empty string> }");
    }
  });

  test("wrong image dialects are rejected, not silently flattened", () => {
    for (const type of ["image", "input_image"]) {
      expect(() => chatToResponsesInput([{ role: "user", content: [{ type, image_url: url }] }]))
        .toThrow("Chat Completions images must use type image_url");
    }
  });
});

describe("image-safe diagnostics", () => {
  test("all supported image dialects, including nested tool results, expose only type and length", () => {
    const source = { content: [image, { type: "input_image", image_url: url },
      { type: "tool_result", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "PRIVATE_IMAGE_BYTES" } },
        { type: "image", source: { type: "url", url } },
      ] }] };
    const before = JSON.stringify(source);
    const safe = requestDiagnosticJson(source);
    expect(JSON.parse(safe)).toEqual({ content: [
      { type: "image_url", length: url.length }, { type: "input_image", length: url.length },
      { type: "tool_result", content: [{ type: "image", length: 19 }, { type: "image", length: url.length }] },
    ] });
    expect(safe).not.toContain("PRIVATE_IMAGE_BYTES");
    expect(safe).not.toContain("data:image");
    expect(JSON.stringify(source)).toBe(before);
  });

  test("size estimates do not treat base64 as prose; text-only estimates stay identical", () => {
    const value = { messages: [{ role: "user", content: [text("Hi")] }] };
    expect(requestDiagnosticJson(value)).toBe(JSON.stringify(value));
    expect(requestDiagnosticJson({ type: "input_image", image_url: "x".repeat(100_000) }))
      .toBe('{"type":"input_image","length":100000}');
  });
});

test("mock Codex wire retains the image; this does not prove live endpoint acceptance", async () => {
  const realFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), "adapter-image-wire-"));
  const auth = join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "mock", account_id: "mock" } }));
  const body = { model: "test-model", ...chatToResponsesInput([{ role: "user", content: [text("Look"), image] }]), stream: true, store: false };
  let calls = 0;
  globalThis.fetch = (async (endpoint: any, init: any) => {
    calls++;
    expect(String(endpoint)).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.body).toBe(JSON.stringify(body));
    expect(JSON.parse(init.body).input[0].content[1]).toEqual({ type: "input_image", image_url: url });
    return new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n');
  }) as typeof fetch;
  try {
    await callBackend(body, "image-test", true, auth);
    expect(calls).toBe(1);
  } finally { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); }
});

test("local HTTP: Codex fixture health, invalid-image 400, image-safe counts and error logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-image-http-"));
  const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = socket.port;
  socket.stop(true);
  const auth = join(dir, "auth.json");
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "mock", account_id: "mock" } }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "chatgpt-oauth-adapter.ts")], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ADAPTER_PORT: String(port), CHATGPT_AUTH_FILE: auth },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  try {
    let health: any;
    for (let i = 0; i < 100; i++) {
      try { health = await (await fetch(base + "/health")).json(); break; } catch { await Bun.sleep(30); }
    }
    expect(health?.route).toBe("codex"); // Fake legacy credentials only, not a running house.
    const cases = [
      ...["system", "assistant", "tool", "developer"].map(role => ({ role, part: image, code: "unsupported_image_role" })),
      ...[undefined, null, url, {}, { url: "" }, { url: "  " }, { url: 42 }].map(image_url =>
        ({ role: "user", part: { type: "image_url", image_url }, code: "invalid_image_part" })),
      ...["image", "input_image"].map(type => ({ role: "user", part: { type, image_url: url }, code: "unsupported_image_format" })),
    ];
    for (const historical of [false, true]) {
      for (const { role, part, code } of cases) {
        const messages = [{ role, content: [text("PRIVATE_REQUEST_TEXT"), part] },
          ...(historical ? [{ role: "assistant", content: "Seen." }, { role: "user", content: "Continue." }] : [])];
        if (historical) expect(isImageTurn({ messages })).toBe(false);
        const response = await post("/v1/chat/completions", JSON.stringify({ messages }));
        expect(response.status).toBe(400);
        const { error } = await response.json();
        expect(error).toEqual({ code, phase: "input", status: 400, message: {
          unsupported_image_role: "Image parts are supported only in user messages (not system, assistant, tool or other roles).",
          invalid_image_part: "User image_url parts require image_url: { url: <non-empty string> }.",
          unsupported_image_format: "Chat Completions images must use type image_url with image_url: { url }.",
        }[code] });
      }
    }
    const messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "x".repeat(100_000) } }] }];
    const counted = await post("/v1/messages/count_tokens", JSON.stringify({ messages }));
    expect((await counted.json()).input_tokens).toBe(Math.ceil(requestDiagnosticJson(messages).length / 4) + 2);
    // Invalid JSON has no parsed image part; ordinary parser diagnostics are retained.
    expect((await post("/v1/chat/completions", "{not json")).status).toBe(502);
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { recursive: true, force: true });
  }
  const logs = (await stdout) + (await stderr);
  const imageLogs = logs.split("\n").filter(line => line.includes("code="));
  expect(imageLogs).toEqual([
    ...Array(4).fill("[adapter] code=unsupported_image_role phase=input status=400"),
    ...Array(7).fill("[adapter] code=invalid_image_part phase=input status=400"),
    ...Array(2).fill("[adapter] code=unsupported_image_format phase=input status=400"),
    ...Array(4).fill("[adapter] code=unsupported_image_role phase=input status=400"),
    ...Array(7).fill("[adapter] code=invalid_image_part phase=input status=400"),
    ...Array(2).fill("[adapter] code=unsupported_image_format phase=input status=400"),
  ]);
  expect(logs).not.toContain("PRIVATE_REQUEST_TEXT");
  expect(logs).not.toContain("PRIVATE_IMAGE_BYTES");
  expect(logs).not.toContain("data:image");
}, 15_000);

// Isolated process per fixture: replayDisabled is process-wide. Preload replaces
// provider fetch entirely; only the parent talks to the loopback adapter server.
async function mockAdapter(official = false) {
  const dir = mkdtempSync(join(tmpdir(), "adapter-image-provider-"));
  const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = socket.port;
  socket.stop(true);
  const auth = join(dir, "auth.json");
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(callsFile, "");
  writeFileSync(auth, JSON.stringify({ tokens: official
    ? { client_id: "issued-test", access_token: "mock", scopes: ["chatgpt.tokens.use.direct"] }
    : { access_token: "mock", account_id: "mock" } }));
  const preload = join(dir, "mock.ts");
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    let rejectedText = false;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(body) + "\\n");
      const raw = JSON.stringify(body);
      const hasImage = raw.includes('"type":"input_image"');
      if (hasImage && raw.includes("NETWORK_FAIL")) throw new Error("PRIVATE_PROVIDER_TEXT " + raw);
      if (hasImage && raw.includes("STREAM_FAIL")) return new Response('data: ' + JSON.stringify({
        type: "response.failed", error: { message: "PRIVATE_PROVIDER_TEXT " + raw }
      }) + '\\n\\n');
      if ((hasImage && !(raw.includes("HISTORY_RETRY_OK") && !body.include?.includes("reasoning.encrypted_content")))
        || raw.includes("TEXT_ALWAYS") || (raw.includes("TEXT_ONCE") && !rejectedText)) {
        rejectedText = true;
        const status = raw.includes("STATUS_429") ? 429 : raw.includes("STATUS_500") ? 500 : 400;
        return Response.json({ error: { code: "private_provider_code", param: "private_param",
          message: "PRIVATE_PROVIDER_TEXT " + (raw.includes("HISTORY_")
            ? "echo:" + raw.match(/base64,([A-Za-z0-9+/=]+)/)?.[1] + " extra:" + "Z".repeat(200) + " "
            : "") + raw + "X".repeat(400) + "TRUNCATED_TAIL" }, request_id: "PRIVATE_REQUEST_ID" },
          { status, headers: { "x-request-id": "PRIVATE_REQUEST_ID" } });
      }
      return new Response('data: ' + JSON.stringify({ type: "response.completed", response: {
        output: [{ type: "reasoning", id: "r", summary: [], encrypted_content: "mock-reasoning" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1 }
      } }) + '\\n\\n');
    };
  `);
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "chatgpt-oauth-adapter.ts")], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ADAPTER_PORT: String(port), CHATGPT_AUTH_FILE: auth,
      ADAPTER_REASONING_REPLAY: "1", ADAPTER_WEB_SEARCH: "0", ADAPTER_NATIVE_WEB_SEARCH: "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    child.kill();
    await child.exited;
    const logs = { stdout: await stdout, stderr: await stderr };
    rmSync(dir, { recursive: true, force: true });
    return logs;
  };
  try {
    let up = false;
    for (let i = 0; i < 100; i++) {
      try { up = (await fetch(base + "/health")).ok; if (up) break; } catch {}
      await Bun.sleep(30);
    }
    if (!up) throw new Error("mock adapter did not start");
  } catch (err) { await stop(); throw err; }
  return {
    request: (path: string, body: any) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) }),
    post: (path: string, content: any[]) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content }] }) }),
    calls: () => readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    stop,
  };
}

const anthropicImage = { type: "image", source: { type: "base64", media_type: "image/png", data: "PRIVATE_IMAGE_BYTES" } };

describe("image-turn boundary", () => {
  const nested = { type: "tool_result", content: [anthropicImage] };
  const assistant = { role: "assistant", content: "Seen." };
  for (const part of [image, anthropicImage, nested]) {
    test(`only messages after the last completing assistant count: ${part.type}`, () => {
      const picture = { role: "user", content: [part] };
      const plain = { role: "user", content: "Continue." };
      expect(isImageTurn({ messages: [picture, plain] })).toBe(true); // No assistant: all messages.
      expect(isImageTurn({ messages: [assistant, picture, plain] })).toBe(true); // Not just the final message.
      expect(isImageTurn({ messages: [picture, assistant, plain] })).toBe(false);
      expect(isImageTurn({ messages: [assistant, picture, assistant, plain] })).toBe(false);
      expect(isImageTurn({ messages: [picture, assistant, plain, picture] })).toBe(true);
      expect(isImageTurn({ messages: [{ role: "assistant", content: [part] }] })).toBe(false);
      expect(isImageTurn({ system: [part], messages: [assistant, plain] })).toBe(true);
    });
  }
  test("tool-call assistants never close the turn; empty tool calls and text replies do", () => {
    const picture = { role: "user", content: [image] };
    const plain = { role: "user", content: "Continue." };
    const continuations = [
      { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "assistant", content: [text("Reading"), { type: "tool_use", id: "c", name: "read", input: {} }] },
    ];
    const completions = [assistant,
      { role: "assistant", content: "Done.", tool_calls: [] },
      { role: "assistant", content: [text("Done.")] },
    ];
    for (const continuation of continuations) {
      expect(isImageTurn({ messages: [picture, continuation, plain, continuation, plain] })).toBe(true);
      expect(isImageTurn({ messages: [assistant, picture, continuation, plain] })).toBe(true);
      for (const completion of completions) {
        expect(isImageTurn({ messages: [picture, continuation, plain, completion, plain] })).toBe(false);
        // An older picture must not become current again when a new text turn calls a tool.
        expect(isImageTurn({ messages: [picture, completion, plain, continuation, plain] })).toBe(false);
      }
    }
  });
  test("empty/missing messages are not image turns", () => {
    expect(isImageTurn({})).toBe(false);
    expect(isImageTurn({ messages: [] })).toBe(false);
  });
});

const toolHopCases = [
  ...[1, 2].map(rounds => ({
    name: `chat with ${rounds} tool round(s)`, path: "/v1/chat/completions",
    messages: [
      { role: "user", content: [text("PRIVATE_REQUEST_TEXT"), image] },
      ...Array.from({ length: rounds }, (_, i) => [
        { role: "assistant", content: "Reading", tool_calls: [
          { id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: `c${i}`, content: "Tool result" },
      ]).flat(),
    ],
  })),
  {
    name: "anthropic with image result then text result", path: "/v1/messages",
    messages: [
      { role: "user", content: [text("PRIVATE_REQUEST_TEXT")] },
      { role: "assistant", content: [text("Reading"), { type: "tool_use", id: "c0", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c0", content: [text("Picture"), anthropicImage] }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "Tool result" }] },
    ],
  },
];

for (const { name, path, messages } of toolHopCases) {
  test(`${name}: provider 400 keeps replay across tool hops; completion restores text fallback`, async () => {
    const adapter = await mockAdapter();
    let logs: { stdout: string; stderr: string };
    try {
      // Seed actual replay content, not only the include flag.
      expect((await adapter.post(path, [text("Seed reasoning")])).status).toBe(200);
      const current = [{ role: "user", content: "Seed reasoning" }, { role: "assistant", content: "ok" }, ...messages];
      const failure = await adapter.request(path, { messages: current });
      expect(failure.status).toBe(400);
      expect((await failure.json()).error).toMatchObject({ code: "image_provider_error", phase: "provider", status: 400 });
      expect(adapter.calls().length).toBe(2); // Seed + one attempt, no replay retry.
      const failedCall = adapter.calls()[1];
      expect(failedCall.include).toContain("reasoning.encrypted_content");
      expect(failedCall.input.some((item: any) => item.type === "reasoning")).toBe(true);
      expect(JSON.stringify(failedCall.input)).toContain("PRIVATE_IMAGE_BYTES");
      expect(failedCall.input.filter((item: any) => item.type === "function_call").length)
        .toBe(path === "/v1/messages" ? 2 : messages.filter(m => m.role === "assistant").length);
      expect(failedCall.input.at(-1).type).toBe("function_call_output");
      expect((await adapter.post(path, [text("Following text request")])).status).toBe(200);
      expect(adapter.calls().length).toBe(3);
      expect(adapter.calls()[2].include).toContain("reasoning.encrypted_content");

      // A completing assistant makes the very same tool-chain image historical.
      const completion = path === "/v1/messages"
        ? { role: "assistant", content: [text("ok")] }
        : { role: "assistant", content: "ok", tool_calls: [] };
      const history = [...current, completion, { role: "user", content: "HISTORY_RETRY_OK" }];
      expect(isImageTurn({ messages: history })).toBe(false);
      expect((await adapter.request(path, { messages: history })).status).toBe(200);
      const calls = adapter.calls();
      expect(calls.length).toBe(5);
      expect(calls[3].include).toContain("reasoning.encrypted_content");
      expect(calls[3].input.some((item: any) => item.type === "reasoning")).toBe(true);
      expect(calls[4].include).toBeUndefined();
      expect(calls[4].input.some((item: any) => item.type === "reasoning")).toBe(false);
      expect(JSON.stringify(calls[4].input)).toContain("PRIVATE_IMAGE_BYTES");
    } finally { logs = await adapter.stop(); }
    expect(logs.stderr.trim()).toBe("[adapter] code=image_provider_error phase=provider status=400");
    expect(logs.stdout.split("reasoning replay rejected").length - 1).toBe(1); // Only after completion.
  }, 15_000);
}

for (const path of ["/v1/chat/completions", "/v1/messages"]) {
  for (const retrySucceeds of [true, false]) {
    test(`${path}: same image becomes history; replay retry ${retrySucceeds ? "succeeds" : "fails"} with safe logs`, async () => {
      const adapter = await mockAdapter();
      const payload = "Ab9+/Q".repeat(80);
      const part = path === "/v1/messages"
        ? { type: "tool_result", tool_use_id: "c", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: payload } }] }
        : { type: "image_url", image_url: { url: `data:image/png;base64,${payload}` } };
      const messages = [{ role: "user", content: "Seed reasoning" }, { role: "assistant", content: "ok" },
        { role: "user", content: [part] }];
      let logs: { stdout: string; stderr: string };
      try {
        expect((await adapter.post(path, [text("Seed reasoning")])).status).toBe(200);
        const first = await adapter.request(path, { messages });
        expect(first.status).toBe(400);
        expect((await first.json()).error).toMatchObject({ code: "image_provider_error", phase: "provider", status: 400 });
        expect(adapter.calls().length).toBe(2); // Seed + exactly one image attempt.
        expect(adapter.calls()[1].include).toContain("reasoning.encrypted_content");
        expect(adapter.calls()[1].input.some((item: any) => item.type === "reasoning")).toBe(true);

        const history = [...messages, { role: "assistant", content: "ok" },
          { role: "user", content: retrySucceeds ? "HISTORY_RETRY_OK" : "HISTORY_ALWAYS_FAIL" }];
        expect(isImageTurn({ messages: history })).toBe(false);
        const second = await adapter.request(path, { messages: history });
        expect(second.status).toBe(retrySucceeds ? 200 : 502);
        const result = await second.json();
        if (!retrySucceeds) expect(result.error.code).toBeUndefined(); // Ordinary legacy error, not image_provider_error.
        const calls = adapter.calls();
        expect(calls.length).toBe(4);
        expect(calls[2].include).toContain("reasoning.encrypted_content");
        expect(calls[2].input.some((item: any) => item.type === "reasoning")).toBe(true);
        expect(calls[3].include).toBeUndefined();
        expect(calls[3].input.some((item: any) => item.type === "reasoning")).toBe(false);
        expect(JSON.stringify(calls[3].input)).toContain(payload); // Retry removes replay, never the image.
        expect((await adapter.post(path, [text("Following text request")])).status).toBe(200);
        expect(adapter.calls().length).toBe(5);
        expect(adapter.calls().at(-1).include).toBeUndefined();
      } finally { logs = await adapter.stop(); }
      const all = logs.stdout + logs.stderr;
      expect(all).not.toContain(payload.slice(0, 12));
      expect(all).not.toContain("Z".repeat(12)); // Also redact unknown reflected Base64 runs, including exactly 200 chars.
      expect(all).not.toContain("TRUNCATED_TAIL");
      const replayLines = logs.stdout.split("\n").filter(line => line.includes("reasoning replay rejected"));
      expect(replayLines.length).toBe(1);
      expect(replayLines[0]).toContain("PRIVATE_PROVIDER_TEXT echo:[image base64 omitted] extra:[image base64 omitted]");
      expect(replayLines[0].length).toBeLessThanOrEqual("[adapter] reasoning replay rejected, disabling: ".length + 300);
      expect(logs.stderr).toContain("code=image_provider_error phase=provider status=400");
      if (!retrySucceeds) {
        expect(logs.stderr).toContain("PRIVATE_PROVIDER_TEXT echo:[image base64 omitted] extra:[image base64 omitted]");
        expect(logs.stderr.trim().split("\n").at(-1)!.length).toBeLessThanOrEqual("[adapter] ".length + 300);
      }
    }, 15_000);
  }

  test(`${path}: a system-field image is always a local fixed-code 400`, async () => {
    const adapter = await mockAdapter();
    let logs: { stdout: string; stderr: string };
    try {
      const response = await adapter.request(path, { system: [anthropicImage], messages: [
        { role: "assistant", content: "Old reply" }, { role: "user", content: "Text" },
      ] });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatchObject({ code: "unsupported_image_role", phase: "input", status: 400 });
      expect(adapter.calls()).toEqual([]);
    } finally { logs = await adapter.stop(); }
    expect(logs.stderr.trim()).toBe("[adapter] code=unsupported_image_role phase=input status=400");
    expect(logs.stdout + logs.stderr).not.toContain("PRIVATE_IMAGE_BYTES");
  }, 15_000);
}
for (const official of [false, true]) {
  for (const [path, part, name] of [
    ["/v1/chat/completions", image, "chat"],
    ["/v1/messages", anthropicImage, "anthropic direct"],
    ["/v1/messages", { type: "tool_result", tool_use_id: "c", content: [anthropicImage] }, "anthropic tool result"],
  ] as const) {
    test(`${official ? "official" : "codex"} ${name}: image provider errors are private and never disable replay`, async () => {
      const adapter = await mockAdapter(official);
      let logs: { stdout: string; stderr: string };
      try {
        for (const [marker, providerStatus, httpStatus] of [
          ["STATUS_400", 400, 400], ["STATUS_429", 429, 429], ["STATUS_500", 500, 500],
          ["STREAM_FAIL", 200, 502], ["NETWORK_FAIL", undefined, 502],
        ] as const) {
          const before = adapter.calls().length;
          const response = await adapter.post(path, [text(marker + " PRIVATE_REQUEST_TEXT"), part]);
          expect(response.status).toBe(httpStatus);
          const result = await response.json();
          expect(result.error).toEqual({
            ...(path === "/v1/messages" ? { type: httpStatus === 429 ? "rate_limit_error" : httpStatus === 400 ? "invalid_request_error" : "api_error" } : {}),
            code: "image_provider_error", phase: "provider",
            message: "The image request could not be completed by the provider.",
            ...(providerStatus === undefined ? {} : { status: providerStatus }),
          });
          expect(adapter.calls().length).toBe(before + 1);
          expect(adapter.calls().at(-1).include).toContain("reasoning.encrypted_content");
          const followup = await adapter.post(path, [text("Following text request")]);
          expect(followup.status).toBe(200);
          expect(adapter.calls().length).toBe(before + 2);
          expect(adapter.calls().at(-1).include).toContain("reasoning.encrypted_content");
        }
      } finally { logs = await adapter.stop(); }
      expect(logs.stderr.trim().split("\n")).toEqual([400, 429, 500, 200, "unknown"].map(status =>
        `[adapter] code=image_provider_error phase=provider status=${status}`));
      const all = logs.stdout + logs.stderr;
      for (const secret of ["PRIVATE_", "private_provider_code", "private_param", "data:image", "reasoning replay rejected"]) {
        expect(all).not.toContain(secret);
      }
    }, 15_000);
  }
}

for (const path of ["/v1/chat/completions", "/v1/messages"]) {
  test(`${path}: text HTTP 400 still retries once, disables replay and logs truncated error text`, async () => {
    const adapter = await mockAdapter();
    let logs: { stdout: string; stderr: string };
    try {
      expect((await adapter.post(path, [text("TEXT_ONCE")])).status).toBe(200);
      const calls = adapter.calls();
      expect(calls.length).toBe(2);
      expect(calls[0].include).toContain("reasoning.encrypted_content");
      expect(calls[1].include).toBeUndefined();
      expect((await adapter.post(path, [text("Following text request")])).status).toBe(200);
      expect(adapter.calls().at(-1).include).toBeUndefined();
      const failure = await adapter.post(path, [text("TEXT_ALWAYS")]);
      expect(failure.status).toBe(502); // Legacy Codex text error envelope/status unchanged.
      expect((await failure.json()).error.message).toContain("PRIVATE_PROVIDER_TEXT");
      expect(adapter.calls().length).toBe(4);
    } finally { logs = await adapter.stop(); }
    const replayLine = logs.stdout.split("\n").find(line => line.startsWith("[adapter] reasoning replay rejected"))!;
    expect(replayLine).toContain("reasoning replay rejected, disabling: Error: backend HTTP 400:");
    expect(replayLine).toContain("PRIVATE_PROVIDER_TEXT");
    expect(replayLine.length).toBe("[adapter] reasoning replay rejected, disabling: ".length + 300);
    expect(logs.stderr.trim()).toContain("[adapter] backend HTTP 400:");
    expect(logs.stderr.trim()).toContain("PRIVATE_PROVIDER_TEXT");
    expect(logs.stderr.trim().length).toBe("[adapter] ".length + 300);
    expect(logs.stdout + logs.stderr).not.toContain("TRUNCATED_TAIL");
  }, 15_000);

  test(`${path}: official text 400 keeps its historical envelope and does not match the legacy replay trigger`, async () => {
    const adapter = await mockAdapter(true);
    let logs: { stdout: string; stderr: string };
    try {
      const response = await adapter.post(path, [text("TEXT_ONCE")]);
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.code).toBe("private_provider_code");
      expect(error.param).toBe("private_param");
      expect(error.request_id).toBe("PRIVATE_REQUEST_ID");
      expect(error.upstream).toBeDefined();
      expect(adapter.calls().length).toBe(1);
      expect((await adapter.post(path, [text("Following text request")])).status).toBe(200);
      expect(adapter.calls().length).toBe(2);
      expect(adapter.calls().at(-1).include).toContain("reasoning.encrypted_content");
    } finally { logs = await adapter.stop(); }
    expect(logs.stderr.trim()).toBe("[adapter] ChatGPT status 400: private_provider_code; remove the unsupported request capability");
    expect(logs.stdout).not.toContain("reasoning replay rejected");
  }, 15_000);
}

