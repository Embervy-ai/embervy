// A leading [Room/Speaker] prefix names the speaker only for this house's
// configured room and for the fixed direct line. Everything else in square
// brackets is the human's own text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { houseRoomNames } from "./house-rooms";
import { roomConfigsFromEnv } from "../Claude/app/room-door";
import { roomUserSpeaker } from "./wake-bridge";
import { join } from "node:path";

const KEYS = ["EMBERVY_ROOM_NAME", "ROOM_NAME", "EMBERVY_ROOMS", "EMBERVY_ROOM_URL", "EMBERVY_ROOM_TOKEN"] as const;
const emptyConfig = { EMBERVY_ROOM_NAME: "", ROOM_NAME: "", EMBERVY_ROOMS: "", EMBERVY_ROOM_URL: "" };
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("houseRoomNames", () => {
  test("reads three name keys at call time, trimmed, without empty names", () => {
    expect([...houseRoomNames(emptyConfig)]).toEqual([]);
    expect([...houseRoomNames({ ...emptyConfig, EMBERVY_ROOM_NAME: " Workshop " })]).toEqual(["Workshop"]);
    expect([...houseRoomNames({ ...emptyConfig, EMBERVY_ROOM_NAME: "Workshop", ROOM_NAME: "Office" })].sort()).toEqual(["Office", "Workshop"]);
    process.env.ROOM_NAME = "Later";
    expect(houseRoomNames().has("Later")).toBe(true);
    process.env.EMBERVY_ROOMS = '[{"name":"Gallery"}]';
    expect(houseRoomNames().has("Gallery")).toBe(true);
  });
});

describe("roomUserSpeaker", () => {
  test("a configured room names its speaker", () => {
    process.env.EMBERVY_ROOM_NAME = "Workshop";
    expect(roomUserSpeaker("[Workshop/Peer] the build is green", "Owner")).toBe("Peer");
    expect(roomUserSpeaker("  [Workshop/ Peer ] with spaces", "Owner")).toBe("Peer");
    process.env.ROOM_NAME = "Office";
    expect(roomUserSpeaker("[Office/Ada] second key", "Owner")).toBe("Ada");
  });

  test("the direct line names its speaker without any configuration", () => {
    expect(roomUserSpeaker("[Direct/Peer] a private note", "Owner")).toBe("Peer");
  });

  test("the prefix is read inside a channel wrapper", () => {
    process.env.EMBERVY_ROOM_NAME = "Workshop";
    expect(roomUserSpeaker('<channel source="app" user="Owner">[Workshop/Peer] hello</channel>', "Owner")).toBe("Peer");
    expect(roomUserSpeaker('<channel source="app" user="Owner">[Draft/2] like this please</channel>', "Owner")).toBe("Owner");
  });

  test("unknown rooms and ordinary bracket text stay with the human", () => {
    process.env.EMBERVY_ROOM_NAME = "Workshop";
    for (const text of [
      "[Draft/2] like this please",
      "[a/b] is the ratio I meant",
      "[Kitchen/Peer] not a room of this house",
      "[workshop/Peer] room names are case-sensitive",
      "[direct/Peer] so is the direct line",
      "[Workshop] no speaker part",
      "[Workshop/Peer/Extra] too many parts",
      "see [Workshop/Peer] in the middle of a sentence",
      "no brackets at all",
    ]) expect(roomUserSpeaker(text, "Owner")).toBe("Owner");
  });

  test("without a configured room only the direct line is a prefix", () => {
    expect(roomUserSpeaker("[Workshop/Peer] hello", "Owner")).toBe("Owner");
  });

  test("an empty speaker falls back to the human", () => {
    process.env.EMBERVY_ROOM_NAME = "Workshop";
    expect(roomUserSpeaker("[Workshop/ ] hello", "Owner")).toBe("Owner");
  });
});

test("room-list archive integration through the real export script", () => {
  const run = Bun.spawnSync([process.execPath, "test", join(import.meta.dir, "../Claude/scripts/session-to-rag.test.ts"),
    "--test-name-pattern", "room list archive regression"], {
    cwd: import.meta.dir, env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
  });
  if (run.exitCode !== 0) console.error(run.stdout.toString() + run.stderr.toString());
  expect(run.exitCode).toBe(0);
}, 30000);

test("Python room-name unit regressions", () => {
  const run = Bun.spawnSync(["python3", "-B", join(import.meta.dir, "../Claude/scripts/transcript_speech_test.py")], {
    env: { PATH: process.env.PATH! },
  });
  if (run.exitCode !== 0) console.error(run.stderr.toString());
  expect(run.exitCode).toBe(0);
  expect(run.stderr.toString()).toMatch(/Ran [1-9]\d* tests?\b/);
  expect(run.stderr.toString()).toMatch(/\bOK\s*$/);
});

describe("Brain, Python and app default-name parity", () => {
  const connection = { url: "https://room.example.test", token: "t".repeat(32) };
  const configs = [
    { EMBERVY_ROOM_URL: connection.url, EMBERVY_ROOM_TOKEN: connection.token },
    { EMBERVY_ROOM_URL: connection.url, EMBERVY_ROOM_TOKEN: connection.token, EMBERVY_ROOM_NAME: "  " },
    { EMBERVY_ROOM_TOKEN: connection.token },
    ...[undefined, null, false, 3, "", "  ", "!?"].map(name => ({
      EMBERVY_ROOMS: JSON.stringify([{ ...connection, name }]),
    })),
    { EMBERVY_ROOMS: JSON.stringify([null, [], 3, "Room"]) },
  ];
  for (const [index, config] of configs.entries()) test(`default names agree, case ${index}`, () => {
    const env = { ...emptyConfig, ...config };
    Object.assign(process.env, env);
    const app = roomConfigsFromEnv(env, () => {}).map(room => room.name).sort();
    const program = `import json
from transcript_speech import house_room_names, user_speech
entry = {"type":"user", "message":{"role":"user", "content":"[Room/Robin] hi"}}
print(json.dumps({"names": sorted(house_room_names()), "speaker": user_speech(entry, "Owner")[0][0]}))`;
    const run = Bun.spawnSync(["python3", "-B", "-c", program], {
      env: { PATH: process.env.PATH!, PYTHONPATH: join(import.meta.dir, "../Claude/scripts"),
        EMBERVY_ROOM_NAME: env.EMBERVY_ROOM_NAME, ROOM_NAME: env.ROOM_NAME, EMBERVY_ROOMS: env.EMBERVY_ROOMS,
        _TRANSCRIPT_ROOM_URL_PRESENT: /\S/.test(env.EMBERVY_ROOM_URL) ? "1" : "" },
    });
    expect(run.exitCode).toBe(0);
    const python = JSON.parse(run.stdout.toString());
    expect([...houseRoomNames(env)].sort()).toEqual(app);
    expect(python.names).toEqual(app);
    const expected = app.includes("Room") ? "Robin" : "Owner";
    expect(python.speaker).toBe(expected);
    expect(roomUserSpeaker("[Room/Robin] hi", "Owner")).toBe(expected);
  });
});

describe("Brain and transcript speech parity", () => {
  const configs = [
    {},
    { EMBERVY_ROOM_NAME: " Workshop " },
    { EMBERVY_ROOM_URL: "https://room.example.test" },
    { EMBERVY_ROOM_URL: "https://room.example.test", EMBERVY_ROOM_NAME: "  " },
    { EMBERVY_ROOM_URL: "https://room.example.test", ROOM_NAME: "Legacy" },
    { ROOM_NAME: " Office! " },
    { EMBERVY_ROOMS: JSON.stringify([{ name: "Workshop" }, { name: "Office!" }, {}, null, { name: 12 }]) },
    { EMBERVY_ROOM_NAME: "Workshop", EMBERVY_ROOMS: "{broken" },
    { EMBERVY_ROOMS: '{"name":"Workshop"}' },
    { EMBERVY_ROOMS: JSON.stringify([{ name: "Café_二" }, { name: "!?" }, { name: "𐐀".repeat(25) }]) },
  ];
  for (const [index, config] of configs.entries()) test(`configured names and speakers agree, case ${index}`, () => {
    const env = { ...emptyConfig, ...config };
    Object.assign(process.env, env);
    const texts = ["[Workshop/Peer] hi", "[Office/Ada] hi", "[Direct/Peer] hi", "[Draft/2] x",
      "[Room/Peer] hi", "[Café_二/Peer] hi", `[${"𐐀".repeat(20)}/Peer] hi`, "[Workshop/ ] hi",
      "[workshop/Peer] hi", "[Workshop/Peer/Extra] hi", "see [Workshop/Peer] here",
      '<channel source="app">[Office/Ada] hi</channel>'];
    const program = `import json, sys
from transcript_speech import house_room_names, user_speech
texts = json.load(sys.stdin)
print(json.dumps({"names": sorted(house_room_names()), "speakers": [user_speech({"type":"user", "message":{"role":"user", "content":text}}, "Owner")[0][0] for text in texts]}))`;
    const run = Bun.spawnSync(["python3", "-B", "-c", program], {
      cwd: process.env.EMBERVY_HOME,
      env: { PATH: process.env.PATH!, PYTHONPATH: join(import.meta.dir, "../Claude/scripts"), ...env,
        EMBERVY_ROOM_URL: undefined, _TRANSCRIPT_ROOM_URL_PRESENT: /\S/.test(env.EMBERVY_ROOM_URL) ? "1" : "" },
      stdin: Buffer.from(JSON.stringify(texts)),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr.toString()).toBe("");
    const python = JSON.parse(run.stdout.toString());
    expect([...houseRoomNames(env)].sort()).toEqual(python.names);
    expect(texts.map(text => roomUserSpeaker(text, "Owner"))).toEqual(python.speakers);
  });
});
