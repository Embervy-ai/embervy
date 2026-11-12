#!/usr/bin/env bun
/**
 * Embervy Weather — local weather as ambient context.
 *
 * Prints a single compact line for inlet injection, e.g.:
 *   ⛅ Lisbon: 18°C (feels 16°C), light rain, wind 24 km/h · today 14–21°C, rain risk 60%
 *
 * Design constraints (module promise: "lightweight, no account needed"):
 *   - Open-Meteo, free + keyless. Geocoding once, then cached forever.
 *   - 15-min result cache — the inlet may call this every few turns.
 *   - NEVER breaks the inlet: any failure prints nothing and exits 0.
 *
 * Config (all optional, first match wins):
 *   EMBERVY_WEATHER_PLACE  city name to geocode (falls back to EMBERVY_TIME_LABEL)
 *   EMBERVY_WEATHER_LAT / EMBERVY_WEATHER_LON  explicit coordinates, skip geocoding
 *
 * State (under $EMBERVY_HOME/state/):
 *   weather-geo.json    resolved coordinates for the configured place
 *   weather-cache.json  last successful line + timestamp
 */

import { existsSync } from "node:fs";
import { envValue, houseHome } from "../scripts/legacy-names";

const HOME = houseHome(process.env, existsSync);
const STATE = `${HOME}/state`;
const GEO_FILE = `${STATE}/weather-geo.json`;
const CACHE_FILE = `${STATE}/weather-cache.json`;
const CACHE_TTL_MS = 15 * 60 * 1000;

// WMO weather interpretation codes → short text. Kept coarse on purpose —
// this is ambient context, not a forecast product.
const WMO: Record<number, [string, string]> = {
  0: ["☀️", "clear"],
  1: ["🌤", "mostly clear"],
  2: ["⛅", "partly cloudy"],
  3: ["☁️", "overcast"],
  45: ["🌫", "fog"],
  48: ["🌫", "rime fog"],
  51: ["🌦", "light drizzle"],
  53: ["🌦", "drizzle"],
  55: ["🌧", "heavy drizzle"],
  56: ["🌧", "freezing drizzle"],
  57: ["🌧", "freezing drizzle"],
  61: ["🌦", "light rain"],
  63: ["🌧", "rain"],
  65: ["🌧", "heavy rain"],
  66: ["🌧", "freezing rain"],
  67: ["🌧", "freezing rain"],
  71: ["🌨", "light snow"],
  73: ["🌨", "snow"],
  75: ["❄️", "heavy snow"],
  77: ["🌨", "snow grains"],
  80: ["🌦", "rain showers"],
  81: ["🌧", "rain showers"],
  82: ["⛈", "violent showers"],
  85: ["🌨", "snow showers"],
  86: ["🌨", "snow showers"],
  95: ["⛈", "thunderstorm"],
  96: ["⛈", "thunderstorm w/ hail"],
  99: ["⛈", "thunderstorm w/ hail"],
};

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function resolveCoords(): Promise<{ lat: number; lon: number; label: string } | null> {
  const envLat = envValue("EMBERVY_WEATHER_LAT");
  const envLon = envValue("EMBERVY_WEATHER_LON");
  const place = envValue("EMBERVY_WEATHER_PLACE") || envValue("EMBERVY_TIME_LABEL") || "";

  if (envLat && envLon) {
    return { lat: parseFloat(envLat), lon: parseFloat(envLon), label: place || "here" };
  }
  if (!place) return null;

  const cached = await readJson(GEO_FILE);
  if (cached && cached.place === place) return cached.coords;

  const geo = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`,
  );
  const hit = geo?.results?.[0];
  if (!hit) return null;
  const coords = { lat: hit.latitude, lon: hit.longitude, label: hit.name as string };
  try {
    await Bun.write(GEO_FILE, JSON.stringify({ place, coords }, null, 2));
  } catch {}
  return coords;
}

function placeKey(): string {
  return (
    envValue("EMBERVY_WEATHER_PLACE") ||
    envValue("EMBERVY_TIME_LABEL") ||
    `${envValue("EMBERVY_WEATHER_LAT") ?? ""},${envValue("EMBERVY_WEATHER_LON") ?? ""}`
  );
}

async function weatherLine(): Promise<string | null> {
  const key = placeKey();
  if (!key || key === ",") return null; // nothing configured — stay silent

  const cache = await readJson(CACHE_FILE);
  if (cache && cache.key === key && Date.now() - cache.ts < CACHE_TTL_MS && cache.line) {
    return cache.line;
  }

  const c = await resolveCoords();
  if (!c) return null;

  const data = await fetchJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=1`,
  );
  const cur = data?.current;
  if (!cur) return null;

  const [icon, text] = WMO[cur.weather_code] ?? ["🌡", "—"];
  const t = Math.round(cur.temperature_2m);
  const feels = Math.round(cur.apparent_temperature);
  const wind = Math.round(cur.wind_speed_10m);
  const d = data.daily ?? {};
  const tmin = Math.round(d.temperature_2m_min?.[0] ?? NaN);
  const tmax = Math.round(d.temperature_2m_max?.[0] ?? NaN);
  const rain = d.precipitation_probability_max?.[0];

  let line = `${icon} ${c.label}: ${t}°C`;
  if (feels !== t) line += ` (feels ${feels}°C)`;
  line += `, ${text}, wind ${wind} km/h`;
  if (!Number.isNaN(tmin) && !Number.isNaN(tmax)) {
    line += ` · today ${tmin}–${tmax}°C`;
    if (typeof rain === "number") line += `, rain risk ${rain}%`;
  }

  try {
    await Bun.write(CACHE_FILE, JSON.stringify({ key, ts: Date.now(), line }, null, 2));
  } catch {}
  return line;
}

try {
  const line = await weatherLine();
  if (line) console.log(line);
} catch {
  // ambient context must never break the inlet — stay silent
}
