// Provides calendar HTTP endpoints and external feed polling.
// The host authenticates API routes; subscription feeds use their own token.

import { join } from "node:path";
import { calendarFile, EXTERNAL_CACHE_NAME, readEntries, upcomingEntries, validateNewEntry, writeEntries } from "./store";
import { renderFeed } from "./ics";
import {
  DEFAULT_DAYS_AHEAD,
  DEFAULT_MAX_BYTES,
  DEFAULT_POLL_MINUTES,
  DEFAULT_TIMEOUT_MS,
  externalBetween,
  parseIcsUrls,
  readExternalCache,
  syncExternal,
} from "./external";
import { addDays, envWord, houseTimeZone, localDate } from "./time";
import { envValue } from "../scripts/legacy-names";
import { appAddress } from "../scripts/app-address";

export const FEED_PATH = "/calendar.ics";

export interface CalendarConfig {
  dataDir: string;
  tz: string;
  enabled: boolean;
  feedToken: string;
  agentLabel: string;
  userLabel: string;
  publicUrl: string;
  icsUrlsRaw: string;
  pollMinutes: number;
  timeoutMs: number;
  maxBytes: number;
}

function num(v: string | undefined, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

export function calendarConfigFromEnv(
  env: Record<string, string | undefined>,
  o: { dataDir: string; agentLabel: string; userLabel: string },
): CalendarConfig {
  return {
    dataDir: o.dataDir,
    tz: houseTimeZone(env),
    enabled: envWord(envValue("EMBERVY_HOOK_CALENDAR", env)) === "1",
    feedToken: envWord(env.CALENDAR_FEED_TOKEN),
    agentLabel: o.agentLabel,
    userLabel: o.userLabel,
    publicUrl: envWord(envValue("EMBERVY_APP_URL", env)).replace(/\/+$/, ""),
    icsUrlsRaw: env.CALENDAR_ICS_URLS || "",
    pollMinutes: num(envWord(env.CALENDAR_ICS_POLL_MINUTES), DEFAULT_POLL_MINUTES, 5, 1440),
    timeoutMs: num(envWord(env.CALENDAR_ICS_TIMEOUT_MS), DEFAULT_TIMEOUT_MS, 1000, 120_000),
    maxBytes: num(envWord(env.CALENDAR_ICS_MAX_BYTES), DEFAULT_MAX_BYTES, 10_000, 50 * 1024 * 1024),
  };
}

export function isCalendarFeedPath(path: string): boolean {
  return path === FEED_PATH;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function feedTokenOk(cfg: CalendarConfig, presented: string | null | undefined): boolean {
  if (!cfg.enabled || cfg.feedToken.length < 16) return false;
  return timingSafeEqual(String(presented ?? ""), cfg.feedToken);
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function feedLink(cfg: CalendarConfig, req?: Request): string | null {
  const origin = appAddress(cfg.publicUrl, req);
  const q = `${FEED_PATH}?token=${encodeURIComponent(cfg.feedToken)}`;
  return origin ? `${origin}${q}` : null;
}

export function createCalendarHandlers(cfg: CalendarConfig, clock: () => number = Date.now) {
  const file = calendarFile(cfg.dataDir);
  const cacheFile = join(cfg.dataDir, EXTERNAL_CACHE_NAME);
  const personConfigured = () => cfg.enabled && parseIcsUrls(cfg.icsUrlsRaw).length > 0;

  return {
    async list(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const days = num(url.searchParams.get("days") ?? undefined, 14, 1, DEFAULT_DAYS_AHEAD);
      const today = localDate(cfg.tz, clock());
      const out: Record<string, unknown> = {
        today,
        timezone: cfg.tz,
        agent_calendar: upcomingEntries(readEntries(file), today),
      };
      if (personConfigured()) {
        const cache = readExternalCache(cacheFile);
        out.person_calendar = {
          about: `Read-only: ${cfg.userLabel}'s own calendar (their secret ICS links). You cannot add, change or remove these.`,
          checked_at: cache?.checked_at ?? null,
          sources: (cache?.sources ?? []).map((s) => ({ name: s.name, ok: s.ok, synced_at: s.synced_at, ...(s.error ? { error: s.error } : {}) })),
          entries: externalBetween(cache, today, addDays(today, days - 1)),
        };
      }
      return json(out);
    },

    async add(req: Request): Promise<Response> {
      const body = await req.json().catch(() => null);
      const { entry, error } = validateNewEntry(body, new Date(clock()));
      if (!entry) return json({ error }, 400);
      const entries = readEntries(file);
      entries.push(entry);
      writeEntries(file, entries);
      return json({ ok: true, entry });
    },

    async remove(req: Request): Promise<Response> {
      const body: any = await req.json().catch(() => null);
      const id = typeof body?.id === "string" ? body.id : "";
      if (!id) return json({ error: "id required" }, 400);
      const entries = readEntries(file);
      const kept = entries.filter((e) => e.id !== id);
      if (kept.length === entries.length) return json({ ok: false, error: "no entry with that id in your calendar" }, 404);
      writeEntries(file, kept);
      return json({ ok: true, removed: entries.length - kept.length });
    },

    async feedInfo(req: Request): Promise<Response> {
      if (!cfg.enabled) return json({ enabled: false, about: "The calendar module is off (EMBERVY_HOOK_CALENDAR=0)." });
      if (cfg.feedToken.length < 16) return json({ enabled: false, about: "No CALENDAR_FEED_TOKEN in .env — run shared/calendar/feed-token.ts rotate, then restart the app." });
      const link = feedLink(cfg, req);
      return json({
        enabled: true,
        url: link,
        path: `${FEED_PATH}?token=${encodeURIComponent(cfg.feedToken)}`,
        about: link
          ? "Read-only subscription link: every entry not marked private, title and time only. Treat it like a password; rotate with shared/calendar/feed-token.ts rotate."
          : "Prefix the path with your app's public address (EMBERVY_APP_URL is not set).",
      });
    },

    async feed(req: Request): Promise<Response> {
      const token = new URL(req.url).searchParams.get("token");
      if (!feedTokenOk(cfg, token)) return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } });
      const body = renderFeed(readEntries(file), {
        calName: `${cfg.agentLabel} — calendar`,
        tz: cfg.tz,
        now: clock(),
        refreshMinutes: 30,
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'inline; filename="calendar.ics"',
          "cache-control": "private, no-cache",
          "x-robots-tag": "noindex",
        },
      });
    },
  };
}

export interface RouteHost {
  get(path: string, handler: (c: any) => any): unknown;
  post(path: string, handler: (c: any) => any): unknown;
}

export function registerCalendarRoutes(app: RouteHost, cfg: CalendarConfig): void {
  const h = createCalendarHandlers(cfg);
  for (const base of ["/api/calendar", "/api/internal/calendar"]) {
    app.get(base, (c) => h.list(c.req.raw));
    app.post(base, (c) => h.add(c.req.raw));
    app.post(`${base}/delete`, (c) => h.remove(c.req.raw));
    app.get(`${base}/feed`, (c) => h.feedInfo(c.req.raw));
  }
  app.get(FEED_PATH, (c) => h.feed(c.req.raw));
}

export function startExternalPoller(cfg: CalendarConfig, log: (line: string) => void = (l) => process.stderr.write(l + "\n")): () => void {
  const cacheFile = join(cfg.dataDir, EXTERNAL_CACHE_NAME);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const cache = await syncExternal({ urlsRaw: cfg.enabled ? cfg.icsUrlsRaw : "", cacheFile, tz: cfg.tz, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes });
      const bad = cache.sources.filter((s) => !s.ok);
      // Feed URLs contain secrets and must not reach logs.
      if (bad.length) log(`calendar: ${bad.length}/${cache.sources.length} personal calendar link(s) failed: ${bad.map((s) => `#${s.index + 1} ${s.error}`).join("; ")}`);
    } catch (err: any) {
      log(`calendar: personal calendar sync failed (${err?.name || "error"})`);
    } finally {
      running = false;
    }
  };
  void tick();
  const first = setTimeout(tick, 1000);
  const timer = setInterval(tick, cfg.pollMinutes * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
