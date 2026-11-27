import { expect, test } from "bun:test";
import { PipeUsageLedger, mergeMessageUsage, type PipeUsageSample } from "./claude-pipe";
import { LiveTurnTokens } from "./live-tokens";

// Shapes recorded from real engine streams (stream-json with partial messages).
// "provisional": the message opens with the whole prompt as input and no cache
// split; the closing delta carries the billed split with the same prompt total.
type Usage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number };
const usage = (input: number, read: number, output = 0, write = 0): Usage =>
  ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });

function stream(id: string, model: string, start: Usage, mirror: Usage, end: Usage): any[] {
  return [
    { type: "stream_event", event: { type: "message_start", message: { id, model, usage: start } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } },
    { type: "assistant", message: { id, model, usage: mirror, content: [{ type: "text", text: "ok" }], stop_reason: null } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: end } },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "result", result_index: 0, usage: end },
  ];
}

const PROVISIONAL = stream("m-prov", "engine-a", usage(30447, 0), usage(30447, 0), usage(239, 30208, 136));
const SPLIT_FROM_START = stream("m-split", "engine-b", usage(241, 30208), usage(241, 30208), usage(241, 30208, 48));
const ALL_CACHED = stream("m-cached", "engine-c", usage(0, 30450), usage(0, 30450), usage(0, 30450, 93));
const COLD = stream("m-cold", "engine-b", usage(30449, 0), usage(30449, 0), usage(30449, 0, 52));

function ledgerRow(events: any[]): PipeUsageSample {
  const rows: PipeUsageSample[] = [];
  const ledger = new PipeUsageLedger((r) => rows.push(r));
  for (const evt of events) ledger.observe(evt, "turn");
  ledger.finish();
  expect(rows).toHaveLength(1);
  return rows[0];
}

function liveSnapshot(events: any[]) {
  const live = new LiveTurnTokens();
  live.reset(1000);
  // The turn result clears the live counters; the status line reads them before it.
  for (const evt of events) if (evt.type !== "result") live.observe(evt, "main", 1100);
  return live.snapshot();
}

test("usage ledger: a provisional start count is replaced by the final split of the same prompt", () => {
  expect(ledgerRow(PROVISIONAL)).toMatchObject({ input: 239, cache_read: 30208, cache_write: 0, output: 136 });
});

test("usage ledger: engines that report the split from the start are unchanged", () => {
  expect(ledgerRow(SPLIT_FROM_START)).toMatchObject({ input: 241, cache_read: 30208, output: 48 });
  expect(ledgerRow(ALL_CACHED)).toMatchObject({ input: 0, cache_read: 30450, output: 93 });
  expect(ledgerRow(COLD)).toMatchObject({ input: 30449, cache_read: 0, output: 52 });
});

test("merge: equal prompt totals keep the split with the larger cached part in either order", () => {
  const forward: Record<string, any> = {};
  mergeMessageUsage(forward, usage(30447, 0));
  mergeMessageUsage(forward, usage(239, 30208, 136));
  expect(forward).toMatchObject({ input_tokens: 239, cache_read_input_tokens: 30208, output_tokens: 136 });
  // A late duplicate of the provisional mirror must not roll the split back.
  mergeMessageUsage(forward, usage(30447, 0));
  expect(forward).toMatchObject({ input_tokens: 239, cache_read_input_tokens: 30208, output_tokens: 136 });

  const reverse: Record<string, any> = {};
  mergeMessageUsage(reverse, usage(239, 30208, 136));
  mergeMessageUsage(reverse, usage(30447, 0));
  expect(reverse).toMatchObject({ input_tokens: 239, cache_read_input_tokens: 30208, output_tokens: 136 });
  expect(reverse.input_tokens + reverse.cache_read_input_tokens + reverse.cache_creation_input_tokens).toBe(30447);
});

test("merge: unequal prompt totals and thin deltas keep the max rule", () => {
  const grown: Record<string, any> = {};
  mergeMessageUsage(grown, usage(100, 5000));
  mergeMessageUsage(grown, usage(90, 5200, 7));
  expect(grown).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 5200, output_tokens: 7 });

  // A delta without prompt fields changes only what it reports.
  const thin: Record<string, any> = {};
  mergeMessageUsage(thin, usage(3, 1000));
  mergeMessageUsage(thin, { output_tokens: 12 });
  expect(thin).toMatchObject({ input_tokens: 3, cache_read_input_tokens: 1000, output_tokens: 12 });

  // A delta that repeats input without cache fields is not a re-split of a cached prompt.
  const partial: Record<string, any> = {};
  mergeMessageUsage(partial, usage(3, 1000));
  mergeMessageUsage(partial, { input_tokens: 3, output_tokens: 12 });
  expect(partial).toMatchObject({ input_tokens: 3, cache_read_input_tokens: 1000, output_tokens: 12 });
});

test("status line: the uncached count follows the final split, the window stays the prompt total", () => {
  const provisional = liveSnapshot(PROVISIONAL);
  expect(provisional.cold).toBe(239 + 136);
  expect(provisional.window).toBe(30447 + 136);

  const split = liveSnapshot(SPLIT_FROM_START);
  expect(split.cold).toBe(241 + 48);
  expect(split.window).toBe(30449 + 48);

  const cold = liveSnapshot(COLD);
  expect(cold.cold).toBe(30449 + 52);
  expect(cold.window).toBe(30449 + 52);
});
