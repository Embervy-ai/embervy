import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeClaudeAuthState } from "../../Brain/claude-auth";
import { join } from "node:path";
import {
  claudeProfile, parseClaudeAuth, claudeScreenExpired, needsClaudeLogin,
  startClaudeSignIn, finishClaudeSignIn, claudeSignedIn, CLAUDE_AUTH_WORDINGS,
  type Runner,
} from "./claude-signin";

const appDir = join(import.meta.dir, "../../Claude/app");
const serverSource = readFileSync(join(appDir, "server.ts"), "utf8");
const clientSource = readFileSync(join(appDir, "public/app.js"), "utf8");
const strings = JSON.parse(readFileSync(join(appDir, "strings/en.json"), "utf8"));
const link = "https://example.invalid/oauth/authorize?state=fixture";
const pasted = "SecretCode1234#NoLogging";
const wait = { pollMs: 1, timeoutMs: 1, sleep: async () => {}, configDir: "/head/profile" };

function runner(options: { changed?: boolean; screen?: string; throwOnPaste?: boolean; stampError?: boolean } = {}) {
  let entered = false;
  let stamps = 0;
  const calls: string[][] = [];
  const target: Runner = {
    async run(cmd, opts) {
      calls.push(cmd);
      if (cmd.includes("load-buffer")) {
        expect(opts?.stdin).toBe(pasted);
        expect(cmd.join(" ")).not.toContain(pasted);
      }
      if (cmd.includes("capture-pane")) return { code: 0, out: entered ? options.screen || link : link };
      if (cmd.includes("paste-buffer") && options.throwOnPaste) throw new Error(`spawn ${cmd.join(" ")}`);
      if (cmd.includes("send-keys") && cmd.at(-1) === "Enter") entered = true;
      if (cmd.some(arg => arg.includes("sha256sum"))) {
        stamps++;
        if (options.stampError) return { code: 1, out: pasted };
        return { code: 0, out: options.changed && stamps > 1 ? "new-stamp" : "old-stamp" };
      }
      if (cmd.some(arg => arg.includes("auth status"))) return { code: 0, out: '{"loggedIn":true,"subscriptionType":"max"}' };
      return { code: 0, out: "" };
    },
  };
  return { target, calls };
}

test("profile selection: Brain state path and null override the app profile", () => {
  expect(claudeProfile(true, parseClaudeAuth('{"state":"expired","config_dir":"/head/profile"}'), "CLAUDE_CONFIG_DIR=/app")).toBe("/head/profile");
  expect(claudeProfile(true, parseClaudeAuth('{"state":"expired","config_dir":null}'), "CLAUDE_CONFIG_DIR=/app")).toBeNull();
  expect(parseClaudeAuth("broken")).toBeNull();
  expect(parseClaudeAuth("null")).toBeNull();
});
test("state: the file Brain itself writes is read for ok and for the default profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-auth-"));
  try {
    const file = join(dir, "claude-auth.json");
    writeClaudeAuthState(dir, "expired", { configDir: undefined, account: "default" } as any);
    expect(parseClaudeAuth(readFileSync(file, "utf8"))).toMatchObject({ state: "expired", config_dir: null });
    writeClaudeAuthState(dir, "ok");
    // Brain's ok state carries no config_dir; rejecting it would keep the banner up forever.
    expect(parseClaudeAuth(readFileSync(file, "utf8"))).toMatchObject({ state: "ok", config_dir: null });
    expect(parseClaudeAuth('{"state":"ok","config_dir":7}')).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("profile selection: Claude Code reads its env or explicitly unsets the profile", () => {
  expect(claudeProfile(false, null, "CLAUDE_CONFIG_DIR='/house/profile with spaces'\n")).toBe("/house/profile with spaces");
  expect(claudeProfile(false, null, "OTHER=value\n")).toBeNull();
});
test("login and status use the selected profile without changing PATH", async () => {
  for (const configDir of ["/head/profile with 'quote'", null]) {
    const r = runner();
    expect((await startClaudeSignIn(r.target, { ...wait, configDir })).ok).toBe(true);
    expect((await claudeSignedIn(r.target, configDir)).signedIn).toBe(true);
    const scripts = r.calls.filter(c => c[0] === "bash" || c.includes("new-session")).map(c => c.at(-1)!);
    expect(scripts.length).toBe(2);
    for (const script of scripts) {
      expect(script).not.toContain("export PATH");
      expect(script).toStartWith(configDir === null ? "unset CLAUDE_CONFIG_DIR;" : "export CLAUDE_CONFIG_DIR='/head/profile with '\\''quote'\\''';");
    }
  }
});
test("start gate: expired wins over signed-in status, while the menu still accepts an existing login", () => {
  expect(needsClaudeLogin(true, true)).toBe(true);
  expect(needsClaudeLogin(false, false)).toBe(true);
  expect(needsClaudeLogin(false, true)).toBe(false);
});
test("finish: signed-in status with unchanged credentials is not proof", async () => {
  const r = runner();
  expect((await claudeSignedIn(r.target, wait.configDir)).signedIn).toBe(true);
  expect(await finishClaudeSignIn(r.target, pasted, wait)).toEqual({ ok: false, error: "unconfirmed" });
});
test("finish: changed credentials after the code is pasted prove completion", async () => {
  const r = runner({ changed: true });
  expect(await finishClaudeSignIn(r.target, pasted, wait)).toEqual({ ok: true, detail: "done" });
  const pasteAt = r.calls.findIndex(c => c.includes("paste-buffer"));
  expect(r.calls.every(c => !c.join(" ").includes(pasted))).toBe(true);
  expect(r.calls.some(c => c.includes("delete-buffer"))).toBe(true);
  const baselineAt = r.calls.findIndex(c => c.some(arg => arg.includes("sha256sum")));
  const enterAt = r.calls.findIndex(c => c.includes("send-keys") && c.at(-1) === "Enter");
  expect(pasteAt).toBeLessThan(baselineAt);
  expect(baselineAt).toBeLessThan(enterAt);
  expect(r.calls.filter(c => c.some(arg => arg.includes("sha256sum"))).every(c => c.at(-1)!.startsWith("export CLAUDE_CONFIG_DIR='/head/profile';"))).toBe(true);
});
test("finish: a configured success marker is proof without auth status", async () => {
  // This synthetic marker tests the seam, not an unverified CLI spelling.
  const marker = "__TEST_ONLY_SUCCESS_MARKER__";
  CLAUDE_AUTH_WORDINGS.success.push(marker);
  try {
    const r = runner({ screen: marker });
    expect((await finishClaudeSignIn(r.target, pasted, wait)).ok).toBe(true);
    expect(r.calls.some(c => c.some(arg => arg.includes("auth status")))).toBe(false);
  } finally { CLAUDE_AUTH_WORDINGS.success.pop(); }
});
test("finish: Login failed and Invalid code override changed credentials without echoing screen text", async () => {
  for (const [screen, error] of [["Login failed", "loginFailed"], ["Invalid code", "invalidCode"]]) {
    const r = runner({ changed: true, screen: `${screen}: ${pasted}` });
    expect(await finishClaudeSignIn(r.target, pasted, wait)).toEqual({ ok: false, error });
  }
});
test("screen expiry: only the CLI's own result line counts, the agent quoting it in prose does not", () => {
  for (const screen of [
    "  ⎿  Failed to authenticate: OAuth session expired and could not be refreshed",
    "  ⎿  API Error: 401 {\"type\":\"error\"} · Please run /login",
    "API Error: 401 authentication_error",
    "\x1b[2m  ⎿  \x1b[31mFailed to authenticate\x1b[0m",
  ]) expect(claudeScreenExpired(screen)).toBe(true);
  for (const screen of [
    "We talked about OAuth clients today.",
    "Type /login in a terminal",
    "● Under the agent's name stood the bare error: Failed to authenticate: OAuth session expired and could not be refreshed.",
    "  Failed to authenticate: OAuth session expired and could not be refreshed",
    "  the banner says \"Please run /login\" is the CLI's wording",
  ]) expect(claudeScreenExpired(screen)).toBe(false);
  // Only the bottom of the screen: an old failure scrolled far up is history.
  expect(claudeScreenExpired(["  ⎿  Failed to authenticate", ...Array(40).fill("● later work")].join("\n"))).toBe(false);
  expect(claudeScreenExpired("Ready")).toBe(false);
});

function routeHarness(expired = true, signedIn = true) {
  const routes: Record<string, Function> = {};
  const app = { get: (path: string, fn: Function) => routes[`GET ${path}`] = fn, post: (path: string, fn: Function) => routes[`POST ${path}`] = fn };
  const start = serverSource.indexOf('app.get("/api/claude-auth"');
  const end = serverSource.indexOf("let chatgptAttempt", start);
  const part = new Bun.Transpiler({ loader: "ts" }).transformSync(serverSource.slice(start, end));
  const starts: unknown[] = [], finishes: unknown[] = [];
  const env = {
    app, S: (key: string) => strings[key], BRAIN_HARNESS: true,
    claudeAuthExpired: async () => expired,
    claudeAuthContext: () => ({ configDir: "/head/profile" }),
    claudeSignedIn: async () => ({ signedIn }), needsClaudeLogin,
    startClaudeSignIn: async (_r: unknown, options: unknown) => { starts.push(options); return { ok: true, url: link }; },
    finishClaudeSignIn: async (_r: unknown, code: string, options: unknown) => { finishes.push(options); throw new Error(`spawn ${code}`); },
    localRunner: {},
  };
  new Function(...Object.keys(env), part)(...Object.values(env));
  const call = async (path: string, body: unknown = {}) => {
    const c = { header() {}, req: { json: async () => body }, json: (data: unknown, status = 200) => ({ status, body: JSON.stringify(data) }) };
    return routes[path](c);
  };
  return { call, starts, finishes };
}
test("start route: signed-in status cannot skip expired recovery", async () => {
  const h = routeHarness();
  expect((await h.call("POST /api/brain/claude-signin/start")).status).toBe(200);
  expect(h.starts).toEqual([{ configDir: "/head/profile" }]);
  const menu = routeHarness(false, true);
  expect(JSON.parse((await menu.call("POST /api/brain/claude-signin/start")).body).already).toBe(true);
  expect(menu.starts).toEqual([]);
  const unsigned = routeHarness(false, false); await unsigned.call("POST /api/brain/claude-signin/start"); expect(unsigned.starts).toEqual([{ configDir: "/head/profile" }]);
});
test("pasted code never reaches captured logs, errors or response bodies", async () => {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
  const capture = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  for (const key of ["log", "warn", "error"] as const) console[key] = (...args) => { lines.push(args.join(" ")); };
  try {
    for (const options of [{ throwOnPaste: true }, { stampError: true }, { screen: `Login failed ${pasted}` }]) {
      const result = await finishClaudeSignIn(runner(options).target, pasted, wait);
      expect(JSON.stringify(result)).not.toContain(pasted);
    }
    const h = routeHarness();
    await h.call("POST /api/brain/claude-signin/start");
    const response = await h.call("POST /api/brain/claude-signin/code", { code: pasted });
    expect(response.status).toBe(502);
    expect(response.body).not.toContain(pasted);
    expect(h.finishes).toEqual([{ configDir: "/head/profile" }]);
    expect(lines.join("\n")).not.toContain(pasted);
    const routePart = serverSource.slice(serverSource.indexOf('app.post("/api/brain/claude-signin/start"'), serverSource.indexOf("let chatgptAttempt"));
    expect(routePart).not.toMatch(/console\.|stderr|appendFileSync|logTerminalInput/);
  } finally {
    Object.assign(console, originals);
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
});

function client() {
  const nodes: Record<string, any> = {};
  const document = { getElementById: (id: string) => nodes[id] ||= {
    hidden: true, textContent: "", value: "", href: "", disabled: false,
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
  } };
  const requests: { url: string; options: any }[] = [];
  let answer: any = { expired: true, kept: true };
  let ok = true;
  const fetch = async (url: string, options: any) => { requests.push({ url, options }); return { ok, json: async () => answer }; };
  const part = clientSource.slice(clientSource.indexOf("  const claudeAuthEl = id =>"), clientSource.indexOf("  async function init() {"));
  // claudeAuthEnabled lives at the top of app.js; the success path polls with it.
  const app = new Function("document", "t", "fetch", "claudeAuthEnabled", `${part}; return { renderClaudeAuth, pollClaudeAuth, sendClaudeAuth };`)(document, (key: string) => {
    if (!(key in strings)) throw new Error(`missing string ${key}`);
    return strings[key];
  }, fetch, true);
  return { nodes, requests, ...app, answer: (data: any, success = true) => { answer = data; ok = success; } };
}
test("banner: Brain keeps the message and clears only on ok", () => {
  const h = client();
  h.renderClaudeAuth({ expired: true, kept: true });
  expect(h.nodes["claude-auth-banner"].hidden).toBe(false);
  expect(h.nodes["claude-auth-text"].textContent).toBe(strings["claudeAuth.kept"]);
  expect(h.nodes["claude-auth-start"].textContent).toBe("Sign in again");
  h.nodes["claude-auth-code"].value = pasted;
  h.renderClaudeAuth({ expired: false, kept: true });
  expect(h.nodes["claude-auth-banner"].hidden).toBe(true);
  expect(h.nodes["claude-auth-code"].value).toBe("");
});
test("banner: Claude Code asks to resend and clears on a clean screen", () => {
  const h = client();
  h.renderClaudeAuth({ expired: true, kept: false });
  expect(h.nodes["claude-auth-banner"].hidden).toBe(false);
  expect(h.nodes["claude-auth-text"].textContent).toBe(strings["claudeAuth.resend"]);
  h.renderClaudeAuth({ expired: false, kept: false });
  expect(h.nodes["claude-auth-banner"].hidden).toBe(true);
});
test("banner: code goes only to sign-in, errors leave a fresh-link button", async () => {
  const h = client();
  h.renderClaudeAuth({ expired: true, kept: true });
  h.answer({ url: link });
  await h.sendClaudeAuth("start");
  expect(h.nodes["claude-auth-form"].hidden).toBe(false);
  h.nodes["claude-auth-code"].value = pasted;
  h.answer({ error: strings["claudeAuth.error.invalidCode"] }, false);
  await h.sendClaudeAuth("code");
  expect(h.nodes["claude-auth-code"].value).toBe("");
  expect(h.nodes["claude-auth-form"].hidden).toBe(true);
  expect(h.nodes["claude-auth-start"].disabled).toBe(false);
  expect(h.nodes["claude-auth-result"].textContent).toBe(strings["claudeAuth.error.invalidCode"]);
  expect(h.requests.map((r: any) => r.url)).toEqual(["/api/brain/claude-signin/start", "/api/brain/claude-signin/code"]);
  expect(JSON.parse(h.requests[1].options.body)).toEqual({ code: pasted });
});
test("banner: a new link says so, and a completed sign-in leaves no button until the banner clears", async () => {
  const h = client();
  h.renderClaudeAuth({ expired: true, kept: true });
  h.answer({ url: link });
  await h.sendClaudeAuth("start");
  await h.sendClaudeAuth("start");
  expect(h.nodes["claude-auth-result"].textContent).toBe(strings["claudeAuth.linkReady"]);
  // Brain may still report expired for a moment after the code went through.
  h.answer({ ok: true, expired: true, kept: true });
  await h.sendClaudeAuth("code");
  expect(h.nodes["claude-auth-result"].textContent).toBe(strings["claudeAuth.done"]);
  expect(h.nodes["claude-auth-start"].hidden).toBe(true);
  h.renderClaudeAuth({ expired: false, kept: true });
  expect(h.nodes["claude-auth-banner"].hidden).toBe(true);
  expect(h.nodes["claude-auth-start"].hidden).toBe(false);
});
test("cache: app script versions match and recovery polling is independent of terminal settings", () => {
  const index = readFileSync(join(appDir, "public/index.html"), "utf8");
  const sw = readFileSync(join(appDir, "public/sw.js"), "utf8");
  expect(index.match(/app\.js\?v=(\d+)/)![1]).toBe(sw.match(/app\.js\?v=(\d+)/)![1]);
  const part = clientSource.slice(clientSource.indexOf("  const claudeAuthEl = id =>"));
  expect(part).toContain("setInterval(pollClaudeAuth, 3000)");
  expect(part).not.toContain("terminalPanelEnabled");
});
