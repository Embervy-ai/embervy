#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { writePrivateJson, writePrivateText } from "./credential-store";
import { chatgptAuthJson, chatgptRoute, DEFAULT_CHATGPT_MODEL, exchangeChatGptCode, REDIRECT_URI, probeChatGpt, startChatGptSignIn } from "./chatgpt-signin";

interface SignInIO {
  print?: (line: string) => void;
  readLine?: () => Promise<string>;
  now?: () => number;
}

function readPrivateLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    // A terminal readline uses raw input; discard its echo so callback secrets never reach stdout.
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const reader = createInterface({ input: process.stdin, output: silent, terminal: !!process.stdin.isTTY });
    reader.once("line", line => { resolve(line); reader.close(); });
    reader.once("SIGINT", () => { reject(new Error("cancelled")); reader.close(); });
    reader.once("close", () => { reject(new Error("input closed")); silent.end(); });
    reader.once("error", () => { reject(new Error("input failed")); reader.close(); });
  });
}

export async function runChatGptSignInCli(args: string[], io: SignInIO = {}): Promise<number> {
  const print = io.print ?? console.log;
  const now = io.now ?? Date.now;
  const usage = "Usage: bun shared/scripts/chatgpt-signin-cli.ts --auth-file <path> [--route codex|official] [--model <slug>]";
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--auth-file", "--route", "--model"].includes(key) || !value || value.startsWith("--") || options[key]) {
      print(`Error: ${usage}`); return 1;
    }
    options[key] = value;
  }
  const route = options["--route"] ?? chatgptRoute();
  const model = options["--model"] ?? DEFAULT_CHATGPT_MODEL;
  if (!options["--auth-file"] || /[\x00-\x1f]/.test(options["--auth-file"]) || !["codex", "official"].includes(route) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) {
    print(`Error: ${usage}`); return 1;
  }
  const authFile = resolve(options["--auth-file"]);
  let error = "Could not start ChatGPT sign-in. Check the authentication file and try again.";
  try {
    let hostId: string | undefined, newHost = false;
    if (route === "official") {
      try { hostId = JSON.parse(readFileSync(`${authFile}.host.json`, "utf8")).ext_agent_host_id; }
      catch (cause: any) { if (cause.code !== "ENOENT") throw cause; newHost = true; hostId = `urn:uuid:${crypto.randomUUID()}`; }
      if (!hostId) throw new Error("invalid host ID");
    }
    // Delay new host metadata and credentials until the model probe has succeeded.
    const attempt = await startChatGptSignIn({ route, authFile, hostId });
    const expiresAt = Math.min(attempt.expiresAt ?? Infinity, now() + 10 * 60_000);
    print(attempt.signInUrl);
    print("After signing in, your browser shows an address starting with http://127.0.0.1:1455/ that may not load. Copy the whole address and paste it here:");
    error = "No callback address received. Start sign-in again and paste the whole browser address.";
    const pasted = await (io.readLine ?? readPrivateLine)();
    error = "ChatGPT sign-in expired. Start again and use the newest link.";
    if (now() >= expiresAt) throw new Error("expired");
    error = "Invalid callback address. Paste the whole address starting with http://127.0.0.1:1455/.";
    const callback = new URL(pasted.trim()), redirect = new URL(REDIRECT_URI);
    if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname) throw new Error("invalid callback");
    error = "ChatGPT callback state mismatch. Start again and use the newest link.";
    if (callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== attempt.state) throw new Error("state mismatch");
    error = "ChatGPT authorization was not completed. Start again and paste the new callback address.";
    if (callback.searchParams.has("error") || callback.searchParams.getAll("code").length !== 1 || !callback.searchParams.get("code")) throw new Error("invalid code");
    error = "ChatGPT could not exchange the sign-in code; it may have expired or already been used. Start again and use the newest link.";
    const tokens = await exchangeChatGptCode(pasted, attempt);
    error = `ChatGPT could not answer with ${model}. Check your subscription, model access and connection, then sign in again.`;
    const probe = await probeChatGpt(tokens, model);
    if (!probe.ok) throw new Error("probe failed");
    error = "Could not save the ChatGPT credentials privately. Check the destination directory permissions.";
    if (newHost) await writePrivateJson(`${authFile}.host.json`, { ext_agent_host_id: hostId });
    await writePrivateText(authFile, chatgptAuthJson(tokens));
    print(`Signed in. ChatGPT answers (${model}).`);
    return 0;
  } catch {
    // Provider and filesystem errors can contain secrets; print only the local phase description.
    print(`Error: ${error}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runChatGptSignInCli(process.argv.slice(2));
