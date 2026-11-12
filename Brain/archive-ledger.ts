import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PendingUpload } from "./pending-uploads";

export interface ArchiveReceipt {
  session: string;
  name: string;
  path: string;
  archived_at: string | null;
  uploaded_at: string | null;
}

/** Late archives belong beside their chronological predecessor, not to the next cut. */
export function catchUpArchiveName(session: string, prefix: string, receipts: ReadonlyMap<string, ArchiveReceipt>, files: Iterable<string>): string {
  const reserved = receipts.get(session)?.name;
  if (reserved) return reserved;
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)(?:\\.(\\d+))?(?:_part\\d+)?\\.md$`);
  const startedAt = (id: string): number | null => {
    const match = /^(\d+)-/.exec(id);
    const time = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(time) ? time : null;
  };
  const start = startedAt(session);
  let base = 0, latest = -1;
  const known = new Set(files);
  for (const receipt of receipts.values()) {
    const file = `${receipt.name}.md`;
    known.add(file);
    const match = pattern.exec(file);
    const time = startedAt(receipt.session);
    if (!match || time === null || start === null || time > start) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number)) continue;
    if (time > latest || (time === latest && number > base)) { latest = time; base = number; }
  }
  const used = new Set<number>();
  for (const file of known) {
    const match = pattern.exec(file);
    if (match && Number(match[1]) === base && match[2]) used.add(Number(match[2]));
  }
  let suffix = 1;
  while (used.has(suffix)) suffix += 1;
  return `${prefix}_${base}.${suffix}`;
}

export function readArchiveLedger(file: string): Map<string, ArchiveReceipt> {
  const entries = new Map<string, ArchiveReceipt>();
  if (!existsSync(file)) return entries;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let entry: ArchiveReceipt;
    try { entry = JSON.parse(line) as ArchiveReceipt; }
    catch (error) {
      // A killed append can leave an incomplete final receipt.
      if (index === lines.length - 1 && !text.endsWith("\n")) break;
      throw error;
    }
    if (!entry?.session || !entry.name || !entry.path) throw new Error("Invalid archive ledger entry");
    entries.set(entry.session, entry);
  }
  return entries;
}

export function recordArchive(file: string, entry: ArchiveReceipt): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const fd = openSync(file, "r");
    let unfinished = false;
    try {
      const size = fstatSync(fd).size;
      const lastByte = Buffer.alloc(1);
      if (size) { readSync(fd, lastByte, 0, 1, size - 1); unfinished = lastByte[0] !== 10; }
    } finally { closeSync(fd); }
    if (unfinished) {
      const text = readFileSync(file, "utf8");
      const last = text.lastIndexOf("\n") + 1;
      let complete = false;
      try { JSON.parse(text.slice(last)); complete = true; } catch {}
      if (complete) appendFileSync(file, "\n");
      else truncateSync(file, Buffer.byteLength(text.slice(0, last)));
    }
  }
  appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

// A below-threshold marker is not evidence that an archive exists and must not seed a receipt.
export function seedArchiveLedger(file: string, logDir: string, archiveDir: string, uploadLedger: string, pending: PendingUpload[]): void {
  if (existsSync(file)) return;
  const entries = new Map<string, ArchiveReceipt>();
  const note = (session: string, name: string, path: string, uploaded: boolean, at?: string) => {
    if (!session || !name) return;
    const previous = entries.get(session);
    const timestamp = at ?? new Date().toISOString();
    entries.set(session, { session, name, path, archived_at: previous?.archived_at ?? (uploaded || existsSync(path) ? timestamp : null), uploaded_at: uploaded ? timestamp : previous?.uploaded_at ?? null });
  };
  let logs: string[] = [];
  try { logs = readdirSync(logDir).filter((name) => /^session-.+\.jsonl$/.test(name)); } catch {}
  for (const log of logs) {
    for (const line of readFileSync(join(logDir, log), "utf8").split("\n")) {
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "session_archived" && event.type !== "catch_up_archived") continue;
      note(event.session ?? log.slice(8, -6), event.name, event.local_path ?? join(archiveDir, `${event.name}.md`), event.uploaded === true, event.at);
    }
  }
  if (uploadLedger && existsSync(uploadLedger)) {
    for (const line of readFileSync(uploadLedger, "utf8").split("\n")) {
      const match = /^conversation-(.+)\.jsonl:\d+:\d+:(.+)$/.exec(line);
      if (match) note(match[1], match[2], join(archiveDir, `${match[2]}.md`), true);
    }
  }
  for (const entry of pending) note(entry.session, entry.name, entry.path, false, entry.since);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, [...entries.values()].map((entry) => JSON.stringify(entry) + "\n").join(""), { mode: 0o600 });
  renameSync(temp, file);
}
