import { afterEach, describe, expect, test } from "bun:test";
import { formatHelperActivity, formatToolUse, redactPreview, toolLogPreview } from "./live-view";
import { forwardCanonicalPipeEvent, PipeVisibleContext, TurnAccumulator } from "./claude-pipe";
import { ToolRecordPolicy } from "./pipe-canonical";

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("display-only secret redaction", () => {
  test("sensitive names match case-insensitively anywhere and short values stay visible", () => {
    const env = {
      APP_KEY: "key-value-123", token_session_id: "token-value-123", SECRET_STORE: "secret-value-123",
      DB_PASSWORD: "password-value-123", SHORT_TOKEN: "short-7", EXACT_KEY: "eight888", LABEL: "ordinary-value",
    };
    const input = Object.values(env).join(" | ");
    expect(redactPreview(input, env)).toBe("[redacted] | [redacted] | [redacted] | [redacted] | short-7 | [redacted] | ordinary-value");
  });

  test("literal values, repeated values and overlapping values are replaced without regex interpretation", () => {
    const env = { API_KEY: "value.*+$123", API_TOKEN: "value.*+$123-extra", OTHER_SECRET: "value.*+$123" };
    expect(redactPreview("a value.*+$123-extra b value.*+$123 c valueZZ123", env))
      .toBe("a [redacted] b [redacted] c valueZZ123");
  });

  test("assignment lines hide unknown and short values while ordinary lines remain intact", () => {
    const input = "PUBLIC=value\r\nAPI_TOKEN=external-value\r\npassword_cache=x\n  export SERVICE_SECRET = \"other\"\nKEYBOARD_ID=\nordinary text";
    expect(redactPreview(input, {})).toBe("PUBLIC=value\r\nAPI_TOKEN=[redacted]\r\npassword_cache=[redacted]\n  export SERVICE_SECRET =[redacted]\nKEYBOARD_ID=[redacted]\nordinary text");
  });

  test("environment values are read at preview time and redacted before truncation", () => {
    setEnv("PREVIEW_TEST_API_TOKEN", "fixture-secret-12345");
    setEnv("PREVIEW_TEST_SHORT_KEY", "small");
    const input = "x".repeat(495) + "fixture-secret-12345 small";
    expect(toolLogPreview(input)).toBe("x".repeat(495) + "[reda");
    expect(toolLogPreview("fixture-secret-12345 small")).toBe("[redacted] small");
    setEnv("PREVIEW_TEST_API_TOKEN", "rotated-secret-12345");
    expect(toolLogPreview("rotated-secret-12345")).toBe("[redacted]");
    expect(toolLogPreview("a".repeat(510))).toBe("a".repeat(500));
  });

  test("JSON previews redact raw string leaves before escaping without mutating inputs", () => {
    setEnv("PREVIEW_TEST_SECRET", "quoted-\"value\\with\nlines");
    const value = { command: "PUBLIC=yes\nREMOTE_PASSWORD=unknown-value\nquoted-\"value\\with\nlines", nested: ["REMOTE_TOKEN=x"] };
    const before = structuredClone(value);
    expect(JSON.parse(toolLogPreview(value))).toEqual({ command: "PUBLIC=yes\nREMOTE_PASSWORD=[redacted]\n[redacted]", nested: ["REMOTE_TOKEN=[redacted]"] });
    expect(value).toEqual(before);
    const ordinary = { path: "file.txt", count: 3, nested: [true, null] };
    expect(toolLogPreview(ordinary)).toBe(JSON.stringify(ordinary));
    expect(toolLogPreview(ordinary, Infinity, 2)).toBe(JSON.stringify(ordinary, null, 2));
  });

  test("serialized keys and repeated display passes keep a fixed redaction marker", () => {
    setEnv("PREVIEW_TEST_SECRET", "redacted");
    setEnv("PREVIEW_TEST_TOKEN", "quoted-\"key-123");
    const value = { "quoted-\"key-123": "redacted" };
    expect(toolLogPreview(value)).toBe('{"[redacted]":"[redacted]"}');
    expect(toolLogPreview(toolLogPreview(value))).toBe('{"[redacted]":"[redacted]"}');
  });

  test("live metadata is redacted before whitespace normalization and clipping", () => {
    setEnv("PREVIEW_TEST_API_KEY", "fixture-live-12345");
    expect(formatToolUse("Bash", { command: "echo fixture-live-12345" })).toBe("  ▸ Bash: echo [redacted]");
    expect(formatToolUse("Bash", { command: "API_TOKEN=external-value\npwd" })).toBe("  ▸ Bash: API_TOKEN=[redacted] pwd");
    expect(formatToolUse("Read", { path: "/tmp/fixture-live-12345/file" })).toBe("  ▸ Read: /tmp/[redacted]/file");
    expect(formatHelperActivity({ id: "helper", phase: "start", description: "fixture-live-12345" })).toContain("[redacted]");
  });

  test("pipe logs and live tool cards redact inputs and every result representation without changing canonical payloads", () => {
    setEnv("PREVIEW_TEST_TOKEN", "fixture-pipe-12345");
    const logs: any[] = [];
    const steps: any[] = [];
    const canonical: any[] = [];
    const liveInputs: any[] = [];
    const acc = new TurnAccumulator({ model: "test-model", systemPrompt: "", toolRecords: new ToolRecordPolicy(undefined),
      logEvent: (event) => logs.push(event), onTuiStep: (step) => steps.push(step), onToolUse: (tool) => liveInputs.push(tool.input),
    }, null, new PipeVisibleContext(), null);
    const input = { command: "fixture-pipe-12345\nREMOTE_TOKEN=external-value", description: "fixture-pipe-12345" };
    const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-preview", name: "Bash", input }] } };
    acc.observe(use);
    forwardCanonicalPipeEvent(use, (event) => canonical.push(event));
    expect(logs.find((event) => event.type === "claude_pipe_tool_use_seen").input_preview)
      .toBe(JSON.stringify({ command: "[redacted]\nREMOTE_TOKEN=[redacted]", description: "[redacted]" }));
    expect(liveInputs[0]).toBe(input);
    expect(JSON.parse(canonical[0].tool_calls[0].function.arguments)).toEqual(input);
    const payloads = [
      "fixture-pipe-12345\nREMOTE_PASSWORD=external-value\nordinary",
      [{ type: "text", text: "fixture-pipe-12345\nREMOTE_PASSWORD=external-value\nordinary" }],
      { text: "fixture-pipe-12345\nREMOTE_PASSWORD=external-value\nordinary" },
      [{ type: "data", data: "fixture-pipe-12345\nREMOTE_PASSWORD=external-value\nordinary" }],
    ];
    for (const content of payloads) {
      const event = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-preview", content }] } };
      const before = structuredClone(event);
      acc.observe(event);
      forwardCanonicalPipeEvent(event, (entry) => canonical.push(entry));
      expect(event).toEqual(before);
      const result = logs.filter((entry) => entry.type === "claude_pipe_tool_result_seen").at(-1);
      const originalText = typeof content === "string" ? content : Array.isArray(content)
        ? content.map((block: any) => typeof block.text === "string" ? block.text : JSON.stringify(block)).join(" ") : JSON.stringify(content);
      expect(result.content_chars).toBe(originalText.length);
      expect(result.content_preview).toContain("[redacted]");
      expect(result.content_preview).not.toContain("fixture-pipe-12345");
      expect(result.content_preview).not.toContain("external-value");
      expect(canonical.at(-1).content).toEqual(content);
    }
    const display = JSON.stringify({ logs, steps });
    expect(display).not.toContain("fixture-pipe-12345");
    expect(display).not.toContain("external-value");
    expect(display).toContain("ordinary");
  });
});
