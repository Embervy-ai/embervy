import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the production scanner without classification or delivery side effects.
const source = readFileSync(join(import.meta.dir, "reply-gateway.sh"), "utf8");
const scanner = source.split("<<'PY'\n")[1].split("\nPY\n")[0];
const names = Bun.spawnSync(["bash", "-c", '. "$1"; embervy_app_tool_names room', "test", join(import.meta.dir, "legacy-names.sh")]).stdout.toString().trim().split(/\s+/);
function scan(prompt: string, name?: string, error = false) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-room-"));
  try {
    const events: any[] = [{ type: "user", message: { content: prompt } }];
    if (name) events.push(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name, input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool", is_error: error }] } },
    );
    events.push({ type: "assistant", uuid: "last", message: { content: [{ type: "text", text: "Terminal answer" }] } });
    const file = join(dir, "turn.jsonl");
    writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n"));
    const run = Bun.spawnSync(["python3", "-c", scanner, file, join(dir, "markers"), "mcp__app__reply"]);
    expect(run.exitCode).toBe(0);
    return run.stdout.toString();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const room = '<channel source="app" kind="room">Hello</channel>';
for (const name of ["room", ...names]) {
  test(`room turn delivered with ${name} skips terminal forwarding`, () => {
    expect(scan(room, name)).toBe("SKIP:replied\n");
  });
}
test("room turn without delivery still sends", () => {
  expect(scan(room)).toBe("SEND:last\nTerminal answer\n");
  expect(scan(room, "room", true)).toBe("SEND:last\nTerminal answer\n");
});
test("direct turn answered only with room still sends", () => {
  expect(scan("Hello", "room")).toBe("SEND:last\nTerminal answer\n");
});
