// The ChatGPT sign-in from the Brain menu, end to end through the real server:
// OpenAI's token endpoint and the subscription backend are stood in for by a
// preloaded fetch, everything else (session, routes, files) is the real thing.
// It walks the part of the route that only a successful sign-in reaches.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASSWORD = "chatgpt-route-password-not-real";
import { startTestApp } from "./test-app-start";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ID_TOKEN = `${b64url({ alg: "none" })}.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-route-test" } })}.sig`;

function preload(dir: string, seen: string): string {
  const file = join(dir, "fake-openai.ts");
  writeFileSync(file, `
const real = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : input.url);
  if (url === "https://auth.openai.com/oauth/token") {
    require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ type: init?.headers?.["Content-Type"], body: String(init?.body) }));
    return Response.json({ access_token: "at-test", refresh_token: "rt-test", id_token: ${JSON.stringify(ID_TOKEN)} });
  }
  if (url === "https://chatgpt.com/backend-api/codex/responses") {
    return new Response("event: response.completed\\ndata: {}\\n\\n", { headers: { "content-type": "text/event-stream" } });
  }
  return real(input, init);
}) as typeof fetch;
`);
  return file;
}

test("a successful ChatGPT sign-in saves the tokens and prepares the ChatGPT head in brain.env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-route-"));
  const home = join(dir, "home");
  const state = join(dir, "state");
  const envFile = join(dir, "brain.env");
  const seen = join(dir, "token-request.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(envFile, `BRAIN_STATE_DIR=${state}\n`);
  const { base, proc, password: PASSWORD } = await startTestApp({
    cmd: ["bun", `--preload=${preload(dir, seen)}`, join(import.meta.dir, "server.ts")],
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_HOME: home,
      EMBERVY_HARNESS: "brain",
      BRAIN_ENV_FILE: envFile,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "chatgpt-route-test-no-such-session",
      APP_SESSION_SECRET: "chatgpt-route-session-secret",
      INTERNAL_API_TOKEN: "agent-bearer-for-tests",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const login = await fetch(`${base}/api/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0]!;

    const start = await fetch(`${base}/api/brain/chatgpt-signin/start`, { method: "POST", headers: { cookie } });
    expect(start.status).toBe(200);
    const url = new URL(((await start.json()) as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");

    const pasted = `http://127.0.0.1:1455/auth/callback?code=ac_route_test&scope=openid&state=${url.searchParams.get("state")}`;
    const done = await fetch(`${base}/api/brain/chatgpt-signin/code`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ pasted }) });
    const body = (await done.json()) as { ok?: boolean; error?: string };
    expect([done.status, body.error]).toEqual([200, undefined]);

    const request = JSON.parse(readFileSync(seen, "utf8"));
    expect(request.type).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(request.body).get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");

    const authFile = join(state, "chatgpt-auth.json");
    expect(existsSync(authFile)).toBe(true);
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(authFile, "utf8")).tokens.account_id).toBe("acc-route-test");

    const env = readFileSync(envFile, "utf8");
    expect(env).toMatch(/^BRAIN_GPT_CACHE_KEY=embervy-[0-9a-f]{24}$/m);
    expect(env).toContain(`BRAIN_GPT_ADAPTER=${home}/shared/tools/chatgpt-oauth-adapter.ts`);
    expect(env).toContain(`CHATGPT_AUTH_FILE=${authFile}`);
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
