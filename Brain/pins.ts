// Keeps temporary notes in the live context until they expire.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { brainTimezone } from "./time-marks";
import { tr } from "./texts";

export interface Pin {
  id: string;
  text: string;
  expiresAt: string;
}

export interface PinsState {
  pins: Pin[];
  nextSeq: number;
}

export const PIN_LIMIT = 20;

export class PinLimitError extends Error {
  constructor() {
    super(`maximum of ${PIN_LIMIT} active pins reached — unpin something first`);
    this.name = "PinLimitError";
  }
}

export class PinTtlError extends Error {
  constructor(raw: string) {
    super(`unrecognized pin ttl: "${raw}" — use "end_of_day", "<N>h", or "YYYY-MM-DD HH:MM"`);
    this.name = "PinTtlError";
  }
}

export function initialPinsState(): PinsState {
  return { pins: [], nextSeq: 1 };
}

function berlinDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Probe near the target midnight because the offset can change between now and expiry.
function nextMidnight(now: Date, timeZone: string): Date {
  const todayKey = berlinDateKey(now, timeZone);
  const [y, m, d] = todayKey.split("-").map(Number);
  const naiveNextMidnightUTC = Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0);
  const probe = new Date(naiveNextMidnightUTC);
  const offsetMinutes = timeZoneOffsetMinutes(probe, timeZone);
  return new Date(naiveNextMidnightUTC - offsetMinutes * 60_000);
}

function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUTC = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour) === 24 ? 0 : Number(values.hour), Number(values.minute), Number(values.second),
  );
  return (asUTC - date.getTime()) / 60_000;
}

function localDateTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  const naiveUTC = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  const offsetMinutes = timeZoneOffsetMinutes(new Date(naiveUTC), timeZone);
  return new Date(naiveUTC - offsetMinutes * 60_000);
}

export function parsePinTtl(raw: string | undefined, now: Date, timeZone = brainTimezone()): Date {
  timeZone = brainTimezone(process.env, timeZone);
  const value = (raw ?? "end_of_day").trim();
  if (value === "end_of_day") return nextMidnight(now, timeZone);
  const hoursMatch = /^(\d+(?:\.\d+)?)h$/i.exec(value);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    if (!Number.isFinite(hours) || hours <= 0) throw new PinTtlError(value);
    return new Date(now.getTime() + hours * 3_600_000);
  }
  const absoluteMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (absoluteMatch) {
    const [, y, mo, d, h, mi] = absoluteMatch.map(Number as unknown as (s: string) => number);
    const parsed = localDateTimeToUtc(y, mo, d, h, mi, timeZone);
    if (Number.isNaN(parsed.getTime())) throw new PinTtlError(value);
    return parsed;
  }
  throw new PinTtlError(value);
}

function makeId(seq: number): string { return `p${seq}`; }

export function addPin(
  state: PinsState,
  text: string,
  ttl: string | undefined,
  now: Date,
  timeZone = brainTimezone(),
): { state: PinsState; pin: Pin } {
  const activeCount = listActivePins(state, now).length;
  if (activeCount >= PIN_LIMIT) throw new PinLimitError();
  const expiresAt = parsePinTtl(ttl, now, timeZone).toISOString();
  const pin: Pin = { id: makeId(state.nextSeq), text, expiresAt };
  const nextState: PinsState = { pins: [...state.pins, pin], nextSeq: state.nextSeq + 1 };
  return { state: nextState, pin };
}

export function removePin(state: PinsState, id: string): PinsState {
  return { pins: state.pins.filter((pin) => pin.id !== id), nextSeq: state.nextSeq };
}

export function listActivePins(state: PinsState, now: Date): Pin[] {
  return state.pins
    .filter((pin) => new Date(pin.expiresAt).getTime() > now.getTime())
    .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime());
}

export function pruneExpiredPins(state: PinsState, now: Date): PinsState {
  const active = listActivePins(state, now);
  if (active.length === state.pins.length) return state; 
  return { pins: active, nextSeq: state.nextSeq };
}

function formatLocalTime(iso: string, timeZone: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function renderPinBlock(state: PinsState, now: Date, timeZone = brainTimezone()): string | null {
  timeZone = brainTimezone(process.env, timeZone);
  const active = listActivePins(state, now);
  if (!active.length) return null;
  const lines = active.map((pin) => tr`- [${pin.id}, until ${formatLocalTime(pin.expiresAt, timeZone)}] ${pin.text}`);
  return `## PINS\n${lines.join("\n")}`;
}


interface PersistedPin { id: string; text: string; expiresAt: string }
interface PersistedPinsFile { pins: PersistedPin[]; nextSeq: number }

function isPersistedPin(value: unknown): value is PersistedPin {
  const record = value as Record<string, unknown>;
  return typeof value === "object" && value !== null
    && typeof record.id === "string"
    && typeof record.text === "string"
    && typeof record.expiresAt === "string"
    && !Number.isNaN(new Date(record.expiresAt).getTime());
}

export function loadPinsState(path: string, now: Date): PinsState {
  if (!existsSync(path)) return initialPinsState();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return initialPinsState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return initialPinsState();
  }
  const record = parsed as Partial<PersistedPinsFile>;
  const pins = Array.isArray(record.pins) ? record.pins.filter(isPersistedPin) : [];
  const nextSeq = typeof record.nextSeq === "number" && Number.isSafeInteger(record.nextSeq) && record.nextSeq >= 1
    ? record.nextSeq
    : pins.length + 1;
  return pruneExpiredPins({ pins, nextSeq }, now);
}

// Rename within the same directory prevents a crash from leaving a partially written state file.
export function savePinsState(path: string, state: PinsState): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dirname(path), { recursive: true });
  const payload: PersistedPinsFile = { pins: state.pins, nextSeq: state.nextSeq };
  writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
}
