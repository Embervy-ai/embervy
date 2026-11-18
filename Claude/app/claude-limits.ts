import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_BYTES = 128 * 1024;
const MAX_AGE_SECONDS = 7 * 86400;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value: unknown): string => typeof value === "string" && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value : "";

function epoch(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(number) && number >= 946684800 && number <= 4102444800 ? number : null;
}

/** Observation only: no polling, inferred resets or writes, even after a reset time. */
export function shapeClaudeLimits(data: unknown, now = Date.now() / 1000) {
  if (!object(data)) return null;
  const reported = epoch(data.timestamp);
  if (reported === null || now < reported || now - reported > MAX_AGE_SECONDS || !object(data.rate_limits)) return null;
  const model = object(data.model) ? label(data.model.id) || label(data.model.display_name) : label(data.model);
  const windows = [];
  for (const [name, raw] of Object.entries(data.rate_limits)) {
    if (!/^[a-z0-9_]{1,40}$/.test(name) || !object(raw)) continue;
    const used = raw.used_percentage;
    const resets = epoch(raw.resets_at);
    if (typeof used !== "number" || !Number.isFinite(used) || resets === null) continue;
    windows.push({ name, utilization: Math.max(0, Math.min(1, used / 100)), resets_at: resets,
      reported_at: reported, model, status: "unknown", age_seconds: Math.floor(now - reported),
      ...(used > 100 ? { exceeded: true } : {}) });
    if (windows.length >= 12) break;
  }
  return windows.length ? { account: null, windows } : null;
}

export function readClaudeLimits(file: string, now = Date.now() / 1000) {
  let fd: number | undefined;
  try {
    // Nonblocking open prevents a FIFO from hanging the app. Never follow a final symlink.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !(stat.mode & 0o444) || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_BYTES) return null;
    return shapeClaudeLimits(JSON.parse(buffer.subarray(0, length).toString("utf8")), now);
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
