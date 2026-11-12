// Which model answers.
// One table of heads over two transports: "pipe" runs an unmodified `claude -p`
// (Claude itself or an Anthropic-compatible engine), "api" runs Brain's own OpenAI-compatible loop.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { accountSeamFromEnv } from "./account";

export function claudeLoginAvailable(env: Record<string, string | undefined>): boolean {
  const home = env.HOME?.trim() || homedir();
  const state = env.BRAIN_STATE_DIR || join(import.meta.dir, "state");
  const vars = accountSeamFromEnv(env, state, home).pipeEnv();
  const effective = { ...env, ...vars.set };
  for (const key of vars.unset) delete effective[key];
  return existsSync(join(effective.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), ".credentials.json"));
}

export type Transport = "pipe" | "api";
export type SystemPromptMode = "append" | "replace";

export function systemPromptMode(head: Pick<HeadSpec, "name" | "transport">, env: Record<string, string | undefined>): SystemPromptMode {
  const mode = env[`BRAIN_${head.name.toUpperCase()}_SYSTEM_PROMPT_MODE`]?.trim().toLowerCase();
  if (mode === "replace" || mode === "append") return mode;
  return head.transport === "pipe" ? "replace" : "append";
}

export interface HeadSpec {
  name: string;
  transport: Transport;
  endpoint: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  pipeEnv: Record<string, string>;
  unavailable: string | null;
  effort?: string | null;
}

type Env = Record<string, string | undefined>;

export const HEAD_NAMES = ["claude", "gpt", "grok", "kimi", "glm", "api"] as const;
export type HeadName = typeof HEAD_NAMES[number];

function pick(env: Env, ...keys: string[]): string {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

export function gptAdapterPort(env: Env): string {
  const port = pick(env, "GPT_ADAPTER_PORT", "BRAIN_GPT_ADAPTER_PORT") || "3041";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("invalid GPT adapter port");
  return String(Number(port));
}

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Cache lifetimes differ by provider, so a house may set the interval per head; unset, every head keeps one default.
export function cachePingMinutes(head: Pick<HeadSpec, "name">, env: Env): number {
  return num(env, `BRAIN_CACHE_PING_MINUTES_${head.name.toUpperCase()}`,
    num(env, "BRAIN_CACHE_PING_MINUTES", 50));
}

export function engineEnv(baseUrl: string, token: string, contextWindow: number): Record<string, string> {
  // The caller must unset ANTHROPIC_API_KEY; an empty value is not equivalent.
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
  };
}

// The Claude head uses only the subscription; engine heads use an auth token.
// Neither may inherit an API key because mixed credentials cause HTTP 401.
export function pipeUnsetEnv(head: HeadSpec): string[] {
  if (head.transport !== "pipe") return [];
  if (head.pipeEnv.ANTHROPIC_BASE_URL) return ["ANTHROPIC_API_KEY"];
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
}

import { tr } from "./texts";

export function resolveHead(nameRaw: string, env: Env, transportOverride?: Transport): HeadSpec {
  const name = (nameRaw || "api").trim().toLowerCase();
  switch (name) {
    case "claude": {
      const model = pick(env, "BRAIN_CLAUDE_MODEL", "BRAIN_MODEL_CLAUDE") || "claude-opus-5-5[1m]";
      return {
        name, transport: "pipe", endpoint: "", apiKey: "", model,
        contextWindow: num(env, "BRAIN_CLAUDE_CONTEXT", 1_000_000),
        pipeEnv: {}, unavailable: env.BRAIN_CLAUDE_LOGIN_CHECK === "1" && !claudeLoginAvailable(env)
          ? tr("Claude is not logged in on this server") : null,
      };
    }
    case "gpt": {
      const model = pick(env, "BRAIN_GPT_MODEL", "EMBERVY_GPT_MODEL") || "gpt-5.6-terra";
      const window = num(env, "BRAIN_GPT_CONTEXT", num(env, "EMBERVY_GPT_CONTEXT", 1_000_000));
      let port: string;
      try { port = gptAdapterPort(env); }
      catch { return { name, model, contextWindow: window, transport: transportOverride ?? "api", endpoint: "", apiKey: "", pipeEnv: {}, unavailable: "invalid GPT adapter port (GPT_ADAPTER_PORT / BRAIN_GPT_ADAPTER_PORT)" }; }
      const unavailable = validAdapterCacheKey(env.BRAIN_GPT_CACHE_KEY) ? null : tr("BRAIN_GPT_CACHE_KEY is missing or invalid (set a resident-unique key; ASCII A-Z a-z 0-9 . _ -, 1–128 characters)");
      const transport = transportOverride ?? ((pick(env, "BRAIN_GPT_TRANSPORT") as Transport) || "api");
      if (transport === "pipe") {
        const base = `http://127.0.0.1:${port}`;
        return {
          name, transport, endpoint: base, apiKey: "subscription-via-adapter", model, contextWindow: window,
          pipeEnv: { ...engineEnv(base, "subscription-via-adapter", window), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) },
          unavailable,
        };
      }
      return {
        name, transport: "api", endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
        // The adapter ignores the key, so a placeholder suffices.
        apiKey: "subscription-via-adapter", model, contextWindow: window, pipeEnv: {}, unavailable,
      };
    }
    case "grok": {
      const key = pick(env, "BRAIN_GROK_API_KEY", "XAI_API_KEY");
      const model = pick(env, "BRAIN_GROK_MODEL") || "grok-4.7";
      return {
        name, transport: "api",
        endpoint: pick(env, "BRAIN_GROK_ENDPOINT") || "https://api.x.ai/v1/chat/completions",
        apiKey: key, model, contextWindow: num(env, "BRAIN_GROK_CONTEXT", 500_000), pipeEnv: {},
        unavailable: key ? null : "XAI_API_KEY (or BRAIN_GROK_API_KEY) is not set",
      };
    }
    case "kimi": {
      const key = pick(env, "BRAIN_KIMI_API_KEY", "KIMI_CODE_KEY");
      const base = pick(env, "BRAIN_KIMI_BASE", "EMBERVY_KIMI_BASE") || "https://api.kimi.com/coding";
      const model = pick(env, "BRAIN_KIMI_MODEL", "EMBERVY_KIMI_MODEL") || "kimi-for-coding";
      const window = num(env, "BRAIN_KIMI_CONTEXT", model === "kimi-for-coding" ? 1_048_576 : 262_144);
      return {
        name, transport: "pipe", endpoint: base, apiKey: key, model, contextWindow: window,
        pipeEnv: { ...engineEnv(base, key, window), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) },
        unavailable: key ? null : "KIMI_CODE_KEY (or BRAIN_KIMI_API_KEY) is not set",
      };
    }
    case "glm": {
      const key = pick(env, "BRAIN_GLM_API_KEY", "GLM_CODE_KEY", "ZAI_MCP_KEY");
      const base = pick(env, "BRAIN_GLM_BASE") || "https://api.z.ai/api/anthropic";
      const model = pick(env, "BRAIN_GLM_MODEL", "EMBERVY_GLM_MODEL") || "glm-5.2[1m]";
      const window = num(env, "BRAIN_GLM_CONTEXT", 1_000_000);
      return {
        name, transport: "pipe", endpoint: base, apiKey: key, model, contextWindow: window,
        pipeEnv: engineEnv(base, key, window),
        unavailable: key ? null : "GLM_CODE_KEY (or BRAIN_GLM_API_KEY, ZAI_MCP_KEY) is not set",
      };
    }
    case "api":
    default: {
      const endpoint = pick(env, "BRAIN_ENDPOINT");
      return {
        name: name === "api" ? "api" : name, transport: "api", endpoint,
        apiKey: pick(env, "BRAIN_API_KEY"), model: pick(env, "BRAIN_MODEL") || "worker-model",
        contextWindow: num(env, "BRAIN_CONTEXT_WINDOW", 1_000_000), pipeEnv: {},
        unavailable: name !== "api" ? `unknown head '${name}' (known: ${HEAD_NAMES.join(", ")})`
          : endpoint ? null : "BRAIN_ENDPOINT is not set",
      };
    }
  }
}

// Kimi's default window depends on the model; engine and watchdog windows must agree.
export function resolveHeadChoice(name: string, env: Env, choice: { model?: string; contextWindow?: number; transport?: Transport } = {}): HeadSpec {
  const selected = { ...env };
  const prefix = name === "api" ? "BRAIN" : `BRAIN_${name.toUpperCase()}`;
  if (choice.model !== undefined) selected[`${prefix}_MODEL`] = choice.model;
  if (choice.contextWindow !== undefined) selected[name === "api" ? "BRAIN_CONTEXT_WINDOW" : `${prefix}_CONTEXT`] = String(choice.contextWindow);
  const head = resolveHead(name, selected, choice.transport);
  if (choice.contextWindow !== undefined && head.transport === "pipe") {
    head.pipeEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(head.contextWindow);
  }
  return head;
}

export const validAdapterCacheKey = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9._-]{1,128}$/.exec(key)?.[0] === key;

// Dated delivery snapshots may match for display, but health checks still require the exact startup model.
export function gptServedModelMatches(ordered: string, served: string | undefined): boolean {
  const o = ordered.trim().toLowerCase(), s = (served ?? "").trim().toLowerCase();
  return Boolean(o && s) && (o === s || s.replace(/-(?:\d{4}-\d{2}-(?:\d{2}|xx)|\d{8})$/, "") === o);
}

// Cuts below capacity limit the subscription cost of each subsequent message.
export const HEAD_WATCHDOG_DEFAULTS: Readonly<Record<string, Readonly<{ warn: number; cut: number }>>> = {
  gpt: { warn: 200_000, cut: 220_000 },
  claude: { warn: 800_000, cut: 900_000 },
};

// Reserve capacity so a misconfigured cut cannot exhaust the model window.
export const WATCHDOG_CUT_CEILING = 0.95;

export interface WatchdogThresholds {
  warn: number;
  cut: number;
  clamped?: { configuredCut: number; ceiling: number; window: number };
}

const positiveTokens = (raw: string): number | undefined =>
  raw && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined;

export function watchdogThresholds(head: HeadSpec, env: Env): WatchdogThresholds {
  const prefix = `BRAIN_${head.name.toUpperCase()}_WATCHDOG`;
  const configuredWarn = positiveTokens(pick(env, `${prefix}_WARN`, "BRAIN_WATCHDOG_WARN"));
  const configuredCut = positiveTokens(pick(env, `${prefix}_CUT`, "BRAIN_WATCHDOG_CUT"));
  const ceiling = Math.floor(head.contextWindow * WATCHDOG_CUT_CEILING);
  const candidate = Object.hasOwn(HEAD_WATCHDOG_DEFAULTS, head.name) ? HEAD_WATCHDOG_DEFAULTS[head.name] : undefined;
  const preset = candidate && candidate.cut <= ceiling ? candidate : undefined;
  let cut = configuredCut ?? preset?.cut ?? Math.floor(head.contextWindow * 0.9);
  let clamped: WatchdogThresholds["clamped"];
  if (cut > ceiling) {
    clamped = { configuredCut: cut, ceiling, window: head.contextWindow };
    cut = ceiling;
  }
  const warn = configuredWarn ?? Math.floor(Math.min(preset?.warn ?? head.contextWindow * 0.8, cut * 0.95));
  return { warn: Math.min(warn, cut), cut, ...(clamped ? { clamped } : {}) };
}


export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,19}$/;
const isStandardEffort = (level: string) => (EFFORT_LEVELS as readonly string[]).includes(level);

export function parseEffort(raw: unknown, extra: readonly string[] = []): string | "default" | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "default" || value === "auto" || value === "reset" || value === "none") return "default";
  if (isStandardEffort(value)) return value as EffortLevel;
  return EFFORT_NAME.test(value) && extra.includes(value) ? value : null;
}

// Catalog-only effort levels require a direct Claude connection and catalog support;
// engine endpoints and CLIs without that level reject them at startup.
export function birthEffort(head: HeadSpec, level: string | null | undefined, catalogLevels: readonly string[] = []): string | null {
  if (!level || headEffortSupport(head).via !== "cli") return null;
  if (isStandardEffort(level)) return level;
  return !head.pipeEnv.ANTHROPIC_BASE_URL && catalogLevels.includes(level) ? level : null;
}

// Validate effort against the destination model, not the running model.
// GPT pipe effort is an adapter startup setting, not a live CLI setting.
export function validateTargetEffort(head: HeadSpec, raw: string, model?: { supportsEffort?: boolean; supportedEffortLevels?: string[] }): { ok: true; level: string | null } | { ok: false; error: string } {
  const effective = head.name === "gpt" && head.transport === "pipe" ? { ...head, transport: "api" as const } : head;
  const support = effortLevelsFor(effective, model);
  const parsed = parseEffort(raw, support.levels);
  if (parsed === "default") return { ok: true, level: null };
  if (parsed && support.levels.includes(parsed) && head.transport === "api" && !requestEffort(head, parsed)) {
    return { ok: false, error: tr`effort=${raw}: target head ${head.name} (${head.model}) reports this level, but the request transport does not support it yet` };
  }
  if (parsed && support.levels.includes(parsed) && head.transport === "pipe" && head.name !== "gpt" && !birthEffort(head, parsed, support.levels)) {
    return { ok: false, error: tr`effort=${raw}: target head ${head.name} (${head.model}) reports this level, but the pipe cannot start with it yet` };
  }
  if (!parsed || !support.supported || !support.levels.includes(parsed)) return { ok: false, error: tr`effort=${raw}: target head ${head.name} (${head.model}) allows ${support.levels.join("|") || tr("no effort level")}|default` };
  return { ok: true, level: parsed };
}

export function effortLevelsFor(head: HeadSpec, model?: { supportsEffort?: boolean; supportedEffortLevels?: string[] }): { supported: boolean; levels: string[] } {
  const via = headEffortSupport(head).via;
  if (via === "none") return { supported: false, levels: [] };
  if (model?.supportsEffort === false) return { supported: false, levels: [] };
  const listed = (model?.supportedEffortLevels ?? []).filter((l) => EFFORT_NAME.test(l));
  return { supported: true, levels: listed.length ? listed : via === "request" ? EFFORT_LEVELS.filter((l) => l !== "max") : [...EFFORT_LEVELS] };
}

export interface EffortSupport {
  via: "cli" | "request" | "none";
  note: string;
}

export function headEffortSupport(head: HeadSpec): EffortSupport {
  if (head.transport === "pipe") {
    if (!head.pipeEnv.ANTHROPIC_BASE_URL) {
      return { via: "cli", note: "live via the CLI control protocol, no restart; Opus 5.5/Fable 5.1 keep the cache, other models recompute it once; models without effort (Haiku) ignore it" };
    }
    if (head.name === "gpt") {
      return { via: "none", note: "GPT pipe effort is an adapter start setting (ADAPTER_EFFORT), not a live CLI setting — /head gpt <model> pipe effort=<level> starts/verifies that adapter profile" };
    }
    if (head.name === "kimi") {
      return { via: "cli", note: "the CLI sends it as output_config.effort; Kimi Code maps low→low, medium/high→high, xhigh/max→max on K3 and K2.8 (no levels documented for the K2.7 code model)" };
    }
    if (head.name === "glm") {
      return { via: "cli", note: "the CLI sends it as output_config.effort; z.ai documents reasoning_effort only for its OpenAI endpoint — whether the Anthropic endpoint honours it is unverified" };
    }
    return { via: "cli", note: "the CLI sends it as output_config.effort to the engine endpoint; its effect there is unverified" };
  }
  if (head.name === "gpt") return { via: "request", note: "reasoning_effort in every request (adapter → reasoning.effort); max is sent as xhigh" };
  if (head.name === "grok") return { via: "request", note: "reasoning_effort in every request (grok-4.5+: low/medium/high/xhigh, default high); max is sent as xhigh" };
  return { via: "none", note: "no effort control on a generic OpenAI-compatible endpoint" };
}

export function requestEffort(head: HeadSpec, level: string | null | undefined): string | undefined {
  if (!level || headEffortSupport(head).via !== "request") return undefined;
  // A claude-catalog-only level (e.g. "ultracode") is no reasoning_effort value.
  if (!isStandardEffort(level)) return undefined;
  return level === "max" ? "xhigh" : level;
}

export function parseHeadCommand(argument: string): { name: string; model?: string; transport?: Transport; effort?: string; error?: string } | null {
  const parts = argument.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const [name, ...rest] = parts;
  let transport: Transport | undefined;
  let model: string | undefined, effort: string | undefined;
  for (const part of rest) {
    if (part.startsWith("effort=")) {
      if (effort !== undefined || !/^[a-z][a-z0-9_-]{0,19}$/.test(part.slice(7))) return { name: name.toLowerCase(), error: tr("effort=X: specify a valid effort level once") };
      effort = part.slice(7);
    } else if (part === "pipe" || part === "api") transport = part;
    else if (part.includes("=") || model !== undefined) return { name: name.toLowerCase(), error: tr("invalid or extra /head argument") };
    else model = part;
  }
  return { name: name.toLowerCase(), model, transport, ...(effort !== undefined ? { effort } : {}) };
}

const HEAD_LABELS: Record<string, string> = {
  claude: "Claude", gpt: "ChatGPT", grok: "Grok", kimi: "Kimi", glm: "GLM", api: "Own endpoint",
};

export type ModelGroup = "catalog" | "more";

export interface HeadModel {
  id: string;
  label: string;
  group: ModelGroup;
  family: string;
  version: string;
  description?: string;
  resolvedModel?: string;
  aliases?: string[];
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export interface ProbedModel {
  id: string;
  label: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export function modelMatches(m: Pick<HeadModel, "id" | "aliases" | "resolvedModel">, model: string): boolean {
  return m.id === model || m.resolvedModel === model || Boolean(m.aliases?.includes(model));
}

export function catalogModel<T extends { id: string; aliases?: string[]; resolvedModel?: string }>(catalog: T[] | null | undefined, model: string): T | undefined {
  return catalog?.find((m) => modelMatches(m, model));
}

// Preserve the [1m] suffix because it selects the context window.
export function switchIdOf(m: Pick<ProbedModel, "id" | "resolvedModel">): string {
  const resolved = m.resolvedModel?.trim();
  if (!resolved) return m.id;
  const bare = resolved.replace(/\[.*$/, "");
  return m.id === resolved || m.id.startsWith(bare) ? m.id : resolved;
}

const MODEL_FAMILIES = ["opus", "fable", "sonnet", "haiku", "astra", "sol", "terra", "luna"];
export const OTHER_FAMILY = "Other";

// Whole words only, so "sol" never matches inside another word.
export function familyOf(id: string, label?: string, description?: string): string {
  for (const text of [id, description, label]) {
    const words = String(text ?? "").toLowerCase().split(/[^a-z0-9]+/);
    const hit = words.find((word) => MODEL_FAMILIES.includes(word));
    if (hit) return hit[0].toUpperCase() + hit.slice(1);
  }
  return tr(OTHER_FAMILY);
}

export function versionOf(label: string, description?: string): string {
  const head = String(description ?? "").split("·")[0].trim();
  if (head && /\d/.test(head) && head.length <= 60) {
    return head.replace(/\s+with\s+(\d+(?:\.\d+)?)\s*([km])\s+context$/i, (_, n: string, unit: string) => ` (${n}${unit.toUpperCase()})`);
  }
  return label;
}

const versionKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export interface HeadChoice {
  name: string;
  label: string;
  model: string;
  models: HeadModel[];
  available: boolean;
  reason: string | null;
}

export function parseModelList(raw: string | undefined): Array<{ id: string; label: string }> {
  if (!raw || !raw.trim()) return [];
  return raw.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const eq = part.indexOf("=");
    const id = (eq >= 0 ? part.slice(0, eq) : part).trim();
    const label = (eq >= 0 ? part.slice(eq + 1) : part).trim() || id;
    return { id, label };
  }).filter((m) => m.id);
}

export function headChoices(
  env: Env,
  probed: Partial<Record<string, ProbedModel[]>> = {},
  current?: { name: string; model: string },
): HeadChoice[] {
  return HEAD_NAMES.filter((name) => name !== "api" || Boolean(env.BRAIN_ENDPOINT)).map((name) => {
    const head = resolveHead(name, env);
    const asked = probed[name] ?? [];
    const configured = parseModelList(env[`BRAIN_${name.toUpperCase()}_MODELS`]);
    const keep = current?.name === name ? current.model : undefined;
    // A catalog that reports effort at all: a model without the field takes none.
    const catalogKnowsEffort = asked.some((m) => typeof m.supportsEffort === "boolean");
    const models: HeadModel[] = [];
    const seen = new Set<string>();
    const catalogVersions = new Set<string>();
    const add = (m: ProbedModel, group: ModelGroup) => {
      if (!m.id) return;
      const id = group === "catalog" ? switchIdOf(m) : m.id;
      const resolved = m.resolvedModel?.trim() || undefined;
      const same = models.find((x) => x.id === id);
      if (same) {
        if (group === "catalog" && m.id !== id && !same.aliases?.includes(m.id)) same.aliases = [...(same.aliases ?? []), m.id];
        return;
      }
      if (seen.has(m.id) || seen.has(id)) return;
      const label = m.label || m.id;
      const version = versionOf(label, m.description);
      if (group === "more" && catalogVersions.has(versionKey(version)) && m.id !== keep) return;
      for (const key of [m.id, id, resolved]) if (key) seen.add(key);
      if (group === "catalog") catalogVersions.add(versionKey(version));
      const supportsEffort = catalogKnowsEffort && group === "catalog" ? m.supportsEffort === true : undefined;
      const levels = supportsEffort ? (m.supportedEffortLevels ?? []).filter((l) => typeof l === "string" && l) : undefined;
      models.push({
        id, label, group, family: familyOf(id, label, m.description), version,
        ...(m.description ? { description: m.description } : {}),
        ...(resolved ? { resolvedModel: resolved } : {}),
        ...(m.id !== id ? { aliases: [m.id] } : {}),
        ...(supportsEffort !== undefined ? { supportsEffort } : {}),
        ...(levels?.length ? { supportedEffortLevels: levels } : {}),
      });
    };
    for (const m of asked) add(m, "catalog");
    for (const m of configured) add(m, asked.length ? "more" : "catalog");
    if (!models.length) add({ id: head.model, label: head.model }, "catalog");
    return { name, label: HEAD_LABELS[name] ?? name, model: head.model, models, available: !head.unavailable, reason: head.unavailable };
  });
}

export function headChoicesText(choices: HeadChoice[], current: { name: string; model: string }): string {
  const lines = ["heads (switch: /head <name> [model-id]):"];
  for (const c of choices) {
    const mark = c.name === current.name ? "●" : c.available ? "○" : "✗";
    const show = (list: HeadModel[]) => list.map((m) => `${m.label}${c.name === current.name && modelMatches(m, current.model) ? " (active)" : ""} [${m.id}]`).join(", ");
    const catalog = c.models.filter((m) => m.group !== "more");
    const more = c.models.filter((m) => m.group === "more");
    lines.push(`${mark} ${c.name} — ${c.label}${c.available ? `: ${show(catalog)}` : ` — not available: ${c.reason}`}`);
    if (c.available && more.length) lines.push(`    more: ${show(more)}`);
    if (c.name === current.name && !c.models.some((m) => modelMatches(m, current.model))) lines.push(`    active model: ${current.model}`);
  }
  return lines.join("\n");
}
