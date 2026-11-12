// Quiet hours suppress approval pushes, not cards; unanswered cards still expire instead of waking the user.

export function inQuietHours(now: Date, spec: string | undefined, timeZone?: string): boolean {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? "");
  if (!match) return false;
  const [from, to] = [Number(match[1]), Number(match[2])];
  if (from > 23 || to > 24 || from === to) return false;
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now));
  } catch {
    hour = now.getHours();
  }
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
