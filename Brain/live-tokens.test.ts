import { expect, test } from "bun:test";
import { LiveTurnTokens, type LiveTokensSnapshot } from "./live-tokens";
import { ClaudePipe } from "./claude-pipe";

const se = (event: unknown, parent?: string) => ({ type: "stream_event", event, ...(parent ? { parent_tool_use_id: parent } : {}) });
const call = (id: string, name: string) => ({ type: "assistant", message: { id: `message-${id}`, content: [{ type: "tool_use", id, name, input: {} }] } });
const result = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

test("live activity: canonical tool starts/ends without tokens, overlapping IDs and helper isolation", () => {
  const live = new LiveTurnTokens();
  live.reset(1000);
  expect(live.snapshot().tool).toBeNull();
  expect(live.snapshot().lastEventAt).toBeUndefined();
  expect(live.observe(call("a", "Read"), "main", 1100)).toBe(true);
  expect(live.snapshot()).toMatchObject({ tool: "Read", lastEventAt: 1100, main: 0 });
  live.observe(call("b", "Bash"), "main", 1200);
  live.observe({ ...call("h", "Write"), parent_tool_use_id: "agent" }, "agent", 1300);
  expect(live.snapshot().tool).toBe("Bash");
  // Even an incorrect scope cannot promote a parent-tagged helper to main.
  live.observe({ ...result("b"), parent_tool_use_id: "agent" }, "main", 1350);
  expect(live.snapshot().tool).toBe("Bash");
  live.observe(result("missing"), "main", 1400);
  expect(live.snapshot().tool).toBe("Bash");
  expect(live.observe(result("b"), "main", 1500)).toBe(true);
  expect(live.snapshot().tool).toBe("Read");
  live.observe(result("a"), "main", 1600);
  expect(live.snapshot()).toMatchObject({ tool: null, lastEventAt: 1600 });
  // Reading or writing a status snapshot never advances the stream clock.
  expect(live.snapshot().lastEventAt).toBe(1600);
});

test("live activity: turn result and reset clear tools; first pre-open event survives", () => {
  const live = new LiveTurnTokens();
  live.observe(call("a", "Read"), "main", 10);
  live.reset(11); // ClaudePipe observes before ensureTurn/reset.
  expect(live.snapshot()).toMatchObject({ tool: "Read", lastEventAt: 10 });
  live.observe({ type: "result", is_error: true }, "main", 20);
  expect(live.snapshot().tool).toBeNull();
  live.observe(call("b", "Bash"), "main", 30);
  live.reset(31);
  expect(live.snapshot()).toMatchObject({ tool: "Bash", lastEventAt: 30 });
  live.reset(40);
  expect(live.snapshot().tool).toBeNull();
  expect(live.snapshot().lastEventAt).toBeUndefined();
  live.observe({ ...call("h", "Write"), parent_tool_use_id: "agent" }, "agent", 50);
  expect(live.snapshot().tool).toBeNull();
});

test("pipe router fixture: token-free tool changes reach the existing one-second live callback", async () => {
  const seen: LiveTokensSnapshot[] = [];
  // Exercise the real router without spawning a process or touching any files.
  const pipe = new ClaudePipe({ model: "fixture", systemPrompt: "", settingsPath: "{}", settingSources: "", cwd: ".",
    onLiveTokens: (snapshot) => seen.push(snapshot) });
  const route = (event: unknown) => (pipe as any).route(event);
  route(call("a", "Read")); // first event arrives before ensureTurn/reset
  expect(seen.at(-1)?.tool).toBe("Read");
  route(call("b", "Bash"));
  route({ ...call("h", "Write"), parent_tool_use_id: "agent" });
  await Bun.sleep(1100);
  expect(seen.at(-1)?.tool).toBe("Bash");
  const eventTime = seen.at(-1)!.lastEventAt!;
  route(result("b"));
  route(result("a"));
  await Bun.sleep(1100);
  expect(seen.at(-1)?.tool).toBeNull();
  expect(seen.at(-1)!.lastEventAt!).toBeGreaterThan(eventTime);
  expect(seen.at(-1)?.main).toBe(0);
});

test("live turn tokens: estimate while streaming, the real count once reported, helpers apart", () => {
  const live = new LiveTurnTokens();
  live.reset(1000);
  expect(live.observe(se({ type: "message_start", message: { id: "m1", usage: { output_tokens: 1 } } }), "main")).toBe(true);
  expect(live.observe(se({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x".repeat(400) } }), "main")).toBe(true);
  expect(live.observe(se({ type: "content_block_delta", delta: { type: "text_delta", text: "y".repeat(40) } }), "main")).toBe(true);
  expect(live.snapshot()).toMatchObject({ main: 110, helpers: 0, startedAt: 1000, estimated: true });
  expect(live.observe(se({ type: "message_delta", usage: { output_tokens: 131 } }), "main")).toBe(true);
  live.observe(se({ type: "message_stop" }), "main");
  // the classic mirror of the same message does not add it twice
  expect(live.observe({ type: "assistant", message: { id: "m1", usage: { output_tokens: 131 } } }, "main")).toBe(true); // activity, no additional tokens
  live.observe(se({ type: "message_start", message: { id: "m2" } }), "main");
  live.observe(se({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "z".repeat(80) } }), "main");
  expect(live.snapshot().main).toBe(151);
  // a helper reports only classic messages
  expect(live.observe({ type: "assistant", message: { id: "h1", usage: { output_tokens: 900 } } }, "toolu_a")).toBe(true);
  expect(live.snapshot()).toMatchObject({ main: 151, helpers: 900 });
  live.observe(se({ type: "message_stop" }), "main");
  live.reset(2000);
  expect(live.snapshot()).toMatchObject({ main: 0, helpers: 0, startedAt: 2000, estimated: false });
});

test("live turn tokens: uncounted stream events still refresh activity; invalid events are ignored", () => {
  const live = new LiveTurnTokens();
  expect(live.observe(se({ type: "content_block_delta", delta: { text: "abc" } }), "main")).toBe(true);
  expect(live.observe({ type: "user", message: {} }, "main")).toBe(true);
  expect(live.observe({ type: "unknown" }, "main")).toBe(false);
  expect(live.observe(null, "main")).toBe(false);
  expect(live.snapshot()).toMatchObject({ main: 0, helpers: 0, startedAt: null, estimated: false });
});

test("live turn tokens: a message that started just before the turn opened keeps counting", () => {
  const live = new LiveTurnTokens();
  live.observe(se({ type: "message_start", message: { id: "old" } }), "main");
  live.observe(se({ type: "message_delta", usage: { output_tokens: 50 } }), "main");
  live.observe(se({ type: "message_stop" }), "main");
  live.observe(se({ type: "message_start", message: { id: "m1" } }), "main");
  live.reset(5);
  live.observe(se({ type: "content_block_delta", delta: { text: "a".repeat(8) } }), "main");
  expect(live.snapshot()).toMatchObject({ main: 2, helpers: 0, startedAt: 5, estimated: true });
});

test("live turn tokens: the CLI's mid-stream mirror (usage of message_start) never freezes the estimate", () => {
  const live = new LiveTurnTokens();
  live.reset(1);
  live.observe(se({ type: "message_start", message: { id: "m1", usage: { output_tokens: 5 } } }), "main");
  live.observe(se({ type: "content_block_delta", delta: { type: "text_delta", text: "t".repeat(400) } }), "main");
  // a finished block, mirrored as an assistant message with message_start's usage
  live.observe({ type: "assistant", message: { id: "m1", usage: { output_tokens: 5 } } }, "main");
  expect(live.snapshot()).toMatchObject({ main: 100, estimated: true });
  live.observe(se({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "j".repeat(200) } }), "main");
  expect(live.snapshot().main).toBe(150);
  // the real count at the end of the step replaces the estimate, thinking included
  live.observe(se({ type: "message_delta", usage: { output_tokens: 887 } }), "main");
  live.observe(se({ type: "message_stop" }), "main");
  expect(live.snapshot()).toMatchObject({ main: 887, estimated: false });
  // a late mirror after the final count changes nothing
  expect(live.observe({ type: "assistant", message: { id: "m1", usage: { output_tokens: 5 } } }, "main")).toBe(true); // receipt time advances
  expect(live.snapshot().main).toBe(887);
});

test("live turn tokens: cold = everything not from the cache, window = the last step's prompt plus what it wrote", () => {
  const live = new LiveTurnTokens();
  live.reset(1);
  expect(live.snapshot()).toMatchObject({ cold: 0, window: null });
  // step 1: the user's message + inlet come in cold (input 2 + cache write 1,500), 490k from the cache
  expect(live.observe(se({ type: "message_start", message: { id: "s1", usage: { input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 490000, output_tokens: 5 } } }), "main")).toBe(true);
  expect(live.snapshot()).toMatchObject({ cold: 1502, window: 491502 });
  live.observe(se({ type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(400) } }), "main");
  expect(live.snapshot()).toMatchObject({ cold: 1602, window: 491602, estimated: true });
  live.observe(se({ type: "message_delta", usage: { output_tokens: 300 } }), "main");
  live.observe(se({ type: "message_stop" }), "main");
  expect(live.snapshot()).toMatchObject({ cold: 1802, window: 491802, estimated: false });
  // step 2: a tool result comes in cold, the rest from the cache
  live.observe(se({ type: "message_start", message: { id: "s2", usage: { input_tokens: 1, cache_creation_input_tokens: 4000, cache_read_input_tokens: 491500 } } }), "main");
  expect(live.snapshot()).toMatchObject({ cold: 5803, window: 495501 });
  // a helper's usage never enters the main counts
  live.observe(se({ type: "message_start", message: { id: "h1", usage: { input_tokens: 9000 } } }, "toolu_h"), "toolu_h");
  expect(live.snapshot()).toMatchObject({ cold: 5803, window: 495501 });
});
