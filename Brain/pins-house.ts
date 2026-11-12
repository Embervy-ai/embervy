/**
 * pins-house.ts — storage adapter so Brain and the Claude-Code house share
 * one set of pins.
 *
 * pins.ts stores `{pins:[{id,text,expiresAt}],nextSeq}`.
 * The house (scripts/pin.py) stores a plain list
 * `[{id,text,expires:<epoch s>,created:"DD.MM. HH:MM"}]` in state/pins.json
 * and renders it into every inlet. Same idea, two file formats. With
 * BRAIN_PINS_FORMAT=house Brain reads and writes the house list, so a pin set
 * in Claude Code shows up in Brain after a switch and the other way round.
 * The pure pin logic stays in pins.ts; this file only converts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tr } from "./texts";
import { brainTimezone } from "./time-marks";
import { loadPinsState, pruneExpiredPins, savePinsState, type Pin, type PinsState } from "./pins";

export type PinsFormat = "brain" | "house";

interface HousePin { id: string; text: string; expires: number; created?: string }

function isHousePin(value: unknown): value is HousePin {
  const record = value as Record<string, unknown>;
  return typeof value === "object" && value !== null
    && typeof record.id === "string" && typeof record.text === "string"
    && typeof record.expires === "number" && Number.isFinite(record.expires);
}

function seqOf(id: string): number {
  const match = /^p(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

function berlinStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: brainTimezone(), day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${v.day}.${v.month}. ${v.hour}:${v.minute}`;
}

/** Read the house list and hand pins.ts a normal PinsState (expired dropped). */
export function loadHousePins(path: string, now: Date): { state: PinsState; created: Map<string, string> } {
  const created = new Map<string, string>();
  if (!existsSync(path)) return { state: { pins: [], nextSeq: 1 }, created };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return { state: { pins: [], nextSeq: 1 }, created }; }
  const list = Array.isArray(parsed) ? parsed.filter(isHousePin) : [];
  const pins: Pin[] = list.map((pin) => {
    if (pin.created) created.set(pin.id, pin.created);
    return { id: pin.id, text: pin.text, expiresAt: new Date(pin.expires * 1000).toISOString() };
  });
  // pin.py numbers max(id)+1 over the live pins; keep that rule.
  const nextSeq = pins.reduce((max, pin) => Math.max(max, seqOf(pin.id)), 0) + 1;
  return { state: pruneExpiredPins({ pins, nextSeq }, now), created };
}

/** Write a PinsState back as the house list (atomic tmp + rename). */
export function saveHousePins(path: string, state: PinsState, created: Map<string, string>, now: Date): void {
  const list: HousePin[] = state.pins.map((pin) => ({
    id: pin.id,
    text: pin.text,
    expires: new Date(pin.expiresAt).getTime() / 1000,
    created: created.get(pin.id) ?? berlinStamp(now),
  }));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(list, null, 1), "utf8");
  renameSync(tmp, path);
}

/** One entry point for brain.ts: load in the configured format. */
export function loadPinsAny(format: PinsFormat, path: string, now: Date): PinsState {
  if (format === "house") return loadHousePins(path, now).state;
  return loadPinsState(path, now);
}

/** One entry point for brain.ts: save in the configured format. House format
 * keeps each pin's original `created` stamp. */
export function savePinsAny(format: PinsFormat, path: string, state: PinsState, now: Date): void {
  if (format === "house") {
    const { created } = loadHousePins(path, new Date(0));
    saveHousePins(path, state, created, now);
    return;
  }
  savePinsState(path, state);
}

/** pin.py render format — used when the house format is active, so the model
 * sees the same block in Brain as in Claude Code. */
export function renderHousePinBlock(state: PinsState, now: Date): string | null {
  const active = state.pins.filter((pin) => new Date(pin.expiresAt).getTime() > now.getTime());
  if (!active.length) return null;
  const lines = active.map((pin) => tr`- [${pin.id}] ${pin.text} (until ${berlinStamp(new Date(pin.expiresAt))})`);
  return tr("📌 Pins (transient, not for RAG/Bridge):\n") + lines.join("\n");
}
