import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDoctorMutes, parseDoctorMutes, pruneDoctorMutes, rawDoctorStatus, doctorRegressed, DOCTOR_MUTE_MS } from "./doctor-mute";

const now = Date.now();
const mute = { at: new Date(now).toISOString(), until: new Date(now + DOCTOR_MUTE_MS).toISOString() };
const check = (id: string, status = "FAIL") => ({ id, status, label: id, detail: "example detail", fix: "example fix" });
const status = (...checks: any[]) => ({ state: checks.some(c => c.status === "FAIL") ? "fail" : checks.some(c => c.status === "WARN") ? "warn" : "ok", checks });
const mutes = { "example-a": mute };

describe("doctor mute logic", () => {
  test("muted FAIL stays truthful while the badge turns green", () => {
    const result = applyDoctorMutes(status(check("example-a")), mutes, now);
    expect(result.state).toBe("fail");
    expect(result.badge_state).toBe("ok");
    expect(result.muted).toBe(1);
    expect(result.checks[0].muted_until).toBe(mute.until);
  });
  test("another FAIL still counts, including beside a muted WARN", () => {
    for (const severity of ["FAIL", "WARN"]) {
      expect(applyDoctorMutes(status(check("example-a", severity), check("example-b")), mutes, now).badge_state).toBe("fail");
    }
    expect(applyDoctorMutes(status(check("example-a", "WARN")), mutes, now).badge_state).toBe("ok");
  });
  test("expiration counts again at the exact deadline", () => {
    const result = applyDoctorMutes(status(check("example-a")), mutes, now + DOCTOR_MUTE_MS);
    expect(result.badge_state).toBe("fail");
    expect(result.checks[0].muted_until).toBeUndefined();
    expect(Object.keys(pruneDoctorMutes(result, mutes, now + DOCTOR_MUTE_MS))).toHaveLength(0);
  });
  test("an intervening OK removes the mute before the next failure", () => {
    const pruned = pruneDoctorMutes(status(check("example-a", "OK")), mutes, now);
    expect(Object.keys(pruned)).toHaveLength(0);
    expect(applyDoctorMutes(status(check("example-a")), pruned, now).badge_state).toBe("fail");
  });
  test("corrupt storage and unsafe timestamps mute nothing", () => {
    for (const text of ["{", "null", "[]", '{"example-a":{"at":"bad","until":"<img>"}}']) {
      expect(applyDoctorMutes(status(check("example-a")), parseDoctorMutes(text), now).muted).toBe(0);
    }
    expect(parseDoctorMutes(JSON.stringify(mutes))).toEqual(mutes);
  });
  test("agent annotations are discarded, prototype names remain ordinary ids", () => {
    expect(rawDoctorStatus({ badge_state: "ok", muted: 1, checks: [{ ...check("example-a"), muted_until: mute.until }] })).toEqual({ checks: [check("example-a")] });
    expect(applyDoctorMutes(status(check("constructor")), {}, now).badge_state).toBe("fail");
    const special = parseDoctorMutes(`{"__proto__":${JSON.stringify(mute)}}`);
    expect(applyDoctorMutes(status(check("__proto__")), special, now).badge_state).toBe("ok");
  });
  test("regressions compare effective state", () => {
    const green = status(check("example-a", "OK"));
    const muted = applyDoctorMutes(status(check("example-a")), mutes, now);
    expect(doctorRegressed(green, muted)).toBe(false);
    expect(doctorRegressed(muted, applyDoctorMutes(status(check("example-a"), check("example-b")), mutes, now))).toBe(true);
  });
});

const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const strings = JSON.parse(readFileSync(join(import.meta.dir, "strings/en.json"), "utf8"));
const t = (key: string, vars: any = {}) => strings[key].replace(/\{(\w+)\}/g, (_: string, k: string) => String(vars[k]));
const pure = new Function("t", "I18N", `${source.slice(source.indexOf("  function escapeHtml(text) {"), source.indexOf("  function appearanceTextColors(background) {"))}\nreturn { doctorReportHtml };`)(t, { formatTime: () => "02:46" });
describe("doctor mute UI", () => {
  test("only FAIL/WARN with an id get an escaped pill", () => {
    const html = pure.doctorReportHtml(status(check('example-"<id>'), check("example-w", "WARN"), check("example-ok", "OK"), check("")));
    expect(html.match(/data-doctor-mute=/g)).toHaveLength(2);
    expect(html).toContain('data-doctor-mute="example-&quot;&lt;id&gt;"');
    expect(html).toContain(strings["doctor.seen"]);
    expect(html).toContain(strings["doctor.seenTitle"]);
  });
  test("muted rows hide details and fixes and use the language formatter", () => {
    const html = pure.doctorReportHtml({ checks: [{ ...check("example-a"), muted_until: mute.until }] });
    expect(html).toContain("doctor-muted");
    expect(html).toContain("muted until 02:46");
    expect(html).not.toContain("example detail");
    expect(html).not.toContain("example fix");
    expect(html).not.toContain("data-doctor-mute");
  });
  test("all badge paths prefer badge_state and the delegated click uses the human door", () => {
    expect(source).toContain("status.badge_state || status.state");
    expect(source).toContain("setDoctorBadge(msg.data)");
    expect(source).toContain("setDoctorBadge(data)");
    expect(source).toContain("setDoctorBadge(data.status ||");
    expect(source).toContain('event.target.closest("[data-doctor-mute]")');
    expect(source).toContain('fetch("/api/doctor/mute"');
    expect(source).not.toContain('fetch("/api/internal/doctor/mute"');
    for (const key of ["seen", "seenTitle", "mutedUntil", "badgeMuted", "muteFailed"]) expect(source).toContain(`t("doctor.${key}"`);
  });
});

describe("doctor mute HTTP routes in an isolated house", () => {
  let dir: string, base: string, cookie: string, proc: ReturnType<typeof Bun.spawn>;
  const token = "example-internal-token";
  const tunnel = { "cf-ray": "example-ray", "cf-connecting-ip": "203.0.113.9" };
  const file = () => join(dir, "state/doctor-mute.json");
  const rawFile = () => join(dir, "state/doctor-last.json");
  const call = async (method: string, path: string, body?: any, auth = "cookie") => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth === "cookie") headers.cookie = cookie;
    if (auth === "bearer") headers.authorization = `Bearer ${token}`;
    const response = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { code: response.status, data: await response.json() };
  };
  const post = (body: any) => call("POST", "/api/internal/doctor/status", body, "bearer");
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "example-doctor-"));
    mkdirSync(join(dir, "state"));
    mkdirSync(join(dir, "bin"));
    for (const name of ["tmux", "pgrep", "pkill", "setsid"]) {
      const path = join(dir, "bin", name);
      writeFileSync(path, "#!/bin/sh\nexit 0\n"); chmodSync(path, 0o755);
    }
    // The preload lives in a temp dir, so the module is named by its resolved path.
    const preload = join(dir, "preload.ts");
    writeFileSync(preload, `import { mock } from "bun:test";\nimport { appendFileSync } from "node:fs";\nmock.module(${JSON.stringify(Bun.resolveSync("web-push", import.meta.dir))}, () => ({ default: { setVapidDetails() {}, async sendNotification() { appendFileSync(${JSON.stringify(join(dir, "push.log"))}, "push\\n"); } } }));\n`);
    const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = socket.port; socket.stop(true);
    if (port === 3030) throw new Error("refusing production port");
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
      cwd: dir, env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir,
        EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_HOME: dir,
        APP_PASSWORD: "example-password", APP_SESSION_SECRET: "example-session-secret", INTERNAL_API_TOKEN: token,
        EMBERVY_TRUST_SAME_HOST: "true", EMBERVY_TERMINAL_PANEL: "0", EMBERVY_STRINGS_LOCAL: join(dir, "missing.json"),
      }, stdout: "ignore", stderr: "pipe",
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(base + "/health")).ok; } catch {}
      if (!ready) await Bun.sleep(100);
    }
    if (!ready) {
      proc.kill();
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`test server did not come up: ${stderr}`);
    }
    const login = await fetch(base + "/api/auth", { method: "POST", headers: { ...tunnel, "content-type": "application/json" }, body: JSON.stringify({ password: "example-password" }) });
    cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).not.toBe("");
    await call("POST", "/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/doctor-mute", keys: {} });
  }, 30_000);
  afterAll(async () => {
    proc?.kill(); if (proc) await proc.exited;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  test("cookie mutes exactly one current failure and raw state stays raw", async () => {
    await post(status(check("example-a"), check("example-ok", "OK")));
    const response = await call("POST", "/api/doctor/mute", { id: "example-a" });
    expect(response.code).toBe(200);
    expect(response.data.status.badge_state).toBe("ok");
    expect(Date.parse(response.data.mute.until) - Date.parse(response.data.mute.at)).toBe(DOCTOR_MUTE_MS);
    expect(JSON.parse(readFileSync(file(), "utf8"))["example-a"]).toEqual(response.data.mute);
    expect(readFileSync(rawFile(), "utf8")).not.toContain("muted_until");
    expect((await call("GET", "/api/internal/doctor/status")).data.muted).toBe(1);
  });
  test("bearer and same-host trust cannot mute; invalid ids leave storage unchanged", async () => {
    const before = readFileSync(file(), "utf8");
    for (const auth of ["bearer", "none"]) expect((await call("POST", "/api/doctor/mute", { id: "example-a" }, auth)).code).toBe(401);
    for (const id of ["example-missing", "example-ok", "x".repeat(201), null]) expect((await call("POST", "/api/doctor/mute", { id })).code).toBe(400);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });
  test("background muted failure after previous green sends no push; new failure does", async () => {
    writeFileSync(rawFile(), JSON.stringify(status(check("example-a", "OK"))));
    writeFileSync(join(dir, "push.log"), "");
    expect((await post(status(check("example-a")))).data.badge_state).toBe("ok");
    expect(readFileSync(join(dir, "push.log"), "utf8")).toBe("");
    await post(status(check("example-a"), check("example-b")));
    expect(readFileSync(join(dir, "push.log"), "utf8")).toBe("push\n");
  });
  test("a stored OK clears the mute and the next failure is visible", async () => {
    await post(status(check("example-a", "OK")));
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
    expect((await post(status(check("example-a")))).data.badge_state).toBe("fail");
  });
  test("on-demand reports carry mutes, broadcast them, and persist raw checks", async () => {
    await post(status(check("example-a")));
    await call("POST", "/api/doctor/mute", { id: "example-a" });
    const runner = join(dir, "bin/bun");
    const output = join(dir, "doctor-output.json");
    writeFileSync(output, JSON.stringify({ ...status(check("example-a")), summary: { fail: 1 }, result: "FAIL" }));
    writeFileSync(runner, `#!/bin/sh\ncat ${JSON.stringify(output)}\n`);
    chmodSync(runner, 0o755);
    const messages: any[] = [];
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { cookie } });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve(); ws.onerror = reject;
      });
      ws.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.type === "doctor-status") messages.push(m.data); };
      const result = await call("GET", "/api/internal/doctor");
      expect(result.code).toBe(200);
      expect(result.data.report.checks[0].muted_until).toBeTruthy();
      expect(result.data.status.badge_state).toBe("ok");
      for (let i = 0; i < 20 && !messages.length; i++) await Bun.sleep(10);
      expect(messages[0].badge_state).toBe("ok");
      expect(readFileSync(rawFile(), "utf8")).not.toContain("muted_until");
      writeFileSync(output, JSON.stringify({ checks: [check("example-a", "OK")], summary: { pass: 1 }, result: "PASS" }));
      await call("GET", "/api/internal/doctor");
      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
      await post(status(check("example-a")));
    } finally { ws.close(); }
  });
  test("corrupt or missing storage is fail-open for diagnostics, never silently green", async () => {
    writeFileSync(file(), "broken");
    expect((await call("GET", "/api/internal/doctor/status")).data.badge_state).toBe("fail");
    rmSync(file());
    expect((await call("GET", "/api/internal/doctor/status")).data.muted).toBe(0);
    expect(existsSync(file())).toBe(false);
  });
});
