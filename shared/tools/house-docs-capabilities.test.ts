import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as docs from "./house-docs";

const temp = mkdtempSync(join(tmpdir(), "capabilities-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function house(runtime = "brain", root = "", brain = "") {
  const home = mkdtempSync(join(temp, "house-"));
  mkdirSync(join(home, "Brain"));
  mkdirSync(join(home, "Claude/app"), { recursive: true });
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${runtime}\n${root}`);
  writeFileSync(join(home, "Brain/brain.env"), `BRAIN_HEAD=api\n${brain}`);
  return home;
}
const header = "# What this house can do\n\nThis list shows what this house can do and where each ability is switched on or off. You can read and change the code and the settings; changes to the approval settings ask your person first. When you add, change or switch off an ability, update this list.";
const render = (home: string) => docs.renderCapabilities(docs.collectFacts(home).facts);
const cli = join(import.meta.dir, "house-docs.ts");
function run(home: string, ...flags: string[]) {
  return Bun.spawnSync([process.execPath, cli, "--home", home, ...flags], {
    env: { PATH: process.env.PATH, HOME: temp }, stdout: "pipe", stderr: "pipe",
  });
}
function state(text: string, name: string) {
  return text.split("\n").find(line => line.startsWith(`- ${name} |`))?.split(" | ")[2];
}

test("capability header is exact, descriptions are short, and runtime lines are exclusive", () => {
  const brain = render(house());
  expect(brain.startsWith(header + "\n\n")).toBe(true);
  expect(brain).toContain("## Brain only");
  expect(brain).not.toContain("## Claude Code only");
  expect(state(brain, "Pins")).toBe("on");
  expect(state(brain, "House doctor")).toBe("on");
  for (const line of brain.split("\n").filter(line => line.startsWith("- "))) {
    expect(line.split(" | ")[1].split(" ").length).toBeGreaterThanOrEqual(3);
    expect(line.split(" | ")[1].split(" ").length).toBeLessThanOrEqual(4);
  }
  const claude = render(house("claude-code"));
  expect(claude).toContain("## Claude Code only");
  expect(claude).not.toContain("## Brain only");
  expect(state(claude, "Timed reminder")).toBeUndefined();
});

const switches = [
  ["brain", "Timed reminder", "", "BRAIN_REMINDERS_COLLECT=1\nBRAIN_MEMORY_URL=https://memory.invalid\nBRAIN_MEMORY_API_KEY=fixture"],
  ["brain", "Calendar in senses", "", "BRAIN_CALENDAR_FILE=calendar.json"],
  ["brain", "Weather", "", "BRAIN_WEATHER_URL=https://weather.invalid"],
  ["brain", "Cache ping", "", "BRAIN_HEAD=claude\nBRAIN_CACHE_PING=on"],
  ["brain", "Approval cards", "", "BRAIN_APPROVAL=app\nBRAIN_APP_URL=http://127.0.0.1:3030\nBRAIN_APP_TOKEN=fixture"],
  ["brain", "Web search", "", "BRAIN_WEB_SEARCH_BACKEND=searxng\nBRAIN_WEB_SEARCH_ENDPOINT=https://search.invalid"],
  ["brain", "Browser", "EMBERVY_BROWSER=1", ""],
  ["brain", "Hearing", "EMBERVY_HEAR_URL=http://127.0.0.1:8765/hear", ""],
  ["brain", "Voice messages", "EMBERVY_HEAR_URL=http://127.0.0.1:8765/hear\nEMBERVY_VOICE_MESSAGES=1", ""],
  ["brain", "Voice replies", "ELEVENLABS_API_KEY=fixture", ""],
  ["brain", "Rooms", 'EMBERVY_ROOMS=\'[{"name":"Work","url":"https://room.invalid","token":"abcdefghijklmnopqrstuvwxyz0123456789"}]\'', ""],
  ["brain", "Peers", 'EMBERVY_PEERS=\'[{"name":"Work","url":"https://peer.invalid","token":"abcdefghijklmnopqrstuvwxyz0123456789"}]\'', ""],
  ["brain", "Agent mail", "EMAIL_SENDER_URL=https://mail.invalid\nEMAIL_SENDER_AUTH=fixture", ""],
  ["brain", "Mailbox reading", "MAILBOX_USER=reader\nMAILBOX_HOST=mail.invalid\nMAILBOX_APP_PASSWORD=fixture", ""],
  ["claude-code", "Calendar in senses", "EMBERVY_HOOK_CALENDAR=1", ""],
  ["claude-code", "Weather", "EMBERVY_HOOK_WEATHER=1\nEMBERVY_WEATHER_PLACE=London", ""],
  ["claude-code", "Cache ping", "EMBERVY_CACHE_PING=1\nEMBERVY_CACHE_PING_MINUTES=50", ""],
];
for (const [runtime, name, root, brain] of switches) test(`${runtime}: ${name} follows configuration`, () => {
  expect(state(render(house(runtime)), name)).toBe("off");
  expect(state(render(house(runtime, root, brain)), name)).toBe("on");
});

test("capabilities preview prints only the list and writes nothing", () => {
  const home = house();
  const result = run(home, "--capabilities");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(render(home));
  expect(existsSync(join(home, "CAPABILITIES.md"))).toBe(false);
  expect(existsSync(join(home, "state"))).toBe(false);
  expect(run(home, "--capabilities", "--write").exitCode).toBe(2);
});

test("write creates private capabilities once and preserves edited or empty files", () => {
  const home = house();
  expect(run(home, "--write").exitCode).toBe(0);
  const path = join(home, "CAPABILITIES.md");
  expect(readFileSync(path, "utf8")).toBe(render(home));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  for (const edited of ["Agent-owned words\n", ""]) {
    writeFileSync(path, edited);
    expect(run(home, "--write").exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(edited);
  }
});

test("check reports every contradictory and missing ability without echoing lines", () => {
  const home = house();
  expect(run(home, "--write").exitCode).toBe(0);
  const text = render(home).replace("- Pins | Keep important context visible | on", "- Pins | PRIVATE_WORDS | off")
    .replace(/^.*- House doctor .*\n/m, "") + "- Handmade ability | My own private description | on | always on\n";
  writeFileSync(join(home, "CAPABILITIES.md"), text);
  const result = run(home, "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("Pins: document says off, now on");
  expect(result.stdout.toString()).toContain("House doctor: missing ability");
  expect(result.stdout.toString()).not.toContain("PRIVATE_WORDS");
  expect(result.stdout.toString()).not.toContain("Handmade");
  expect(readFileSync(join(home, "CAPABILITIES.md"), "utf8")).toBe(text);
  writeFileSync(join(home, "CAPABILITIES.md"), render(home) + "- Handmade ability | My own private description | off | always on\n");
  expect(run(home, "--check").exitCode).toBe(0);
});

test("capability comparison works without a recorded baseline and notices duplicates", () => {
  const home = house();
  const facts = docs.collectFacts(home).facts;
  const text = render(home);
  expect(docs.checkCapabilities(text, facts)).toEqual([]);
  expect(docs.checkCapabilities(text + "- Pins | Keep important context visible | off | always on\n", facts)).toEqual(["Pins: document says off, now on"]);
  expect(docs.checkCapabilities("", facts).length).toBe(facts.capabilities!.length);
  expect(run(home, "--check").stdout.toString()).toContain("CAPABILITIES.md: missing document");
});

test("saved head and approval settings determine capabilities without reading credentials", () => {
  const home = house("brain", "", "BRAIN_HEAD=api\nBRAIN_APPROVAL_SETTINGS=approval.json\nBRAIN_APP_URL=http://127.0.0.1:3030\nBRAIN_APP_TOKEN=fixture\nBRAIN_CONTROL_TOKEN=fixture");
  mkdirSync(join(home, "Brain/state"));
  writeFileSync(join(home, "Brain/state/brain-head.json"), JSON.stringify({ version: 1, head: "claude", model: "test", window: 1000000, transport: "pipe" }));
  writeFileSync(join(home, "approval.json"), JSON.stringify({ level: "none", extra: [] }));
  const text = render(home);
  expect(state(text, "Cache ping")).toBe("on");
  expect(state(text, "Web search")).toBe("on");
  expect(state(text, "Approval cards")).toBe("off");
  writeFileSync(join(home, "approval.json"), JSON.stringify({ level: "important", extra: [] }));
  expect(state(render(home), "Approval cards")).toBe("on");
});

test("facts record contains capability booleans and no credential values", () => {
  const home = house("brain", "ELEVENLABS_API_KEY=fixture-secret\nEMBERVY_HEAR_URL=http://127.0.0.1/hear");
  expect(run(home, "--write").exitCode).toBe(0);
  const text = readFileSync(join(home, "state/house-docs-facts.json"), "utf8");
  const record = JSON.parse(text);
  expect(record.capabilities["Hearing"]).toBe(true);
  expect(record.capabilities["Voice replies"]).toBe(true);
  expect(record.credentials.ELEVENLABS_API_KEY).toBe(true);
  expect(text.includes("fixture-secret")).toBe(false);
});

test("capabilities destination cannot escape the house through a symlink", () => {
  const home = house();
  const outside = join(temp, "outside.md");
  writeFileSync(outside, "unchanged");
  symlinkSync(outside, join(home, "CAPABILITIES.md"));
  expect(run(home, "--write").exitCode).toBe(2);
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
  expect(existsSync(join(home, "HANDBOOK.md"))).toBe(false);
});

test("capabilities-only write and check preserve every other document and the facts record", () => {
  const home = house();
  mkdirSync(join(home, "state"));
  const kept = ["HANDBOOK.md", "INFRASTRUCTURE.md", "state/house-docs-facts.json"];
  const original = Buffer.from("house-owned\r\n\u0000unchanged\n");
  for (const file of kept) writeFileSync(join(home, file), original);
  const unchanged = () => {
    for (const file of kept) expect(readFileSync(join(home, file))).toEqual(original);
  };
  const missing = run(home, "--check", "--only", "capabilities");
  expect(missing.exitCode).toBe(1);
  expect(missing.stdout.toString()).toBe("CAPABILITIES.md: missing document\n");
  unchanged();
  expect(run(home, "--write", "--only", "capabilities").exitCode).toBe(0);
  expect(readFileSync(join(home, "CAPABILITIES.md"), "utf8")).toBe(render(home));
  expect(statSync(join(home, "CAPABILITIES.md")).mode & 0o777).toBe(0o600);
  unchanged();
  expect(run(home, "--check", "--only", "capabilities").exitCode).toBe(0);
  unchanged();
  const edited = render(home).replace("- Pins | Keep important context visible | on", "- Pins | Keep important context visible | off");
  writeFileSync(join(home, "CAPABILITIES.md"), edited);
  expect(run(home, "--check", "--only", "capabilities").exitCode).toBe(1);
  expect(run(home, "--write", "--only", "capabilities").exitCode).toBe(0);
  expect(readFileSync(join(home, "CAPABILITIES.md"), "utf8")).toBe(edited);
  unchanged();
});

test("capabilities-only operations need no other documents or baseline", () => {
  const home = house();
  expect(run(home, "--write", "--only", "capabilities").exitCode).toBe(0);
  expect(run(home, "--check", "--only", "capabilities").exitCode).toBe(0);
  for (const file of ["HANDBOOK.md", "INFRASTRUCTURE.md", "state"]) expect(existsSync(join(home, file))).toBe(false);
});

test("unsupported or incomplete only selections are refused before writing", () => {
  const home = house();
  for (const flags of [["--write", "--only", "handbook"], ["--check", "--only", "all"], ["--write", "--only"], ["--write", "--only=other"]]) {
    const result = run(home, ...flags);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("--only accepts only capabilities");
  }
  expect(run(home, "--only", "capabilities").exitCode).toBe(2);
  expect(run(home, "--capabilities", "--only", "capabilities").exitCode).toBe(2);
  expect(existsSync(join(home, "CAPABILITIES.md"))).toBe(false);
  expect(existsSync(join(home, "state"))).toBe(false);
});

test("capabilities-only destinations retain symlink protection", () => {
  const home = house(), outside = join(temp, "only-outside.md");
  writeFileSync(outside, "unchanged");
  symlinkSync(outside, join(home, "CAPABILITIES.md"));
  for (const mode of ["--write", "--check"]) expect(run(home, mode, "--only", "capabilities").exitCode).toBe(2);
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
});

test("native Brain web tools respect explicit per-head and global tool denies", () => {
  const denied = render(house("brain", "", "BRAIN_HEAD=claude\nBRAIN_DISALLOWED_TOOLS=WebSearch,WebFetch"));
  expect(state(denied, "Web search")).toBe("off");
  expect(state(denied, "Web fetch")).toBe("off");
  const override = render(house("brain", "", "BRAIN_HEAD=claude\nBRAIN_DISALLOWED_TOOLS=WebSearch,WebFetch\nBRAIN_CLAUDE_DISALLOWED_TOOLS=WebSearch"));
  expect(state(override, "Web search")).toBe("off");
  expect(state(override, "Web fetch")).toBe("on");
});

test("voice message mode is independent of the hearing service", () => {
  const text = render(house("brain", "EMBERVY_VOICE_MESSAGES=1"));
  expect(state(text, "Voice messages")).toBe("on");
  expect(state(text, "Hearing")).toBe("off");
});

test("explicit Brain cache ping also enables API heads", () => {
  expect(state(render(house("brain", "", "BRAIN_CACHE_PING=on")), "Cache ping")).toBe("on");
});

test("sense and fetch disable switches override configured inputs", () => {
  const text = render(house("brain", "", "BRAIN_SENSE=off\nBRAIN_CALENDAR_FILE=calendar.json\nBRAIN_WEATHER_URL=https://weather.invalid\nBRAIN_WEB_FETCH=off"));
  for (const name of ["Calendar in senses", "Weather", "Web fetch"]) expect(state(text, name)).toBe("off");
  expect(state(render(house()), "Web fetch")).toBe("on");
});
