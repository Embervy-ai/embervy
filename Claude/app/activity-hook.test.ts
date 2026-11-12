import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "activity-hook.sh");
let root: string;
let house: string;
let app: string;
let events: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "activity hook-"));
  house = join(root, "house");
  app = join(house, "Claude/app");
  events = join(app, "data/activity/events.jsonl");
  mkdirSync(app, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(input: string, home = house, appDir = app) {
  const result = spawnSync("/bin/sh", [hook], {
    cwd: house,
    input,
    encoding: "utf8",
    env: { ...process.env, EMBERVY_HOME: home, EMBERVY_APP_DIR: appDir },
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return existsSync(events)
    ? readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line))
    : [];
}

function input(cwd: string, event = "UserPromptSubmit") {
  return JSON.stringify({ cwd, hook_event_name: event, tool_name: "Bash" });
}

test("house cwd is recorded", () => {
  expect(run(input(house))).toMatchObject([{ event: "turn_start" }]);
});

test("nested house cwd is recorded", () => {
  const nested = join(house, "sub/dir");
  mkdirSync(nested, { recursive: true });
  expect(run(input(nested))).toMatchObject([{ event: "turn_start" }]);
});

test("sibling with the house as a string prefix is refused", () => {
  const sibling = house + "-other";
  mkdirSync(sibling);
  expect(run(input(sibling))).toEqual([]);
  expect(existsSync(events)).toBe(false);
});

test("unrelated cwd is refused", () => {
  const other = join(root, "elsewhere");
  mkdirSync(other);
  expect(run(input(other))).toEqual([]);
  expect(existsSync(events)).toBe(false);
});

test("symlinked house and nested cwd resolve to this house", () => {
  const alias = join(root, "house-link");
  const nested = join(house, "sub/dir");
  mkdirSync(nested, { recursive: true });
  symlinkSync(house, alias, "dir");
  expect(run(input(join(alias, "sub/dir")), alias, join(alias, "Claude/app")))
    .toMatchObject([{ event: "turn_start" }]);
});

test("canonical cwd is accepted when the configured house is a symlink", () => {
  const alias = join(root, "house-link");
  symlinkSync(house, alias, "dir");
  expect(run(input(house), alias)).toMatchObject([{ event: "turn_start" }]);
});

test("a symlink under the house leading outside is refused", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  const link = join(house, "outside-link");
  symlinkSync(outside, link, "dir");
  expect(run(input(link))).toEqual([]);
});

test("dot-dot cannot escape the house", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  expect(run(input(house + "/../outside"))).toEqual([]);
});

for (const [event, kind] of [
  ["UserPromptSubmit", "turn_start"],
  ["PreToolUse", "tool_start"],
  ["PostToolUse", "tool_end"],
  ["Stop", "turn_end"],
]) {
  test(`${event} maps to ${kind}`, () => {
    const rows = run(input(house, event));
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe(kind);
    expect(Number.isFinite(Date.parse(rows[0].ts))).toBe(true);
    if (kind === "tool_start") expect(rows[0].tool).toBe("Bash");
  });
}

test("unknown hook events are ignored", () => {
  expect(run(input(house, "UnknownHook"))).toEqual([]);
});

for (const bad of ["", "not json", "{"]) {
  test(`invalid input ${JSON.stringify(bad)} still exits zero`, () => {
    expect(run(bad)).toEqual([]);
  });
}

test("unresolvable cwd and house are refused without failing", () => {
  expect(run(input(join(root, "missing/child")))).toEqual([]);
  expect(run(input(house), join(root, "missing/house"))).toEqual([]);
});

test("failure to create the activity directory still exits zero", () => {
  writeFileSync(join(app, "data"), "not a directory");
  expect(run(input(house))).toEqual([]);
});
