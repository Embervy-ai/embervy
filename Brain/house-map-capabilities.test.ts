import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { houseCapabilities, houseMapExtra, renderHouseMap } from "./house-map";

const homes: string[] = [];
function home() {
  const root = mkdtempSync(join(tmpdir(), "capabilities-map-"));
  homes.push(root);
  mkdirSync(join(root, "Brain"));
  return root;
}
afterEach(() => { for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("capabilities at Brain birth", () => {
  test("real API and pipe starts share one process snapshot across head changes", () => {
    const root = home();
    const file = join(root, "CAPABILITIES.md");
    const extra = join(root, "HOUSE.md");
    writeFileSync(file, "CAPABILITY-BIRTH-SNAPSHOT");
    writeFileSync(extra, "PERSONAL-MAP-SNAPSHOT");
    const script = `
      import { apiSystemPrompt, buildPipeSystemPrompt, makeInitialState } from ${JSON.stringify(join(import.meta.dir, "brain.ts"))};
      import { resolveHead } from ${JSON.stringify(join(import.meta.dir, "heads.ts"))};
      import { writeFileSync } from "node:fs";
      const state = makeInitialState([]);
      const prompts = [];
      for (const name of ["api", "claude", "gpt", "grok", "kimi", "glm"]) {
        const head = resolveHead(name, process.env);
        state.head = head;
        prompts.push(head.transport === "pipe" ? await buildPipeSystemPrompt(state, head, "test") : await apiSystemPrompt(state));
        writeFileSync(process.env.BRAIN_CAPABILITIES_FILE, "CHANGED-AFTER-BIRTH");
        writeFileSync(process.env.BRAIN_HOUSE_MAP_EXTRA_FILE, "CHANGED-PERSONAL-MAP");
      }
      console.log(JSON.stringify(prompts.map(prompt => ({
        capabilities: (prompt.match(/CAPABILITY-BIRTH-SNAPSHOT/g) || []).length,
        extra: prompt.includes("PERSONAL-MAP-SNAPSHOT"),
        changed: prompt.includes("CHANGED-AFTER-BIRTH") || prompt.includes("CHANGED-PERSONAL-MAP")
      }))));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, BRAIN_NO_ENV_FILE: "1", BRAIN_STERILE: "1",
        BRAIN_HOUSE_MAP: "on", BRAIN_WEB_BROWSER: "off", BRAIN_CAPABILITIES_FILE: file,
        BRAIN_HOUSE_MAP_EXTRA_FILE: extra, BRAIN_STATE_DIR: join(root, "state"), BRAIN_LOG_DIR: join(root, "logs"),
        BRAIN_GPT_CACHE_KEY: "test-house", BRAIN_ENDPOINT: "http://127.0.0.1:1",
        BRAIN_CLAUDE_SYSTEM_PROMPT_MODE: "append", BRAIN_KIMI_SYSTEM_PROMPT_MODE: "append",
        BRAIN_GLM_SYSTEM_PROMPT_MODE: "append" },
      stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString().trim())).toEqual(
      Array.from({ length: 6 }, () => ({ capabilities: 1, extra: true, changed: false })),
    );
  });

  test("the default path is the parent of Brain, independent of the working directory", () => {
    const root = home();
    writeFileSync(join(root, "CAPABILITIES.md"), "# What this house can do\n");
    expect(houseCapabilities(join(root, "Brain"))).toBe("# What this house can do\n");
  });

  test("an explicit path replaces the default", () => {
    const root = home();
    const file = join(root, "custom.md");
    writeFileSync(file, "Custom capabilities");
    expect(houseCapabilities(join(root, "Brain"), file)).toBe("Custom capabilities");
  });

  test("missing capabilities add nothing", () => {
    expect(houseCapabilities(join(home(), "Brain"))).toBeNull();
  });

  test("an unreadable destination adds one content-free notice", () => {
    const root = home();
    mkdirSync(join(root, "CAPABILITIES.md"));
    expect(houseCapabilities(join(root, "Brain"))).toBe("Capabilities unavailable: file unreadable.");
  });

  test("oversized capabilities add one short notice instead of content", () => {
    const root = home();
    writeFileSync(join(root, "CAPABILITIES.md"), "x".repeat(65537));
    expect(houseCapabilities(join(root, "Brain"))).toBe("Capabilities unavailable: file too large.");
  });

  test("every head sees capabilities after commands and retains its personal map", () => {
    const root = home();
    const extraFile = join(root, "HOUSE.md");
    writeFileSync(extraFile, "Personal map");
    for (const head of ["claude", "gpt", "grok", "kimi", "glm", "api"]) {
      const text = renderHouseMap({ root: join(root, "Brain"), stateDir: join(root, "state"),
        logDir: join(root, "logs"), head, model: "test-model", commands: ["/help"],
        capabilities: "# What this house can do\n- Pins: on", extra: houseMapExtra(extraFile, join(root, "state")) });
      expect(text.indexOf("# What this house can do")).toBeGreaterThan(text.indexOf("/help"));
      expect(text).toContain("Personal map");
      expect(text.match(/# What this house can do/g)).toHaveLength(1);
    }
  });
});
