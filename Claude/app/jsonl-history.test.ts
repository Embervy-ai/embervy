import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlHistory, readJsonlBatch } from "./jsonl-history";

test("bridge batches resume at byte boundaries without skipping backlog or partial records", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-batch-"));
  try {
    const path = join(dir, "inbox.jsonl");
    const rows = Array.from({ length: 125 }, (_, id) => JSON.stringify({ id, text: "é".repeat(id === 49 ? 70000 : 2) }));
    writeFileSync(path, rows.join("\n") + '\n{"id":125');
    let offset = 0;
    const received: number[] = [];
    for (const expected of [50, 50, 25]) {
      const batch = readJsonlBatch(path, offset);
      expect(batch.lines).toHaveLength(expected);
      received.push(...batch.lines.map(line => JSON.parse(line).id));
      expect(batch.offset).toBeGreaterThan(offset);
      offset = batch.offset;
    }
    expect(received).toEqual(Array.from({ length: 125 }, (_, i) => i));
    expect(readJsonlBatch(path, offset)).toEqual({ lines: [], offset });
    appendFileSync(path, '}\n');
    expect(readJsonlBatch(path, offset).lines.map(line => JSON.parse(line).id)).toEqual([125]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history scans a filtered tail, follows appends and preserves the journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-history-"));
  try {
    const path = join(dir, "inbox.jsonl");
    const own = Array.from({ length: 250 }, (_, id) => ({ id, text: "é".repeat(400) }));
    const foreign = Array.from({ length: 3000 }, (_, id) => ({ id, source: "room" }));
    const original = [...own, ...foreign].map(m => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(path, original);
    const history = new JsonlHistory(path, 200, m => m.source !== "room");
    expect(history.read().map(m => m.id)).toEqual(own.slice(-200).map(m => m.id));
    expect(history.read().at(-1).text).toBe(own.at(-1)!.text);
    expect(readFileSync(path, "utf8")).toBe(original);
    appendFileSync(path, '{"id":250,"text":"partial');
    expect(history.read().at(-1).id).toBe(249);
    appendFileSync(path, '"}\n{bad}\n' + JSON.stringify({ id: 251, source: "room" }) + "\n");
    expect(history.read().at(-1).id).toBe(250);
    expect(history.read()).toHaveLength(200);
    const initialPartial = new JsonlHistory(path);
    appendFileSync(path, '{"id":252');
    const restartPartial = new JsonlHistory(path);
    expect(restartPartial.read().at(-1).id).toBe(251);
    appendFileSync(path, '}\n');
    expect(restartPartial.read().at(-1).id).toBe(252);
    expect(initialPartial.read().at(-1).id).toBe(252);
    writeFileSync(path, '{"id":"truncated"}\n');
    expect(history.read()).toEqual([{ id: "truncated" }]);
    writeFileSync(path + ".new", '{"id":"replaced"}\n');
    renameSync(path + ".new", path);
    expect(history.read()).toEqual([{ id: "replaced" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
