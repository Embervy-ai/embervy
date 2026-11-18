import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readClaudeLimits, shapeClaudeLimits } from "./claude-limits";
import { startTestApp } from "./test-app-start";

const now = 1800000000;
const snapshot = (timestamp: unknown = now) => ({ timestamp, model: "claude-example", rate_limits: {
  five_hour: { used_percentage: 25, resets_at: now + 3600 },
  seven_day: { used_percentage: 105, resets_at: now + 86400 },
} });

describe("read-only Claude Code limits", () => {
  test("Brain-shaped windows use seconds, utilization, observation age and no invented status", () => {
    expect(shapeClaudeLimits(snapshot(), now + 60)).toEqual({ account: null, windows: [
      { name: "five_hour", utilization: 0.25, resets_at: now + 3600, reported_at: now, model: "claude-example", status: "unknown", age_seconds: 60 },
      { name: "seven_day", utilization: 1, resets_at: now + 86400, reported_at: now, model: "claude-example", status: "unknown", age_seconds: 60, exceeded: true },
    ] });
    const iso = snapshot(new Date(now * 1000).toISOString());
    (iso.rate_limits.five_hour.resets_at as any) = new Date((now + 3600) * 1000).toISOString();
    expect(shapeClaudeLimits(iso, now)).toEqual(shapeClaudeLimits(snapshot(), now));
  });
  test("freshness is timestamp-based, seven days inclusive, no future observations", () => {
    expect(shapeClaudeLimits(snapshot(), now + 7 * 86400)).not.toBeNull();
    expect(shapeClaudeLimits(snapshot(), now + 7 * 86400 + 0.1)).toBeNull();
    for (const timestamp of [null, false, now * 1000, now + 1, "bad", "1800000000"]) {
      expect(shapeClaudeLimits(snapshot(timestamp), now)).toBeNull();
    }
    // A reset time in the past does not turn an old observation into a new zero.
    expect(shapeClaudeLimits(snapshot(), now + 7200)?.windows[0]?.utilization).toBe(0.25);
  });
  test("invalid windows are skipped; percentages clamped; private fields never escape", () => {
    const data: any = { ...snapshot(), session_id: "PRIVATE_SESSION", workspace: "PRIVATE_WORKSPACE", cost: "PRIVATE_COST" };
    data.model = { id: "claude-example", extra: "PRIVATE_MODEL" };
    data.rate_limits.five_hour.used_percentage = -1;
    data.rate_limits.invalid = { used_percentage: "99", resets_at: now };
    data.rate_limits.infinite = { used_percentage: Infinity, resets_at: now };
    data.rate_limits.milliseconds = { used_percentage: 99, resets_at: now * 1000 };
    data.rate_limits["bad\nname"] = { used_percentage: 90, resets_at: now };
    const result = shapeClaudeLimits(data, now)!;
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]!.utilization).toBe(0);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    for (const rate_limits of [null, [], {}, { five_hour: { used_percentage: 10 } }]) {
      expect(shapeClaudeLimits({ ...data, rate_limits }, now)).toBeNull();
    }
  });
  test("missing, unreadable, nonregular, corrupt and oversized files are null, never repaired", () => {
    const dir = mkdtempSync(join(tmpdir(), "limits-reader-"));
    try {
      const file = join(dir, "snapshot.json");
      expect(readClaudeLimits(file, now)).toBeNull();
      expect(readClaudeLimits(dir, now)).toBeNull();
      for (const raw of ["{", "null", "x".repeat(128 * 1024 + 1)]) {
        writeFileSync(file, raw);
        expect(readClaudeLimits(file, now)).toBeNull();
        expect(readFileSync(file, "utf8")).toBe(raw);
      }
      writeFileSync(file, JSON.stringify(snapshot()));
      chmodSync(file, 0);
      expect(readClaudeLimits(file, now)).toBeNull();
      chmodSync(file, 0o600);
      symlinkSync(file, join(dir, "linked"));
      expect(readClaudeLimits(join(dir, "linked"), now)).toBeNull();
      expect(readClaudeLimits(file, now)).toEqual(shapeClaudeLimits(snapshot(), now));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

for (const [harness, substrate] of [["claude-code", "claude"], ["claude-code", "gpt"], ["brain", "claude"], ["", "brain"]]) test(`claude-limits HTTP session door and read-only behavior (${harness}/${substrate})`, async () => {
  const home = mkdtempSync(join(tmpdir(), "limits-http-"));
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    mkdirSync(join(home, "state"));
    mkdirSync(join(home, "Claude/app"), { recursive: true });
    // Root/app configuration precedence matches the writer and cache ping.
    writeFileSync(join(home, ".env"), "EMBERVY_CACHE_PING_STATUS_FILE=state/root.json\n");
    writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_CACHE_PING_STATUS_FILE=state/custom.json\n");
    const started = await startTestApp({ cwd: import.meta.dir, env: { ...process.env,
      EMBERVY_HOME: home, EMBERVY_HARNESS: harness, EMBERVY_SUBSTRATE: substrate,
      EMBERVY_APP_DATA_DIR: join(home, "data"), EMBERVY_TRUST_SAME_HOST: "true",
      APP_SESSION_SECRET: "isolated-limits-session-secret", INTERNAL_API_TOKEN: "limits-agent-token",
      EMBERVY_TERMINAL_PANEL: "0", EMBERVY_DOCTOR_INTERVAL_MIN: "0",
    } });
    proc = started.proc;
    const url = started.base + "/api/claude-limits";
    for (const headers of [{}, { authorization: "Bearer limits-agent-token" }, { cookie: "embervy_session=invalid" }]) {
      expect((await fetch(url, { headers })).status).toBe(401);
    }
    const get = () => fetch(url, { headers: { cookie: started.cookie } });
    expect(await (await get()).json()).toBeNull();
    const file = join(home, "state/custom.json");
    const observed = Math.floor(Date.now() / 1000) - 2;
    const data = snapshot(observed);
    data.rate_limits.five_hour.resets_at = observed + 3600;
    const raw = JSON.stringify(data);
    writeFileSync(file, raw);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = await response.json();
    if (harness === "brain" || substrate === "brain") expect(result).toBeNull();
    else {
      expect(result.account).toBeNull();
      expect(result.windows).toHaveLength(2);
      expect(result.windows[0]).toMatchObject({ name: "five_hour", utilization: 0.25, resets_at: observed + 3600, reported_at: observed, model: "claude-example" });
    }
    expect(readFileSync(file, "utf8")).toBe(raw);
    writeFileSync(file, JSON.stringify(snapshot(observed - 7 * 86400)));
    expect(await (await get()).json()).toBeNull();
    writeFileSync(file, "{");
    expect(await (await get()).json()).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("{");
  } finally {
    if (proc) { proc.kill(); await proc.exited; }
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
