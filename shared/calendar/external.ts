// Fetches external ICS calendars and caches their upcoming events.
// Feed URLs grant calendar access, so logs, errors and cached data must not expose them.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "./store";
import { addDays, localDate } from "./time";
import { occurrencesBetween, readCalendar, type ExternalOccurrence } from "./ics-reader";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_POLL_MINUTES = 15;
export const DEFAULT_DAYS_AHEAD = 30;

export interface SourceState {
  index: number;
  fingerprint?: string;
  name: string;
  ok: boolean;
  synced_at: string | null;
  error?: string;
  occurrences: ExternalOccurrence[];
}

export interface ExternalCache {
  version: 1;
  checked_at: string;
  tz: string;
  from: string;
  to: string;
  sources: SourceState[];
}

// Keep invalid slots so rejecting a URL does not renumber the other calendars.
export function parseIcsUrls(raw: string | undefined): { url: string | null; index: number }[] {
  if (!raw) return [];
  return raw
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2")
    .replace(/(^|\s)#.*$/, "") // systemd preserves inline comments.
    .split(/[\s,]+/)
    .map((u) => u.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .map((u, index) => {
      const fixed = u.replace(/^webcals?:\/\//i, "https://");
      try {
        const parsed = new URL(fixed);
        return { url: parsed.protocol === "https:" ? parsed.toString() : null, index };
      } catch {
        return { url: null, index };
      }
    });
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchIcsText(url: string, opts: FetchOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { signal: ctrl.signal, redirect: "follow", headers: { accept: "text/calendar, */*;q=0.5" } });
    } catch (err: any) {
      throw new Error(ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `could not connect (${err?.name || "error"})`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error(`larger than the ${Math.round(maxBytes / 1024)} KB cap`);
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw new Error(ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)} s` : "connection dropped");
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`larger than the ${Math.round(maxBytes / 1024)} KB cap`);
      }
      chunks.push(chunk.value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

export function readExternalCache(file: string): ExternalCache | null {
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return c && c.version === 1 && Array.isArray(c.sources) ? c : null;
  } catch {
    return null;
  }
}

export interface SyncOptions extends FetchOptions {
  urlsRaw: string | undefined;
  cacheFile: string;
  tz: string;
  now?: number;
  daysAhead?: number;
}

// Keep the last successful events so a provider failure does not blank the calendar.
export async function syncExternal(opts: SyncOptions): Promise<ExternalCache> {
  const now = opts.now ?? Date.now();
  const today = localDate(opts.tz, now);
  const from = addDays(today, -1);
  const to = addDays(today, opts.daysAhead ?? DEFAULT_DAYS_AHEAD);
  const prev = readExternalCache(opts.cacheFile);
  const slots = parseIcsUrls(opts.urlsRaw).map(({ url, index }) => ({
    url, index, fingerprint: url ? createHash("sha256").update(url).digest("hex") : undefined,
  }));
  // Persist source removal before network waits so failed replacements cannot revive old data.
  writeJsonAtomic(opts.cacheFile, {
    version: 1, checked_at: new Date(now).toISOString(), tz: opts.tz, from, to,
    sources: slots.flatMap(({ fingerprint, index }) => {
      const old = fingerprint && prev?.sources.find((s) => s.fingerprint === fingerprint);
      return old ? [{ ...old, index }] : [];
    }),
  });
  const sources: SourceState[] = [];
  for (const { url, index, fingerprint } of slots) {
    const old = fingerprint ? prev?.sources.find((s) => s.fingerprint === fingerprint) : undefined;
    const fallbackName = `calendar ${index + 1}`;
    if (!url) {
      sources.push({ index, name: fallbackName, ok: false, synced_at: null, error: "not an https or webcal link", occurrences: [] });
      continue;
    }
    try {
      const text = await fetchIcsText(url, opts);
      const cal = readCalendar(text, opts.tz);
      const name = cal.name || fallbackName;
      sources.push({
        index,
        fingerprint,
        name,
        ok: true,
        synced_at: new Date(now).toISOString(),
        occurrences: occurrencesBetween(cal, opts.tz, from, to, name),
      });
    } catch (err: any) {
      const msg = String(err?.message || "failed");
      sources.push({
        index,
        fingerprint,
        name: old?.name || fallbackName,
        ok: false,
        synced_at: old?.synced_at ?? null,
        error: /^(HTTP \d+|timed out|larger than|could not connect|connection dropped|not an ICS)/.test(msg) ? msg : "could not read the calendar",
        occurrences: old?.occurrences ?? [],
      });
    }
  }
  const cache: ExternalCache = { version: 1, checked_at: new Date(now).toISOString(), tz: opts.tz, from, to, sources };
  writeJsonAtomic(opts.cacheFile, cache);
  return cache;
}

export function externalOn(cache: ExternalCache | null, day: string): ExternalOccurrence[] {
  return externalBetween(cache, day, day);
}

export function externalBetween(cache: ExternalCache | null, from: string, to: string): ExternalOccurrence[] {
  if (!cache) return [];
  const all = cache.sources.flatMap((s) => s.occurrences).filter((o) => o.date >= from && o.date <= to);
  return all.sort((a, b) => `${a.date} ${a.time ?? ""}`.localeCompare(`${b.date} ${b.time ?? ""}`));
}

export function lastSynced(cache: ExternalCache | null): string | null {
  if (!cache || !cache.sources.length) return null;
  const stamps = cache.sources.map((s) => s.synced_at);
  if (stamps.some((s) => !s)) return null;
  return stamps.sort()[0];
}
