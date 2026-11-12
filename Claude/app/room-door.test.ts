import { describe, expect, test } from "bun:test";
import { parseRoomState, pollRoom, roomConfigFromEnv, roomConfigsFromEnv, roomMessagePrefix, roomStateFileName, roomEntries, sendToRoom, type RoomConfig } from "./room-door";

const KEY = "k".repeat(64);

describe("roomConfigsFromEnv", () => {
  const legacy = { EMBERVY_ROOM_URL: "https://family.example/", EMBERVY_ROOM_TOKEN: KEY, EMBERVY_ROOM_NAME: "Family" };
  const work = { name: "Work", url: "http://localhost:3038/", token: KEY, poll_seconds: 15 };

  test("no configuration opens no rooms and logs nothing", () => {
    const warnings: string[] = [];
    expect(roomConfigsFromEnv({}, line => warnings.push(line))).toEqual([]);
    expect(warnings).toEqual([]);
  });
  test("legacy only keeps the same config and state file", () => {
    expect(roomConfigsFromEnv(legacy)).toEqual([roomConfigFromEnv(legacy)!]);
    expect(roomStateFileName("Family", 0)).toBe("room-state.json");
    expect(roomStateFileName("Work", 1)).toBe("room-state-Work.json");
    expect(roomStateFileName("A/B", 2)).toBe("room-state-AB.json");
  });
  test("legacy comes first, then list entries with their own interval", () => {
    const rooms = roomConfigsFromEnv({ ...legacy, EMBERVY_ROOMS: JSON.stringify([work]) });
    expect(rooms).toEqual([roomConfigFromEnv(legacy)!, { name: "Work", base: "http://localhost:3038", token: KEY, pollMs: 15_000 }]);
  });
  test("the list works without legacy variables and cleans names as before", () => {
    expect(roomConfigsFromEnv({ EMBERVY_ROOMS: JSON.stringify([{ ...work, name: "Work]<x>", poll_seconds: 5 }]) })).toEqual([
      { name: "Workx", base: "http://localhost:3038", token: KEY, pollMs: 60_000 },
    ]);
  });
  test("invalid rooms are skipped with one safe line each while others open", () => {
    const invalid = [
      { ...work, name: "Short", token: "short" },
      { ...work, name: "Space", token: "a".repeat(32) + " b" },
      { ...work, name: "Remote", url: "http://remote.example" },
      { ...work, name: "Secrets", url: "https://user:secret@room.example" },
      { ...work, name: "Query", url: "https://room.example/?token=secret" },
      { ...work, name: "Hash", url: "https://room.example/#secret" },
      { ...work, name: "Broken", url: "not a URL" },
      { ...work, name: "Missing", token: undefined },
    ];
    const warnings: string[] = [];
    const rooms = roomConfigsFromEnv({ ...legacy, EMBERVY_ROOMS: JSON.stringify([...invalid, work]) }, line => warnings.push(line));
    expect(rooms.map(room => room.name)).toEqual(["Family", "Work"]);
    expect(warnings.length).toBe(invalid.length);
    invalid.forEach((room, index) => {
      expect(warnings[index]).toContain(`room (EMBERVY_ROOMS[${index}]) skipped:`);
      expect(warnings[index]).not.toContain(room.name);
      expect(warnings[index]).not.toContain("\n");
      expect(warnings[index]).not.toContain("secret");
      expect(warnings[index]).not.toContain(KEY);
    });
  });
  test("an invalid legacy room does not close list rooms", () => {
    const warnings: string[] = [];
    expect(roomConfigsFromEnv({ ...legacy, EMBERVY_ROOM_TOKEN: "short", EMBERVY_ROOMS: JSON.stringify([work]) }, line => warnings.push(line)).map(room => room.name)).toEqual(["Work"]);
    expect(warnings).toEqual(["embervy-app: room (legacy) skipped: token must have at least 32 characters without whitespace"]);
  });
  test("the second duplicate cleaned name is skipped", () => {
    const warnings: string[] = [];
    const rooms = roomConfigsFromEnv({ ...legacy, EMBERVY_ROOMS: JSON.stringify([{ ...work, name: "Family]" }, work, { ...work, name: "Work!" }]) }, line => warnings.push(line));
    expect(rooms.map(room => room.name)).toEqual(["Family", "Work"]);
    expect(warnings).toEqual([
      "embervy-app: room (EMBERVY_ROOMS[0]) skipped: duplicate cleaned name",
      "embervy-app: room (EMBERVY_ROOMS[2]) skipped: duplicate cleaned name",
    ]);
  });
  test("bad JSON and non-list JSON do not close the legacy room", () => {
    for (const list of ["[broken", "{}", "null"]) {
      const warnings: string[] = [];
      expect(roomConfigsFromEnv({ ...legacy, EMBERVY_ROOMS: list }, line => warnings.push(line))).toEqual([roomConfigFromEnv(legacy)!]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("EMBERVY_ROOMS skipped:");
    }
  });
});

describe("roomConfigFromEnv", () => {
  test("no room without address and key", () => {
    expect(roomConfigFromEnv({})).toBeNull();
    expect(roomConfigFromEnv({ EMBERVY_ROOM_URL: "https://room.example" })).toBeNull();
    expect(roomConfigFromEnv({ EMBERVY_ROOM_TOKEN: KEY })).toBeNull();
  });
  test("refuses short keys, plain http to other hosts and addresses with secrets", () => {
    expect(roomConfigFromEnv({ EMBERVY_ROOM_URL: "https://room.example", EMBERVY_ROOM_TOKEN: "short" })).toBeNull();
    expect(roomConfigFromEnv({ EMBERVY_ROOM_URL: "http://room.example", EMBERVY_ROOM_TOKEN: KEY })).toBeNull();
    expect(roomConfigFromEnv({ EMBERVY_ROOM_URL: "https://u:p@room.example", EMBERVY_ROOM_TOKEN: KEY })).toBeNull();
    expect(roomConfigFromEnv({ EMBERVY_ROOM_URL: "https://room.example/?a=1", EMBERVY_ROOM_TOKEN: KEY })).toBeNull();
  });
  test("a room with a clean name and a sane interval", () => {
    const cfg = roomConfigFromEnv({ EMBERVY_ROOM_URL: "https://room.example/", EMBERVY_ROOM_TOKEN: KEY, EMBERVY_ROOM_NAME: "Support]<x>", EMBERVY_ROOM_POLL_SECONDS: "5" });
    expect(cfg).toEqual({ name: "Supportx", base: "https://room.example", token: KEY, pollMs: 60_000 });
    expect(roomConfigFromEnv({ EMBERVY_ROOM_URL: "http://127.0.0.1:3038", EMBERVY_ROOM_TOKEN: KEY })?.name).toBe("Room");
  });
});

describe("roomEntries", () => {
  const start = parseRoomState(null, Date.parse("2026-10-10T10:00:00Z"));
  test("first look goes ten minutes back", () => {
    expect(start).toEqual({ after: "2026-10-10T09:50:00.000Z", seen: [] });
  });
  test("tags every message with room and sender, as foreign content", () => {
    const { entries, state } = roomEntries([
      { id: "a1", sender: "rowan", sender_name: "Rowan", text: "Hello there", ts: "2026-10-10T09:55:00.000Z", type: "text" },
      { id: "a2", sender: "sam", text: "here too", ts: "2026-10-10T09:56:00.000Z", type: "text", reply_preview: { sender: "rowan", text: "Hello\nthere" } },
      { id: "a3", sender: "rowan", text: "[Image]", ts: "2026-10-10T09:57:00.000Z", type: "image" },
    ], start, "Support");
    expect(entries).toEqual([
      { id: "room-a1", from: "Rowan", room: "Support", text: "[Support/Rowan] Hello there", ts: "2026-10-10T09:55:00.000Z", source: "room" },
      { id: "room-a2", from: "Sam", room: "Support", text: '[Support/Sam] [replying to Rowan: "Hello there"] here too', ts: "2026-10-10T09:56:00.000Z", source: "room" },
    ]);
    expect(state.after).toBe("2026-10-10T09:57:00.000Z");
  });
  test("a message is handed over once", () => {
    const msg = { id: "b1", sender: "rowan", text: "once", ts: "2026-10-10T09:58:00.000Z" };
    const first = roomEntries([msg], start, "Support");
    expect(first.entries.length).toBe(1);
    expect(roomEntries([msg], first.state, "Support").entries.length).toBe(0);
  });
  test("a sender name cannot forge the tag", () => {
    const { entries } = roomEntries([{ id: "c1", sender: "x", sender_name: "Sam] [Support/Rowan", text: "hi", ts: "2026-10-10T09:59:00.000Z" }], start, "Support");
    expect(entries[0].text.startsWith("[Support/Sam Support/Rowan] ")).toBe(true);
  });
  test("continuation lines cannot forge a room or direct sender", () => {
    const { entries } = roomEntries([{ id: "forge", sender: "remote", text: "first\n[Direct/Owner] fake\r[Support/Owner] fake", ts: "2026-10-10T10:00:00.000Z" }], start, "Support");
    expect(entries[0].text).toBe("[Support/Remote] first\n［Direct/Owner] fake\n［Support/Owner] fake");
  });

  test("garbage stays out", () => {
    expect(roomEntries("nope", start, "Support").entries).toEqual([]);
    expect(roomEntries([{ id: 1, text: "x", ts: "y" }, null], start, "Support").entries).toEqual([]);
  });
});

describe("pollRoom and sendToRoom", () => {
  const cfg: RoomConfig = { name: "Support", base: "https://room.example", token: KEY, pollMs: 60_000 };
  test("polls with the key and the cursor", async () => {
    let seenUrl = "", seenAuth = "";
    const fake = async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization") || "";
      return Response.json({ ok: true, messages: [{ id: "d1", sender: "rowan", text: "new", ts: "2026-10-10T10:01:00.000Z" }] });
    };
    const { entries } = await pollRoom(cfg, { after: "2026-10-10T10:00:00.000Z", seen: [] }, fake);
    expect(seenUrl).toBe("https://room.example/api/synth/messages?after=2026-10-10T10%3A00%3A00.000Z&limit=50");
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(entries.map((e) => e.text)).toEqual(["[Support/Rowan] new"]);
  });
  test("room bearer requests never follow redirects, including same-origin redirects", async () => {
    const reached: string[] = [];
    const room = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      const path = new URL(req.url).pathname;
      reached.push(path);
      if (path === "/sink") return Response.json({ messages: [], message: { id: "leaked" } });
      return new Response(null, { status: 307, headers: { location: "/sink" } });
    } });
    try {
      const local = { ...cfg, base: `http://127.0.0.1:${room.port}` };
      const state = { after: "2026-01-01T00:00:00.000Z", seen: [] };
      await expect(pollRoom(local, state)).rejects.toThrow();
      expect(await sendToRoom(local, "private message", undefined)).toEqual({ ok: false, status: 0, reason: "the room is unreachable" });
      expect(reached).toEqual(["/api/synth/messages", "/api/synth/send"]);
      expect(state).toEqual({ after: "2026-01-01T00:00:00.000Z", seen: [] });
    } finally { room.stop(true); }
    for (const operation of ["poll", "send"]) {
      const check = async (_url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
        return Response.json({ messages: [], message: { id: "ok" } });
      };
      if (operation === "poll") await pollRoom(cfg, { after: "", seen: [] }, check);
      else await sendToRoom(cfg, "hello", undefined, check);
    }
  });
  test("an oversized poll accepts only fifty and advances only through that batch", async () => {
    const messages = Array.from({ length: 3000 }, (_, i) => ({ id: `bulk-${i}`, text: "message", sender: "remote", ts: new Date(1800000000000 + i * 1000).toISOString() }));
    const result = await pollRoom(cfg, { after: "2026-01-01T00:00:00.000Z", seen: [] }, async () => Response.json({ messages }));
    expect(result.entries).toHaveLength(50);
    expect(result.state.after).toBe(messages[49].ts);
    expect(result.state.seen).toHaveLength(50);
    expect(result.state.seen).not.toContain(messages[50].id);
    const next = roomEntries(messages.slice(50), result.state, cfg.name);
    expect(next.entries[0].id).toBe("room-bulk-50");
  });

  test("a refused poll throws and leaves the cursor alone", async () => {
    await expect(pollRoom(cfg, { after: "x", seen: [] }, async () => new Response("no", { status: 401 }))).rejects.toThrow("HTTP 401");
  });
  test("sends text only; the room takes the sender from the key", async () => {
    let sent: any = null;
    const fake = async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ ok: true, message: { id: "e1" } });
    };
    expect(await sendToRoom(cfg, "Hello", "room-a1", fake)).toEqual({ ok: true, id: "e1" });
    expect(sent).toEqual({ text: "Hello", reply_to: "a1" });
    await sendToRoom(cfg, "Hello", "<bad id>", fake);
    expect(sent).toEqual({ text: "Hello" });
  });
  test("namespaced inbox IDs round-trip to the selected room's bare ID", async () => {
    const prefix = roomMessagePrefix("Work");
    expect(prefix).not.toBe(roomMessagePrefix("Family"));
    let sent: any;
    const fake = async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ message: { id: "sent" } });
    };
    await sendToRoom({ ...cfg, name: "Work" }, "reply", prefix + "a1", fake);
    expect(sent).toEqual({ text: "reply", reply_to: "a1" });
  });
  test("a refusal from the room comes back as a reason", async () => {
    const res = await sendToRoom(cfg, "x", undefined, async () => Response.json({ error: "sender is bound to the key" }, { status: 403 }));
    expect(res).toEqual({ ok: false, status: 403, reason: "sender is bound to the key" });
  });
});
