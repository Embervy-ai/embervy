import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { houseRoomNames } from "./house-rooms";
import { roomConfigsFromEnv } from "../Claude/app/room-door";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loader = join(import.meta.dir, "scripts/brain-env.sh");
const speakerModule = join(import.meta.dir, "wake-bridge.ts");
const roomModule = join(import.meta.dir, "house-rooms.ts");
const keys = ["EMBERVY_ROOM_NAME", "ROOM_NAME", "EMBERVY_ROOMS", "EMBERVY_ROOM_URL", "EMBERVY_ROOM_TOKEN"];
const urlCanary = "https://room.example.test/private-url-canary-72491";
const canary = "private-canary-not-for-brain-72491";

function startup(houseEnv: string, texts: string[], appEnv?: string) {
  const home = mkdtempSync(join(tmpdir(), "room-startup-"));
  try {
    mkdirSync(join(home, "Brain"));
    writeFileSync(join(home, "Brain/brain.env"), `EMBERVY_HOME=${home}\nBRAIN_LANG=en\n`);
    writeFileSync(join(home, ".env"), `${houseEnv}\nPRIVATE_CANARY=${canary}\n`);
    if (appEnv !== undefined) {
      mkdirSync(join(home, "Claude/app"), { recursive: true });
      writeFileSync(join(home, "Claude/app/.env"), `${appEnv}\nPRIVATE_CANARY=${canary}\n`);
    }
    const code = `
      import { roomUserSpeaker, nativeMessages } from ${JSON.stringify(speakerModule)};
      import { freshZone } from ${JSON.stringify(join(import.meta.dir, "fresh-zone.ts"))};
      import { houseRoomNames } from ${JSON.stringify(roomModule)};
      const before = {...process.env};
      const texts = ${JSON.stringify(texts)};
      const speakers = texts.map(text => roomUserSpeaker(text, "Owner"));
      const rules = {userName: "Owner", workerName: "Agent", systemLine: /^SYSTEM:/, scheduledLine: /^SCHEDULED:/};
      const records = texts.map(content => ({role: "user", content}));
      const native = nativeMessages(records, rules);
      const fresh = freshZone(records.map(row => JSON.stringify(row)).join("\\n"), rules, {maxChars: 10000});
      console.log(JSON.stringify({speakers, native, fresh, names: [...houseRoomNames()],
        unchanged: JSON.stringify(before) === JSON.stringify({...process.env}),
        roomKeys: ${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined),
        canary: process.env.PRIVATE_CANARY ?? null}));
    `;
    // Only the loader's inputs are inherited, not the test runner's room settings.
    const child = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; exec "$2" --no-env-file -e "$3"',
      "room-startup", loader, process.execPath, code], {
      cwd: home,
      env: { PATH: process.env.PATH!, HOME: home, BRAIN_HOME: join(home, "Brain") },
    });
    expect(child.exitCode).toBe(0);
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    expect(stderr).toBe("");
    expect(stdout + stderr).not.toContain(canary);
    expect(stdout + stderr).not.toContain(urlCanary);
    const result = JSON.parse(stdout);
    expect(result.unchanged).toBe(true);
    expect(result.roomKeys).toEqual([]);
    expect(result.canary).toBeNull();
    expect(result.native).toEqual(texts.map((text, index) => [result.speakers[index], text]));
    texts.forEach((text, index) => expect(result.fresh).toContain(`**${result.speakers[index]}**\n\n${text}`));
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("real Brain loader finds the single room only in the house env", () => {
  const result = startup('EMBERVY_ROOM_NAME="Studio"', ["[Studio/Robin] hi", "[Draft/2] x"]);
  expect(result.names).toEqual(["Studio"]);
  expect(result.speakers).toEqual(["Robin", "Owner"]);
});

test("real Brain loader finds room names only in the app settings", () => {
  const result = startup("", ["[Studio/Robin] hi", "[Gallery/Peer] hi", "[Legacy/Peer] hi", "[Draft/2] x"],
    `EMBERVY_ROOM_NAME=Studio\nROOM_NAME=Legacy\nEMBERVY_ROOMS='[{"name":"Gallery","url":"${urlCanary}","token":"${canary}"}]'`);
  expect(result.names).toEqual(["Studio", "Legacy", "Gallery"]);
  expect(result.speakers).toEqual(["Robin", "Peer", "Peer", "Owner"]);
});

test("real Brain loader combines house names with app URL presence and uses the default without a name", () => {
  for (const [houseEnv, expected] of [["EMBERVY_ROOM_NAME=Studio", "Studio"], ["", "Room"]]) {
    const result = startup(houseEnv, [`[${expected}/Peer] hi`], `EMBERVY_ROOM_URL=${urlCanary}`);
    expect(result.names).toEqual([expected]);
    expect(result.speakers).toEqual(["Peer"]);
  }
});

test("real Brain loader finds two rooms only in the house JSON list", () => {
  const result = startup(`EMBERVY_ROOMS='[{"name":"Studio"},{"name":"Gallery"}]'`,
    ["[Studio/Robin] hi", "[Gallery/Alex] hello", "[Draft/2] x"]);
  expect(result.names).toEqual(["Studio", "Gallery"]);
  expect(result.speakers).toEqual(["Robin", "Alex", "Owner"]);
});

test("real Brain loader without rooms accepts only Direct and does not import other settings", () => {
  const result = startup("", ["[Studio/Robin] hi", "[Room/Robin] hi", "[Direct/Alex] hi", "[Draft/2] x"]);
  expect(result.names).toEqual([]);
  expect(result.speakers).toEqual(["Owner", "Owner", "Alex", "Owner"]);
});

test("real Brain loader uses Room for URL-only configuration, never token-only configuration", () => {
  for (const name of ["", 'EMBERVY_ROOM_NAME="  "\n']) {
    const result = startup(`${name}EMBERVY_ROOM_URL=${urlCanary}\nEMBERVY_ROOM_TOKEN=${canary}`,
      ["[Room/Robin] hi", "[Draft/2] x"]);
    expect(result.names).toEqual(["Room"]);
    expect(result.speakers).toEqual(["Robin", "Owner"]);
  }
  const result = startup(`EMBERVY_ROOM_TOKEN=${canary}`, ["[Room/Robin] hi"]);
  expect(result.names).toEqual([]);
  expect(result.speakers).toEqual(["Owner"]);
});

test("real Brain loader uses Room for nameless list objects, not other list entries", () => {
  const result = startup(`EMBERVY_ROOMS='[null,[],3,{}]'`, ["[Room/Robin] hi"]);
  expect(result.names).toEqual(["Room"]);
  expect(result.speakers).toEqual(["Robin"]);
});

function configured(values: Record<string, string> = {}) {
  return { EMBERVY_ROOM_NAME: "", ROOM_NAME: "", EMBERVY_ROOMS: "", EMBERVY_ROOM_URL: "", ...values };
}

test("name cleaning matches the app for named configurations without needing connection settings", () => {
  const rawNames = [" Studio! /North ", "Café_二-3", "!?", "a".repeat(50), "𐐀".repeat(25), " Cafe\u0301 ", "  Gallery  "];
  const rooms = rawNames.map(name => ({ name, url: "https://room.example.test", token: "t".repeat(32) }));
  const env = configured({ EMBERVY_ROOM_NAME: " First/Room! ", EMBERVY_ROOMS: JSON.stringify(rooms) });
  const warnings: string[] = [];
  const app = roomConfigsFromEnv({ ...env, EMBERVY_ROOM_URL: "https://room.example.test", EMBERVY_ROOM_TOKEN: "t".repeat(32) }, line => warnings.push(line));
  expect(warnings).toEqual([]);
  expect([...houseRoomNames(env)]).toEqual(app.map(room => room.name));
  expect([...houseRoomNames(configured({ EMBERVY_ROOMS: JSON.stringify(rawNames.map(name => ({ name }))) }))])
    .toEqual(app.slice(1).map(room => room.name));
});

test("invalid lists and non-objects are ignored; nameless objects use the app default", () => {
  for (const value of ["{broken", "null", "42", '{}', '"Studio"']) {
    expect([...houseRoomNames(configured({ ROOM_NAME: "Legacy", EMBERVY_ROOMS: value }))]).toEqual(["Legacy"]);
  }
  const rooms = [null, [], 5, "Studio", {}, { name: null }, { name: 3 }, { name: "" }, { name: "  " },
    { name: "Studio" }, { name: "Gallery" }, { name: "Studio!" }];
  expect([...houseRoomNames(configured({ EMBERVY_ROOMS: JSON.stringify(rooms) }))]).toEqual(["Room", "Studio", "Gallery"]);
});

test("file parsing is selective, uses shared quoting rules and respects per-key environment precedence", () => {
  const home = mkdtempSync(join(tmpdir(), "room-settings-"));
  const before = { ...process.env };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    writeFileSync(join(home, ".env"), [
      `PRIVATE_CANARY=${canary}`,
      `PRIVATE_CANARY_TWO="${canary}`, // Even malformed unrelated values are ignored.
      `export EMBERVY_ROOM_NAME = 'File Studio' # inline comment`,
      `ROOM_NAME="File Gallery"`,
      `EMBERVY_ROOMS='[{"name":"List One"},{"name":"List Two","url":"${canary}","token":"${canary}"}]'`,
    ].join("\n"));
    expect([...houseRoomNames({ EMBERVY_HOME: home })]).toEqual(["File Studio", "File Gallery", "List One", "List Two"]);
    expect([...houseRoomNames({ EMBERVY_HOME: home, EMBERVY_ROOM_NAME: "Process Studio", ROOM_NAME: "" })])
      .toEqual(["Process Studio", "List One", "List Two"]);
    expect([...houseRoomNames({ EMBERVY_HOME: home, EMBERVY_ROOMS: "broken" })]).toEqual(["File Studio", "File Gallery"]);
    expect([...houseRoomNames({ EMBERVY_HOME: home, ...configured() })]).toEqual([]);
    expect(process.env).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("file precedence is per key, with explicit empty values masking app settings", () => {
  const home = mkdtempSync(join(tmpdir(), "room-precedence-"));
  const file = join(home, ".env");
  const env = { EMBERVY_HOME: home };
  try {
    mkdirSync(join(home, "Claude/app"), { recursive: true });
    writeFileSync(join(home, "Claude/app/.env"), [
      "EMBERVY_ROOM_NAME=App Studio", "ROOM_NAME=App Legacy",
      `EMBERVY_ROOMS='[{"name":"App List"}]'`, `EMBERVY_ROOM_URL=${urlCanary}`,
    ].join("\n"));
    writeFileSync(file, ["EMBERVY_ROOM_NAME=House Studio", "ROOM_NAME=House Legacy",
      `EMBERVY_ROOMS='[{"name":"House List"}]'`, "EMBERVY_ROOM_URL="].join("\n"));
    expect([...houseRoomNames(env)]).toEqual(["House Studio", "House Legacy", "House List"]);
    for (const [key, value, expected] of [
      ["EMBERVY_ROOM_NAME", "Process Studio", ["Process Studio", "House Legacy", "House List"]],
      ["ROOM_NAME", "Process Legacy", ["House Studio", "Process Legacy", "House List"]],
      ["EMBERVY_ROOMS", '[{"name":"Process List"}]', ["House Studio", "House Legacy", "Process List"]],
      ["EMBERVY_ROOM_NAME", "", ["House Legacy", "House List"]],
      ["ROOM_NAME", "", ["House Studio", "House List"]],
      ["EMBERVY_ROOMS", "", ["House Studio", "House Legacy"]],
    ] as const) {
      expect([...houseRoomNames({ ...env, [key]: value })]).toEqual(expected);
    }
    // Higher-priority empty names and URL presence are still set values.
    writeFileSync(file, "EMBERVY_ROOM_NAME=\nROOM_NAME=\nEMBERVY_ROOMS=\nEMBERVY_ROOM_URL=\n");
    expect([...houseRoomNames(env)]).toEqual([]);
    expect([...houseRoomNames({ ...env, EMBERVY_ROOM_URL: urlCanary })]).toEqual(["Room"]);
    writeFileSync(file, "EMBERVY_ROOM_NAME=\nROOM_NAME=\nEMBERVY_ROOMS=\n");
    expect([...houseRoomNames(env)]).toEqual(["Room"]);
    expect([...houseRoomNames({ ...env, EMBERVY_ROOM_URL: "" })]).toEqual([]);
    writeFileSync(file, "ROOM_NAME=House Legacy\n");
    expect([...houseRoomNames(env)]).toEqual(["App Studio", "House Legacy", "App List"]);
    expect([...houseRoomNames({ ...env, ...configured() })]).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("file caches refresh independently on app mtime, size, removal and creation", () => {
  const home = mkdtempSync(join(tmpdir(), "room-app-cache-"));
  const house = join(home, ".env");
  const app = join(home, "Claude/app/.env");
  const env = { EMBERVY_HOME: home };
  const open = spyOn(fs, "openSync");
  const reads = (file: string) => open.mock.calls.filter(call => call[0] === file).length;
  try {
    mkdirSync(join(home, "Claude/app"), { recursive: true });
    writeFileSync(house, "ROOM_NAME=Legacy");
    writeFileSync(app, "EMBERVY_ROOM_NAME=Studio");
    utimesSync(app, 1000, 1000);
    expect([...houseRoomNames(env)]).toEqual(["Studio", "Legacy"]);
    expect(reads(house)).toBe(1);
    expect(reads(app)).toBe(1);
    for (let i = 0; i < 3; i++) expect([...houseRoomNames(env)]).toEqual(["Studio", "Legacy"]);
    expect(reads(house)).toBe(1);
    expect(reads(app)).toBe(1);
    writeFileSync(app, "EMBERVY_ROOM_NAME=Office"); // Same size, different mtime.
    utimesSync(app, 1001, 1001);
    expect([...houseRoomNames(env)]).toEqual(["Office", "Legacy"]);
    expect(reads(app)).toBe(2);
    writeFileSync(app, "EMBERVY_ROOM_NAME=Gallery"); // Same mtime, different size.
    utimesSync(app, 1001, 1001);
    expect([...houseRoomNames(env)]).toEqual(["Gallery", "Legacy"]);
    expect(reads(app)).toBe(3);
    rmSync(app);
    expect([...houseRoomNames(env)]).toEqual(["Legacy"]);
    writeFileSync(app, "EMBERVY_ROOM_NAME=Gallery");
    utimesSync(app, 1001, 1001); // The removed entry must not survive with this stamp.
    expect([...houseRoomNames(env)]).toEqual(["Gallery", "Legacy"]);
    expect(reads(app)).toBe(4);
    expect(reads(house)).toBe(1);
    writeFileSync(house, "ROOM_NAME=House Gallery");
    expect([...houseRoomNames(env)]).toEqual(["Gallery", "House Gallery"]);
    expect(reads(house)).toBe(2);
    expect(reads(app)).toBe(4);
  } finally {
    open.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("file caches refresh on mtime, size and house changes without reopening unchanged files", () => {
  const home = mkdtempSync(join(tmpdir(), "room-cache-"));
  const other = mkdtempSync(join(tmpdir(), "room-cache-"));
  const file = join(home, ".env");
  const env = { EMBERVY_HOME: home };
  const open = spyOn(fs, "openSync");
  try {
    writeFileSync(file, "ROOM_NAME=Studio");
    utimesSync(file, 1000, 1000);
    expect([...houseRoomNames(env)]).toEqual(["Studio"]);
    const opened = open.mock.calls.length;
    expect(opened).toBeGreaterThan(0);
    const mutable = houseRoomNames(env);
    mutable.add("Forged");
    for (let i = 0; i < 10; i++) expect([...houseRoomNames(env)]).toEqual(["Studio"]);
    expect(open.mock.calls.length).toBe(opened);
    writeFileSync(file, "ROOM_NAME=Office"); // Same size, different mtime.
    utimesSync(file, 1001, 1001);
    expect([...houseRoomNames(env)]).toEqual(["Office"]);
    writeFileSync(file, "ROOM_NAME=Gallery"); // Same mtime, different size.
    utimesSync(file, 1001, 1001);
    expect([...houseRoomNames(env)]).toEqual(["Gallery"]);
    writeFileSync(join(other, ".env"), "ROOM_NAME=Other");
    expect([...houseRoomNames({ EMBERVY_HOME: other })]).toEqual(["Other"]);
    expect([...houseRoomNames(env)]).toEqual(["Gallery"]);
    rmSync(file);
    expect([...houseRoomNames(env)]).toEqual([]);
    writeFileSync(file, "ROOM_NAME=Restored");
    expect([...houseRoomNames(env)]).toEqual(["Restored"]);
  } finally {
    open.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("URL scanning retains only a bit, respects overrides and refreshes the cache", () => {
  const home = mkdtempSync(join(tmpdir(), "room-url-cache-"));
  const file = join(home, ".env");
  const env = { EMBERVY_HOME: home };
  const decoded: string[] = [];
  const original = Buffer.prototype.toString;
  const decode = spyOn(Buffer.prototype, "toString").mockImplementation(function (...args: any[]) {
    const text = original.apply(this, args as any);
    decoded.push(text);
    return text;
  });
  try {
    // Cross a read-buffer boundary, and leave the final line unterminated.
    writeFileSync(file, `#${"x".repeat(4050)}\nEMBERVY_ROOM_NAME=\nexport EMBERVY_ROOM_URL = '${urlCanary}'\nEMBERVY_ROOM_TOKEN=${canary}`);
    expect([...houseRoomNames(env)]).toEqual(["Room"]);
    expect([...houseRoomNames({ ...env, EMBERVY_ROOM_URL: "" })]).toEqual([]);
    expect([...houseRoomNames(env)]).toEqual(["Room"]);
    expect([...houseRoomNames({ ...env, EMBERVY_ROOM_NAME: "Studio" })]).toEqual(["Studio"]);
    expect(decoded.join("\n")).not.toContain(urlCanary);
    expect(decoded.join("\n")).not.toContain(canary);
    for (const value of ["", "   ", "''", '"  "', " # no URL", "' ' # no URL"]) {
      writeFileSync(file, `EMBERVY_ROOM_URL=${value}\n`);
      expect([...houseRoomNames(env)]).toEqual([]);
    }
    writeFileSync(file, `EMBERVY_ROOM_URL=${urlCanary}\nEMBERVY_ROOM_URL=\n`);
    expect([...houseRoomNames(env)]).toEqual([]);
    expect([...houseRoomNames({ ...env, EMBERVY_ROOM_URL: urlCanary })]).toEqual(["Room"]);
    expect([...houseRoomNames(env)]).toEqual([]);

    writeFileSync(file, `EMBERVY_ROOM_URL=${urlCanary}\nEMBERVY_ROOM_TOKEN=${canary}`);
    mkdirSync(join(home, "Claude/app"), { recursive: true });
    writeFileSync(join(home, "Claude/app/.env"),
      `EMBERVY_ROOM_URL=${urlCanary}\nEMBERVY_ROOM_TOKEN=${canary}\nEMBERVY_ROOMS='[{"name":"Studio","url":"${urlCanary}","token":"${canary}"}]'`);
    // Inspect the private cache in an isolated evaluation of the real module;
    // no production debug/export surface and no fixture module on disk.
    const source = fs.readFileSync(roomModule, "utf8")
      .replace('"../shared/scripts/env-file"', JSON.stringify(join(import.meta.dir, "../shared/scripts/env-file.ts")));
    const run = Bun.spawnSync([process.execPath, "--no-env-file", "-e", source + `
      houseRoomNames({EMBERVY_HOME: ${JSON.stringify(home)}});
      console.log(JSON.stringify({cache: [...cache.values()], env: process.env}));`], {
      cwd: home, env: { PATH: process.env.PATH!, HOME: home },
    });
    expect(run.exitCode).toBe(0);
    const output = run.stdout.toString() + run.stderr.toString();
    expect(output).not.toContain(urlCanary);
    expect(output).not.toContain(canary);
    expect(JSON.parse(run.stdout.toString()).cache.map((entry: { names: unknown }) => entry.names))
      .toEqual([{ urlConfigured: true }, { urlConfigured: true, EMBERVY_ROOMS: ["Studio"] }]);
  } finally {
    decode.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing or unreadable files produce only one class-only warning per process", () => {
  const home = mkdtempSync(join(tmpdir(), "room-unavailable-"));
  try {
    mkdirSync(join(home, "directory"));
    mkdirSync(join(home, "directory/.env"));
    const code = `import { houseRoomNames } from ${JSON.stringify(roomModule)};
      for (const home of ${JSON.stringify([join(home, "directory"), home, join(home, canary)])}) {
        for (let i = 0; i < 3; i++) console.log(JSON.stringify([...houseRoomNames({EMBERVY_HOME: home})]));
      }`;
    const run = Bun.spawnSync([process.execPath, "--no-env-file", "-e", code], {
      cwd: home, env: { PATH: process.env.PATH!, HOME: home },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim().split("\n")).toEqual(Array(9).fill("[]"));
    expect(run.stderr.toString().trim()).toBe("Brain: house room settings unavailable (unreadable).");
    expect(run.stderr.toString()).not.toContain(home);
    expect(run.stderr.toString()).not.toContain(canary);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
