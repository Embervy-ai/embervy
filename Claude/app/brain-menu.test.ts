import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";
import { parseEnv } from "../../shared/scripts/env-file";


test("the Claude Code menu reads bridge settings from the house env", async () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const start = source.indexOf("function readClaudeCodeEnv(");
  expect(start).toBeGreaterThan(-1);
  const helpers = source.slice(start, source.indexOf("async function requestClaudeCodeCut", start));
  const routeStart = source.indexOf('app.get("/api/brain/heads"');
  const route = source.slice(routeStart, source.indexOf('app.post("/api/brain/command"', routeStart));
  const home = mkdtempSync(join(tmpdir(), "menu-bridge-"));
  try {
    mkdirSync(join(home, "Claude/app"), { recursive: true });
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`${helpers}\n${route}`);
    const load = new Function("process", "houseHome", "existsSync", "join", "parseEnv", "readText", "app", "claudeCodeCutAvailable", "S", compiled);
    const cases = [
      { root: "", app: "", expected: { mode: "turns", count: 40 } },
      { root: "EMBERVY_BRIDGE_TURNS=7\n", app: "", expected: { mode: "turns", count: 7 } },
      { root: "EMBERVY_BRIDGE_MODE=sessions\n", app: "", expected: { mode: "sessions", count: 2 } },
      { root: "EMBERVY_BRIDGE_MODE=turns\n", app: "export EMBERVY_BRIDGE_MODE='sessions' # local\nEMBERVY_BRIDGE_SESSIONS=3\n", expected: { mode: "sessions", count: 3 } },
      { root: "EMBERVY_BRIDGE_MODE=sessions\n", app: "EMBERVY_BRIDGE_SESSIONS=0\n", expected: { mode: "sessions", count: 2 } },
      { root: "EMBERVY_BRIDGE_MODE=other\n", app: "EMBERVY_BRIDGE_TURNS=2junk\n", expected: { mode: "turns", count: 40 } },
    ];
    for (const item of cases) {
      writeFileSync(join(home, ".env"), item.root);
      writeFileSync(join(home, "Claude/app/.env"), item.app);
      let handler: Function = () => { throw new Error("route not registered"); };
      load({ env: {} }, () => home, () => true, join, parseEnv, (path: string) => readFileSync(path, "utf8"), { get: (_path: string, fn: Function) => { handler = fn; } }, () => true, (key: string) => key);
      const headers: Record<string, string> = {};
      const result = await handler({ header: (key: string, value: string) => { headers[key] = value; }, json: (value: unknown) => value });
      expect(result.restartOnly).toBe(true);
      expect(result.current.headLabel).toBe("brainMenu.claudeCode.title");
      expect(result.bridge).toEqual(item.expected);
      expect(headers["Cache-Control"]).toBe("no-store");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
import {
  BRAIN_RESTART_COMMAND, brainControlFrom, brainEffortCommand, brainHeadsError, brainMenuCommand,
  brainSwitchCommand, shapeBrainHeads, targetEffortLevels,
} from "./brain-menu";

const TOKEN = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

describe("brainControlFrom", () => {
  test("port, token and bridge depth, read the way Brain reads its env file", () => {
    expect(brainControlFrom(`X=1\nBRAIN_CONTROL_PORT=3911\nBRAIN_CONTROL_TOKEN=${TOKEN}\nBRAIN_BRIDGE_MODE=sessions\nBRAIN_BRIDGE_SESSIONS=4\n`))
      .toEqual({ port: 3911, token: TOKEN, bridge: { mode: "sessions", count: 4 } });
    expect(brainControlFrom(`  BRAIN_CONTROL_TOKEN = "${TOKEN}"  \r\nBRAIN_CONTROL_PORT='3912'\nBRAIN_BRIDGE_TURNS=25\n`))
      .toEqual({ port: 3912, token: TOKEN, bridge: { mode: "turns", count: 25 } });
  });
  test("port or depth missing or garbage → Brain's defaults (3910; turns 40; sessions 2)", () => {
    expect(brainControlFrom(`BRAIN_CONTROL_TOKEN=${TOKEN}\n`)).toEqual({ port: 3910, token: TOKEN, bridge: { mode: "turns", count: 40 } });
    expect(brainControlFrom(`BRAIN_CONTROL_TOKEN=${TOKEN}\nBRAIN_CONTROL_PORT=abc\nBRAIN_BRIDGE_TURNS=<bridge-turn-count>\n`))
      .toMatchObject({ port: 3910, bridge: { mode: "turns", count: 40 } });
    expect(brainControlFrom(`BRAIN_CONTROL_TOKEN=${TOKEN}\nBRAIN_CONTROL_PORT=70000\nBRAIN_BRIDGE_MODE=Sessions\nBRAIN_BRIDGE_SESSIONS=0\n`))
      .toMatchObject({ port: 3910, bridge: { mode: "sessions", count: 2 } });
  });
  test("no usable token → null (missing, placeholder, too short, commented out)", () => {
    expect(brainControlFrom("")).toBeNull();
    expect(brainControlFrom("BRAIN_CONTROL_TOKEN=\n")).toBeNull();
    expect(brainControlFrom("BRAIN_CONTROL_TOKEN=REPLACE_ME\n")).toBeNull();
    expect(brainControlFrom("BRAIN_CONTROL_TOKEN=<random-hex-32>\n")).toBeNull();
    expect(brainControlFrom("BRAIN_CONTROL_TOKEN=short\n")).toBeNull();
    expect(brainControlFrom(`# BRAIN_CONTROL_TOKEN=${TOKEN}\n`)).toBeNull();
  });
  test("the first non-empty value wins (brain.env before .env, as in Brain)", () => {
    expect(brainControlFrom(`BRAIN_CONTROL_TOKEN=\nBRAIN_CONTROL_TOKEN=${TOKEN}\nBRAIN_CONTROL_TOKEN=${"z".repeat(40)}\n`)?.token).toBe(TOKEN);
  });
});

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const RAW = {
  current: { head: "claude", model: "claude-opus-5-5[1m]", transport: "pipe", effort: "high", effortApplied: "high", effortVia: "cli", supportsEffort: true, effortLevels: LEVELS },
  claudeCatalog: true,
  heads: [
    { name: "claude", label: "Claude", model: "claude-opus-5-5[1m]", available: true, reason: null, models: [
      { id: "claude-opus-5-5[1m]", label: "Default (recommended)", group: "catalog", family: "Opus", version: "Opus 5.5 (1M)", description: "Opus 5.5 with 1M context · Best for everyday", resolvedModel: "claude-opus-5-5[1m]", aliases: ["default", "opus[1m]"], supportsEffort: true, supportedEffortLevels: LEVELS },
      { id: "claude-fable-5-1[1m]", label: "Fable", group: "catalog", family: "Fable", version: "Fable 5.1", resolvedModel: "claude-fable-5-1" },
      { id: "claude-sonnet-5", label: "Sonnet", group: "catalog", family: "Sonnet", version: "Sonnet 5", resolvedModel: "claude-sonnet-5" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku", group: "catalog", family: "Haiku", version: "Haiku 4.5", supportsEffort: false },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)", group: "more", family: "Opus", version: "Opus 4.8 (1M)" },
      { id: "claude-fable-5", label: "Fable 5", group: "more", family: "Fable", version: "Fable 5" },
      { id: "bad id; rm", label: "x", group: "more", family: "Opus", version: "x" },
    ] },
    { name: "gpt", label: "ChatGPT", model: "gpt-5.6-terra", available: true, reason: null, models: [
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra", group: "catalog", family: "Terra", version: "gpt-5.6-terra" },
    ] },
    { name: "grok", label: "Grok", model: "grok-4.7", available: false, reason: "XAI_API_KEY (or BRAIN_GROK_API_KEY) is not set", models: [
      { id: "grok-4.7", label: "grok-4.7", group: "catalog", family: "Other", version: "grok-4.7" },
    ] },
  ],
};

const CURRENT_CATALOG = {
  ...RAW,
  heads: [
    { ...RAW.heads[0]!, models: [
      { id: "claude-opus-5-5", label: "Default (recommended)", group: "catalog", family: "Opus", version: "Opus 5.5", resolvedModel: "claude-opus-5-5", aliases: ["default", "opus"] },
      { id: "claude-fable-5-2", label: "Fable", group: "catalog", family: "Fable", version: "Fable 5.2", resolvedModel: "claude-fable-5-2", aliases: ["fable"] },
    ] },
    ...RAW.heads.slice(1),
  ],
};

describe("window-aware model matching", () => {
  test("an unsuffixed catalog supplies the current model's name, family and note", () => {
    const menu = shapeBrainHeads(CURRENT_CATALOG)!;
    expect(menu.current).toMatchObject({ model: "claude-opus-5-5[1m]", modelLabel: "Opus 5.5", family: "Opus" });
    const marked = menu.heads.flatMap(h => h.families.flatMap(f => f.models)).filter(m => m.current);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ id: "claude-opus-5-5", version: "Opus 5.5", note: "Default (recommended)", kind: "current" });
    expect(menu.heads[0]!.families.filter(f => f.current).map(f => f.name)).toEqual(["Opus"]);
  });

  test.each(["id", "resolvedModel", "aliases"])("window fallback matches %s", field => {
    const entry = { id: "catalog-choice", family: "Opus", version: "Opus 5.5", [field]: field === "aliases" ? ["claude-opus-5-5"] : "claude-opus-5-5" };
    const menu = shapeBrainHeads({ ...CURRENT_CATALOG, heads: [{ name: "claude", models: [entry] }] })!;
    expect(menu.current.modelLabel).toBe("Opus 5.5");
    expect(menu.heads[0]!.families[0]!.models[0]!.current).toBe(true);
  });

  test.each(["id", "resolvedModel", "aliases"])("an exact %s match wins over a bare id", field => {
    const entry = { id: "exact-choice", family: "Exact", version: "Exact model", [field]: field === "aliases" ? [RAW.current.model] : RAW.current.model };
    const menu = shapeBrainHeads({ ...CURRENT_CATALOG, heads: [{ name: "claude", models: [...CURRENT_CATALOG.heads[0]!.models, entry] }] })!;
    expect(menu.current).toMatchObject({ modelLabel: "Exact model", family: "Exact" });
    expect(menu.heads[0]!.families.flatMap(f => f.models).filter(m => m.current).map(m => m.id)).toEqual([entry.id]);
  });

  test.each(["claude-opus-5-5", "claude-opus-5-5[1m]"])("matches rank id, resolved model, alias, then catalog order for %s", model => {
    const candidates = [
      { id: "alias-first", aliases: ["claude-opus-5-5"] },
      { id: "alias-second", aliases: ["claude-opus-5-5"] },
      { id: "resolved-first", resolvedModel: "claude-opus-5-5" },
      { id: "resolved-second", resolvedModel: "claude-opus-5-5" },
      { id: "claude-opus-5-5" },
    ];
    for (const [count, winner] of [[5, "claude-opus-5-5"], [4, "resolved-first"], [2, "alias-first"]] as const) {
      const menu = shapeBrainHeads({ current: { head: "claude", model }, heads: [{ name: "claude", models: candidates.slice(0, count) }] })!;
      expect(menu.heads[0]!.families.flatMap(f => f.models).filter(m => m.current).map(m => m.id)).toEqual([winner]);
    }
  });

  test("an unknown suffixed model leaves all entries unmarked", () => {
    const menu = shapeBrainHeads({ ...CURRENT_CATALOG, current: { ...RAW.current, model: "claude-custom-9[1m]" } })!;
    expect(menu.current).toMatchObject({ modelLabel: "claude-custom-9[1m]", family: null });
    expect(menu.heads.flatMap(h => h.families.flatMap(f => f.models)).some(m => m.current)).toBe(false);
  });

  test("an unsuffixed running model does not match a suffixed id by fallback", () => {
    const menu = shapeBrainHeads({ current: { head: "claude", model: "opus" }, heads: [{ name: "claude", models: [{ id: "opus[1m]" }] }] })!;
    expect(menu.heads[0]!.families[0]!.models[0]!.current).toBe(false);
  });
});

describe("window-aware model switches", () => {
  const menu = shapeBrainHeads(CURRENT_CATALOG)!;
  const body = { action: "switch", head: "claude", model: "claude-fable-5-2" };

  test("same-head switches preserve the running window from server context", () => {
    expect(brainMenuCommand(body, menu)?.cmd).toBe("/head claude claude-fable-5-2[1m]");
    expect(brainSwitchCommand("claude", body.model, false, undefined, menu)).toEqual({ head: "claude", model: "claude-fable-5-2[1m]", move: false, cmd: "/head claude claude-fable-5-2[1m]" });
    expect(brainMenuCommand({ ...body, model: "claude-fable-5-2[1m]" }, menu)?.cmd).toBe("/head claude claude-fable-5-2[1m]");
  });

  test("unsuffixed state, explicit catalog windows, other heads and moves stay unchanged", () => {
    const unsuffixed = shapeBrainHeads({ ...CURRENT_CATALOG, current: { ...RAW.current, model: "claude-opus-5-5" } })!;
    expect(brainMenuCommand(body, unsuffixed)?.cmd).toBe("/head claude claude-fable-5-2");
    expect(brainMenuCommand(body, shapeBrainHeads(RAW))?.cmd).toBe("/head claude claude-fable-5-2");
    expect(brainMenuCommand({ ...body, model: "claude-fable-5-1[1m]" }, shapeBrainHeads(RAW))?.cmd).toBe("/head claude claude-fable-5-1[1m]");
    expect(brainMenuCommand({ ...body, head: "gpt", model: "gpt-5.6-terra" }, menu)?.cmd).toBe("/head gpt gpt-5.6-terra");
    expect(brainMenuCommand({ ...body, move: true }, menu)?.cmd).toBe("/move claude claude-fable-5-2");
    expect(brainMenuCommand({ ...body, head: "gpt", model: "gpt-5.6-terra", move: true }, menu)?.cmd).toBe("/move gpt gpt-5.6-terra");
  });

  test("a suffix anywhere in the same catalog prevents implicit window selection", () => {
    const raw = structuredClone(CURRENT_CATALOG);
    raw.heads[0]!.models.push({ ...raw.heads[0]!.models[1]!, id: "older-model[1m]", group: "more" });
    expect(brainMenuCommand(body, shapeBrainHeads(raw))?.cmd).toBe("/head claude claude-fable-5-2");
    raw.heads[0]!.models.pop();
    raw.heads[1]!.models.push({ id: "other-model[1m]", label: "Other", group: "catalog", family: "Other", version: "Other" });
    expect(brainMenuCommand(body, shapeBrainHeads(raw))?.cmd).toBe("/head claude claude-fable-5-2[1m]");
  });

  test("request metadata cannot supply state and unsafe results are rejected", () => {
    expect(brainMenuCommand({ ...body, current: menu.current, heads: menu.heads, menu })?.cmd).toBe("/head claude claude-fable-5-2");
    for (const model of ["bad model", "x; /stop", "opus[1m][1m]", "x".repeat(81)]) {
      expect(brainMenuCommand({ ...body, model }, menu)).toBeNull();
    }
    expect(brainMenuCommand({ ...body, model: "x".repeat(80) }, menu)?.cmd).toBe(`/head claude ${"x".repeat(80)}[1m]`);
  });
});

describe("shapeBrainHeads", () => {
  const menu = shapeBrainHeads(RAW)!;

  test("status: head, model as its version, family, thinking level with the running model's levels", () => {
    expect(menu.current).toEqual({
      head: "claude", headLabel: "Claude", model: "claude-opus-5-5[1m]", modelLabel: "Opus 5.5 (1M)", family: "Opus",
      effort: "high", effortApplied: "high", effortVia: "cli", supportsEffort: true, effortLevels: LEVELS,
    });
    expect(menu.claudeCatalog).toBe(true);
  });

  test("drill-down: families in catalog order, catalog before more, ONE Opus 5.5, the mark on every level", () => {
    const claude = menu.heads.find((h) => h.name === "claude")!;
    expect(claude.current).toBe(true);
    expect(claude.families.map((f) => [f.name, f.current])).toEqual([["Opus", true], ["Fable", false], ["Sonnet", false], ["Haiku", false]]);
    const opus = claude.families[0]!;
    expect(opus.models.map((m) => [m.id, m.version, m.note, m.more, m.current, m.kind])).toEqual([
      ["claude-opus-5-5[1m]", "Opus 5.5 (1M)", "Default (recommended)", false, true, "current"],
      ["claude-opus-4-8[1m]", "Opus 4.8 (1M)", null, true, false, "model"],
    ]);
    expect(claude.families[1]!.models.map((m) => [m.version, m.note, m.more])).toEqual([["Fable 5.1", null, false], ["Fable 5", null, true]]);
  });

  test("marked also when Brain runs under an alias or the resolved model", () => {
    for (const model of ["default", "opus[1m]"]) {
      const m = shapeBrainHeads({ ...RAW, current: { ...RAW.current, model } })!;
      expect(m.current.modelLabel).toBe("Opus 5.5 (1M)");
      expect(m.heads[0]!.families[0]!.models[0]!.current).toBe(true);
    }
    const fable = shapeBrainHeads({ ...RAW, current: { ...RAW.current, model: "claude-fable-5-1" } })!;
    expect(fable.current.family).toBe("Fable");
  });

  test("thinking levels: only reported, clean ones, new ones included; none → supportsEffort false", () => {
    const ultra = shapeBrainHeads({ ...RAW, current: { ...RAW.current, effortLevels: ["low", "high", "ultracode", "Bad Level", 3, "high"] } })!;
    expect(ultra.current.effortLevels).toEqual(["low", "high", "ultracode"]);
    expect(ultra.current.supportsEffort).toBe(true);
    const haiku = shapeBrainHeads({ ...RAW, current: { ...RAW.current, model: "claude-haiku-4-5-20251001", supportsEffort: false, effortLevels: [] } })!;
    expect(haiku.current).toMatchObject({ supportsEffort: false, effortLevels: [], modelLabel: "Haiku 4.5" });
    expect(shapeBrainHeads({ ...RAW, current: { ...RAW.current, effortLevels: undefined } })!.current.supportsEffort).toBe(false);
  });

  test("unclean ids are dropped", () => {
    const ids = menu.heads.flatMap((h) => h.families.flatMap((f) => f.models.map((m) => m.id)));
    expect(ids).not.toContain("bad id; rm");
  });

  test("another head = a move, with the levels it can start with; not set up → its reason", () => {
    const gpt = menu.heads.find((h) => h.name === "gpt")!;
    expect(gpt.current).toBe(false);
    expect(gpt.families[0]!.models[0]!).toMatchObject({ kind: "head", effortLevels: ["low", "medium", "high", "xhigh"] });
    const grok = menu.heads.find((h) => h.name === "grok")!;
    expect(grok.available).toBe(false);
    expect(grok.reason).toContain("XAI_API_KEY");
    expect(menu.heads[0]!.families.flatMap((f) => f.models.map((m) => m.effortLevels))).toEqual([[], [], [], [], [], []]);
  });

  test("running model not in the list → its id as the label, no family", () => {
    const m = shapeBrainHeads({ ...RAW, current: { ...RAW.current, model: "claude-custom-9" } })!;
    expect(m.current.modelLabel).toBe("claude-custom-9");
    expect(m.current.family).toBeNull();
    expect(m.heads[0]!.families.some((f) => f.current)).toBe(false);
  });

  test("default thinking level = null; no family → Other (or the translated text the server passes)", () => {
    const raw = { current: { head: "kimi", model: "k" }, heads: [{ name: "kimi", label: "Kimi", available: true, models: [{ id: "k", label: "K" }] }] };
    const m = shapeBrainHeads(raw)!;
    expect(m.current.effort).toBeNull();
    expect(m.heads[0]!.families).toEqual([{ name: "Other", current: true, models: [{ id: "k", version: "K", note: null, more: false, current: true, kind: "current", effortLevels: [] }] }]);
    expect(shapeBrainHeads(raw, { otherFamily: "Autres" })!.heads[0]!.families[0]!.name).toBe("Autres");
  });

  test("an unavailable head without a reason gets the (translated) fallback", () => {
    const raw = { current: { head: "claude", model: "m" }, heads: [{ name: "claude", available: true, models: [] }, { name: "glm", available: false }] };
    expect(shapeBrainHeads(raw)!.heads[1]!.reason).toBe("not set up");
    expect(shapeBrainHeads(raw, { notSetUp: "pas configuré" })!.heads[1]!.reason).toBe("pas configuré");
  });

  test("optional timestamp metadata under an unknown name is ignored, as are other extra fields", () => {
    for (const metadata of [
      {},
      { catalogLastFetchedAt: "2026-01-02T03:04:05.000Z" },
      { lastFreshLookup: 1767323045000 },
      { futureCatalogMetadata: { fetchedAt: "2026-01-02T03:04:05.000Z" } },
      { catalogLastFetchedAt: null },
      { catalogLastFetchedAt: { unexpected: true } },
    ]) expect(shapeBrainHeads({ ...RAW, ...metadata })).toEqual(menu);
  });

  test("garbage → null", () => {
    expect(shapeBrainHeads(null)).toBeNull();
    expect(shapeBrainHeads("x")).toBeNull();
    expect(shapeBrainHeads({ heads: [] })).toBeNull();
    expect(shapeBrainHeads({ current: { head: "claude", model: "m" } })).toBeNull();
  });
});

describe("targetEffortLevels", () => {
  test("the catalog's own list first; a model without levels gets none", () => {
    expect(targetEffortLevels("claude", { supportedEffortLevels: ["low", "high", "ultracode", "Bad"] })).toEqual(["low", "high", "ultracode"]);
    expect(targetEffortLevels("claude", { supportsEffort: false, supportedEffortLevels: LEVELS })).toEqual([]);
  });
  test("otherwise what Brain accepts at a pipe start: Claude five, the GPT pipe four, an unknown head none", () => {
    expect(targetEffortLevels("claude", {})).toEqual(LEVELS);
    expect(targetEffortLevels("gpt", null)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(targetEffortLevels("grok", {})).toEqual([]);
  });
});

describe("commands from the menu", () => {
  test("another head = /move (the configured bridge depth: no bridge= override); a model of the same head stays live", () => {
    expect(brainSwitchCommand("claude", "claude-opus-4-8[1m]", true)).toEqual({ head: "claude", model: "claude-opus-4-8[1m]", move: true, cmd: "/move claude claude-opus-4-8[1m]" });
    expect(brainSwitchCommand("GPT", " gpt-5.6-terra ", true)?.cmd).toBe("/move gpt gpt-5.6-terra");
    expect(brainSwitchCommand("claude", "opus[1m]", false)).toEqual({ head: "claude", model: "opus[1m]", move: false, cmd: "/head claude opus[1m]" });
    expect(brainSwitchCommand("claude", "opus[1m]")?.cmd).toBe("/head claude opus[1m]");
    for (const [h, m] of [["claude", "x; /stop"], ["claude", "a b"], ["claude", "m;"], ["claude", ""], ["claude", "bridge=50"], ["../x", "m"], ["claude pipe", "m"], [1, "m"], ["claude", null]] as const) {
      expect(brainSwitchCommand(h, m, true)).toBeNull();
    }
  });

  test("the thinking level belongs to the target head: effort= only with a move, empty = the level last used there", () => {
    expect(brainSwitchCommand("claude", "claude-opus-5-5[1m]", true, "xhigh")?.cmd).toBe("/move claude claude-opus-5-5[1m] effort=xhigh");
    expect(brainSwitchCommand("gpt", "gpt-5.6-sol", true, "")?.cmd).toBe("/move gpt gpt-5.6-sol");
    expect(brainSwitchCommand("gpt", "gpt-5.6-sol", true, null)?.cmd).toBe("/move gpt gpt-5.6-sol");
    for (const bad of ["x; /stop", "High", "a b", "effort=max", 3, {}]) expect(brainSwitchCommand("claude", "opus[1m]", true, bad)).toBeNull();
    expect(brainSwitchCommand("claude", "opus[1m]", false, "high")).toBeNull();
  });

  test("the running head's thinking level", () => {
    expect(brainEffortCommand("high")).toBe("/effort high");
    expect(brainEffortCommand("default")).toBe("/effort default");
    expect(brainEffortCommand("ultracode")).toBe("/effort ultracode");
    for (const bad of ["", "High", "high; /stop", "a b", null, 3]) expect(brainEffortCommand(bad)).toBeNull();
  });

  test("POST body → exactly one command; restart is /respawn; nothing ever yields /stop", () => {
    expect(brainMenuCommand({ action: "switch", head: "gpt", model: "gpt-5.6-terra", move: true, effort: "high" }))
      .toEqual({ action: "switch", cmd: "/move gpt gpt-5.6-terra effort=high", move: true });
    expect(brainMenuCommand({ action: "switch", head: "claude", model: "claude-sonnet-5" })).toEqual({ action: "switch", cmd: "/head claude claude-sonnet-5", move: false });
    expect(brainMenuCommand({ action: "effort", level: "low" })).toEqual({ action: "effort", cmd: "/effort low" });
    expect(brainMenuCommand({ action: "restart" })).toEqual({ action: "restart", cmd: "/respawn" });
    expect(BRAIN_RESTART_COMMAND).toBe("/respawn");
    for (const bad of [null, "restart", {}, { action: "stop" }, { action: "exit" }, { action: "switch", head: "claude" }, { action: "effort" }, { action: "effort", level: "x y" }]) {
      expect(brainMenuCommand(bad)).toBeNull();
    }
    const commands = [
      brainMenuCommand({ action: "restart" }), brainMenuCommand({ action: "effort", level: "stop" }),
      brainMenuCommand({ action: "switch", head: "stop", model: "stop", move: true }),
    ].map((c) => c?.cmd ?? "");
    for (const cmd of commands) expect(cmd.startsWith("/stop")).toBe(false);
  });

  test("errors from Brain's control endpoint", () => {
    expect(brainHeadsError(404)).toBe("notReady");
    expect(brainHeadsError(401)).toBe("refused");
    expect(brainHeadsError(500)).toBe("status");
  });
});

import { brainDirFor } from "./brain-menu";
describe("brainDirFor", () => {
  const has = (paths: string[]) => (p: string) => paths.includes(p);
  test("the house home wins when Brain lives there (checkout below the home)", () => {
    expect(brainDirFor("/h/checkout/Claude/app", "/h", has(["/h/Brain/brain.env"]))).toBe("/h/Brain");
  });
  test("without a home, Brain sits beside the app as before", () => {
    expect(brainDirFor("/h/Claude/app", undefined, has([]))).toBe("/h/Brain");
  });
  test("a home without Brain does not pull the app away from a Brain beside it", () => {
    expect(brainDirFor("/x/Claude/app", "/h", has(["/x/Brain"]))).toBe("/x/Brain");
  });
  test("the standard layout gives the same folder either way", () => {
    expect(brainDirFor("/h/Claude/app", "/h", has([]))).toBe("/h/Brain");
  });
});

class MenuElement {
  children: MenuElement[] = [];
  listeners: Record<string, Function> = {};
  attrs: Record<string, string> = {};
  hidden = false;
  disabled = false;
  selected = false;
  textContent = "";
  value = "";
  className = "";
  classes = new Set<string>();
  classList = {
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  constructor(public tagName = "div") {}
  append(...nodes: MenuElement[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener(event: string, fn: Function) { this.listeners[event] = fn; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
}

function menuSurface(extraRequest?: string) {
  const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
  const html = readFileSync(join(import.meta.dir, "public/index.html"), "utf8");
  const ids = ["brain-menu-btn", "brain-menu-overlay", "brain-menu-body", "brain-menu-meta", "brain-menu-title", "brain-menu-close-btn", "brain-menu-refresh-btn"];
  const elements = Object.fromEntries(ids.map(id => {
    const node = new MenuElement();
    const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
    expect(tag).toBeDefined();
    node.hidden = /\shidden(?:\s|>)/.test(tag!);
    for (const match of tag!.matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(match[1]!, match[2]!);
    return [id, node];
  }));
  const requests: Array<{ path: string; init: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const start = source.indexOf("  // The Brain menu:");
  const end = source.indexOf("  const modelToggle", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const controls = new Function("document", "fetch", "t", `
    let claudeAuthEnabled = false;
    ${source.slice(start, end)}
    return { loadBrainMenu: (...args) => {
      const pending = loadBrainMenu(...args);
      ${extraRequest ? `fetch(${JSON.stringify(extraRequest)}, {}).catch(() => {});` : ""}
      return pending;
    }, selection: () => ({ ...bmSel }), data: () => brainMenuData };
  `)({
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (tag: string) => new MenuElement(tag),
    addEventListener() {},
  }, (path: string, init: RequestInit) => {
    // House menu sections may load their own routes. Only Brain requests belong
    // to this suite's exact count/order contract; resolve unrelated loads too.
    if (!path.startsWith("/api/brain/")) return Promise.resolve(Response.json(null));
    return new Promise<Response>((resolve, reject) => { requests.push({ path, init, resolve, reject }); });
  }, (key: string) => key);
  const body = elements["brain-menu-body"]!;
  const refresh = elements["brain-menu-refresh-btn"]!;
  const all = (node: MenuElement): MenuElement[] => [node, ...node.children.flatMap(all)];
  const change = (label: string, value: string) => {
    const select = all(body).find(node => node.tagName === "select" && node.attrs["aria-label"] === label)!;
    expect(select).toBeDefined();
    select.value = value;
    select.listeners.change!();
  };
  const fixture = () => {
    const raw = structuredClone(RAW);
    raw.heads[1]!.models.push(
      { id: "gpt-luna-old", label: "Luna old", group: "catalog", family: "Luna", version: "Luna old" },
      { id: "gpt-luna-latest", label: "Luna latest", group: "catalog", family: "Luna", version: "Luna latest" },
    );
    return shapeBrainHeads(raw)!;
  };
  const load = async (data: unknown = fixture()) => {
    const pending = controls.loadBrainMenu();
    requests.at(-1)!.resolve(Response.json(data));
    await pending;
  };
  const texts = () => all(body).map(node => node.textContent);
  return { controls, elements, refresh, requests, change, fixture, load, texts, all, body };
}

describe("Brain key setup surface", () => {
  const raw = (name = "kimi", available = false, setup: unknown = "key") => ({ ...RAW,
    heads: [...RAW.heads, { name, label: name, available, reason: "translated arbitrary reason", setup, models: [] }],
  });
  test("only the advertised, supported missing-key head has Set up; no string matching", async () => {
    const ui = menuSurface();
    for (const data of [raw(), raw("kimi", true), raw("kimi", false, null), raw("glm"), raw("constructor"), RAW,
      { restartOnly: true, current: { headLabel: "Claude Code" }, heads: [] }]) {
      await ui.load(shapeBrainHeads(data) || data);
      const expected = data.heads.some((h: any) => h.name === "kimi" && !h.available && h.setup === "key");
      expect(ui.texts().includes("brainMenu.key.setup")).toBe(expected);
      expect(ui.texts().some(text => /remove/i.test(text))).toBe(false);
      expect(ui.all(ui.body).filter(n => n.tagName === "section" && n.children[0]?.textContent === "kimi")).toHaveLength(expected ? 1 : 0);
    }
  });
  test("hidden setup never hides an available head from the Head selector", async () => {
    const ui = menuSurface();
    for (const available of [false, true]) {
      const source = raw("kimi", available, available ? null : "key");
      Object.assign(source.heads.at(-1)!, { setupHidden: true });
      await ui.load(shapeBrainHeads(source));
      expect(ui.texts()).not.toContain("brainMenu.key.setup");
      expect(ui.all(ui.body).filter(n => n.tagName === "section" && n.children[0]?.textContent === "kimi")).toHaveLength(0);
      const selector = ui.all(ui.body).find(n => n.tagName === "select" && n.attrs["aria-label"] === "brainMenu.head")!;
      const option = selector.children.find(n => n.value === "kimi")!;
      expect(option.disabled).toBe(!available);
      expect(option.textContent).toBe(available ? "kimi" : "brainMenu.unavailable");
      expect(option.textContent).not.toContain("brainMenu.key.setup");
    }
  });
  test("password form cancels cleanly, saves through its own route, and trusts the refreshed Brain list", async () => {
    const ui = menuSurface();
    const data = shapeBrainHeads(raw())!;
    await ui.load(data);
    const button = (text: string) => ui.all(ui.body).find(n => n.tagName === "button" && n.textContent === text)!;
    button("brainMenu.key.setup").listeners.click!();
    const input = ui.all(ui.body).find(n => n.tagName === "input")! as any;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    expect(input.className).toBe("bm-input");
    const save = button("brainMenu.key.save");
    const cancel = button("brainMenu.key.cancel");
    const row = ui.all(ui.body).find(n => n.children.includes(save))!;
    expect(row.children).toContain(cancel);
    expect(row.className.split(/\s+/)).toContain("approval-actions");
    expect(save.className.split(/\s+/)).toContain("bm-apply");
    expect(save.className.split(/\s+/)).toContain("approval-allow");
    expect(cancel.className.split(/\s+/)).not.toContain("approval-allow");
    // Bind the built row to the actual CSS: the secondary-only Brain rule
    // must not match Save, and the reused primary override must follow its base.
    const css = readFileSync(join(import.meta.dir, "public/style.css"), "utf8");
    expect(css).toMatch(/\.brain-menu-actions button\s*\{[^}]*background: var\(--bg\)/);
    expect(ui.all(ui.body).filter(n => n.className.split(/\s+/).includes("brain-menu-actions") && ui.all(n).includes(save))).toHaveLength(0);
    expect(css).toMatch(/\.approval-actions\s*\{[^}]*gap: 10px/);
    expect(css).toMatch(/\.approval-actions button\s*\{[^}]*background: transparent/);
    expect(css).toContain(".approval-actions .approval-allow { background: var(--accent); color: var(--on-accent); }");
    expect(css.indexOf(".approval-actions .approval-allow {")).toBeGreaterThan(css.indexOf(".approval-actions button {"));
    expect(ui.texts()).toContain("brainMenu.key.kimiSource");
    expect(ui.texts()).toContain("brainMenu.key.privacy");
    expect(ui.all(ui.body).some(n => n.tagName === "a")).toBe(false);
    input.value = "NOT-A-REAL-UI-KEY";
    button("brainMenu.key.cancel").listeners.click!();
    expect(input.value === "").toBe(true);
    expect(ui.all(ui.body).some(n => n.tagName === "input")).toBe(false);
    expect(ui.requests.length).toBe(1);
    button("brainMenu.key.setup").listeners.click!();
    const second = ui.all(ui.body).find(n => n.tagName === "input")!;
    second.value = "NOT-A-REAL-UI-KEY";
    const saving = button("brainMenu.key.save").listeners.click!();
    expect(second.value === "").toBe(true);
    const request = ui.requests.at(-1)!;
    expect(request.path).toBe("/api/brain/key-setup/kimi/save");
    expect(request.init.method).toBe("POST");
    expect(request.init.credentials).toBe("include");
    expect(JSON.parse(String(request.init.body)).key === "NOT-A-REAL-UI-KEY").toBe(true);
    request.resolve(Response.json({ ok: true, effective: "Effective on head switch" }));
    for (let i = 0; i < 20 && ui.requests.at(-1) === request; i++) await Bun.sleep(1);
    expect(ui.requests.at(-1)!.path).toBe("/api/brain/heads");
    // A stale or overridden Brain can still report unavailable. Never invent success.
    ui.requests.at(-1)!.resolve(Response.json(data));
    await saving;
    expect(ui.controls.data().heads.find((h: any) => h.name === "kimi").available).toBe(false);
    expect(ui.texts()).toContain("brainMenu.key.setup");
    expect(ui.texts().some(t => t.includes("NOT-A-REAL-UI-KEY"))).toBe(false);

    button("brainMenu.key.setup").listeners.click!();
    const finalInput = ui.all(ui.body).find(n => n.tagName === "input")!;
    finalInput.value = "NOT-A-REAL-UI-KEY";
    const saved = button("brainMenu.key.save").listeners.click!();
    const saveRequest = ui.requests.at(-1)!;
    saveRequest.resolve(Response.json({ ok: true, effective: "Effective on head switch" }));
    for (let i = 0; i < 20 && ui.requests.at(-1) === saveRequest; i++) await Bun.sleep(1);
    expect(ui.requests.at(-1)!.path).toBe("/api/brain/heads");
    ui.requests.at(-1)!.resolve(Response.json(shapeBrainHeads(raw("kimi", true, null))));
    await saved;
    expect(ui.texts()).not.toContain("brainMenu.key.setup");
    expect(ui.all(ui.body).filter(n => n.tagName === "section" && n.children[0]?.textContent === "kimi")).toHaveLength(0);
    const selector = ui.all(ui.body).find(n => n.tagName === "select" && n.attrs["aria-label"] === "brainMenu.head")!;
    expect(selector.children.find(n => n.value === "kimi")!.disabled).toBe(false);
    expect(finalInput.value === "").toBe(true);
    expect(ui.texts().some(t => /remove|NOT-A-REAL-UI-KEY/i.test(t))).toBe(false);
  });
});

describe("Brain menu refresh surface", () => {
  test("house loads are allowed but an extra Brain request still breaks the exact contract", async () => {
    const expected = ["/api/brain/heads"];
    const house = menuSurface("/api/claude-limits");
    await house.load();
    expect(house.requests.map(r => r.path)).toEqual(expected);
    const mutant = menuSurface("/api/brain/unexpected");
    const pending = mutant.controls.loadBrainMenu();
    mutant.requests[0]!.resolve(Response.json(mutant.fixture()));
    mutant.requests[1]!.resolve(Response.json(null));
    await pending;
    expect(() => expect(mutant.requests.map(r => r.path)).toEqual(expected)).toThrow();
    expect(mutant.requests.map(r => r.path)).toEqual([...expected, "/api/brain/unexpected"]);
  });

  test("a named header button spins and is locked until the fresh list arrives, retaining head and family", async () => {
    const ui = menuSurface();
    expect(ui.refresh.hidden).toBe(true);
    expect(ui.refresh.attrs["aria-label"]).toBe("Refresh model lists");
    expect(ui.refresh.attrs["data-i18n-aria-label"]).toBe("brainMenu.refresh");
    const html = readFileSync(join(import.meta.dir, "public/index.html"), "utf8");
    expect(html).toMatch(/class="brain-menu-header-actions">\s*<button id="brain-menu-refresh-btn"[^>]*><span aria-hidden="true">↻<\/span><\/button>\s*<button id="brain-menu-close-btn"/);
    await ui.load();
    expect(ui.requests[0]!.path).toBe("/api/brain/heads");
    expect(ui.refresh.hidden).toBe(false);
    expect(ui.refresh.disabled).toBe(false);
    ui.change("brainMenu.head", "gpt");
    ui.change("brainMenu.family", "Luna");
    ui.change("brainMenu.version", "gpt-luna-latest");
    const before = ui.controls.selection();
    const oldData = ui.controls.data();
    const pending = ui.refresh.listeners.click!();
    expect(ui.refresh.disabled).toBe(true);
    expect(ui.refresh.classes.has("refreshing")).toBe(true);
    expect(ui.refresh.attrs["aria-busy"]).toBe("true");
    expect(ui.controls.data()).toBe(oldData);
    expect(ui.requests.at(-1)!.path).toBe("/api/brain/heads?refresh=1");
    expect(ui.requests.at(-1)!.init).toMatchObject({ credentials: "include", cache: "no-store" });
    await ui.refresh.listeners.click!();
    expect(ui.requests).toHaveLength(2);
    const fresh = ui.fixture();
    fresh.heads[1]!.families[1]!.models.push({ id: "gpt-luna-new", version: "Luna new", note: null, more: false, current: false, kind: "head", effortLevels: [] });
    ui.requests.at(-1)!.resolve(Response.json({ ...fresh, unknownCatalogTimestamp: "2026-01-02T03:04:05.000Z" }));
    await pending;
    expect(ui.refresh.disabled).toBe(false);
    expect(ui.refresh.classes.has("refreshing")).toBe(false);
    expect(ui.refresh.attrs["aria-busy"]).toBe("false");
    expect(ui.controls.selection()).toEqual(before);
    expect(ui.texts()).toContain("Luna new");
    expect(ui.texts()).not.toContain("2026-01-02T03:04:05.000Z");
    expect(ui.texts()).not.toContain("brainMenu.refreshFailed");
  });

  test("a removed model does not reset an existing head and family; missing families and heads fall back safely", async () => {
    const ui = menuSurface();
    await ui.load();
    ui.change("brainMenu.head", "gpt");
    ui.change("brainMenu.family", "Luna");
    ui.change("brainMenu.version", "gpt-luna-latest");
    let fresh = ui.fixture();
    fresh.heads[1]!.families[1]!.models = fresh.heads[1]!.families[1]!.models.filter(m => m.id !== "gpt-luna-latest");
    let pending = ui.refresh.listeners.click!();
    ui.requests.at(-1)!.resolve(Response.json(fresh));
    await pending;
    expect(ui.controls.selection()).toMatchObject({ head: "gpt", family: "Luna", model: "gpt-luna-old" });
    fresh = ui.fixture();
    fresh.heads[1]!.families = [fresh.heads[1]!.families[0]!];
    pending = ui.refresh.listeners.click!();
    ui.requests.at(-1)!.resolve(Response.json(fresh));
    await pending;
    expect(ui.controls.selection()).toMatchObject({ head: "gpt", family: "Terra", model: "gpt-5.6-terra" });
    fresh.heads = fresh.heads.filter(h => h.name !== "gpt");
    pending = ui.refresh.listeners.click!();
    ui.requests.at(-1)!.resolve(Response.json(fresh));
    await pending;
    expect(ui.controls.selection()).toMatchObject({ head: "claude", family: "Opus" });
  });

  test("HTTP, network and unreadable replies leave the old list and selection with a short error, and retry recovers", async () => {
    const ui = menuSurface();
    await ui.load();
    ui.change("brainMenu.head", "gpt");
    ui.change("brainMenu.family", "Luna");
    const oldData = ui.controls.data();
    const selection = ui.controls.selection();
    for (const failure of [Response.json({ error: "private upstream details" }, { status: 502 }), new Error("offline"), new Response("not JSON"), Response.json({ current: {} })]) {
      const pending = ui.refresh.listeners.click!();
      expect(ui.texts()).not.toContain("brainMenu.refreshFailed");
      const request = ui.requests.at(-1)!;
      if (failure instanceof Error) request.reject(failure);
      else request.resolve(failure);
      await pending;
      expect(ui.controls.data()).toBe(oldData);
      expect(ui.controls.selection()).toEqual(selection);
      expect(ui.texts()).toContain("Luna latest");
      expect(ui.texts()).toContain("brainMenu.refreshFailed");
      expect(ui.texts()).not.toContain("private upstream details");
      expect(ui.all(ui.body).find(node => node.textContent === "brainMenu.refreshFailed")!.attrs.role).toBe("status");
      expect(ui.refresh.disabled).toBe(false);
      expect(ui.refresh.classes.has("refreshing")).toBe(false);
    }
    const retry = ui.refresh.listeners.click!();
    ui.requests.at(-1)!.resolve(Response.json(ui.fixture()));
    await retry;
    expect(ui.texts()).not.toContain("brainMenu.refreshFailed");
    expect(ui.controls.selection()).toEqual(selection);
  });

  test("selection changes during refresh survive and a stale response cannot replace a newer list", async () => {
    const ui = menuSurface();
    await ui.load();
    const refresh = ui.refresh.listeners.click!();
    ui.change("brainMenu.head", "gpt");
    ui.change("brainMenu.family", "Luna");
    const selected = ui.controls.selection();
    ui.requests.at(-1)!.resolve(Response.json(ui.fixture()));
    await refresh;
    expect(ui.controls.selection()).toEqual(selected);

    const stale = ui.refresh.listeners.click!();
    const staleRequest = ui.requests.at(-1)!;
    const latest = ui.controls.loadBrainMenu({ keepSelection: true });
    const latestRequest = ui.requests.at(-1)!;
    staleRequest.resolve(Response.json({ restartOnly: true, current: { headLabel: "Claude Code" }, heads: [] }));
    await stale;
    expect(ui.refresh.disabled).toBe(true);
    latestRequest.resolve(Response.json(ui.fixture()));
    await latest;
    expect(ui.refresh.hidden).toBe(false);
    expect(ui.refresh.disabled).toBe(false);
    expect(ui.controls.selection()).toEqual(selected);
  });

  test("Claude Code and non-Brain houses never expose or request model refresh", async () => {
    const ui = menuSurface();
    await ui.load({ restartOnly: true, current: { headLabel: "Claude Code", modelLabel: "" }, heads: [], bridge: { mode: "turns", count: 40 } });
    expect(ui.refresh.hidden).toBe(true);
    await ui.refresh.listeners.click!();
    expect(ui.requests).toHaveLength(1);
    const pending = ui.controls.loadBrainMenu();
    ui.requests.at(-1)!.resolve(Response.json({ error: "not brain" }, { status: 404 }));
    await pending;
    expect(ui.elements["brain-menu-btn"]!.hidden).toBe(true);
    expect(ui.refresh.hidden).toBe(true);
    await ui.refresh.listeners.click!();
    expect(ui.requests).toHaveLength(2);
  });

  test("the client parses and changed static assets share raised versions", () => {
    expect(() => new Function(readFileSync(join(import.meta.dir, "public/app.js"), "utf8"))).not.toThrow();
    const index = readFileSync(join(import.meta.dir, "public/index.html"), "utf8");
    const settings = readFileSync(join(import.meta.dir, "public/settings.html"), "utf8");
    const worker = readFileSync(join(import.meta.dir, "public/sw.js"), "utf8");
    const style = readAssetUrl(index, "style.css");
    const script = readAssetUrl(index, "app.js");
    expect(readAssetStamp(index, "style.css")).toBeGreaterThan(120);
    expect(readAssetStamp(index, "app.js")).toBeGreaterThan(137);
    expect(readAssetUrl(settings, "style.css")).toBe(style);
    expect(readAssetUrl(worker, "style.css")).toBe(style);
    expect(readAssetUrl(worker, "app.js")).toBe(script);
    expect(readCacheNumber(worker)).toBeGreaterThan(54);
    const css = readFileSync(join(import.meta.dir, "public/style.css"), "utf8");
    expect(css).toContain("#brain-menu-refresh-btn.refreshing span { animation: brain-menu-spin");
    expect(css).toContain("@keyframes brain-menu-spin");
  });
});
