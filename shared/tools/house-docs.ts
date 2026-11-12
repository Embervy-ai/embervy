#!/usr/bin/env bun
// Builds installation documents from public configuration without copying credentials.
import { chmodSync, closeSync, constants, existsSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { parseEnv } from "../scripts/env-file";
import { roomConfigsFromEnv } from "../../Claude/app/room-door";
import { peerConfigsFromEnv } from "../../Claude/app/peer-door";
import { webConfigFromEnv, webToolPlan } from "../../Brain/web-tools";
import { resolveHeadChoice } from "../../Brain/heads";
import { validateHeadState } from "../../Brain/move";
import HANDBOOK_TEMPLATE from "./house-docs/HANDBOOK.md" with { type: "text" };
import { HOME_DIR, VAR_DIR } from "../scripts/legacy-names";

export type Harness = "brain" | "claude-code";
export type IdentityRule = "own" | "together";
export interface HandbookVars {
  IDENTITY_RULE?: IdentityRule;
  HOME: string;
  SERVER: string;
  USER?: string;
  HEAD?: string;
  MEMORY_TOOLS: string;
  WARN: string;
  CUT: string;
  BRIDGE_TURNS: string;
  COMPACTION: string;
  REPLY_TOOL: string;
  DOCTOR: string;
  OWN_MAP: string;
  TMUX: string;
  APP_UNIT: string;
  APP_PORT?: string;
  GPT_PORT?: string;
  BROWSER_PORT?: string;
  TMUX_SOCKET?: string;
  BRAIN_ADAPTER_PORT?: string;
  BRAIN_CONTROL_PORT?: string;
  BROWSER?: boolean;
  MEMORY_SCHEDULED?: boolean;
  DREAM_SCHEDULED?: boolean;
  LOGS?: string;
  CALENDAR_FEED?: boolean;
  RESCUE_ACCESS?: boolean;
  CLOUDFLARE_SIGNIN?: boolean;
  CLOUDFLARE_HOUSE_KEY?: boolean;
  CLOUDFLARE_CLIENT_ID?: string;
}
export const HANDBOOK_TEMPLATE_TEXT: string = HANDBOOK_TEMPLATE;
export const tokenCount = (n: number | string): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function scheduleGuide(home: string, worker: "memory" | "dream", scheduled?: boolean): string {
  const subject = worker === "memory" ? "The memory daemon" : "The dream worker";
  const file = `${home}/shared/memory/${worker === "dream" ? "dream-worker/" : ""}wrangler.toml`;
  if (scheduled === undefined) return `${subject} runs on ${worker === "memory" ? "the memory worker's" : "its own"} schedule, which may be empty; check the worker's configuration.`;
  if (!scheduled) return `${subject} has no scheduled runs in the local worker configuration at \`${file}\` (\`crons = []\`); manual invocation is separate.`;
  return `${subject} follows the non-empty cron schedule in the local worker configuration at \`${file}\`; check its cron entries for timing.`;
}

export function renderHandbook(vars: HandbookVars, harness: Harness, template = HANDBOOK_TEMPLATE): string {
  if (harness !== "brain" && harness !== "claude-code") throw new Error("HANDBOOK.md: unknown harness");
  // The shared template also serves installer callers. Qualify its new-house
  // default, and gate sign-in prose on evidence supplied by this particular house.
  template = template.replace("Approval cards start at **important**:",
    "For a new house, approval cards default to **important**. The current level is in the app's **Approvals** settings; `CAPABILITIES.md` records whether cards are enabled. At **important**:");
  if (vars.CLOUDFLARE_HOUSE_KEY && !vars.CLOUDFLARE_SIGNIN) {
    // A key the installer created: say so, and leave out the sign-in's own revocation steps.
    template = template.replace("If the house sign-in was approved, you have your own Cloudflare OAuth access, limited to Workers scripts, D1, Vectorize and R2; wrangler stores and refreshes it for root.",
      "The installer created a Cloudflare key for this house (current validity not checked), limited to Workers scripts, D1, Vectorize and R2.")
      .replace(/To revoke the house sign-in,[\s\S]*?does not revoke server-side access\. /, "");
  } else if (!vars.CLOUDFLARE_SIGNIN) {
    template = template.replace(/^\*\*Cloudflare access\.\*\*[\s\S]*?(?=^You need \{\{USER\}\}'s okay for:)/m, "")
      .replace("deploying your workers with that access", "deploying workers, if access is configured")
      .replace("permissions this sign-in does not have", "permissions the available credentials do not have");
  } else {
    template = template.replace("If the house sign-in was approved, you have your own Cloudflare OAuth access, limited to",
      "The stored house sign-in configures Cloudflare OAuth access (current validity not checked), limited to")
      .replace("9e5b2d9f4c01440f097ab0d8c758a064", vars.CLOUDFLARE_CLIENT_ID || "9e5b2d9f4c01440f097ab0d8c758a064");
  }
  template = template.replace(/<!-- identity:(own|together) -->([\s\S]*?)<!-- \/identity -->/g,
    (_m, rule: string, inner: string) => rule === (vars.IDENTITY_RULE || "own") ? inner : "");
  let out = template.replace(/<!-- harness:(claude-code|brain) -->\n?([\s\S]*?)<!-- \/harness -->\n?/g,
    (_m, h: string, inner: string) => h === harness ? inner : "");
  out = out.replace(/<!-- named -->([\s\S]*?)<!-- \/named -->/g, (_m, inner: string) => vars.USER ? inner : "");
  out = out.replace(/<!-- browser -->([\s\S]*?)<!-- \/browser -->/g, (_m, inner: string) => vars.BROWSER ? inner : "");
  out = out.replace(/<!-- adapter -->([\s\S]*?)<!-- \/adapter -->/g, (_m, inner: string) =>
    (harness === "brain" ? vars.BRAIN_ADAPTER_PORT : vars.GPT_PORT) ? inner : "");
  const values: Record<string, string | boolean | undefined> = {
    APP_PORT: "3030", GPT_PORT: "3041", BRAIN_ADAPTER_PORT: "3042", BRAIN_CONTROL_PORT: "3910",
    BROWSER_PORT: "3055", TMUX_SOCKET: harness === "brain" ? "brain" : "embervy", ...vars,
    LOGS: vars.LOGS || `${vars.HOME}/${harness === "brain" ? "Brain/logs" : "logs"}`,
    MEMORY_SCHEDULE_GUIDE: scheduleGuide(vars.HOME, "memory", vars.MEMORY_SCHEDULED),
    DREAM_SCHEDULE_GUIDE: scheduleGuide(vars.HOME, "dream", vars.DREAM_SCHEDULED),
    CALENDAR_GUIDE: vars.CALENDAR_FEED === true
      ? "The phone feed is enabled and its token is set. Use the calendar tool's `feed` action to give your user the private subscription link; they add it as a subscribed calendar in their phone's calendar app. Never put that link in this document."
      : vars.CALENDAR_FEED === false
        ? "The phone feed is not configured for use. Enable `EMBERVY_HOOK_CALENDAR=1` in the house and app environment, create a `CALENDAR_FEED_TOKEN` with the feed-token tool, and restart the app with permission before subscribing."
        : "The phone feed requires `EMBERVY_HOOK_CALENDAR=1` and `CALENDAR_FEED_TOKEN` in the app environment; when enabled, the calendar tool's `feed` action supplies the private subscription link.",
  };
  out = out.replace(/\{\{([A-Z_]+)\}\}/g, (_whole, key: string, offset: number, all: string) => {
    if (key === "USER") return vars.USER || (/(?:^|\n|[.!?]\s+)$/.test(all.slice(0, offset)) ? "Your user" : "your user");
    if (values[key] === undefined) throw new Error(`HANDBOOK.md: no value for {{${key}}}`);
    return String(values[key]);
  });
  const left = out.match(/\{\{|<!--[\s\S]*?-->/);
  if (left) throw new Error(`HANDBOOK.md: leftover marker or placeholder ${left[0]}`);
  const access = vars.RESCUE_ACCESS ? `

## Emergency access — save this once.

The \`embervy-rescue\` line in \`/root/.ssh/authorized_keys\` is your user's emergency access. Never remove an \`embervy-rescue\` line on your own. If your user asks you to remove it, first say plainly: "This is your only way in when the app is down. Do you have another way in?" Wait for their answer before changing it.
` : "\n";
  if (!vars.RESCUE_ACCESS) out = out.replace(/^## 7\./m, "If the app is down, your user gets in through their own SSH access.\n\n## 7.");
  return out.replace(/\n{3,}/g, "\n\n").trimEnd() + access;
}

export interface HouseFacts {
  identityRule?: IdentityRule;
  invalidIdentityRule?: boolean;
  home: string;
  harness: Harness;
  server: string;
  tunnel?: { id: string; name?: string };
  calendarFeed?: boolean;
  user?: string;
  head: string;
  model: string;
  tmux: { session: string; socket: string };
  ports: { app: number; adapter?: number; browser?: number; control?: number };
  capabilities?: Capability[];
  envFiles?: string[];
  credentials?: Record<string, boolean>;
  rooms?: Record<string, boolean>;
  rescueAccess?: boolean;
  cloudflareSignIn?: boolean;
  cloudflareHouseKey?: boolean;
  cloudflareClientId?: string;
  units: { role: string; name: string; active: string; enabled: string }[];
  workers: { memory?: string; rag?: string; app?: string };
  schedules?: { memory?: boolean; dream?: boolean };
  paths: { identity: string; state: string; logs: string; bridge: string; archives: string; notes: string; inbox: string; ownMap: string };
  watchdog: { warn: number; cut: number };
  bridgeTurns: number;
  compaction: "on" | "off";
  approval: string;
  inlet: string;
  enrichment: boolean;
  hooks: { calendar: boolean; weather: boolean; browser: boolean; cachePing: boolean; reminders: boolean; mail?: boolean };
  settingSources?: string;
  operation?: { effort?: string; inletLog?: string; calendar?: string; externalCalendar?: string; firstTurn?: string; startupDoctor: boolean; brainDoctor: boolean };
  overflow?: { reserve?: string; present?: boolean };
  installer?: {
    provider?: string;
    ssh?: { keyPath: string; host: string; user?: string };
    statePath?: string;
    resources?: { kind: string; name: string; id: string }[];
    backup?: string;
  };
}

export interface Capability {
  name: string;
  description: string;
  enabled: boolean;
  switch: string;
  runtime?: Harness;
}
export const CAPABILITIES_HEADER = "# What this house can do\n\nThis list shows what this house can do and where each ability is switched on or off. You can read and change the code and the settings; changes to the approval settings ask your person first. When you add, change or switch off an ability, update this list.";

export interface CapabilityConfig {
  harness: Harness;
  env: Record<string, string>;
  brain?: Record<string, string>;
  hookEnv?: Record<string, string>;
  headState?: unknown;
  approvalLevel?: string;
  weatherFeature?: boolean;
  settingsFiles?: string[];
  headFile?: string;
  approvalFile?: string;
}

// Only configuration gates are described; this is not a service health probe.
export function capabilityFacts(config: CapabilityConfig): Capability[] {
  const { harness, env, brain: brain = {}, hookEnv = env } = config;
  const b = harness === "brain";
  const entries: Capability[] = [];
  const inFiles = (keys: string, candidates: string[]) => {
    if (config.settingsFiles === undefined) return `${keys} (house settings; file presence not checked)`;
    const files = candidates.filter(file => config.settingsFiles!.includes(file));
    return files.length ? `${keys} in ${files.join(" / ")}` : `${keys} (no settings file present)`;
  };
  const app = (keys: string) => inFiles(keys, [".env", "Claude/app/.env"]);
  const own = (keys: string) => inFiles(keys, ["Brain/brain.env"]);
  const add = (name: string, description: string, enabled: boolean, location: string, runtime?: Harness) =>
    entries.push({ name, description, enabled, switch: location, ...(runtime ? { runtime } : {}) });
  add("Browser", "Browse interactive web pages", env.EMBERVY_BROWSER === "1" || (b && !!brain.BRAIN_BROWSER_COMMAND),
    app("EMBERVY_BROWSER") + (b ? "; " + own("BRAIN_BROWSER_COMMAND") : ""));
  add("Hearing", "Hear words and sounds", !!env.EMBERVY_HEAR_URL, app("EMBERVY_HEAR_URL"));
  add("Voice messages", "Receive spoken voice notes", env.EMBERVY_VOICE_MESSAGES === "1", app("EMBERVY_VOICE_MESSAGES"));
  add("Voice replies", "Send spoken app replies", !!env.ELEVENLABS_API_KEY, app("ELEVENLABS_API_KEY"));
  add("Files and images", "Send files and images", true, "always on");
  add("Rooms", "Talk in shared rooms", roomConfigsFromEnv(env, () => {}).length > 0, app("EMBERVY_ROOMS, EMBERVY_ROOM_URL, EMBERVY_ROOM_TOKEN"));
  add("Peers", "Contact other houses directly", peerConfigsFromEnv(env, () => {}).length > 0, app("EMBERVY_PEERS"));
  add("Agent mail", "Send approved outgoing mail", !!(env.EMAIL_SENDER_URL && env.EMAIL_SENDER_AUTH), app("EMAIL_SENDER_URL, EMAIL_SENDER_AUTH"));
  const graph = ["graph", "outlook"].includes((env.MAILBOX_PROVIDER || "").toLowerCase());
  add("Mailbox reading", "Read incoming mailbox messages", !!(env.MAILBOX_USER && (graph ? env.MAILBOX_GRAPH_CLIENT_ID : env.MAILBOX_HOST && env.MAILBOX_APP_PASSWORD)),
    app("MAILBOX_PROVIDER, MAILBOX_USER, MAILBOX_HOST, MAILBOX_APP_PASSWORD, MAILBOX_GRAPH_CLIENT_ID"));
  add("House doctor", "Check house configuration health", true, "always on");
  if (b) {
    const checked = validateHeadState(config.headState);
    const head = checked.ok ? resolveHeadChoice(checked.value.head, { ...brain, BRAIN_CLAUDE_LOGIN_CHECK: "0" }, {
      model: checked.value.model, contextWindow: checked.value.window, transport: checked.value.transport,
    }) : resolveHeadChoice(brain.BRAIN_HEAD ?? "api", { ...brain, BRAIN_CLAUDE_LOGIN_CHECK: "0" });
    const sense = (brain.BRAIN_SENSE ?? "on").toLowerCase() !== "off";
    const control = !!brain.BRAIN_CONTROL_TOKEN;
    const web = webToolPlan(head, webConfigFromEnv({ ...brain, BRAIN_WEB_BROWSER: "off" }, ""), control);
    const native = web.via === "native";
    const pipe = head.transport === "pipe";
    const denyKey = `BRAIN_${head.name.toUpperCase()}_DISALLOWED_TOOLS`;
    const denied = new Set((brain[denyKey]?.trim() || brain.BRAIN_DISALLOWED_TOOLS?.trim() || "").split(",").map(tool => tool.trim()));
    const nativeSwitch = own(`BRAIN_DISALLOWED_TOOLS, ${denyKey}`) + "; native head tools";
    const cache = (brain.BRAIN_CACHE_PING ?? "auto").toLowerCase();
    add("Pins", "Keep important context visible", true, "always on", harness);
    add("Timed reminder", "Wake for due reminders", brain.BRAIN_REMINDERS_COLLECT === "1" && !!(brain.BRAIN_MEMORY_URL && brain.BRAIN_MEMORY_API_KEY) && brain.BRAIN_REMINDERS_PENDING !== "",
      own("BRAIN_REMINDERS_COLLECT, BRAIN_MEMORY_URL, BRAIN_MEMORY_API_KEY, BRAIN_REMINDERS_PENDING, BRAIN_REMINDERS_ESCALATE_MIN"), harness);
    add("Calendar in senses", "Notice upcoming calendar entries", sense && !!(brain.BRAIN_CALENDAR_FILE || brain.BRAIN_CALENDAR_EXTERNAL_FILE), own("BRAIN_SENSE, BRAIN_CALENDAR_FILE, BRAIN_CALENDAR_EXTERNAL_FILE"), harness);
    add("Weather", "Sense local weather conditions", sense && !!brain.BRAIN_WEATHER_URL, own("BRAIN_SENSE, BRAIN_WEATHER_URL"), harness);
    add("Web search", "Search public web pages", (native && !denied.has("WebSearch")) || web.tools.includes("web_search"),
      native ? nativeSwitch : own("BRAIN_WEB_SEARCH_BACKEND, BRAIN_WEB_SEARCH_API_KEY, BRAIN_WEB_SEARCH_ENDPOINT, BRAIN_CONTROL_TOKEN"), harness);
    add("Web fetch", "Read public web pages", web.tools.includes("web_fetch") || (pipe && !denied.has("WebFetch")),
      native ? nativeSwitch : own("BRAIN_WEB_FETCH, BRAIN_CONTROL_TOKEN") + (pipe ? "; " + nativeSwitch : ""), harness);
    add("Cache ping", "Keep prompt cache warm", cache === "on" || (cache !== "off" && pipe && !head.pipeEnv.ANTHROPIC_BASE_URL), own("BRAIN_CACHE_PING, BRAIN_CACHE_PING_MINUTES, BRAIN_HEAD, BRAIN_HEAD_FILE") + (config.headFile && config.settingsFiles?.includes(config.headFile) ? `; saved head in ${config.headFile}` : ""), harness);
    add("Head and model switching", "Change head and model", true, "always on", harness);
    add("Effort", "Adjust model reasoning effort", true, "always on", harness);
    const cards = brain.BRAIN_APPROVAL_SETTINGS ? config.approvalLevel !== "none"
      : pipe ? brain.BRAIN_PIPE_PERMISSION === "app" : (brain.BRAIN_APPROVAL || "off").toLowerCase() === "app";
    add("Approval cards", "Ask before important actions", cards && !!brain.BRAIN_APP_URL && !!(brain.BRAIN_APP_TOKEN || env.INTERNAL_API_TOKEN) && (!pipe || control),
      own("BRAIN_APPROVAL, BRAIN_PIPE_PERMISSION, BRAIN_CONTROL_TOKEN, BRAIN_APP_URL, BRAIN_APP_TOKEN, BRAIN_APPROVAL_SETTINGS") + (config.approvalFile && config.settingsFiles?.includes(config.approvalFile) ? `; level in ${config.approvalFile}` : "; level in the app's Approvals settings"), harness);
  } else {
    add("Calendar in senses", "Notice upcoming calendar entries", hookEnv.EMBERVY_HOOK_CALENDAR === "1", inFiles("EMBERVY_HOOK_CALENDAR", [".env"]), harness);
    add("Weather", "Sense local weather conditions", (hookEnv.EMBERVY_HOOK_WEATHER === "1" || !!config.weatherFeature) && !!(hookEnv.EMBERVY_WEATHER_PLACE || hookEnv.EMBERVY_TIME_LABEL || (hookEnv.EMBERVY_WEATHER_LAT && hookEnv.EMBERVY_WEATHER_LON)),
      inFiles("EMBERVY_HOOK_WEATHER, EMBERVY_WEATHER_PLACE, EMBERVY_TIME_LABEL, EMBERVY_WEATHER_LAT, EMBERVY_WEATHER_LON", [".env"]) + (config.settingsFiles?.includes("config/features.json") ? "; weather in config/features.json" : ""), harness);
    add("Cache ping", "Keep prompt cache warm", env.EMBERVY_CACHE_PING === "1" && /^[1-9][0-9]{0,5}$/.test(env.EMBERVY_CACHE_PING_MINUTES || ""), app("EMBERVY_CACHE_PING, EMBERVY_CACHE_PING_MINUTES"), harness);
    add("Head and model switching", "Change backend and model", true, "always on", harness);
    add("Effort", "Adjust model reasoning effort", true, "always on", harness);
    add("Web search", "Search public web pages", ["claude", "gpt"].includes(env.EMBERVY_BACKEND || "claude"), app("EMBERVY_BACKEND") + "; native CLI tools", harness);
    add("Web fetch", "Read public web pages", true, "always on (native CLI tool)", harness);
  }
  return entries;
}

export function renderCapabilities(f: Pick<HouseFacts, "harness" | "capabilities">): string {
  const lines = [CAPABILITIES_HEADER, "", "## Shared house abilities"];
  for (const runtime of [undefined, f.harness]) {
    if (runtime) lines.push("", runtime === "brain" ? "## Brain only" : "## Claude Code only");
    for (const c of f.capabilities || []) if (c.runtime === runtime) {
      lines.push(`- ${c.name} | ${c.description} | ${c.enabled ? "on" : "off"} | ${c.switch}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function checkCapabilities(text: string, f: Pick<HouseFacts, "capabilities">): string[] {
  const named = new Map<string, Set<string>>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+([^|]+)\|[^|]*\|\s*(on|off)\s*(?:\||$)/i.exec(line);
    if (!match) continue;
    const name = match[1].replace(/[`*]/g, "").trim().toLowerCase();
    const states = named.get(name) || new Set<string>();
    states.add(match[2].toLowerCase());
    named.set(name, states);
  }
  return (f.capabilities || []).flatMap(c => {
    const states = named.get(c.name.toLowerCase());
    const now = c.enabled ? "on" : "off", opposite = c.enabled ? "off" : "on";
    if (!states) return [`${c.name}: missing ability`];
    return states.has(opposite) ? [`${c.name}: document says ${opposite}, now ${now}`] : [];
  });
}

// URL userinfo, queries, fragments and paths can all carry credentials.
export function publicUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch { return undefined; }
}

export function renderInfrastructure(f: HouseFacts): string {
  const p = f.paths;
  const unit = (role: string) => f.units.find(u => u.role === role)?.name;
  const lines = [
    "# INFRASTRUCTURE — this installation", "",
    "This file describes the house as it was set up. The agent owns it and keeps it true.",
    "How this house works is in `HANDBOOK.md`, next to this map.", "",
    "## Substrate",
    `- Server: ${f.server}${f.installer?.provider ? ` (${f.installer.provider})` : ""}`,
    `- Harness: **${f.harness === "brain" ? "Brain" : "Claude Code"}**`,
    `- Configured head: ${f.head}; model: ${f.model}`,
    ...(f.harness === "claude-code" ? [`- Subscription/backend: ${f.head}`] : []),
    ...(f.operation?.effort ? [`- Configured adapter reasoning effort: ${f.operation.effort}`] : []),
    `- tmux session: \`${f.tmux.session}\`; socket: \`${f.tmux.socket}\` (detach with Ctrl-B, then D; never Ctrl-C)`, "",
    "## Reachability",
    ...(f.tunnel ? [`- Tunnel: ${f.tunnel.name ? `**${f.tunnel.name}**` : "name not available locally"} (\`${f.tunnel.id}\`)`] : []),
    `- Local app port: ${f.ports.app}`,
    ...(f.head === "gpt" && f.ports.adapter ? [`- Subscription adapter port: ${f.ports.adapter}`] : []),
    ...(f.hooks.browser && f.ports.browser ? [`- Browser daemon port: ${f.ports.browser}`] : []),
    ...(f.ports.control ? [`- Brain control port: ${f.ports.control}`] : []),
    ...Object.entries(f.workers).flatMap(([name, url]) => publicUrl(url) ? [`- ${name}: ${publicUrl(url)}`] : []), "",
    "## Services (systemd)",
    ...(f.units.length ? f.units.map(u => `- \`${u.name}\` — ${u.role}; active: ${u.active}; enabled: ${u.enabled}`)
      : ["- No unit names configured in the house env files; no other units were queried."]),
    "- Never run both harnesses against the same app inbox.",
    ...f.units.filter(u => ["brain", "loop", "tunnel", "brain_watchdog", "watchdog"].includes(u.role))
      .map(u => `- ${u.role} status: \`systemctl status ${u.name}\`; logs: \`journalctl -u ${u.name} -n 50\``),
    ...(unit("app") ? [`- App status: \`systemctl status ${unit("app")}\`; logs: \`journalctl -u ${unit("app")} -n 50\``] : []), "",
    f.harness === "brain" ? "## Brain (the harness)" : "## Claude Code (the harness)",
    ...(f.harness === "brain" ? [
      "- Brain holds the conversation; the model that thinks is the head. `/head`, `/heads`, `/model` and `/move` in the app change the head without changing the house.",
      `- Logs: files in \`${p.logs}/\` — \`session-<id>.jsonl\`, \`conversation-<id>.jsonl\`, \`brain-watchdog.log\`, \`brain-cutoff.log\`. The next session's bridge is \`${p.bridge}\`.`,
      ...(f.operation?.inletLog ? [`- Inlet diagnostics: \`${f.operation.inletLog}\`.`] : []),
      ...(f.operation?.brainDoctor ? [`- Brain's own doctor: \`bun ${f.home}/Brain/scripts/brain-doctor.ts\` checks head, ports, login, adapter, memory and inbox configuration.`] : []),
      ...(f.operation?.startupDoctor ? ["- Brain runs `BRAIN_DOCTOR_CMD` once per session and reports its result; the command stays in `Brain/brain.env`."] : []),
      ...(f.operation?.firstTurn ? [`- First-turn input: \`${f.operation.firstTurn}\`; your own house map is \`${p.ownMap}\`, included at birth.`] : []),
      ...(f.operation?.calendar ? [`- Calendar sense source: \`${f.operation.calendar}\`; calendar lines appear once per start and day when senses are enabled.`] : []),
      ...(f.operation?.externalCalendar ? [`- Read-only external calendar sense source: \`${f.operation.externalCalendar}\`; private ICS links stay in \`CALENDAR_ICS_URLS\`.`] : []),
      `- Wrapper: \`${f.home}/Brain/scripts/brain-loop-wrapper.sh\`. Exit code 75 is a deliberate stop; the unit does not restart then.`,
      `- Configuration: \`${f.home}/Brain/brain.env\` (0600; carries tokens, never print it). Delete a line to unset it; blank assignments beat defaults.`,
      `- State: \`${p.state}/brain_context.json\` records pid, head, transport, model and tokens for the watchdog; \`app-inbox-cursor.json\` tracks the inbox at \`${p.inbox}\`.`,
      "- App replies use `mcp__app__reply`, delivered through the app's `/api/internal/broadcast` endpoint.",
      "- On first start the cursor begins at the inbox end unless one was prepared. Use `mcp__app__reply`; the reply gateway can also deliver terminal prose when enabled and no successful app reply exists, unless the turn is silent or classified as an internal note.",
      "- At cut the watchdog runs `Brain/scripts/brain-cutoff.sh`: SIGTERM, Brain writes the bridge and archive, then the loop starts a new session. The next session renames the bridge to `bridge.used.md`.",
      "- The inlet is invoked by Brain; do not also install the Claude Code UserPromptSubmit inlet hook.",
      ...(f.head === "gpt" && f.ports.adapter ? [`- ChatGPT adapter: loopback port ${f.ports.adapter}; health at \`http://127.0.0.1:${f.ports.adapter}/health\`. Brain starts its own transient \`brain-gpt-adapter-<identity>.service\` and never adopts a foreign listener.`] : []),
      `- Approval policy: ${f.approval}. First-turn and greeting settings live in \`Brain/brain.env\`.`,
    ] : [
      `- Wrapper: \`${f.home}/Claude/scripts/loop-wrapper.sh\`; loop: \`Claude/scripts/start-claude-loop.sh\`. The wrapper forwards explicit CLI settings.`,
      "- House hooks live in `.claude/settings.json`." + (f.settingSources === undefined
        ? " Check the loop service's ExecStart and `Claude/scripts/loop-wrapper.sh` / `Claude/scripts/start-claude-loop.sh` for the settings sources actually passed to Claude Code."
        : f.settingSources ? ` The configured loop passes \`--setting-sources ${f.settingSources}\`.` : ""),
      "- App messages arrive through the stdio app MCP channel. Use `mcp__app__reply`; an enabled reply gateway can also deliver terminal prose after a turn without a successful app reply, unless silent or classified as an internal note.",
      "- The watchdog runs `Claude/scripts/cutoff.sh`, writes the bridge and exports through `session-to-rag.sh` before terminating. The loop starts a fresh life with the bridge; `--continue` is for crash recovery.",
    ]),
    `- Inlet: ${f.inlet}.`,
    `- Watchdog: warn ${tokenCount(f.watchdog.warn)}, cut ${tokenCount(f.watchdog.cut)} tokens; automatic compaction ${f.compaction}.`,
    f.harness === "brain"
      ? "- Thresholds: `BRAIN_<HEAD>_WATCHDOG_WARN` / `BRAIN_<HEAD>_WATCHDOG_CUT` in `Brain/brain.env`; reread at the next model call, no cut needed. A cut above 95% of the head's window is clamped."
      : "- Thresholds: `WATCHDOG_WARN_TOKENS_<ENGINE>` / `WATCHDOG_CUT_TOKENS_<ENGINE>` in the root `.env` (app env only if root is absent); reread within a minute, no cut needed.",
    `- Bridge depth: ${f.bridgeTurns} user turns (when turns mode is selected).`,
    `- Header enrichment: ${f.enrichment ? f.harness === "brain"
      ? "enabled via BRAIN_HEADER_ENRICH_CMD in Brain/brain.env; Brain passes a temporary archive file to that command; the command determines its own settings"
      : "enabled, using the house's auto-rag-header definition and project,local settings"
      : "not configured"}; failure keeps placeholder fields and still archives the transcript.`, "",
    "## Where things live",
    `- App + workers checkout: \`${f.home}\``,
    ...Object.entries(p).map(([name, path]) => `- ${name}: \`${path}\``),
    `- Feature flags: \`${f.home}/config/features.json\``,
    `- House env files (0600): ${f.envFiles === undefined ? "not inspected" : f.envFiles.length ? f.envFiles.map(file => `\`${f.home}/${file}\``).join(", ") : "none present"}; secret values stay there, never in this map.`,
    "- MCP configuration: `.mcp.json` (0600). An MCP process must restart to read changed code or settings; an app refresh does not reload it.",
    `- Identity rule: \`EMBERVY_IDENTITY_RULE=${f.identityRule || "own"}\` (root and app env${f.harness === "brain" ? "; Brain/brain.env takes precedence" : "; app env takes precedence"}).`,
    "- Incoming documents: `incoming/`; ask the agent to weave them into its memory. " + (f.identityRule === "together"
      ? "The identity file is written together with the person and changed only with their okay; changes are shown as before and after text, not a summary."
      : "The identity file belongs to the agent; changes are shown to the person as before and after text, not a summary."), "",
    "## Ground layer",
    ...Object.entries(f.hooks).map(([name, on]) => {
      const capability = name === "weather" ? "Weather" : name === "cachePing" ? "Cache ping" : undefined;
      const enabled = capability ? f.capabilities?.find(c => c.name === capability)?.enabled ?? on : on;
      const label = capability ? `${f.harness === "brain" ? "Brain" : "Claude Code"} ${name}` : name;
      return `- ${label}: ${enabled ? "on" : "off"}`;
    }),
    ...Object.entries(f.rooms || {}).map(([name, on]) => `- Room ${name}: ${on ? "on" : "off"}`),
    "- Calendar entries: `Claude/app/data/calendar.json`; external calendars are read-only. Feed and ICS credentials stay in env files; use the calendar tool's `feed` action for the full subscription link.",
    `- Rotate the phone feed with \`bun ${f.home}/shared/calendar/feed-token.ts rotate --env ${f.home}/.env\`; keep the app environment in sync, restart this house's app with permission, and subscribe again using the new link. See \`${f.home}/docs/calendar.md\`.`,
    "- Browser: `shared/tools/browser/browse.py`; profile and logins: `state/browser/`; install/update with `bash shared/tools/browser/install.sh`. It starts on first use; `browse.py stop` frees its memory. Instructions: `.claude/skills/browser/SKILL.md`.", "",
    "## Credential presence", "",
    ...Object.entries(f.credentials || {}).map(([key, set]) => `- \`${key}\`: ${set ? "set" : "not set"}`), "",
    "## Room to overflow",
    ...(f.overflow?.reserve ? [f.overflow.present
      ? `- Disk full: remove the reserve \`${f.overflow.reserve}\` first, clean up old logs, then recreate it with \`fallocate -l 2G ${f.overflow.reserve} && chmod 600 ${f.overflow.reserve}\`.`
      : `- No disk reserve found at \`${f.overflow.reserve}\`; create one there once there is room.`]
      : ["- No house-local disk reserve configured or checked. Ask the server owner about any shared reserve before deleting it."]),
    `- Full-disk cleanup: review old files in \`${p.logs}/\` before removing them; then \`journalctl --vacuum-size=200M\` and \`apt-get clean\`. Journal cleanup affects the whole server, not just this house.`,
    "- Bootstrap can provide `/swapfile`, a 500 MB journal cap and weekly/50 MB log rotation. These server-wide provisions are not verified by this tool.",
    `- \`bun ${f.home}/shared/tools/embervy-doctor.ts\` checks memory, chronicle, app and disk; warns at 80% disk and missing swap.`,
  ];
  if (f.installer?.resources?.length) lines.push("", "## Cloud resources", "| Resource | Name | ID |", "|---|---|---|",
    ...f.installer.resources.map(r => `| ${r.kind} | ${r.name} | ${r.id} |`));
  if (f.installer?.backup) lines.push("", `Program backup before repair: \`${f.installer.backup}\`.`);
  if (f.installer?.statePath) lines.push("", `Installer state: \`${f.installer.statePath}\` (safe to delete after a successful install; a new run starts fresh).`);
  if (f.installer?.ssh) {
    const ssh = f.installer.ssh;
    lines.push("", f.rescueAccess ? "## Emergency access — save this once." : "## SSH access", "",
      f.rescueAccess ? "Save the SSH key somewhere safe. Never remove an `embervy-rescue` authorized key without confirming another way in with the user." : "Use the SSH access supplied for this installation.",
      `\`ssh -i "${ssh.keyPath}" ${ssh.user || "root"}@${ssh.host}\``);
  }
  return lines.join("\n").trimEnd() + "\n";
}

function within(home: string, path: string): boolean {
  const rel = relative(home, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
}

// Check every existing ancestor so a directory symlink cannot redirect even a missing file.
function housePath(home: string, name: string): string {
  const path = resolve(home, name);
  if (!within(home, path)) throw new Error("house-docs: path outside --home refused");
  let check = path;
  for (;;) {
    try {
      const stat = lstatSync(check);
      if (!within(home, realpathSync(check))) throw new Error("house-docs: symlink outside --home refused");
      if (check === path && (!stat.isFile() || stat.nlink !== 1)) throw new Error("house-docs: expected a regular, unshared file");
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
      // A dangling symlink is not a missing regular file.
      try { if (lstatSync(check).isSymbolicLink()) throw new Error("house-docs: dangling symlink refused"); }
      catch (inner: any) { if (inner.code !== "ENOENT") throw inner; }
    }
    if (check === home) break;
    check = dirname(check);
  }
  return path;
}

function readOptional(home: string, name: string): string {
  const path = housePath(home, name);
  try { return readFileSync(path, "utf8"); }
  catch (err: any) { if (err.code === "ENOENT") return ""; throw new Error("house-docs: cannot read house file"); }
}

function workerScheduled(home: string, file: string): boolean | undefined {
  const text = readOptional(home, file);
  if (!text.trim()) return undefined;
  try {
    const config = Bun.TOML.parse(text) as { triggers?: { crons?: unknown } };
    const crons = config.triggers?.crons;
    if (!Array.isArray(crons) || !crons.every(cron => typeof cron === "string" && cron.trim())) return undefined;
    return crons.length > 0;
  } catch { return undefined; }
}

type Env = Record<string, string>;
const on = (value?: string) => value === "1" || value === "true" || value === "on";
const credentialKey = (key: string) => /(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE_KEY)$/.test(key)
  && !/(?:CACHE_KEY|PUBLIC_KEY)$/.test(key);
const credentialKeys = [
  "EMBERVY_API_KEY", "RAG_AUTH_TOKEN", "OPENROUTER_API_KEY", "INTERNAL_API_TOKEN", "EXTERNAL_PUSH_TOKEN",
  "APP_PASSWORD", "APP_SESSION_SECRET", "VAPID_PRIVATE_KEY", "ELEVENLABS_API_KEY", "EMAIL_SENDER_AUTH",
  "EMAIL_WORKER_TOKEN", "CALENDAR_FEED_TOKEN", "CALENDAR_ICS_URLS", "EMBERVY_ROOM_TOKEN", "MAILBOX_APP_PASSWORD", "BFL_API_KEY",
];

export function rescueLinePresent(text: string): boolean {
  return text.split(/\r?\n/).some(line => !/^\s*(?:#|$)/.test(line)
    && /(?:^|\s)(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-\S+)\s+\S+\s+(?:.*\s)?embervy-rescue(?:\s|$)/.test(line));
}

function rescueAccess(): boolean {
  try { return rescueLinePresent(readFileSync("/root/.ssh/authorized_keys", "utf8")); }
  catch { return false; }
}
function positive(value: string | undefined, fallback: number, port = false): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || (port && n > 65535)) throw new Error("house-docs: invalid numeric setting");
  return n;
}

function loopSettingSources(home: string, state: string): string | undefined {
  const starts = state.split("\n").filter(line => line.startsWith("ExecStart="));
  if (starts.length !== 1) return undefined;
  const start = /^ExecStart=\{ path=([^;]+) ; argv\[\]=([^;]+) ;[^{}]*\}$/.exec(starts[0]);
  const command = start?.[2];
  if (!command || /[$\\\r\n]/.test(command)) return undefined;
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) || [];
  if (tokens.join(" ") !== command.trim().replace(/ +/g, " ")) return undefined;
  const args = tokens.map(token => /^["']/.test(token) ? token.slice(1, -1) : token);
  if (args[0] !== start![1]) return undefined;
  if (["/bin/bash", "/usr/bin/bash", "bash"].includes(args[0])) args.shift();
  if (args.shift() !== join(home, "Claude/scripts/loop-wrapper.sh")) return undefined;
  // A script that sets sources itself can override the service arguments.
  if (!["loop-wrapper.sh", "start-claude-loop.sh"].every(script => {
    const text = readOptional(home, `Claude/scripts/${script}`);
    return text.length > 0 && !text.includes("setting-sources");
  })) return undefined;
  let sources = "";
  for (let i = 0; i < args.length; i++) {
    if (["--continue", "-c"].includes(args[i])) continue;
    if (["--settings", "--model", "--effort"].includes(args[i])) {
      if (!args[++i] || args[i].startsWith("-")) return undefined;
      continue;
    }
    if (args[i] === "--setting-sources" || args[i].startsWith("--setting-sources=")) {
      const value = args[i] === "--setting-sources" ? args[++i] : args[i].slice("--setting-sources=".length);
      if (sources || !value || !/^(?:user|project|local)(?:,(?:user|project|local))*$/.test(value)) return undefined;
      sources = value;
    } else return undefined;
  }
  return sources;
}

function reservePresent(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.nlink === 1 && realpathSync(path) === path;
  } catch { return false; }
}

export function reserveFacts(home: string, configured?: string, present = reservePresent): HouseFacts["overflow"] {
  home = resolve(home);
  // Bootstrap's default reserve is not evidence of ownership for an arbitrary home.
  // Named houses must not claim the first house's reserve.
  const candidates = home === HOME_DIR
    ? [`${VAR_DIR}/reserve.img`]
    : /^\/opt\/embervy-[a-z0-9-]{2,20}$/.test(home) ? [`/var/lib/${basename(home)}/reserve.img`] : [];
  const explicit = configured ? resolve(home, configured) : undefined;
  if (explicit && !candidates.includes(explicit)) housePath(home, explicit);
  if (explicit && present(explicit)) return { reserve: explicit, present: true };
  for (const installer of candidates) if (installer !== explicit && present(installer)) return { reserve: installer, present: true };
  return explicit ? { reserve: explicit, present: false } : undefined;
}

function cloudflareSignIn(home: string, env: Env): { present: boolean; secrets: string[] } {
  // Installer-owned per-house Wrangler configuration only. Never inspect root's
  // login or another house's XDG directory, and never contact Cloudflare.
  const absent = { present: false, secrets: [] as string[] };
  if (!env.XDG_CONFIG_HOME || !env.WRANGLER_CLIENT_ID || !env.CLOUDFLARE_ACCOUNT_ID) return absent;
  const auth = resolve(home, env.XDG_CONFIG_HOME, ".wrangler/config/default.toml");
  if (!within(home, auth)) return absent;
  const text = readOptional(home, auth);
  let config: any;
  try { config = Bun.TOML.parse(text); } catch { return absent; }
  const secrets = [config.oauth_token, config.refresh_token].filter((v): v is string => typeof v === "string" && !!v.trim());
  const scopes = ["workers-scripts.write", "d1.write", "vectorize.write", "workers-r2.write"];
  const granted = Array.isArray(config.scopes) ? config.scopes.filter((s: unknown) => s !== "offline_access") : [];
  return { present: secrets.length === 2 && granted.length === scopes.length && scopes.every(s => granted.includes(s)), secrets };
}

export function localPublicIPv4(interfaces = networkInterfaces(), routes = (() => {
  try { return readFileSync("/proc/net/route", "utf8"); } catch { return ""; }
})()): string | undefined {
  const primary = routes.split("\n").slice(1).map(line => line.trim().split(/\s+/))
    .filter(row => row[1] === "00000000" && (parseInt(row[3], 16) & 1))
    .sort((a, b) => Number(a[6]) - Number(b[6]))[0]?.[0];
  return (interfaces[primary] || []).find(address => {
    if (address.family !== "IPv4" || address.internal) return false;
    const [a, b, c] = address.address.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 192 && b === 0) && !(a === 198 && [18, 19].includes(b))
      && !(a === 198 && b === 51 && c === 100) && !(a === 203 && b === 0 && c === 113);
  })?.address;
}

export function configuredTunnel(home: string, prefix: string | undefined, state: string, previous: string,
  read = (path: string) => readOptional(dirname(path), path)): { tunnel?: HouseFacts["tunnel"]; secrets: string[] } {
  const absent = { secrets: [] as string[] };
  if (!prefix || !/^embervy(?:-[a-z0-9-]{2,20})?$/.test(prefix)) return absent;
  const expected = `/etc/${prefix}/tunnel.env`;
  const local = join(home, "tunnel.env");
  const files = /^EnvironmentFiles=(.*)$/m.exec(state)?.[1] || "";
  const path = [expected, local].find(path => files === `${path} (ignore_errors=no)` || files === `${path} (ignore_errors=yes)`);
  if (!path || !/^ExecStart=.*\/cloudflared\b.*tunnel run(?: ;|$)/m.test(state)) return absent;
  try {
    const token = parseEnv(read(path)).TUNNEL_TOKEN;
    if (!token) return absent;
    const secrets = [token];
    let payload: any;
    try { payload = JSON.parse(Buffer.from(token, "base64").toString("utf8")); } catch { return { secrets }; }
    if (typeof payload.s === "string" && payload.s) secrets.push(payload.s);
    const id = payload.t;
    if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return { secrets };
    // Remotely managed connector tokens contain an ID, not a name. Retain a
    // previous public label only when its ID matches this unit's credential.
    const label = new RegExp(`^- Tunnel: \\*\\*([\\w .-]{1,100})\\*\\* \\(\\\`${escapePattern(id)}\\\`\\)`, "mi").exec(previous)?.[1];
    return { tunnel: { id, ...(label ? { name: label } : {}) }, secrets };
  } catch { return absent; }
}

export function collectFacts(homeArg: string, options: { queryUnits?: boolean } = {}): { facts: HouseFacts; redact: (text: string) => string } {
  const home = realpathSync(resolve(homeArg));
  if (!lstatSync(home).isDirectory()) throw new Error("house-docs: --home must be a directory");
  const root = parseEnv(readOptional(home, ".env"));
  const app = parseEnv(readOptional(home, "Claude/app/.env"));
  const brain = parseEnv(readOptional(home, "Brain/brain.env"));
  const env: Env = { ...root, ...app };
  const cloudflare = cloudflareSignIn(home, env);
  const harness: Harness = (env.EMBERVY_HARNESS || env.EMBERVY_SUBSTRATE) === "brain" ? "brain" : "claude-code";
  const b = harness === "brain";
  const own: Env = b ? { ...env, ...brain } : env;
  const keys = [...new Set([...credentialKeys, ...Object.keys(own).filter(credentialKey),
    ...(b ? ["BRAIN_API_KEY", "BRAIN_MEMORY_API_KEY", "BRAIN_RAG_AUTH_TOKEN", "BRAIN_APP_TOKEN", "BRAIN_CONTROL_TOKEN", "BRAIN_WEB_SEARCH_API_KEY"] : [])])].sort();
  const credentials = Object.fromEntries(keys.map(key => [key, !!own[key]?.trim()]));
  const roomConfigs = roomConfigsFromEnv(env, () => {});
  const rooms = Object.fromEntries(roomConfigs.map(room => [room.name, true]));
  roomConfigs.forEach(room => { credentials[`room ${room.name} token`] = !!room.token; });
  const peers = peerConfigsFromEnv(env, () => {});
  peers.forEach(peer => { credentials[`peer ${peer.name} token`] = !!peer.token; });
  const headFile = b ? relative(home, resolve(home, brain.BRAIN_HEAD_FILE || join(brain.BRAIN_STATE_DIR || "Brain/state", "brain-head.json"))) : undefined;
  const headText = b ? readOptional(home, headFile!) : "";
  const savedHead = (() => {
    try { const checked = validateHeadState(JSON.parse(headText)); return checked.ok ? checked.value : undefined; }
    catch { return undefined; }
  })();
  const head = (b ? savedHead?.head || brain.BRAIN_HEAD || "api" : env.EMBERVY_BACKEND) || "claude";
  const upper = head.toUpperCase();
  const model = (b ? savedHead?.model || brain[`BRAIN_${upper}_MODEL`] || (head === "api" ? brain.BRAIN_MODEL : "") : env[`EMBERVY_${upper}_MODEL`]) || "CLI default";
  const defaults: Record<string, [number, number]> = { claude: [800000, 900000], gpt: [200000, 220000], glm: [800000, 900000], kimi: [180000, 210000], minimax: [150000, 180000] };
  const windows: Record<string, number> = { claude: 1000000, gpt: 1000000, grok: 500000, kimi: 256000, glm: 1000000 };
  const window = savedHead?.window || positive(brain[`BRAIN_${upper}_CONTEXT`] || (head === "api" ? brain.BRAIN_CONTEXT_WINDOW : ""), windows[head] || 1000000);
  const preset = (b && !["claude", "gpt"].includes(head) ? undefined : defaults[head]) || [Math.floor(window * 0.8), Math.floor(window * 0.9)];
  const thresholds = b ? brain : existsSync(join(home, ".env")) ? root : app;
  const warn = positive(b ? thresholds[`BRAIN_${upper}_WATCHDOG_WARN`] || thresholds.BRAIN_WATCHDOG_WARN
    : thresholds[`WATCHDOG_WARN_TOKENS_${upper}`] || (!["gpt", "kimi", "minimax"].includes(head) ? thresholds.WATCHDOG_WARN_TOKENS : ""), preset[0]);
  const cut = positive(b ? thresholds[`BRAIN_${upper}_WATCHDOG_CUT`] || thresholds.BRAIN_WATCHDOG_CUT
    : thresholds[`WATCHDOG_CUT_TOKENS_${upper}`] || (!["gpt", "kimi", "minimax"].includes(head) ? thresholds.WATCHDOG_CUT_TOKENS : ""), preset[1]);
  const path = (key: string, fallback: string) => {
    const value = own[key] || fallback;
    const result = resolve(home, value);
    if (!within(home, result)) throw new Error(`house-docs: ${key} points outside --home`);
    // Configured paths are described, never opened.
    return result;
  };
  const units: HouseFacts["units"] = [];
  let settingSources: string | undefined;
  let tunnel: ReturnType<typeof configuredTunnel> = { secrets: [] };
  // Query exact house names, never a server-wide listing or a prefix glob (which
  // would include named neighbouring houses). Explicit env names remain authoritative.
  const configuredUnits = Object.entries(own).filter(([key, value]) => /(?:_SERVICE|_UNIT)$/.test(key) && value);
  const appPrefix = /^(embervy(?:-[a-z0-9-]{2,20})?)-app(?:\.service)?$/.exec(env.EMBERVY_APP_SERVICE || "")?.[1];
  const layoutPrefix = /^\/opt\/embervy(?:-[a-z0-9-]{2,20})?$/.test(home) ? basename(home) : undefined;
  const prefix = appPrefix || layoutPrefix;
  const discovered = new Set<string>();
  if (prefix) for (const part of ["app.service", "brain.service", "brain-watchdog.service", "loop.service", "watchdog.service", "tunnel.service", "ears.service", "moments.service", "moments.timer", "mail-poll.service", "mail-poll.timer", "calendar-poll.service", "calendar-poll.timer"]) {
    const name = `${prefix}-${part}`;
    if (configuredUnits.some(([, value]) => ( /\.(service|timer|socket)$/.test(value) ? value : value + ".service") === name)) continue;
    const role = part.replace(/\.(service|timer)$/, "").replaceAll("-", "_").toUpperCase();
    configuredUnits.push([`EMBERVY_${role}_UNIT`, name]);
    discovered.add(name);
  }
  for (const [key, value] of configuredUnits) {
    if (!/(?:_SERVICE|_UNIT)$/.test(key) || !value) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(value)) throw new Error("house-docs: invalid configured unit name");
    const name = /\.(service|timer|socket)$/.test(value) ? value : value + ".service";
    if (units.some(u => u.name === name)) continue;
    const role = key === "EMBERVY_APP_SERVICE" ? "app" : key === "BRAIN_UNIT" ? "brain" : key.replace(/^(EMBERVY_|BRAIN_)/, "").replace(/_(SERVICE|UNIT)$/, "").toLowerCase();
    let active = "unknown", enabled = "unknown", found = !discovered.has(name);
    if (options.queryUnits !== false) try {
      const loop = !b && role === "loop";
      const run = Bun.spawnSync(["systemctl", "show", `--property=LoadState,ActiveState,UnitFileState${loop ? ",ExecStart" : role === "tunnel" ? ",ExecStart,EnvironmentFiles" : ""}`, "--", name], {
        env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C", SYSTEMD_PAGER: "cat" },
        cwd: home, stdout: "pipe", stderr: "ignore", timeout: 5000,
      });
      if (run.exitCode === 0) {
        const output = run.stdout.toString();
        if (loop) settingSources = loopSettingSources(home, output);
        if (role === "tunnel" && name === `${prefix}-tunnel.service`) tunnel = configuredTunnel(home, prefix, output, readOptional(home, "INFRASTRUCTURE.md"));
        const state = parseEnv(output);
        found ||= !!state.LoadState && state.LoadState !== "not-found";
        const safeState = (s?: string) => s && /^[a-z-]+$/.test(s) ? s : "unknown";
        active = safeState(state.ActiveState); enabled = safeState(state.UnitFileState);
      }
    } catch { /* Documentation does not require systemd. */ }
    if (found) units.push({ role, name, active, enabled });
  }
  units.sort((a, z) => a.name.localeCompare(z.name));
  const identityRule = own.EMBERVY_IDENTITY_RULE;
  const facts: HouseFacts = {
    identityRule: identityRule === "together" ? "together" : "own",
    invalidIdentityRule: identityRule !== undefined && identityRule !== "own" && identityRule !== "together",
    home, harness, server: localPublicIPv4() || "this machine", tunnel: tunnel.tunnel, user: (b ? brain.BRAIN_USER_NAME : env.USER_LABEL) || undefined,
    head, model, ...(!b ? { settingSources } : {}),
    ...(b ? { operation: { effort: brain.ADAPTER_EFFORT || undefined,
      ...(brain.BRAIN_INLET_WORKER_LOG ? { inletLog: path("BRAIN_INLET_WORKER_LOG", "") } : {}),
      ...(brain.BRAIN_CALENDAR_FILE ? { calendar: path("BRAIN_CALENDAR_FILE", "") } : {}),
      ...(brain.BRAIN_CALENDAR_EXTERNAL_FILE ? { externalCalendar: path("BRAIN_CALENDAR_EXTERNAL_FILE", "") } : {}),
      ...(brain.BRAIN_FIRST_TURN_FILE ? { firstTurn: path("BRAIN_FIRST_TURN_FILE", "") } : {}),
      startupDoctor: !!brain.BRAIN_DOCTOR_CMD,
      brainDoctor: existsSync(housePath(home, "Brain/scripts/brain-doctor.ts")),
    } } : {}),
    tmux: { session: (b ? own.BRAIN_TMUX_SESSION : own.EMBERVY_TMUX_SESSION) || (b ? "brain" : "embervy"),
      socket: (b ? own.BRAIN_TMUX_SOCKET : own.EMBERVY_TMUX_SOCKET) || (b ? "brain" : "embervy") },
    ports: { app: positive(env.EMBERVY_APP_PORT, 3030, true),
      ...(head === "gpt" ? { adapter: positive(own.GPT_ADAPTER_PORT || (b ? own.BRAIN_GPT_ADAPTER_PORT : ""), b ? 3042 : 3041, true) } : {}),
      ...(on(env.EMBERVY_BROWSER) ? { browser: positive(env.EMBERVY_BROWSER_PORT, 3055, true) } : {}),
      ...(b ? { control: positive(brain.BRAIN_CONTROL_PORT, 3910, true) } : {}) },
    calendarFeed: env.EMBERVY_HOOK_CALENDAR === "1" && !!env.CALENDAR_FEED_TOKEN?.trim(),
    credentials, rooms, rescueAccess: rescueAccess(), cloudflareSignIn: cloudflare.present,
    // The installer names the key it created; a bare token of unknown purpose is no evidence of house access.
    cloudflareHouseKey: Boolean(env.EMBERVY_CF_HOUSE_KEY && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
    ...(cloudflare.present ? { cloudflareClientId: env.WRANGLER_CLIENT_ID } : {}),
    units, workers: { memory: publicUrl((b ? brain.BRAIN_MEMORY_URL : "") || env.EMBERVY_URL), rag: publicUrl((b ? brain.BRAIN_RAG_URL : "") || env.RAG_URL), app: publicUrl(env.EMBERVY_APP_URL) },
    schedules: { memory: workerScheduled(home, "shared/memory/wrangler.toml"), dream: workerScheduled(home, "shared/memory/dream-worker/wrangler.toml") },
    paths: { identity: path(b ? "BRAIN_SYSTEM" : "CLAUDE_MD", b ? "EMBERVY.md" : "CLAUDE.md"), state: path("BRAIN_STATE_DIR", b ? "Brain/state" : "state"),
      logs: path("BRAIN_LOG_DIR", b ? "Brain/logs" : "logs"), bridge: path("BRAIN_BRIDGE_FILE", b ? "Brain/logs/bridge.md" : "state/wake_bridge.md"),
      archives: path("BRAIN_SESSION_ARCHIVE_DIR", b ? "Brain/logs/sessions" : "logs"), notes: b ? path("BRAIN_NOTES_DIR", "notes") : "Claude Code project memory (managed by the CLI)",
      inbox: path("BRAIN_APP_INBOX_FILE", "Claude/app/data/inbox.jsonl"), ownMap: path("BRAIN_HOUSE_MAP_EXTRA_FILE", "HOUSE.md") },
    watchdog: { warn, cut: b ? Math.min(cut, Math.floor(window * 0.95)) : cut }, bridgeTurns: positive(own.BRAIN_BRIDGE_TURNS || own.BRIDGE_TURNS, 40),
    compaction: !b && env.EMBERVY_AUTO_COMPACT === "on" ? "on" : "off", approval: b ? brain.BRAIN_APPROVAL || "off" : "CLI permissions",
    inlet: b ? brain.BRAIN_INLET_WORKER ? "house inlet worker" : brain.BRAIN_INLET === "false" ? "off" : "built-in search" : "project UserPromptSubmit hook (see .claude/settings.json)",
    enrichment: b ? !!brain.BRAIN_HEADER_ENRICH_CMD : (() => { try { return !!(lstatSync(housePath(home, "Claude/scripts/enrich-header.sh")).mode & 0o111); } catch { return false; } })(),
    hooks: { calendar: b ? !!brain.BRAIN_CALENDAR_FILE : on(env.EMBERVY_HOOK_CALENDAR), weather: b ? !!brain.BRAIN_WEATHER_URL : on(env.EMBERVY_HOOK_WEATHER),
      browser: on(env.EMBERVY_BROWSER), cachePing: on(env.EMBERVY_CACHE_PING), reminders: b && brain.BRAIN_REMINDERS_COLLECT === "1",
      mail: !!(env.EMAIL_SENDER_URL && env.EMAIL_SENDER_AUTH) || !!(env.MAILBOX_USER &&
        (["graph", "outlook"].includes((env.MAILBOX_PROVIDER || "").toLowerCase()) ? env.MAILBOX_GRAPH_CLIENT_ID : env.MAILBOX_HOST && env.MAILBOX_APP_PASSWORD)) },
  };
  facts.overflow = reserveFacts(home, env.EMBERVY_RESERVE_FILE);
  const json = (name: string): any => {
    const text = readOptional(home, name);
    try { return JSON.parse(text); } catch { return undefined; }
  };
  facts.envFiles = [".env", "Claude/app/.env", ...(b ? ["Brain/brain.env"] : [])].filter(file => existsSync(housePath(home, file)));
  const approvalFile = b && brain.BRAIN_APPROVAL_SETTINGS ? relative(home, resolve(home, brain.BRAIN_APPROVAL_SETTINGS)) : undefined;
  const settingsFiles = [...facts.envFiles, "config/features.json", ...[headFile, approvalFile].filter((file): file is string => !!file)]
    .filter(file => existsSync(housePath(home, file)));
  facts.capabilities = capabilityFacts({ harness, env, brain, hookEnv: root, settingsFiles, headFile, approvalFile,
    ...(b ? { headState: json(headFile!), approvalLevel: approvalFile ? json(approvalFile)?.level : undefined }
      : { weatherFeature: json("config/features.json")?.weather === true }),
  });
  // Redact credentials even if a public field accidentally repeats a secret value.
  const secretValues = [root, app, brain].flatMap(e => Object.entries(e)
    .filter(([key, value]) => value && /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL|PRIVATE|CALENDAR_ICS_URLS/.test(key)).map(([, value]) => value));
  const secrets = [...new Set([...secretValues, ...cloudflare.secrets, ...tunnel.secrets, ...roomConfigs.map(room => room.token), ...peers.map(peer => peer.token)])].sort((a, z) => z.length - a.length);
  const redact = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  return { facts, redact };
}

export function checkCapabilitiesFile(home: string): string[] {
  const { facts } = collectFacts(home, { queryUnits: false });
  return checkCapabilities(readOptional(facts.home, "CAPABILITIES.md"), facts);
}

export function handbookVars(f: HouseFacts): HandbookVars {
  return { IDENTITY_RULE: f.identityRule || "own", HOME: f.home, SERVER: f.server, USER: f.user, HEAD: `${f.head} (${f.model})`, MEMORY_TOOLS: "named `mcp__lore__<name>`",
    WARN: tokenCount(f.watchdog.warn), CUT: tokenCount(f.watchdog.cut), BRIDGE_TURNS: String(f.bridgeTurns), COMPACTION: f.compaction,
    REPLY_TOOL: "mcp__app__reply", DOCTOR: `bun ${f.home}/shared/tools/embervy-doctor.ts`, OWN_MAP: f.paths.ownMap,
    TMUX: f.tmux.session, TMUX_SOCKET: f.tmux.socket, APP_UNIT: f.units.find(u => u.role === "app")?.name || "APP_UNIT_NOT_CONFIGURED",
    APP_PORT: String(f.ports.app),
    ...(f.head === "gpt" && f.ports.adapter ? { GPT_PORT: String(f.ports.adapter), BRAIN_ADAPTER_PORT: String(f.ports.adapter) } : {}),
    BRAIN_CONTROL_PORT: String(f.ports.control || 3910), BROWSER_PORT: String(f.ports.browser || ""),
    BROWSER: f.hooks.browser, LOGS: f.paths.logs, CALENDAR_FEED: f.calendarFeed, RESCUE_ACCESS: f.rescueAccess,
    MEMORY_SCHEDULED: f.schedules?.memory, DREAM_SCHEDULED: f.schedules?.dream,
    CLOUDFLARE_SIGNIN: f.cloudflareSignIn, CLOUDFLARE_CLIENT_ID: f.cloudflareClientId, CLOUDFLARE_HOUSE_KEY: f.cloudflareHouseKey };
}

export interface FactsRecord {
  identityRule?: IdentityRule;
  version: 1;
  harness: Harness;
  head: string;
  tmux: HouseFacts["tmux"];
  ports: HouseFacts["ports"];
  units: HouseFacts["units"];
  modules: { calendar: boolean; weather: boolean; browser: boolean; cachePing: boolean; reminders: boolean; mail: boolean; rooms: Record<string, boolean> };
  credentials: Record<string, boolean>;
  capabilities?: Record<string, boolean>;
}

export function factsRecord(f: HouseFacts): FactsRecord {
  return { version: 1, identityRule: f.identityRule || "own", harness: f.harness, head: f.head, tmux: f.tmux, ports: f.ports, units: f.units,
    modules: { ...f.hooks, mail: !!f.hooks.mail, rooms: f.rooms || {} }, credentials: f.credentials || {},
    capabilities: Object.fromEntries((f.capabilities || []).map(c => [c.name, c.enabled])) };
}

type FactValue = string | number | boolean;
type Fact = { value: FactValue; kind: "setting" | "module" | "credential" };
function factEntries(f: FactsRecord): Map<string, Fact> {
  const entries = new Map<string, Fact>();
  const add = (key: string, value: FactValue, kind: Fact["kind"] = "setting") => entries.set(key, { value, kind });
  add("harness", f.harness); add("head", f.head);
  add("EMBERVY_IDENTITY_RULE", f.identityRule || "own");
  add("tmux session", f.tmux.session); add("tmux socket", f.tmux.socket);
  for (const [key, port] of Object.entries(f.ports)) {
    // Older records carried a dormant adapter port even for native heads.
    if (key === "adapter" && f.head !== "gpt") continue;
    add(`${key} port`, port);
  }
  for (const unit of f.units) {
    add(`unit ${unit.name}`, unit.role);
    add(`unit ${unit.name} active`, unit.active); add(`unit ${unit.name} enabled`, unit.enabled);
  }
  for (const [key, value] of Object.entries(f.modules)) {
    if (key === "rooms") continue;
    add(key === "cachePing" ? "cache ping" : key, value as boolean, "module");
  }
  for (const [name, enabled] of Object.entries(f.modules.rooms)) add(`room ${name}`, enabled, "module");
  for (const [key, set] of Object.entries(f.credentials)) add(key, set, "credential");
  for (const [name, enabled] of Object.entries(f.capabilities || {})) add(`capability ${name}`, enabled, "module");
  return entries;
}

function parseRecord(text: string): FactsRecord {
  try {
    const f = JSON.parse(text);
    const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
    const booleans = (v: any) => object(v) && Object.values(v).every(x => typeof x === "boolean");
    if (f.version !== 1 || !["brain", "claude-code"].includes(f.harness) || typeof f.head !== "string"
      || (f.identityRule !== undefined && !["own", "together"].includes(f.identityRule))
      || !object(f.tmux) || typeof f.tmux.session !== "string" || typeof f.tmux.socket !== "string"
      || !object(f.ports) || !Number.isInteger(f.ports.app) || (f.head === "gpt" && !Number.isInteger(f.ports.adapter))
      || !Object.entries(f.ports).every(([key, n]) => ["app", "adapter", "browser", "control"].includes(key) && Number.isInteger(n) && Number(n) > 0 && Number(n) <= 65535)
      || !Array.isArray(f.units) || !f.units.every((u: any) => object(u) && ["role", "name", "active", "enabled"].every(key => typeof u[key] === "string"))
      || !object(f.modules) || !["calendar", "weather", "browser", "cachePing", "reminders", "mail"].every(key => typeof f.modules[key] === "boolean")
      || !booleans(f.modules.rooms) || !booleans(f.credentials)
      || (f.capabilities !== undefined && !booleans(f.capabilities))) throw new Error();
    return f;
  } catch { throw new Error("house-docs: invalid state/house-docs-facts.json; use --write to record facts"); }
}

function factWords(fact?: Fact): string {
  if (!fact) return "not configured";
  if (fact.kind === "credential") return fact.value ? "set" : "not set";
  if (fact.kind === "module") return fact.value ? "on" : "off";
  return String(fact.value);
}

export function compareFacts(before: FactsRecord, now: FactsRecord): string[] {
  const old = factEntries(before), current = factEntries(now), lines: string[] = [];
  for (const key of new Set([...old.keys(), ...current.keys()])) {
    // The head change already reports entering or leaving the adapter path.
    if (key === "adapter port" && before.head !== now.head) continue;
    let a = old.get(key), z = current.get(key);
    const kind = (z || a)!.kind;
    // Removing an assignment unsets a credential or disables a named room.
    if (kind !== "setting") { a ||= { kind, value: false }; z ||= { kind, value: false }; }
    if (a?.value === z?.value) continue;
    lines.push(kind === "credential" ? `${key}: was ${factWords(a)}, now ${factWords(z)}` : `${key}: ${factWords(a)} → ${factWords(z)}`);
  }
  return lines;
}

type Claim = { key: string; value: FactValue; line: number };
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function documentClaims(text: string, current: Map<string, Fact>): Claim[] {
  const claims: Claim[] = [];
  let fence = "", comment = false, heading = "", approvalList = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const marker = raw.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = ""; return; }
    if (fence) return;
    if (raw.includes("<!--")) comment = true;
    if (comment) { if (raw.includes("-->")) comment = false; return; }
    const section = /^\s*##\s+(.+?)\s*#*\s*$/.exec(raw);
    if (section) { heading = section[1].toLowerCase().replace(/\s+/g, " "); approvalList = false; }
    const line = raw.replace(/[`*]/g, "").replace(/^\s*(?:[-+]\s+|\d+\.\s+)?/, "").trim();
    if (heading === "modules enabled" && /^\s*[-*+]\s+/.test(raw)) {
      const module = line.toLowerCase().replace(/_/g, " ");
      const key = module === "weather" && current.has("capability Weather") ? "capability Weather"
        : module === "cache ping" && current.has("capability Cache ping") ? "capability Cache ping" : module;
      if (current.get(key)?.kind === "module") claims.push({ key, value: true, line: index + 1 });
    }
    const add = (key: string, value: FactValue) => claims.push({ key, value, line: index + 1 });
    // The default identity paragraph also contains a conditional instruction, not a conditional rule.
    for (const sentence of line.split(/(?<=[.!])\s+/)) {
      if (/\?|\b(?:if|unless|example|choose|when|would|could|should)\b/i.test(sentence)) continue;
      if (/^(?:Your identity file is yours[.!]|The identity file belongs to (?:you|the agent)[.;])/i.test(sentence)) add("EMBERVY_IDENTITY_RULE", "own");
      if (/^(?:Your|The) identity(?: file)? is written together\b.*\bchanged only with\b/i.test(sentence)) add("EMBERVY_IDENTITY_RULE", "together");
    }
    if (/^5\.\s/.test(heading) && /^You need .+['’]s okay for:$/.test(line)) approvalList = true;
    else if (line && !/^\s*[-*+]\s/.test(raw)) approvalList = false;
    if (approvalList && /^changes to your identity file[;.]?$/i.test(line)) add("EMBERVY_IDENTITY_RULE", "together");
    const identitySetting = /^Identity rule:\s*EMBERVY_IDENTITY_RULE=(own|together)(?=[\s.;]|$)/.exec(line);
    if (identitySetting) add("EMBERVY_IDENTITY_RULE", identitySetting[1]);
    // Questions, conditions and examples do not assert the installation's state.
    if (/\?|\b(?:if|unless|example|choose|when|would|could|should)\b/i.test(line)) return;
    const clauses = line.split(/;\s*|\.\s+(?=[A-Z])/);
    for (const clause of clauses) {
      const scoped = clause.match(/^(Brain|Claude Code)\s+(weather|cachePing):\s*(on|off)(?=[\s.,;!]|$)/i);
      if (scoped && current.get("harness")?.value === (scoped[1].toLowerCase() === "brain" ? "brain" : "claude-code")) {
        const capability = `capability ${scoped[2].toLowerCase() === "weather" ? "Weather" : "Cache ping"}`;
        const legacy = scoped[2].toLowerCase() === "weather" ? "weather" : "cache ping";
        add(current.has(capability) ? capability : legacy, scoped[3].toLowerCase() === "on");
      }
      const room = clause.match(/^room\s+([\p{L}\p{N} _-]{1,40})\s*:\s*(on|off|enabled|disabled)(?=[\s.,;!]|$)/iu);
      if (room) add(`room ${room[1].trim()}`, /^(?:on|enabled)$/i.test(room[2]));
      for (const [key, fact] of current) {
        if (fact.kind === "module" && key.startsWith("room ")) continue;
        if (fact.kind === "credential" || fact.kind === "module") {
          const name = key === "cache ping" ? "cache\\s*ping" : escapePattern(key);
          const state = fact.kind === "credential" ? "(not set|missing|set)" : "(on|off|enabled|disabled)";
          const pattern = new RegExp(`^(?:the\\s+)?${name}(?:\\s+(?:key|module))?\\s*(?::|=|is|—|-)\\s*${state}(?=[\\s.,;!]|$)`, "i");
          const match = clause.match(pattern);
          if (match) add(key, /^(?:set|on|enabled)$/i.test(match[1]));
        }
      }
      const ports: [string, string][] = [
        ["app port", "(?:your |the |local |your local )?app"],
        ["adapter port", "(?:the )?(?:subscription |chatgpt |gpt )?adapter"],
        ["browser port", "(?:the )?browser(?: daemon)?"],
        ["control port", "(?:the )?(?:brain )?control(?: endpoint)?"],
      ];
      for (const [key, service] of ports) {
        const pattern = new RegExp(`(?:^|\\band (?:the )?)${service}\\s+(?:port\\s*[:=]?|(?:listens on|uses|on|:|—)\\s+(?:loopback )?port)\\s*(\\d{1,5})\\b`, "i");
        const match = clause.match(pattern);
        if (match) add(key, Number(match[1]));
      }
      const harness = clause.match(/^harness\s*:\s*(Brain|Claude Code)\b/i);
      if (harness) add("harness", harness[1].toLowerCase() === "brain" ? "brain" : "claude-code");
      const head = clause.match(/^configured head:\s*([\w-]+)\s*$/i);
      if (head) add("head", head[1]);
      const tmux = clause.match(/^(?:your )?tmux (session|socket)(?: is|:)\s*([\w.@/-]+)\s*[.!]?$/i);
      if (tmux) add(`tmux ${tmux[1].toLowerCase()}`, tmux[2].replace(/[.!]$/, ""));
      const socket = clause.match(/^socket:\s*([\w.@/-]+)(?:\s|$)/i);
      if (socket) add("tmux socket", socket[1]);
      const unit = clause.match(/^([\w.@:-]+\.(?:service|timer|socket))\s*—\s*([\w-]+);?$/);
      if (unit) add(`unit ${unit[1]}`, unit[2]);
    }
    const unitState = line.match(/^([\w.@:-]+\.(?:service|timer|socket))\s*—\s*[\w-]+;\s*active:\s*([a-z-]+);\s*enabled:\s*([a-z-]+)\s*$/);
    if (unitState) { add(`unit ${unitState[1]} active`, unitState[2]); add(`unit ${unitState[1]} enabled`, unitState[3]); }
  });
  return claims;
}

export function checkDocumentClaims(text: string, now: FactsRecord, keptHeading?: string): string[] {
  const current = factEntries(now);
  for (const key of text.match(/\b[A-Z][A-Z0-9_]+\b/g) || []) {
    if (credentialKey(key) && !current.has(key)) current.set(key, { kind: "credential", value: false });
  }
  return documentClaims(text, current).flatMap(claim => {
    const fact = current.get(claim.key) || (claim.key.startsWith("room ") ? { kind: "module", value: false } as Fact : undefined);
    if (fact?.value === claim.value) return [];
    if (keptHeading !== undefined) return [`kept section ${keptHeading}: ${claim.key}: contradicts house configuration`];
    const said = { value: claim.value, kind: fact?.kind || "setting" } as Fact;
    return [`${claim.line}: ${claim.key}: document says ${factWords(said)}, now ${factWords(fact)}`];
  });
}

type DocumentSection = { heading: string; start: number; end: number; text: string };
const keptMarker = (name: string) => `<!-- kept from the previous ${name}: house-docs does not generate these sections -->`;

function documentSections(text: string, name: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  let offset = 0, fence = "", fenceLength = 0, comment = false;
  let current: DocumentSection | undefined;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const line = raw.replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!comment && marker) {
      if (!fence) { fence = marker[1][0]; fenceLength = marker[1].length; }
      else if (marker[1][0] === fence && marker[1].length >= fenceLength && !marker[2].trim()) fence = "";
    } else if (!fence) {
      const heading = !comment && /^ {0,3}##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (heading || (!comment && line === keptMarker(name))) {
        if (current) current.end = offset;
        current = heading ? { heading: heading[1], start: offset, end: text.length, text: "" } : undefined;
        if (current) sections.push(current);
      }
      for (const token of line.match(/<!--|-->/g) || []) comment = token === "<!--";
    }
    offset += raw.length;
  }
  return sections.map(section => ({ ...section, text: text.slice(section.start, section.end) }));
}

function sectionKey(heading: string, user?: string): string {
  let key = heading.toLowerCase().replace(/\s+/g, " ").trim();
  const number = /^(\d+)\s*\./.exec(key);
  if (number) return `section ${Number(number[1])}`;
  if (user?.trim()) key = key.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(user.toLowerCase().trim().replace(/\s+/g, " "))}(?![\\p{L}\\p{N}_])`, "gu"), "your user");
  return key;
}

function agentKept(section: DocumentSection): boolean {
  return /^[^\n]*\r?\n<!-- kept by the agent -->(?:\r?\n|$)/.test(section.text);
}

function keptSections(previous: string, generated: string, name: string, user?: string): DocumentSection[] {
  const headings = new Set(documentSections(generated, name).map(section => sectionKey(section.heading, user)));
  return documentSections(previous, name).filter(section => agentKept(section) || !headings.has(sectionKey(section.heading, user)));
}

function mergeSections(previous: string, generated: string, name: string, user?: string): string {
  const old = documentSections(previous, name);
  const kept = keptSections(previous, generated, name, user);
  if (!old.some(agentKept)) return generated + (kept.length ? "\n" + keptMarker(name) + "\n\n" + kept.map(section => section.text).join("") : "");
  const fresh = documentSections(generated, name);
  const key = (section: DocumentSection) => sectionKey(section.heading, user);
  const markedKeys = new Set(old.filter(agentKept).map(key));
  const emitted = new Set<string>();
  let out = generated.slice(0, fresh[0]?.start ?? generated.length);
  const append = (section: DocumentSection) => {
    if (out && !out.endsWith("\n")) out += "\n";
    out += section.text;
    emitted.add(key(section));
  };
  for (const section of old) {
    const index = fresh.findIndex(candidate => key(candidate) === key(section));
    if (agentKept(section)) append(section);
    else if (!markedKeys.has(key(section)) && !emitted.has(key(section))) append(index < 0 ? section : fresh[index]);
  }
  for (const section of fresh) if (!emitted.has(key(section))) append(section);
  return out;
}

function writePrivate(path: string, text: string, exclusive = false): boolean {
  const temp = path + ".house-docs-" + crypto.randomUUID();
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
    chmodSync(temp, 0o600);
    if (exclusive) {
      try { linkSync(temp, path); }
      catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
    } else renameSync(temp, path);
    return true;
  } finally { try { unlinkSync(temp); } catch { /* Renamed files have no temporary path. */ } }
}

export function main(args = process.argv.slice(2)): number {
  let home: string | undefined, write = false, check = false, capabilities = false, onlyCapabilities = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--home" && args[i + 1] && !args[i + 1].startsWith("--")) home = args[++i];
    else if (args[i] === "--write") write = true;
    else if (args[i] === "--check") check = true;
    else if (args[i] === "--capabilities") capabilities = true;
    else if (args[i] === "--only" || args[i].startsWith("--only=")) {
      const value = args[i] === "--only" ? args[++i] : args[i].slice("--only=".length);
      if (value !== "capabilities") throw new Error("house-docs: --only accepts only capabilities");
      onlyCapabilities = true;
    }
    else throw new Error("Usage: bun shared/tools/house-docs.ts --home <EMBERVY_HOME> [--write] [--check] [--only capabilities] [--capabilities]");
  }
  if (!home) throw new Error("house-docs: --home is required");
  if (capabilities && (write || check)) throw new Error("house-docs: --capabilities cannot be combined with --write or --check");
  if (onlyCapabilities && (capabilities || (!write && !check))) throw new Error("house-docs: --only capabilities requires --write or --check, without --capabilities");
  const { facts, redact } = collectFacts(home);
  if (capabilities) { console.log(renderCapabilities(facts).trimEnd()); return 0; }
  if (onlyCapabilities) {
    const path = housePath(facts.home, "CAPABILITIES.md");
    if (check) {
      const differences = existsSync(path)
        ? checkCapabilities(readOptional(facts.home, "CAPABILITIES.md"), facts)
        : ["missing document"];
      for (const line of differences) console.log(redact(`CAPABILITIES.md: ${line}`));
      if (!differences.length) console.log("house-docs: no fact differences");
      return differences.length ? 1 : 0;
    }
    const written = writePrivate(path, renderCapabilities(facts), true);
    console.log(`CAPABILITIES.md: ${written ? "written (0600)" : "kept (agent-owned)"}`);
    return 0;
  }
  const docs = { "HANDBOOK.md": redact(renderHandbook(handbookVars(facts), facts.harness)), "INFRASTRUCTURE.md": redact(renderInfrastructure(facts)), "CAPABILITIES.md": renderCapabilities(facts) };
  // A rejected destination must not leave a partially written set of documents.
  const paths = Object.fromEntries(Object.keys(docs).map(name => [name, housePath(facts.home, name)]));
  const previous = Object.fromEntries(["HANDBOOK.md", "INFRASTRUCTURE.md"].map(name => [name, readOptional(facts.home, name)]));
  const kept = Object.fromEntries(Object.entries(previous).map(([name, text]) => [name, keptSections(text, docs[name as keyof typeof docs], name, facts.user)]));
  const recordName = "state/house-docs-facts.json";
  const recordPath = housePath(facts.home, recordName);
  // Redact string fields before serialization so a short secret cannot corrupt JSON numbers or booleans.
  const current: FactsRecord = JSON.parse(JSON.stringify(factsRecord(facts), (_key, value) => typeof value === "string" ? redact(value) : value));
  current.modules.rooms = Object.fromEntries(Object.entries(current.modules.rooms).map(([name, on]) => [redact(name), on]));
  current.credentials = Object.fromEntries(Object.entries(current.credentials).map(([key, set]) => [redact(key), set]));
  if (check) {
    const recorded = readOptional(facts.home, recordName);
    const differences: string[] = facts.invalidIdentityRule
      ? ["EMBERVY_IDENTITY_RULE: unrecognised setting; using own"] : [];
    if (recorded) differences.push(...compareFacts(parseRecord(recorded), current));
    else console.log(`${recordName}: no recorded facts; checking document claims against facts the documents would contain now`);
    for (const name of Object.keys(docs)) {
      if (!existsSync(paths[name])) differences.push(`${name}: missing document`);
      else if (name === "CAPABILITIES.md") differences.push(...checkCapabilities(readOptional(facts.home, name), facts).map(line => `${name}: ${line}`));
      else {
        for (const section of kept[name]) console.log(redact(`${name}: kept section: ${section.heading}${agentKept(section) ? " (kept by the agent)" : ""}`));
        for (const section of kept[name]) differences.push(...checkDocumentClaims(section.text, current, section.heading).map(line => `${name}: ${line}`));
        // Kept prose reports the section and fact, never the source line.
        let claims = previous[name];
        for (const section of [...kept[name]].reverse()) claims = claims.slice(0, section.start)
          + section.text.replace(/[^\r\n]/g, " ") + claims.slice(section.end);
        differences.push(...checkDocumentClaims(claims, current).map(line => `${name}:${line}`));
      }
    }
    // Claim diagnostics contain only recognized facts, never the source line.
    for (const line of differences) console.log(redact(line));
    if (!differences.length) console.log("house-docs: no fact differences");
    return differences.length ? 1 : 0;
  }
  for (const [name, sections] of Object.entries(kept)) {
    if (!sections.length) continue;
    const text = sections.map(section => section.text).join("");
    // Refuse rather than rewrite a kept section or copy a known credential.
    if (write && redact(text) !== text) throw new Error("house-docs: kept sections contain configured credentials; move them to private configuration before --write");
    docs[name as keyof typeof docs] = redact(mergeSections(previous[name], docs[name as keyof typeof docs], name, facts.user));
  }
  if (write) {
    mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(docs)) {
      const written = writePrivate(paths[name], text, name === "CAPABILITIES.md");
      console.log(`${name}: ${written ? "written (0600)" : "kept (agent-owned)"}`);
    }
    writePrivate(recordPath, JSON.stringify(current, null, 2) + "\n");
    console.log(`${recordName}: written (0600)`);
  } else for (const [name, text] of Object.entries(docs)) console.log(`--- ${name} ---\n${text}`);
  return 0;
}

if (import.meta.main) {
  try { process.exitCode = main(); }
  catch (err: any) { console.error(err.message?.startsWith("house-docs:") || err.message?.startsWith("Usage:") ? err.message : "house-docs: could not build documents from this house"); process.exitCode = 2; }
}
