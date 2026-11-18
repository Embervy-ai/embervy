import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudePipe, type PipeOptions } from "./claude-pipe";
import { changedPipeProfile, headEnvironment, readPipeProfile } from "./brain";
import { resolveHead } from "./heads";

const key = "CLAUDE_CODE_SILENT_TURN_REMINDER";
const saved = new Map<string, string | undefined>();
const dirs: string[] = [];
function env(name: string, value?: string) {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "silent-turn-reminder-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Observe the real child environment, not a second implementation of the defaults.
async function capture(options: Partial<PipeOptions> = {}) {
  const dir = directory(), binary = join(dir, "claude"), output = join(dir, "env.json");
  writeFileSync(binary, `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", () => {
  out({type:"system",subtype:"init",session_id:"silent-turn-fixture",model:"fixture"});
  out({type:"assistant",message:{id:"m1",model:"fixture",content:[{type:"text",text:"ok"}]}});
  out({type:"result",subtype:"success",is_error:false,result:"ok",usage:{input_tokens:1,output_tokens:1}});
});
`);
  chmodSync(binary, 0o755);
  const pipe = new ClaudePipe({ model: "fixture", systemPrompt: "fixture", settingsPath: "{}",
    settingSources: "", cwd: dir, binary, ...options });
  try {
    await pipe.start();
    expect((await pipe.send("say ok")).finalContent).toBe("ok");
    return JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
  } finally { await pipe.stop(1000); }
}

for (const value of [undefined, "", "1", "0", "house-value"]) {
  test(`pipe birth snapshot preserves reminder ${JSON.stringify(value)}`, async () => {
    const birthEnv = { [key]: value, HOUSE_MARKER: "unchanged" };
    const result = await capture({ birthEnv });
    expect(result[key]).toBe(value ?? "0");
    expect(result.HOUSE_MARKER).toBe("unchanged");
    expect(result.DISABLE_AUTO_COMPACT).toBe("1");
    expect(result.DISABLE_AUTOCOMPACT).toBe("1");
    expect(result.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
    expect(result.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE).toBe("950000");
    expect(result.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe("1");
    expect(birthEnv[key]).toBe(value);
  });
  test(`pipe inherited environment preserves reminder ${JSON.stringify(value)}`, async () => {
    env(key, value);
    expect((await capture())[key]).toBe(value ?? "0");
    expect(process.env[key]).toBe(value); // No default leaks to API heads or other subprocesses.
  });
}

for (const value of ["", "1", "0"]) {
  test(`brain.env reminder ${JSON.stringify(value)} reaches the pipe profile and child`, async () => {
    env(key);
    env("BRAIN_NO_ENV_FILE", "0");
    env("BRAIN_ENV_FILE", join(directory(), "brain.env"));
    env("BRAIN_EXTRA_ENV_FILE");
    env("BRAIN_IMPORT_ENV_FILE");
    writeFileSync(process.env.BRAIN_ENV_FILE!, `${key}="${value}"\n`);
    const profile = readPipeProfile(headEnvironment());
    expect(profile.env[key]).toBe(value);
    expect((await capture({ birthEnv: profile.env }))[key]).toBe(value);
    expect(process.env[key]).toBeUndefined();
  });
}

for (const value of ["", "1"]) {
  test(`inherited reminder ${JSON.stringify(value)} wins over brain.env`, () => {
    env(key, value);
    env("BRAIN_NO_ENV_FILE", "0");
    env("BRAIN_ENV_FILE", join(directory(), "brain.env"));
    env("BRAIN_EXTRA_ENV_FILE");
    env("BRAIN_IMPORT_ENV_FILE");
    writeFileSync(process.env.BRAIN_ENV_FILE!, `${key}=0\n`);
    expect(headEnvironment()[key]).toBe(value);
  });
}

test("reload distinguishes an empty reminder from the unset default", () => {
  const unset = readPipeProfile({});
  for (const value of ["", "1"]) {
    const explicit = readPipeProfile({ [key]: value });
    expect(changedPipeProfile(unset, explicit)).toEqual([key]);
    expect(changedPipeProfile(explicit, unset)).toEqual([key]);
  }
  expect(changedPipeProfile(unset, readPipeProfile({ [key]: "0" }))).toEqual([]);
});

test("API head resolution does not acquire a Claude-only default", () => {
  for (const name of ["api", "gpt", "grok"]) {
    const head = resolveHead(name, { BRAIN_GPT_CACHE_KEY: "fixture", XAI_API_KEY: "fixture" });
    expect(head.transport).toBe("api");
    expect(head.pipeEnv).not.toHaveProperty(key);
  }
});
