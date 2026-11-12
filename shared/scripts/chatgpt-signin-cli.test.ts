import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["success", "wrong-state", "expired", "exchange-error", "probe-error", "existing-file"]) {
  test(`ChatGPT command ${scenario} keeps credentials private`, async () => {
    const { runChatGptSignInCli } = await import("./chatgpt-signin-cli");
    const dir = mkdtempSync(join(tmpdir(), "chatgpt-command-"));
    const auth = join(dir, "auth.json"), output: string[] = [];
    const savedFetch = globalThis.fetch;
    let requests = 0, clock = Date.now(), pasted = "";
    const secret = "private-access-token", code = "private-authorization-code";
    const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "private-account" } })).toString("base64url");
    const idToken = `header.${claims}.signature`;
    if (scenario === "existing-file") writeFileSync(auth, "existing-private-credentials", { mode: 0o600 });
    globalThis.fetch = (async (_url: any, init: any) => {
      requests++;
      if (requests === 1) {
        expect(String(init.body)).toContain(code);
        if (["exchange-error", "existing-file"].includes(scenario)) return new Response(secret, { status: 400 });
        return Response.json({ access_token: secret, refresh_token: "private-refresh-token", id_token: idToken });
      }
      expect(JSON.parse(init.body).model).toBe("gpt-5.6-terra");
      return scenario === "probe-error" ? new Response(secret, { status: 403 }) : new Response('data: {"type":"response.completed"}\n\n');
    }) as typeof fetch;
    try {
      const status = await runChatGptSignInCli(["--auth-file", auth, "--route", "codex"], {
        print: (line: string) => output.push(line), now: () => clock,
        readLine: async () => {
          const state = new URL(output[0]).searchParams.get("state");
          if (scenario === "expired") clock += 11 * 60_000;
          pasted = `http://127.0.0.1:1455/auth/callback?code=${code}&state=${scenario === "wrong-state" ? "wrong" : state}`;
          return pasted;
        },
      });
      expect(status).toBe(scenario === "success" ? 0 : 1);
      expect(output[1]).toBe("After signing in, your browser shows an address starting with http://127.0.0.1:1455/ that may not load. Copy the whole address and paste it here:");
      for (const value of [secret, code, pasted, idToken, "private-refresh-token"]) expect(output.join("\n")).not.toContain(value);
      if (scenario === "success") {
        expect(statSync(auth).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(auth, "utf8")).tokens.access_token).toBe(secret);
        expect(output.at(-1)).toBe("Signed in. ChatGPT answers (gpt-5.6-terra).");
        expect(readdirSync(dir)).toEqual(["auth.json"]);
        expect(requests).toBe(2);
      } else {
        if (scenario === "existing-file") expect(readFileSync(auth, "utf8")).toBe("existing-private-credentials");
        else { expect(existsSync(auth)).toBe(false); expect(readdirSync(dir)).toEqual([]); }
        expect(output.at(-1)).toMatch(/^Error: /);
        if (scenario === "wrong-state") { expect(output.at(-1)).toContain("state mismatch"); expect(requests).toBe(0); }
        if (scenario === "expired") { expect(output.at(-1)).toContain("expired"); expect(requests).toBe(0); }
      }
    } finally { globalThis.fetch = savedFetch; rmSync(dir, { recursive: true, force: true }); }
  });
}

test("official sign-in failure leaves no host metadata or credential file", async () => {
  const { runChatGptSignInCli } = await import("./chatgpt-signin-cli");
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-official-command-"));
  const output: string[] = [];
  try {
    expect(await runChatGptSignInCli(["--auth-file", join(dir, "auth.json"), "--route", "official"], {
      print: line => output.push(line), readLine: async () => "http://127.0.0.1:1455/auth/callback?code=private-code&state=wrong",
    })).toBe(1);
    expect(new URL(output[0]).pathname).toBe("/api/accounts/authorize");
    expect(output.at(-1)).toContain("state mismatch");
    expect(output.join("\n")).not.toContain("private-code");
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runnable command reads a single callback line without printing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chatgpt-stdin-"));
  try {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "chatgpt-signin-cli.ts"), "--auth-file", join(dir, "auth.json"), "--route", "codex"], {
      stdin: new Blob(["http://127.0.0.1:1455/auth/callback?code=private-code&state=wrong\n"]), stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: dir },
    });
    const output = await new Response(run.stdout).text();
    expect(await run.exited).toBe(1);
    expect(output).toContain("state mismatch");
    expect(output).not.toContain("private-code");
    expect(await new Response(run.stderr).text()).toBe("");
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ChatGPT command rejects missing paths and unsupported flags before sign-in", async () => {
  const { runChatGptSignInCli } = await import("./chatgpt-signin-cli");
  for (const args of [[], ["--auth-file"], ["--auth-file", "/unused", "--route", "other"], ["--auth-file", "/unused", "--model", "bad\nmodel"], ["--other", "value"]]) {
    const output: string[] = [];
    expect(await runChatGptSignInCli(args, { print: (line: string) => output.push(line), readLine: async () => { throw new Error("must not read"); } })).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("Usage:");
  }
});
