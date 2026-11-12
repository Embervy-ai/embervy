import { describe, expect, test } from "bun:test";
import { houseDayStartUtc, houseTime } from "./src/index";

// The journal shelf shows and filters in the house's wall time; the store
// keeps UTC.
describe("journal shelf in house time", () => {
  test("a stored UTC time reads as the house's clock, summer and winter", () => {
    expect(houseTime("2026-10-08 22:03:00", "Europe/Berlin")).toBe("2026-10-09 00:03");
    expect(houseTime("2026-12-01 23:30:00", "Europe/Berlin")).toBe("2026-12-02 00:30");
    expect(houseTime("2026-10-08 22:03:00", "UTC")).toBe("2026-10-08 22:03");
    expect(houseTime("2026-10-08T22:03:00Z", "America/New_York")).toBe("2026-10-08 18:03");
    expect(houseTime("not a time", "Europe/Berlin")).toBe("not a time");
  });

  test("a house day starts at its own midnight in stored UTC; 'to' ends before the next one", () => {
    expect(houseDayStartUtc("2026-10-09", "Europe/Berlin")).toBe("2026-10-08 22:00:00");
    expect(houseDayStartUtc("2026-10-09", "Europe/Berlin", 1)).toBe("2026-10-09 22:00:00");
    expect(houseDayStartUtc("2026-12-31", "Europe/Berlin", 1)).toBe("2026-12-31 23:00:00");
    expect(houseDayStartUtc("2026-10-09", "UTC")).toBe("2026-10-09 00:00:00");
    expect(houseDayStartUtc("09.10.2026", "UTC")).toBeNull();
    // The entry written at 00:03 house time belongs to the 9th, not the 8th.
    const stored = "2026-10-08 22:03:00";
    expect(stored >= houseDayStartUtc("2026-10-09", "Europe/Berlin")!).toBe(true);
    expect(stored < houseDayStartUtc("2026-10-08", "Europe/Berlin", 1)!).toBe(false);
  });
});
