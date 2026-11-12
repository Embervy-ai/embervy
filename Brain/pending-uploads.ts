/**
 * Sessions archived locally whose RAG upload failed.
 * Each waits here with its name and file; Brain retries them at every start
 * with the same name, and the doctor reports what still waits. Pure file I/O.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** segments: the session's rolling live segments already in the RAG; they go
 * once the whole session landed, as after a cut whose upload worked.
 * log: its conversation log, for the upload ledger once it landed. */
/** deferred: a cut with a restart left the upload to the next start on purpose. */
export interface PendingUpload { session: string; name: string; path: string; since: string; segments?: string[]; log?: string; deferred?: boolean }

export function readPendingUploads(file: string): PendingUpload[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const p = JSON.parse(line);
        return typeof p?.name === "string" && typeof p?.path === "string" ? [p as PendingUpload] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

export function writePendingUploads(file: string, list: PendingUpload[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, list.map((p) => JSON.stringify(p)).join("\n") + (list.length ? "\n" : ""));
  renameSync(tmp, file);
}
