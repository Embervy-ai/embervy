export const DOCTOR_MUTE_MS = 12 * 60 * 60 * 1000;
export const DOCTOR_ID_MAX = 200;
export type DoctorMutes = Record<string, { at: string; until: string }>;
export function validDoctorId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= DOCTOR_ID_MAX;
}
export function parseDoctorMutes(text: string): DoctorMutes {
  const result: DoctorMutes = Object.create(null);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const [id, m] of Object.entries(value) as [string, any][]) {
      if (!validDoctorId(id) || !m || typeof m.at !== "string" || typeof m.until !== "string") continue;
      const at = Date.parse(m.at), until = Date.parse(m.until);
      if (!Number.isFinite(at) || !Number.isFinite(until) || until <= at || until - at > DOCTOR_MUTE_MS) continue;
      result[id] = { at: new Date(at).toISOString(), until: new Date(until).toISOString() };
    }
  } catch { /* Missing or corrupt storage means nothing is muted. */ }
  return result;
}
export function pruneDoctorMutes(status: any, mutes: DoctorMutes, now = Date.now()): DoctorMutes {
  const result: DoctorMutes = Object.create(null);
  const recovered = new Set((Array.isArray(status?.checks) ? status.checks : []).filter((c: any) => c?.status === "OK").map((c: any) => c.id));
  for (const [id, mute] of Object.entries(mutes)) {
    if (Date.parse(mute.until) > now && !recovered.has(id)) result[id] = mute;
  }
  return result;
}
// Never accept badge annotations supplied by the background agent.
export function rawDoctorStatus(status: any): any {
  const { badge_state, muted, ...raw } = status || {};
  if (Array.isArray(raw.checks)) raw.checks = raw.checks.map((c: any) => {
    const { muted_until, ...check } = c || {};
    return check;
  });
  return raw;
}
export function applyDoctorMutes(status: any, mutes: DoctorMutes, now = Date.now()): any {
  if (!status) return status;
  const raw = rawDoctorStatus(status);
  if (!Array.isArray(raw.checks)) return { ...raw, badge_state: raw.state, muted: 0 };
  let badge = "ok", muted = 0;
  const active = pruneDoctorMutes(raw, mutes, now);
  const checks = raw.checks.map((c: any) => {
    const problem = c.status === "FAIL" || c.status === "WARN";
    const mute = validDoctorId(c.id) && Object.hasOwn(active, c.id) ? active[c.id] : undefined;
    if (problem && mute) { muted++; return { ...c, muted_until: mute.until }; }
    if (c.status === "FAIL") badge = "fail";
    else if (c.status === "WARN" && badge !== "fail") badge = "warn";
    return c;
  });
  return { ...raw, checks, badge_state: badge, muted };
}
export function doctorRegressed(previous: any, next: any): boolean {
  const order: Record<string, number> = { ok: 0, warn: 1, fail: 2 };
  return (order[next?.badge_state ?? next?.state] ?? 0) > (order[previous?.badge_state ?? previous?.state] ?? 0);
}
