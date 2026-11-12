import { expect, test } from "bun:test";
import { inQuietHours } from "./quiet-hours";

const at = (iso: string) => new Date(iso);

test("a range across midnight is quiet late at night and early in the morning, not by day", () => {
  expect(inQuietHours(at("2026-03-01T23:30:00Z"), "23-6", "UTC")).toBe(true);
  expect(inQuietHours(at("2026-03-01T02:00:00Z"), "23-6", "UTC")).toBe(true);
  expect(inQuietHours(at("2026-03-01T05:59:00Z"), "23-6", "UTC")).toBe(true);
  expect(inQuietHours(at("2026-03-01T06:00:00Z"), "23-6", "UTC")).toBe(false);
  expect(inQuietHours(at("2026-03-01T14:00:00Z"), "23-6", "UTC")).toBe(false);
  expect(inQuietHours(at("2026-03-01T22:59:00Z"), "23-6", "UTC")).toBe(false);
});

test("the hour is read in the house's time zone", () => {
  expect(inQuietHours(at("2026-01-15T21:30:00Z"), "22-7", "Europe/Berlin")).toBe(true);
  expect(inQuietHours(at("2026-01-15T21:30:00Z"), "22-7", "Asia/Tokyo")).toBe(true);
  expect(inQuietHours(at("2026-01-15T21:30:00Z"), "22-7", "America/New_York")).toBe(false);
});

test("a range within one day works too", () => {
  expect(inQuietHours(at("2026-03-01T13:00:00Z"), "12-14", "UTC")).toBe(true);
  expect(inQuietHours(at("2026-03-01T14:00:00Z"), "12-14", "UTC")).toBe(false);
});

test("off, empty, malformed or impossible settings are never quiet", () => {
  for (const spec of ["off", "", undefined, "23", "a-b", "25-6", "6-6", "23:00-06:00"]) {
    expect(inQuietHours(at("2026-03-01T02:00:00Z"), spec, "UTC")).toBe(false);
  }
});

test("an unknown time zone falls back to the server clock instead of failing", () => {
  expect(() => inQuietHours(at("2026-03-01T02:00:00Z"), "23-6", "Not/AZone")).not.toThrow();
});
