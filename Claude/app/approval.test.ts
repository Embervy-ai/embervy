import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askApproval } from "../../Brain/app-channel";

test("approval cards separate agent requests from human decisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "approval-"));
  const data = join(dir, "data");
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port;
  listener.stop(true);
  if (port === 3030) throw new Error("refusing default port");
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, "run", join(import.meta.dir, "server.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir, EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), INTERNAL_API_TOKEN: "internal-test", APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-session-secret", EMBERVY_TERMINAL_PANEL: "0" },
    stdout: "ignore", stderr: "pipe",
  });
  const bearer = { authorization: "Bearer internal-test" };
  const call = (path: string, headers: Record<string, string>, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(base + "/health")).ok; } catch {}
      if (!ready) await Bun.sleep(100);
    }
    if (!ready) { server.kill(); throw new Error(`Test server startup failed: ${await new Response(server.stderr).text()}`); }
    const login = await call("/api/auth", {}, { password: "test-password" });
    const human = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const ask = async (title = "Run sensitive tool") => {
      const res = await call("/api/approval/ask", bearer, { title, detail: "Review this operation", kind: "test" });
      expect(res.status).toBe(200);
      return (await res.json() as any).id as string;
    };
    const status = async (id: string) => (await (await call(`/api/approval/${id}`, bearer)).json() as any).status;
    const decide = (id: string, decision: string, headers = human) => call(`/api/approval/${id}/decide`, headers, { decision });
    const id = await ask();
    expect(await status(id)).toBe("pending");
    expect((await call(`/api/approval/${id}`, human)).status).toBe(200);
    for (const decision of ["allow", "deny"]) {
      expect((await decide(id, decision, bearer as any)).status).toBe(403);
      expect(await status(id)).toBe("pending");
    }
    expect((await decide(id, "expired", bearer as any)).status).toBe(200);
    expect(await status(id)).toBe("expired");
    const second = await ask();
    expect((await decide(second, "allow")).status).toBe(200);
    expect(await status(second)).toBe("allow");
    expect((await decide(second, "deny")).status).toBe(200);
    expect(await status(second)).toBe("allow");
    expect((await call("/api/approval/ask", {}, { title: "No credentials" })).status).toBe(401);
    expect((await call(`/api/approval/${id}`, {})).status).toBe(401);
    expect((await decide(id, "allow", {} as any)).status).toBe(401);
    expect((await call("/api/approval/missing", bearer)).status).toBe(404);
    expect((await decide("missing", "allow")).status).toBe(404);
    expect((await decide("missing", "expired", bearer as any)).status).toBe(404);
    for (const body of [{}, { title: " " }, { title: "x".repeat(201) }, { title: "x", detail: "x".repeat(2001) }, { title: "x", kind: "x".repeat(41) }]) {
      expect((await call("/api/approval/ask", bearer, body)).status).toBe(400);
    }
    const reactionId = await ask();
    expect((await call("/api/internal/react", bearer, { message_id: reactionId, emoji: "❤️", from: "User" })).status).toBe(200);
    expect(await status(reactionId)).toBe("pending");
    expect((await call("/api/react", bearer, { message_id: reactionId, emoji: "❤️" })).status).toBe(401);
    expect((await call("/api/react", human, { message_id: reactionId, emoji: "❤️" })).status).toBe(200);
    expect(await status(reactionId)).toBe("allow");
    const history: any = await (await call("/api/messages", human)).json();
    expect(history.find((row: any) => row.id === reactionId)).toMatchObject({ source: "approval", approval_id: reactionId });
    const result = await askApproval({ baseUrl: base, token: "internal-test", pollMs: 1, timeoutMs: 5000,
      sleep: async () => {
        const rows = readFileSync(join(data, "approvals.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        const pending = rows.find(row => row.title === "Real client");
        expect(pending).toBeDefined();
        expect((await decide(pending.id, "allow")).status).toBe(200);
      },
    }, "Real client", "Actual askApproval request");
    expect(result.decision).toBe("allow");
    expect(await status(result.id!)).toBe("allow");
    // The agent learns the decision from the poll; a note in the inbox would read as the person speaking.
    const inbox = existsSync(join(data, "inbox.jsonl")) ? readFileSync(join(data, "inbox.jsonl"), "utf8") : "";
    expect(inbox).not.toContain("Approval granted");
  } finally {
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
