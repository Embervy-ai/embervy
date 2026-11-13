import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeptError, KeptStore, KEPT_MAX_ENTRIES, KEPT_MAX_TEXT, keptAudioUrl } from "./kept";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "kept-store-"));
  dirs.push(dir);
  return { dir, store: new KeptStore(join(dir, "kept.json")) };
}
const copy = (extra = {}) => ({ text: "An unchanged passage.\n\n```sh\necho test\n```", speaker: "person" as const,
  said_at: "2024-02-29T12:34:56+01:00", added_by: "person" as const, ...extra });
function rejects(code: string, action: () => unknown) {
  try { action(); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(KeptError); expect((error as KeptError).code).toBe(code); }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("stores an independent copy with its own identifier and timestamps", () => {
  const { store } = fixture();
  const original = { ...copy(), message_id: "message-1", audio_url: "/api/images/voice-1.webm" };
  const before = Date.now();
  const saved = store.keep(original);
  expect(saved).toMatchObject(original);
  expect(saved.id).not.toBe(original.message_id);
  expect(Date.parse(saved.kept_at)).toBeGreaterThanOrEqual(before);
  original.text = "Changed source";
  saved.text = "Changed return value";
  expect(store.list()[0].text).toBe(copy().text);
  const listed = store.list();
  listed[0].text = "Changed list result";
  expect(new KeptStore(store.path).list()[0].text).toBe(copy().text);
});

test("duplicate message IDs are idempotent and removing an entry leaves other copies intact", () => {
  const { store } = fixture();
  const first = store.keep(copy({ message_id: "same" }));
  expect(store.keep(copy({ message_id: "same", text: "Different request" }))).toEqual(first);
  const second = store.keep(copy({ added_by: "agent", speaker: "agent" }));
  expect(store.list()).toHaveLength(2);
  expect(store.remove(first.id)).toBe(true);
  expect(store.remove(first.id)).toBe(false);
  expect(store.list()).toEqual([second]);
});

test("text limits reject rather than truncate and count Unicode characters", () => {
  const { store } = fixture();
  const text = "🙂".repeat(KEPT_MAX_TEXT);
  expect(store.keep(copy({ text })).text).toBe(text);
  rejects("tooLong", () => store.keep(copy({ text: "x".repeat(KEPT_MAX_TEXT + 1) })));
  rejects("tooLong", () => store.keep(copy({ text: text + "🙂" })));
  expect(store.list()).toHaveLength(1);
});

test("the full list rejects new copies but still supports duplicate requests and removal", () => {
  const { store } = fixture();
  for (let i = 0; i < KEPT_MAX_ENTRIES; i++) store.keep(copy({ message_id: `message-${i}` }));
  const disk = readFileSync(store.path, "utf8");
  rejects("full", () => store.keep(copy({ added_by: "agent" })));
  expect(readFileSync(store.path, "utf8")).toBe(disk);
  expect(store.keep(copy({ message_id: "message-0" })).message_id).toBe("message-0");
  expect(store.list()).toHaveLength(KEPT_MAX_ENTRIES);
  store.remove(store.list()[0].id);
  store.keep(copy({ added_by: "agent" }));
  expect(store.list()).toHaveLength(KEPT_MAX_ENTRIES);
});

test("private atomic replacements survive fresh store instances and tighten old permissions", () => {
  const { store, dir } = fixture();
  expect(store.list()).toEqual([]);
  const one = store.keep(copy());
  const inode = statSync(store.path).ino;
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  const two = store.keep(copy({ added_by: "agent" }));
  expect(statSync(store.path).ino).not.toBe(inode);
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(["kept.json"]);
  chmodSync(store.path, 0o644);
  expect(new KeptStore(store.path).list()).toEqual(expect.arrayContaining([one, two]));
  expect(statSync(store.path).mode & 0o777).toBe(0o600);
  store.remove(one.id);
  expect(new KeptStore(store.path).list()).toEqual([two]);
});

test("lists newest first, independently of file order", () => {
  const { store } = fixture();
  const older = store.keep(copy());
  const newer = store.keep(copy());
  older.kept_at = "2024-01-01T00:00:00Z";
  newer.kept_at = "2025-01-01T00:00:00Z";
  writeFileSync(store.path, JSON.stringify([older, newer]));
  expect(store.list().map(entry => entry.id)).toEqual([newer.id, older.id]);
});

test("rejects invalid metadata, external audio and invalid calendar dates without saving", () => {
  const { store } = fixture();
  for (const extra of [
    { text: " " }, { text: 7 }, { speaker: "user" }, { added_by: "unknown" },
    { said_at: "2025-01-01" }, { said_at: "2025-01-01T12:00:00" }, { said_at: "2025-02-29T12:00:00Z" },
    { said_at: "2025-01-01T24:00:00Z" }, { said_at: "tomorrow" },
    { message_id: "../id" }, { audio_url: "https://example.invalid/audio.mp3" },
    { audio_url: "/api/images/../voice.mp3" }, { audio_url: "/api/images/voice.svg" },
  ]) rejects("invalid", () => store.keep(copy(extra) as any));
  expect(store.list()).toEqual([]);
  expect(keptAudioUrl("/api/images/voice.mp3")).toBe(true);
  expect(store.keep(copy({ text: "", audio_url: "/api/images/voice.mp3" })).text).toBe("");
});

test("unknown input fields are never persisted", () => {
  const { store } = fixture();
  const entry = store.keep(copy({ id: "forged", kept_at: "2020-01-01T00:00:00Z", secret: "not stored" }));
  expect(entry.id).not.toBe("forged");
  expect(entry.kept_at).not.toBe("2020-01-01T00:00:00Z");
  expect(readFileSync(store.path, "utf8")).not.toContain("not stored");
});

test("damaged stores fail closed without overwriting their contents", () => {
  const { store } = fixture();
  for (const data of ["not json", "{}", '[{"text":"incomplete"}]']) {
    writeFileSync(store.path, data);
    rejects("storage", () => store.list());
    rejects("storage", () => store.keep(copy()));
    rejects("storage", () => store.remove("any"));
    expect(readFileSync(store.path, "utf8")).toBe(data);
  }
});

test("filesystem failures expose only a neutral storage code", () => {
  const { dir } = fixture();
  const parent = join(dir, "blocked");
  writeFileSync(parent, "not a directory");
  rejects("storage", () => new KeptStore(join(parent, "kept.json")).keep(copy()));
  const target = join(dir, "directory");
  mkdirSync(target);
  rejects("storage", () => new KeptStore(target).list());
  expect(readFileSync(parent, "utf8")).toBe("not a directory");
});
