import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export type ApprovalLevel = "all" | "important" | "none";
export type ApprovalPattern = { label: string; tool: string; field: string; pattern: string };
export type ApprovalSettings = { level: ApprovalLevel; extra: ApprovalPattern[]; updated_at: string; updated_by: "person" | "agent" };
export type ApprovalChange = { level?: ApprovalLevel; add?: ApprovalPattern[]; remove?: ApprovalPattern[]; reason: string };
const rank = { none: 0, important: 1, all: 2 };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (p: ApprovalPattern) => JSON.stringify([p.label, p.tool, p.field, p.pattern]);
const object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
function pattern(v: any): ApprovalPattern {
  if (!object(v) || !["label", "tool", "field", "pattern"].every(k => typeof v[k] === "string" && v[k].trim() && v[k].length <= 500)) throw new Error("approvalSettings.invalid");
  try { new RegExp(v.pattern, "i"); } catch { throw new Error("approvalSettings.invalid"); }
  return { label: v.label, tool: v.tool, field: v.field, pattern: v.pattern };
}
export function approvalChange(v: any): ApprovalChange {
  if (!object(v) || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 1000 || (v.level !== undefined && (typeof v.level !== "string" || !Object.hasOwn(rank, v.level)))) throw new Error("approvalSettings.invalid");
  for (const k of ["add", "remove"]) if (v[k] !== undefined && (!Array.isArray(v[k]) || v[k].length > 100)) throw new Error("approvalSettings.invalid");
  return { ...(v.level !== undefined ? { level: v.level } : {}), ...(v.add ? { add: v.add.map(pattern) } : {}), ...(v.remove ? { remove: v.remove.map(pattern) } : {}), reason: v.reason.trim() };
}
export function proposedSettings(current: ApprovalSettings, change: ApprovalChange): ApprovalSettings {
  const removed = new Set((change.remove || []).map(key));
  const extra = current.extra.filter(p => !removed.has(key(p)));
  for (const p of change.add || []) if (!extra.some(e => key(e) === key(p))) extra.push(p);
  if (extra.length > 100) throw new Error("approvalSettings.invalid");
  return { ...current, level: change.level ?? current.level, extra };
}
export function loosens(current: ApprovalSettings, next: ApprovalSettings): boolean {
  return rank[next.level] < rank[current.level] || current.extra.some(p => !next.extra.some(e => key(e) === key(p)));
}

// The observed hash advances after an outside edit too: one edit yields one notice.
export class ApprovalSettingsStore {
  private observed = "";
  private previous: ApprovalSettings;
  constructor(readonly path: string, private notice: (old: ApprovalSettings, next: ApprovalSettings | null) => void) {
    this.previous = { level: "important", extra: [], updated_at: new Date().toISOString(), updated_by: "person" };
    if (!existsSync(path)) this.write(this.previous, "person");
    else {
      const text = readFileSync(path, "utf8");
      this.observed = hash(text);
      try { this.previous = this.parse(text); }
      catch { this.notice(this.previous, null); }
    }
  }
  private parse(text: string): ApprovalSettings {
    const v = JSON.parse(text);
    if (!object(v) || typeof v.level !== "string" || !Object.hasOwn(rank, v.level) || !Array.isArray(v.extra) || v.extra.length > 100 || !["person", "agent"].includes(v.updated_by) || typeof v.updated_at !== "string" || !Number.isFinite(Date.parse(v.updated_at))) throw new Error("approvalSettings.invalid");
    return { level: v.level, extra: v.extra.map(pattern), updated_at: v.updated_at, updated_by: v.updated_by };
  }
  read(): ApprovalSettings {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) {
      // Removal or unreadability is an outside change too, not a reason to recreate consent.
      if (this.observed !== "unreadable") { this.observed = "unreadable"; this.notice(this.previous, null); }
      throw error;
    }
    const digest = hash(text);
    let next: ApprovalSettings;
    try { next = this.parse(text); }
    catch (error) {
      if (digest !== this.observed) { this.observed = digest; this.notice(this.previous, null); }
      throw error;
    }
    if (digest !== this.observed) {
      this.observed = digest;
      const old = this.previous;
      this.previous = next;
      this.notice(old, next);
    }
    return next;
  }
  write(settings: ApprovalSettings, by: "person" | "agent"): ApprovalSettings {
    const next = { ...settings, updated_at: new Date().toISOString(), updated_by: by };
    const text = JSON.stringify(next, null, 2) + "\n";
    const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, this.path);
    this.observed = hash(text);
    this.previous = next;
    return next;
  }
}
