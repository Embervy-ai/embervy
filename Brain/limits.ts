import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface LimitWindow {
  name: string;
  utilization: number;
  resets_at: number;
  status: string;
  reported_at: number;
  model: string;
  exceeded?: boolean;
  reset?: boolean;
}
export interface LimitOverage {
  is_using_overage?: boolean;
  status?: string;
  disabled_reason?: string;
  reported_at: number;
}
interface AccountLimits { windows: LimitWindow[]; overage?: LimitOverage }
export interface LimitsSnapshot {
  account: string | null;
  windows: (LimitWindow & { age_seconds: number })[];
  overage?: LimitOverage & { age_seconds: number };
}
const MAX_WINDOWS = 12;
const MAX_RESET_AHEAD_SECONDS = 366 * 86400;
const validName = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 40 && !/[^a-z0-9_]/.test(value);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value);
// Fixed epoch bounds keep stale snapshots readable without accepting milliseconds as seconds.
const epoch = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 946684800 && value <= 4102444800;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const keyOf = (account: string | null) => account ?? "default";

function windowFrom(name: string, raw: unknown, reportedAt: number, model: string): LimitWindow | null {
  if (!validName(name) || !object(raw) || !finite(raw.utilization) || !epoch(raw.resetsAt) || !label(raw.status)) return null;
  return { name, utilization: Math.max(0, Math.min(1, raw.utilization)), resets_at: raw.resetsAt,
    status: raw.status, reported_at: reportedAt, model, ...(raw.utilization > 1 ? { exceeded: true } : {}) };
}

/** Staging and replacement share a directory so readers see either complete version. */
export function writeLimitsFile(file: string, text: string, stage: (fd: number, text: string) => void = writeFileSync): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    stage(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Replacement already removed the staging name. */ }
  }
}

export class LimitsStore {
  private accounts: Record<string, AccountLimits> = Object.create(null);
  private loaded = false;
  private announced = new Map<string, number>();
  constructor(private readonly file: string, private readonly options: {
    now?: () => number;
    log?: (event: Record<string, unknown>) => void;
  } = {}) {}

  private now(): number { return (this.options.now?.() ?? Date.now()) / 1000; }
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stat = statSync(this.file);
      if (!stat.isFile() || stat.size > 262144 || !(stat.mode & 0o400)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (!object(data) || data.version !== 1 || !object(data.accounts)) return;
      for (const [key, raw] of Object.entries(data.accounts)) {
        if (!validName(key) || !object(raw) || !Array.isArray(raw.windows) || raw.windows.length > MAX_WINDOWS) continue;
        const windows: LimitWindow[] = [];
        for (const row of raw.windows) {
          if (!object(row) || !epoch(row.reported_at) || !label(row.model) || windows.some((w) => w.name === row.name)) continue;
          const w = windowFrom(row.name, { ...row, resetsAt: row.resets_at }, row.reported_at, row.model);
          if (!w || w.resets_at > this.now() + MAX_RESET_AHEAD_SECONDS) continue;
          if (row.exceeded === true) w.exceeded = true;
          if (row.reset === true) { w.reset = true; w.utilization = 0; delete w.exceeded; }
          windows.push(w);
          this.announced.set(`${key}:${w.name}`, w.utilization);
        }
        const overage = this.readOverage(raw.overage);
        if (windows.length || overage) this.accounts[key] = { windows, ...(overage ? { overage } : {}) };
      }
    } catch { /* Optional telemetry must not prevent a turn or startup. */ }
  }

  private readOverage(raw: unknown): LimitOverage | undefined {
    if (!object(raw) || !epoch(raw.reported_at)) return;
    const result: LimitOverage = { reported_at: raw.reported_at };
    if (typeof raw.is_using_overage === "boolean") result.is_using_overage = raw.is_using_overage;
    if (label(raw.status)) result.status = raw.status;
    if (label(raw.disabled_reason)) result.disabled_reason = raw.disabled_reason;
    return Object.keys(result).length > 1 ? result : undefined;
  }

  private save(): void {
    try { writeLimitsFile(this.file, JSON.stringify({ version: 1, accounts: this.accounts }) + "\n"); }
    catch { /* Keep the in-memory observation when storage is unavailable. */ }
  }

  private emit(account: string | null, windows: LimitWindow[]): void {
    if (!windows.length) return;
    for (const w of windows) this.announced.set(`${keyOf(account)}:${w.name}`, w.utilization);
    try { this.options.log?.({ type: "claude_limits", account, windows: windows.map((w) => ({ ...w })) }); }
    catch { /* A logger cannot invalidate telemetry or a model turn. */ }
  }

  private expire(account: string | null, now: number): void {
    const changed: LimitWindow[] = [];
    for (const w of this.accounts[keyOf(account)]?.windows ?? []) {
      if (w.resets_at <= now && !w.reset) {
        w.utilization = 0;
        w.reset = true;
        delete w.exceeded;
        changed.push(w);
      }
    }
    if (changed.length) { this.save(); this.emit(account, changed); }
  }

  observe(account: string | null, info: unknown, model: string): void {
    this.load();
    const key = keyOf(account);
    if (!validName(key) || !label(model)) return;
    const now = this.now();
    this.expire(account, now);
    if (!object(info)) return;
    const current = this.accounts[key] ?? { windows: [] };
    const changed: LimitWindow[] = [];
    let accepted = false;
    // An oversized batch is ambiguous; never let it evict known windows.
    if (object(info.unifiedWindows) && Object.keys(info.unifiedWindows).length <= MAX_WINDOWS) {
      for (const [name, raw] of Object.entries(info.unifiedWindows)) {
        const w = windowFrom(name, raw, now, model);
        if (!w || w.resets_at > now + MAX_RESET_AHEAD_SECONDS) continue;
        const index = current.windows.findIndex((old) => old.name === name);
        if (index < 0 && current.windows.length >= MAX_WINDOWS) continue;
        if (w.resets_at <= now) { w.reset = true; w.utilization = 0; delete w.exceeded; }
        const old = current.windows[index];
        const baseline = this.announced.get(`${key}:${name}`) ?? old?.utilization;
        if (!old || old.reset !== w.reset || Math.abs(w.utilization - baseline!) >= 0.01 - 1e-12) changed.push(w);
        if (index < 0) current.windows.push(w); else current.windows[index] = w;
        accepted = true;
      }
    }
    const overage = this.readOverage({ reported_at: now, is_using_overage: info.isUsingOverage,
      status: info.overageStatus, disabled_reason: info.overageDisabledReason });
    if (overage) {
      current.overage = { ...current.overage, ...overage };
      accepted = true;
    }
    if (accepted) { this.accounts[key] = current; this.save(); this.emit(account, changed); }
  }

  snapshot(account: string | null): LimitsSnapshot | null {
    this.load();
    const now = this.now();
    this.expire(account, now);
    const current = this.accounts[keyOf(account)];
    if (!current) return null;
    const age = (time: number) => Math.max(0, Math.floor(now - time));
    return { account, windows: current.windows.map((w) => ({ ...w, age_seconds: age(w.reported_at) })),
      ...(current.overage ? { overage: { ...current.overage, age_seconds: age(current.overage.reported_at) } } : {}) };
  }
}

function ageText(seconds: number): string {
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export function formatLimitsStatus(snapshot: LimitsSnapshot | null, timeZone?: string): string | null {
  if (!snapshot) return null;
  if (!snapshot.windows.length) {
    const overage = snapshot.overage;
    if (!overage) return null;
    const active = overage.is_using_overage === undefined ? "unknown" : overage.is_using_overage ? "active" : "inactive";
    return `limits: overage ${active}${overage.status ? ` · ${overage.status}` : ""}${overage.is_using_overage === false && overage.disabled_reason ? ` · ${overage.disabled_reason}` : ""} (${ageText(overage.age_seconds)})`;
  }
  const resetTime = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const groups = new Map<string, { labels: string[]; reset: string; age: number }>();
  for (const w of snapshot.windows) {
    const name = w.name === "seven_day" ? "week" : w.name === "five_hour" ? "5h" : w.name;
    const key = `${w.resets_at}:${w.age_seconds}`;
    const group = groups.get(key) ?? { labels: [], reset: resetTime.format(new Date(w.resets_at * 1000)).replace(",", ""), age: w.age_seconds };
    group.labels.push(`${name} ${Math.round(w.utilization * 100)}%${w.exceeded ? " (exceeded)" : ""}${w.reset ? " (reset)" : ""}`);
    groups.set(key, group);
  }
  // Shared timestamps can be compacted, but an older window must keep its own age.
  return "limits: " + [...groups.values()].map((g) => `${g.labels.join(" · ")} · resets ${g.reset} (${ageText(g.age)})`).join(" · ");
}
