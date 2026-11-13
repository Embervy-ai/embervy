// Only the app server writes this store; synchronous transactions cannot interleave.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const KEPT_MAX_ENTRIES = 200;
export const KEPT_MAX_TEXT = 20_000;
export type Speaker = "person" | "agent";
export type KeptEntry = {
  id: string;
  text: string;
  speaker: Speaker;
  said_at: string;
  kept_at: string;
  added_by: Speaker;
  message_id?: string;
  audio_url?: string;
};
export class KeptError extends Error {
  constructor(public code: "invalid" | "tooLong" | "full" | "storage") { super(code); }
}

const speaker = (value: unknown): value is Speaker => value === "person" || value === "agent";
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second = "0"] = parts;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return calendar.getUTCFullYear() === Number(year) && calendar.getUTCMonth() + 1 === Number(month) &&
    calendar.getUTCDate() === Number(day) && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
}
export const keptAudioUrl = (value: unknown): value is string => typeof value === "string" &&
  /^\/api\/images\/[A-Za-z0-9_-]{1,240}\.(?:mp3|m4a|ogg|wav|webm|mp4)$/i.test(value);
const messageId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value);

type Copy = Pick<KeptEntry, "text" | "speaker" | "said_at" | "added_by" | "message_id" | "audio_url">;
function validate(copy: Copy): void {
  if (typeof copy?.text !== "string" || !speaker(copy.speaker) || !speaker(copy.added_by) || !timestamp(copy.said_at)) throw new KeptError("invalid");
  if ([...copy.text].length > KEPT_MAX_TEXT) throw new KeptError("tooLong");
  if (!copy.text.trim() && !copy.audio_url) throw new KeptError("invalid");
  if (copy.message_id !== undefined && !messageId(copy.message_id)) throw new KeptError("invalid");
  if (copy.audio_url !== undefined && !keptAudioUrl(copy.audio_url)) throw new KeptError("invalid");
}

export class KeptStore {
  constructor(public readonly path: string) {}

  list(): KeptEntry[] {
    try {
      if (!existsSync(this.path)) return [];
      // Bound even a damaged file before allocating its contents; never replace it with an empty list.
      if (statSync(this.path).size > 32 * 1024 * 1024) throw new KeptError("storage");
      chmodSync(this.path, 0o600);
      const entries = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(entries) || entries.length > KEPT_MAX_ENTRIES) throw new KeptError("storage");
      const ids = new Set();
      for (const entry of entries) {
        validate(entry);
        if (!messageId(entry.id) || !timestamp(entry.kept_at) || ids.has(entry.id)) throw new KeptError("storage");
        ids.add(entry.id);
      }
      return entries.sort((a, b) => b.kept_at.localeCompare(a.kept_at));
    } catch { throw new KeptError("storage"); }
  }

  keep(copy: Copy): KeptEntry {
    validate(copy);
    const entries = this.list();
    const existing = copy.message_id && entries.find(entry => entry.message_id === copy.message_id);
    if (existing) return existing;
    if (entries.length >= KEPT_MAX_ENTRIES) throw new KeptError("full");
    // Whitelist fields so request metadata can never turn into persisted private state.
    const entry: KeptEntry = {
      id: randomUUID(), text: copy.text, speaker: copy.speaker, said_at: copy.said_at,
      kept_at: new Date().toISOString(), added_by: copy.added_by,
      ...(copy.message_id ? { message_id: copy.message_id } : {}),
      ...(copy.audio_url ? { audio_url: copy.audio_url } : {}),
    };
    this.write([entry, ...entries]);
    return entry;
  }

  remove(id: string): boolean {
    const entries = this.list();
    const remaining = entries.filter(entry => entry.id !== id);
    if (remaining.length === entries.length) return false;
    this.write(remaining);
    return true;
  }

  private write(entries: KeptEntry[]): void {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(entries));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
    } catch { throw new KeptError("storage"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}
