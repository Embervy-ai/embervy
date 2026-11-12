import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HelperActivity } from "./live-view";
import { tr } from "./texts";

/** Delivery retries are not new completions; exit=null with endedAt set means ended with an unknown exit. */
export function residentTaskActivity(previous: readonly ResidentTaskEntry[], next: readonly ResidentTaskEntry[]): HelperActivity[] {
  const before = new Map(previous.map((task) => [task.id, task]));
  const events: HelperActivity[] = [];
  for (const task of next) {
    const old = before.get(task.id);
    const running = task.exit === null && task.endedAt === null;
    const wasRunning = old && old.exit === null && old.endedAt === null;
    if (!old && running) events.push({ id: task.id, phase: "start", description: task.label });
    else if (!running && (wasRunning || (!old && !task.delivered))) {
      events.push({ id: task.id, phase: "end", description: task.label,
        status: task.exit === null ? "exit unknown" : `exit ${task.exit}` });
    }
  }
  return events;
}

// Background tasks outlive a restart: they run detached and are recorded in a
// registry, so a respawn re-adopts them instead of killing them, and each
// completion is announced exactly once.

export interface ResidentTaskEntry {
  id: string;
  label: string;
  command: string;
  cwd: string;
  pid: number;
  outFile: string;
  rcFile: string;
  startedAt: number;
  exit: number | null;
  endedAt: number | null;
  delivered: boolean;
  endedDuringRestart?: boolean;
}

export interface ResidentTasksFile {
  tasks: ResidentTaskEntry[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isValidEntry(value: unknown): value is ResidentTaskEntry {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === "string" && r.id.length > 0
    && typeof r.label === "string"
    && typeof r.command === "string"
    && typeof r.cwd === "string"
    && typeof r.pid === "number" && Number.isFinite(r.pid)
    && typeof r.outFile === "string"
    && typeof r.rcFile === "string"
    && typeof r.startedAt === "number"
    && (r.exit === null || typeof r.exit === "number")
    && (r.endedAt === null || r.endedAt === undefined || typeof r.endedAt === "number")
    && typeof r.delivered === "boolean";
}

/** Reads the registry. Missing/empty/corrupt file → empty state
 * (backward compatible: no error, no crash on the very first boot). */
export function loadResidentTasks(path: string): ResidentTaskEntry[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const record = parsed as Partial<ResidentTasksFile>;
  if (!Array.isArray(record.tasks)) return [];
  return record.tasks
    .filter(isValidEntry)
    .map((t) => ({ ...t, endedAt: t.endedAt ?? null }));
}

/** Writes the registry atomically (tmp in the same directory + rename) —
 * called on every status change, never a half-written file. */
export function saveResidentTasks(path: string, tasks: ResidentTaskEntry[]): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dirname(path), { recursive: true });
  const payload: ResidentTasksFile = { tasks };
  writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
}

export function pruneOldEndedTasks(tasks: ResidentTaskEntry[], now: number): ResidentTaskEntry[] {
  return tasks.filter((t) => {
    if (t.exit === null) return true;
    const endedAt = t.endedAt ?? t.startedAt;
    return now - endedAt < SEVEN_DAYS_MS;
  });
}

export type PidLiveness = (pid: number) => boolean;

/** kill(pid, 0) — standard liveness probe, no signal, only an existence
 * check. ESRCH → dead, EPERM → alive (owned by someone else, but alive). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function readExitCode(rcFile: string): number | null {
  try {
    const raw = readFileSync(rcFile, "utf8").trim();
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface BootReadoptionResult {
  tasks: ResidentTaskEntry[];
  toAnnounce: ResidentTaskEntry[];
}

export function reconcileOnBoot(
  tasks: ResidentTaskEntry[],
  now: number,
  pidAlive: PidLiveness = isPidAlive,
  readRc: (rcFile: string) => number | null = readExitCode,
): BootReadoptionResult {
  const toAnnounce: ResidentTaskEntry[] = [];
  const reconciled = tasks.map((t) => {
    // Ended but not yet delivered (an earlier announce failed): announce again,
    // or the exactly-once delivery would swallow it.
    if (t.exit !== null) {
      if (!t.delivered) toAnnounce.push(t);
      return t; // Status itself unchanged — only queued again for delivery.
    }
    // The rc file first: it is the wrapper's last action. A recycled PID can make
    // kill(pid, 0) say "alive" long after the task finished.
    const rc = readRc(t.rcFile);
    if (rc !== null) {
      const updated: ResidentTaskEntry = {
        ...t,
        exit: rc,
        endedAt: now,
        endedDuringRestart: true,
        delivered: false,
      };
      toAnnounce.push(updated);
      return updated;
    }
    if (pidAlive(t.pid)) return t; // still alive, re-adopted as-is
    const updated: ResidentTaskEntry = {
      ...t,
      exit: null,
      endedAt: now,
      endedDuringRestart: true,
      delivered: false,
    };
    toAnnounce.push(updated);
    return updated;
  });
  return { tasks: pruneOldEndedTasks(reconciled, now), toAnnounce };
}

export interface WatcherTickResult {
  tasks: ResidentTaskEntry[];
  toAnnounce: ResidentTaskEntry[];
}

export function watcherTick(
  tasks: ResidentTaskEntry[],
  now: number,
  pidAlive: PidLiveness = isPidAlive,
  readRc: (rcFile: string) => number | null = readExitCode,
): WatcherTickResult {
  const toAnnounce: ResidentTaskEntry[] = [];
  const updated = tasks.map((t) => {
    // Like reconcileOnBoot: the watcher must retry an entry with exit set
    // but delivered:false (previous announce append failed) on every tick.
    // Status stays unchanged, it is only queued again for delivery.
    if (t.exit !== null) {
      if (!t.delivered) toAnnounce.push(t);
      return t;
    }
    // rc file first, same reason as in reconcileOnBoot — it is the strictly
    // stronger end signal, PID recycling must not override it.
    const rc = readRc(t.rcFile);
    if (rc !== null) {
      const done: ResidentTaskEntry = { ...t, exit: rc, endedAt: now, delivered: false };
      toAnnounce.push(done);
      return done;
    }
    if (pidAlive(t.pid)) return t; // still running
    const done: ResidentTaskEntry = { ...t, exit: null, endedAt: now, delivered: false };
    toAnnounce.push(done);
    return done;
  });
  return { tasks: updated, toAnnounce };
}

export function markDelivered(tasks: ResidentTaskEntry[], id: string): ResidentTaskEntry[] {
  return tasks.map((t) => (t.id === id ? { ...t, delivered: true } : t));
}

export function buildCompletionMessage(task: ResidentTaskEntry, opts: { duringRestart?: boolean } = {}): string {
  const exitText = task.exit === null ? tr("exit unknown (no rc file found)") : `exit ${task.exit}`;
  const restartNote = opts.duringRestart ? tr(" (ended during a restart)") : "";
  return tr`Background task “${task.label}" (${task.id}) ended with ${exitText}${restartNote}. Output: task_output(${task.id})`;
}
