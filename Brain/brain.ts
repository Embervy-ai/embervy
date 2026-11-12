#!/usr/bin/env bun
/**
 * Brain: the agent's conversation runtime.
 *
 * Runs one conversation with one model at a time: the model's turns, its
 * tools, retrieval before each message and the session archive. Every
 * external connection is opt-in through a BRAIN_* variable; with only a model
 * endpoint configured, it works without memory.
 *
 * When the context fills up, the session is cut: the process writes a bridge
 * and an archive and exits, and the restart loop starts a fresh process that
 * loads the bridge.
 */

import {
  appendFileSync,
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { LiveTokensSnapshot } from "./live-tokens";
import { readPendingUploads, writePendingUploads, type PendingUpload } from "./pending-uploads";
import { freshZoneCut } from "./fresh-zone";
import { splitArchive } from "./rag-split";
import { ToolRecordPolicy } from "./pipe-canonical";
import { isCliNoOutputPrompt, ClaudePipe, pipeWatchdogTokens, anthropicUsage, UNKNOWN_MODEL, usageNumber, type PipeUsageSample, type UsageTokens, type UsageSource, type SelfTurnEvent, type SelfTurnKind, type SendResult } from "./claude-pipe";
import { brainTimezone } from "./time-marks";
import { ClaudeAuthExpiredError, credentialsPath, credentialsStamp, writeClaudeAuthState, type ClaudeAuthProfile } from "./claude-auth";
import { firstLoggedAt, firstMessageAtInLog, localDateKey, noteLoggedAt } from "./archive-date";
import { tr, brainLocale } from "./texts";
import { approvalMatch, createApprovalSettingsReader, loadApprovalRules } from "./approval-rules";
import { catchUpArchiveName, readArchiveLedger, recordArchive, seedArchiveLedger, type ArchiveReceipt } from "./archive-ledger";
import { houseCheckBlock, houseCheckMessage, runStartupDoctor, type HouseFinding } from "./house-check";
import { approvalSettingsArg, pipeApprovalMatch, type ApprovalHookOptions } from "./approval-hook";
import { sweepOrphanedClaudePipeTempDirs } from "./secure-temp";
import { formatToolUse, formatHelperActivity, formatHelperCount, liveViewEnabled, isTerminalReply, toolLogPreview, type HelperActivity } from "./live-view";
import { residentTaskActivity, type ResidentTaskEntry } from "./resident-tasks";
import { addPin, initialPinsState, listActivePins, PinLimitError, PinTtlError, removePin, renderPinBlock, type PinsState } from "./pins";
import { loadPinsAny, renderHousePinBlock, savePinsAny, type PinsFormat } from "./pins-house";
import type { DriftGuardState } from "./drift-guard";
import { HEAD_NAMES, cachePingMinutes, validateTargetEffort, birthEffort, effortLevelsFor, gptServedModelMatches, headChoices, headChoicesText, catalogModel, headEffortSupport, modelMatches, parseEffort, parseHeadCommand, pipeUnsetEnv, requestEffort, resolveHead, resolveHeadChoice, systemPromptMode, watchdogThresholds, WATCHDOG_CUT_CEILING, type HeadSpec, type Transport, type WatchdogThresholds } from "./heads";
import {
  appendDueReminders, lateReminders, markRemindersDelivered, readCalendars, readFreshWarning, readPendingReminders, renderSense,
  REMINDER_TAG, reminderEscalationText, weatherCacheFromOpenMeteo, weatherLine, type SenseState, type WeatherCache,
} from "./sense";
import { appMcpServer, appBroadcast, appReplySpeech, isAppReplyTool, askApproval, channelTag, commitCursor, inboxConsoleLine, isForeignEntry, isPeerTool, isRoomTool, loadCursor, toolCallSpeech, readInbox, saveCursor, inboxBatchBytes, type InboxCursor } from "./app-channel";
import { createBrainEcho, isBrainEcho } from "./echo";
import { ModelCatalogCache, modelsListRequest, probeClaudeModels, probeGptModels, probeListModels, type CatalogReadMode, type ModelInfo } from "./head-models";
import { accountSeamFromEnv, type RateLimitInfo } from "./account";
import { headFile } from "./head-file";
import { projectionSeamFromEnv } from "./projection";
import { isScheduledTurn, roomUserSpeaker, outreachSpeech, isMailCall, toolOutreachDelivered, resolveOutreachRecords } from "./wake-bridge";
import { jumpSeamFromEnv } from "./jump";
import { ALIASES } from "./aliases";
import { checkParallel, claimLock, lockFileFromEnv } from "./lock";
import { loadMcpConfig, prefixedToolName, splitPrefixedToolName, StdioMcpClient } from "./mcp-stdio";
import { houseCapabilities, houseMapExtra, renderHouseMap } from "./house-map";
import { loadSystemPromptExtras } from "./system-prompt";
import { startAuthenticatedControlEndpoint } from "./control-endpoint";
import {
  buildCompletionMessage, dispatchResidentTool, jailResolve as residentJailResolve, RESIDENT_TOOL_NAMES, residentToolDefs, shellEnv, TaskRegistry, type ResidentConfig,
} from "./resident-tools";
import {
  birthRebuildNeeded, bridgeCapBytes, CACHE_PING_ORIGIN, captureJumpIfForeign, clipBridge, finishWakeBridge, fitBirthMaterial, isCachePingRecord, markOwnBridge, numberLine, SCHEDULED_SPEAKER, tailWholeTurns, writeWakeBridgeSync,
  type BridgeMode, type CutInfo, type WakeBridgeConfig, type WakeBuilt,
} from "./wake-bridge";
import { mergeDisallowedTools, pipeWebWiring, runWebTool, WEB_TOOL_NAMES, webConfigFromEnv, webStatusLine, webToolDefs, webToolPlan, type WebToolPlan } from "./web-tools";
import { adapterCacheKey, adapterKnobMismatches, adapterPlanFromUnit, adapterUnitArgs, adapterUnitName, assessAdapter, createAdapterGate, ensureGptAdapterReady, gptAdapterContract, headStateCommit, snapshotFileBytes, headStateFor, isGptConnectionFailure, LEGACY_ADAPTER, loadHeadState, prepareMove, type AdapterContract, type AdapterPaths, type AdapterProbe, type AdapterStartPlan, type AdapterUnitSnapshot, type HeadState, type HeadStateCommit } from "./move";

const HERE = dirname(fileURLToPath(import.meta.url));

const fileEnvAtStartup = new Map<string, string>();
function loadEnv(path: string, only?: Set<string>, target: Record<string, string | undefined> = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    if (only && (!only.has(match[1]) || match[1].startsWith("ANTHROPIC_"))) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const explicitLockOff = match[1] === "BRAIN_LOCK_FILE" && target[match[1]] === "";
    if (!explicitLockOff && !target[match[1]]?.trim() && (value.trim() || match[1] === "BRAIN_LOCK_FILE")) {
      target[match[1]] = value;
      if (target === process.env) fileEnvAtStartup.set(match[1], value);
    }
  }
}

function loadConfiguredEnv(target: Record<string, string | undefined>): void {
  if (target.BRAIN_NO_ENV_FILE === "1") return;
  const explicit = target.BRAIN_ENV_FILE?.trim();
  loadEnv(explicit || join(HERE, "brain.env"), undefined, target);
  if (!explicit) loadEnv(join(HERE, ".env"), undefined, target);
  if (target.BRAIN_EXTRA_ENV_FILE) loadEnv(target.BRAIN_EXTRA_ENV_FILE, undefined, target);
  // Restricted imports must never turn a subscription pipe into API billing.
  const keys = (target.BRAIN_IMPORT_ENV_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (target.BRAIN_IMPORT_ENV_FILE && keys.length) loadEnv(target.BRAIN_IMPORT_ENV_FILE, new Set(keys), target);
}

export function adoptLoopFileKeys(env: Record<string, string | undefined> = process.env): void {
  for (const key of (env.BRAIN_ENV_FILE_KEYS ?? "").split(/\s+/)) {
    const value = key ? env[key] : undefined;
    if (value !== undefined) fileEnvAtStartup.set(key, value);
  }
}
adoptLoopFileKeys();
loadConfiguredEnv(process.env);
ALIASES.env(process.env);

export function headEnvironment(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const [key, value] of fileEnvAtStartup) if (env[key] === value) delete env[key];
  loadConfiguredEnv(env);
  ALIASES.env(env);
  return env;
}

const API_KEY = process.env.BRAIN_API_KEY ?? "";
const ENDPOINT = process.env.BRAIN_ENDPOINT ?? "";
const DEFAULT_MODEL = process.env.BRAIN_MODEL ?? "worker-model";
const SYSTEM_PROMPT_FILE = process.env.BRAIN_SYSTEM ?? join(HERE, "system_prompt.md");
const MEMORY_URL = process.env.BRAIN_MEMORY_URL ?? "";
const MEMORY_KEY = process.env.BRAIN_MEMORY_API_KEY ?? "";
const TEMPERATURE_RAW = (process.env.BRAIN_TEMPERATURE ?? "").trim();
const TEMPERATURE_VALUE = Number(TEMPERATURE_RAW);
const TEMPERATURE = TEMPERATURE_RAW && Number.isFinite(TEMPERATURE_VALUE) ? TEMPERATURE_VALUE : undefined;
if (TEMPERATURE_RAW && TEMPERATURE === undefined) console.warn("brain: invalid BRAIN_TEMPERATURE ignored; using the provider default");
const MAX_TOOL_HOPS = Number.parseInt(process.env.BRAIN_MAX_TOOL_HOPS ?? "12", 10);
const INLET_ENABLED = (process.env.BRAIN_INLET ?? "true").toLowerCase() === "true";
// Keep each turn's retrieved context attached to its user message in later
// requests. Otherwise that message changes shape after it was sent, the shared
// prefix breaks there, and the prompt cache never carries across turns.
const INLET_PERSIST = (process.env.BRAIN_INLET_PERSIST ?? "true").toLowerCase() === "true";
const WORKER_NAME = process.env.BRAIN_WORKER_NAME ?? "Worker";
const USER_NAME = process.env.BRAIN_USER_NAME ?? "User";
const LOG_DIR = process.env.BRAIN_LOG_DIR ?? join(HERE, "logs");
const RAG_URL = process.env.BRAIN_RAG_URL ?? "";
const RAG_AUTH_TOKEN = process.env.BRAIN_RAG_AUTH_TOKEN ?? "";
const RAG_FILENAME_PREFIX = process.env.BRAIN_RAG_FILENAME_PREFIX ?? "";
const ROLLING_TOKENS = Number.parseInt(process.env.BRAIN_ROLLING_TOKENS ?? "0", 10);
const ROLLING_KEEP_VALUE = Number(process.env.BRAIN_ROLLING_KEEP_TOKENS);
const ROLLING_KEEP_DEFAULT = Math.floor(ROLLING_TOKENS / 2);
const ROLLING_KEEP_TOKENS = Number.isFinite(ROLLING_KEEP_VALUE) && ROLLING_KEEP_VALUE > 0 && ROLLING_KEEP_VALUE < ROLLING_TOKENS
  ? ROLLING_KEEP_VALUE : ROLLING_KEEP_DEFAULT;
let rollingKeepFallbackLogged = false;
const ROLLING_SEGMENT_VALUE = Number(process.env.BRAIN_ROLLING_SEGMENT_TOKENS);
const ROLLING_SEGMENT_TOKENS = Number.isFinite(ROLLING_SEGMENT_VALUE) && ROLLING_SEGMENT_VALUE > 0 ? ROLLING_SEGMENT_VALUE : 0;
const WORKSPACE_READ = process.env.BRAIN_WORKSPACE_READ ?? "";
const WRITE_LIST_PATH = process.env.BRAIN_WORKSPACE_WRITE_LIST ?? "";
const WRITE_BACKUP_DIR = process.env.BRAIN_WORKSPACE_BACKUP_DIR ?? join(HERE, "backups");
const SELF_FILE = process.env.BRAIN_SELF_FILE ?? join(HERE, "self.md");
const USER_FILE = process.env.BRAIN_USER_FILE ?? join(HERE, "user.md");
export const WEB = webConfigFromEnv(process.env, HERE);
const BRIDGE_FILE = process.env.BRAIN_BRIDGE_FILE ?? join(LOG_DIR, "bridge.md");
// Fresh tool context is opt-in so the normal bridge contains only cleaned turns.
export const FRESH_CHARS_DEFAULT = 0;
function freshCharsFrom(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? Math.max(0, n) : FRESH_CHARS_DEFAULT;
}
export function bridgeShape(env: Record<string, string | undefined> = headEnvironment()): {
  mode: BridgeMode; sessions: number; turns: number; minUserTurns: number; freshChars: number;
} {
  return {
    mode: (env.BRAIN_BRIDGE_MODE ?? "turns").trim().toLowerCase() === "sessions" ? "sessions" : "turns",
    sessions: Math.max(1, Number.parseInt(env.BRAIN_BRIDGE_SESSIONS ?? "2", 10) || 2),
    turns: Number.parseInt(env.BRAIN_BRIDGE_TURNS ?? "40", 10),
    minUserTurns: Math.max(0, Number.parseInt(env.BRAIN_BRIDGE_MIN_USER_TURNS ?? "8", 10) || 0),
    freshChars: freshCharsFrom(env.BRAIN_BRIDGE_FRESH_CHARS),
  };
}
const BRIDGE_NO_BRIDGE_MARKER = process.env.BRAIN_BRIDGE_NO_BRIDGE_MARKER ?? "";
const SESSION_NAME_OVERRIDE = process.env.BRAIN_SESSION_NAME ?? "";
const MIN_TURNS_FOR_UPLOAD = Math.max(1, Number.parseInt(process.env.BRAIN_MIN_TURNS_FOR_UPLOAD ?? "1", 10) || 1);
const REQUEST_TIMEOUT_MIN = Number(process.env.BRAIN_REQUEST_TIMEOUT_MIN ?? "30");
const SESSION_ARCHIVE_DIR = process.env.BRAIN_SESSION_ARCHIVE_DIR ?? join(LOG_DIR, "sessions");

const STERILE = process.env.BRAIN_STERILE === "1";
const STATE_DIR = process.env.BRAIN_STATE_DIR ?? join(HERE, "state");
const SESSION_PREFIX = (process.env.BRAIN_SESSION_PREFIX ?? "Session").trim() || "Session";
const ARCHIVE_PARK_DIR = process.env.BRAIN_ARCHIVE_PARK_DIR ?? "";
const HEADER_ENRICH_CMD = (process.env.BRAIN_HEADER_ENRICH_CMD ?? "").trim();
const HEADER_ENRICH_TIMEOUT_MS = 90_000;
export const PINS_FILE = process.env.BRAIN_PINS_FILE ?? join(STATE_DIR, "pins.json");
const PINS_FORMAT: PinsFormat = process.env.BRAIN_PINS_FORMAT === "house" ? "house" : "brain";
const CONTEXT_STATE_FILE = process.env.BRAIN_CONTEXT_STATE_FILE ?? join(STATE_DIR, "brain_context.json");
const CONTEXT_WARNING_FILE = process.env.BRAIN_CONTEXT_WARNING_FILE ?? join(STATE_DIR, "context_warning");
const PROCESS_STARTED_MS = Date.now();
const EFFORT_FILE = process.env.BRAIN_EFFORT_FILE ?? join(STATE_DIR, "brain-effort.json");
const HEAD_FILE = headFile(process.env);
const STOP_MARKER = join(STATE_DIR, "brain_stop");
const SENSE_ON = (process.env.BRAIN_SENSE ?? "on").toLowerCase() !== "off";
const LIVE_VIEW_ON = liveViewEnabled(process.env.BRAIN_LIVE_VIEW);
// Count both transports together: detached API tasks survive a head switch.
const liveHelpers = new Set<string>();
let liveReadline: readline.Interface | null = null;

function terminalLine(line: string): void {
  if (output.isTTY && liveReadline) {
    readline.clearLine(output, 0);
    readline.cursorTo(output, 0);
    output.write(line + "\n");
    liveReadline.prompt(true);
  } else output.write(line + "\n");
}

function liveLine(line: string): void {
  if (!LIVE_VIEW_ON) return;
  terminalLine(line);
}

const pendingTasks = new Map<string, PendingTask>();
const pendingTaskUsage = new Map<string, Map<string, number>>(); // helper tool_use id → message → cold tokens
let onPendingTasksChanged: (() => void) | null = null;
export interface PendingTask { description: string; kind: string; since: string; toolUseId?: string; tokens?: number }

export function pendingTaskKind(event: Pick<HelperActivity, "description" | "kind">): string {
  if (event.kind === "local_agent") return "helper";
  const description = event.description.trim();
  if (/^(wait|watch|keep waiting)\b/i.test(description) || ALIASES.timerLine?.test(description)) return "timer";
  return "background";
}

export function notePendingTask(tasks: Map<string, PendingTask>, key: string, event: HelperActivity, now = new Date()): boolean {
  if (event.phase === "start") {
    if (tasks.has(key)) return false;
    tasks.set(key, { description: event.description.trim() || "background task", kind: pendingTaskKind(event), since: now.toISOString(), ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}) });
    return true;
  }
  return tasks.delete(key);
}

export function pendingTaskFields(tasks: ReadonlyMap<string, PendingTask>): Record<string, unknown> {
  return { pending_tasks: [...tasks.values()].sort((a, b) => a.since.localeCompare(b.since))
    .map(({ toolUseId: _id, ...task }) => task) };
}

export function notePendingTaskUsage(tasks: Map<string, PendingTask>, perMessage: Map<string, Map<string, number>>, helperId: string | undefined, usage: { message_id: string; input: number | null; output: number | null; cache_write: number | null }): boolean {
  if (!helperId) return false;
  const task = [...tasks.values()].find((t) => t.toolUseId === helperId);
  if (!task) return false;
  const cold = (usage.input ?? 0) + (usage.cache_write ?? 0) + (usage.output ?? 0);
  const messages = perMessage.get(helperId) ?? new Map<string, number>();
  perMessage.set(helperId, messages);
  if (cold <= (messages.get(usage.message_id) ?? 0)) return false;
  messages.set(usage.message_id, cold);
  task.tokens = [...messages.values()].reduce((a, b) => a + b, 0);
  return true;
}

function forgetPendingTasks(prefix: string): void {
  let changed = false;
  for (const key of [...pendingTasks.keys()]) if (key.startsWith(prefix)) changed = pendingTasks.delete(key) || changed;
  if (changed) onPendingTasksChanged?.();
}

function liveHelper(source: string, event: HelperActivity): void {
  if (event.phase === "end" && event.toolUseId) pendingTaskUsage.delete(event.toolUseId);
  if (notePendingTask(pendingTasks, `${source}:${event.id}`, event)) onPendingTasksChanged?.();
  if (!LIVE_VIEW_ON) return;
  const id = `${source}:${event.id}`;
  const before = liveHelpers.size;
  if (event.phase === "start") {
    if (liveHelpers.has(id)) return;
    liveHelpers.add(id);
  } else liveHelpers.delete(id);
  liveLine(formatHelperActivity(event));
  if (before !== liveHelpers.size) liveLine(formatHelperCount(liveHelpers.size));
}
const CALENDAR_FILE = process.env.BRAIN_CALENDAR_FILE ?? "";
const CALENDAR_EXTERNAL_FILE = process.env.BRAIN_CALENDAR_EXTERNAL_FILE ?? "";
const WEATHER_URL = process.env.BRAIN_WEATHER_URL ?? "";
const WEATHER_PLACE = process.env.BRAIN_WEATHER_PLACE ?? tr("here");
const REMINDERS_PENDING = process.env.BRAIN_REMINDERS_PENDING ?? join(STATE_DIR, "reminders-pending.jsonl");
const REMINDERS_COLLECT = process.env.BRAIN_REMINDERS_COLLECT === "1";
const REMINDERS_ESCALATE_MIN = Number(process.env.BRAIN_REMINDERS_ESCALATE_MIN ?? "60");
const INLET_WORKER = process.env.BRAIN_INLET_WORKER ?? "";
const GREET_PROMPT = process.env.BRAIN_GREET_PROMPT ?? "";
const GREET_FLAG_FILE = process.env.BRAIN_GREET_FLAG_FILE ?? "";
const GREET_DELAY_MS = Number.parseInt(process.env.BRAIN_GREET_DELAY_MS ?? "", 10) || 8_000;
let personSpokeSinceStart = false;
const INLET_WORKER_TIMEOUT_MS = Number.parseInt(process.env.BRAIN_INLET_WORKER_TIMEOUT_MS ?? "", 10) || 30_000;
const INLET_WORKER_LOG = process.env.BRAIN_INLET_WORKER_LOG ?? "";
const INLET_WORKER_CWD = process.env.BRAIN_INLET_WORKER_CWD ?? process.cwd();
const APP_INBOX_FILE = process.env.BRAIN_APP_INBOX_FILE ?? "";
const APP_URL = process.env.BRAIN_APP_URL ?? "";
const APP_TOKEN = process.env.BRAIN_APP_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
const APP_SOURCE = process.env.BRAIN_APP_SOURCE ?? appMcpServer();
const APP_USER = process.env.BRAIN_APP_USER ?? USER_NAME;
const APP_POLL_MS = Number(process.env.BRAIN_APP_POLL_MS ?? "2000");
const APP_BATCH_BYTES = inboxBatchBytes();
const APP_CURSOR_FILE = join(STATE_DIR, "app-inbox-cursor.json");
const MCP_CONFIG = process.env.BRAIN_MCP_CONFIG ?? "";
const MCP_SERVERS = (process.env.BRAIN_MCP_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const BROWSER_COMMAND = process.env.BRAIN_BROWSER_COMMAND ?? "";
const APPROVAL_MODE = (process.env.BRAIN_APPROVAL ?? "off").toLowerCase();
/** Off unless explicitly enabled, and never in a sterile instance. */
const SHELL_ON = (process.env.BRAIN_SHELL ?? "off").toLowerCase() === "on" && !STERILE;
const SHELL_TIMEOUT_MS = Number(process.env.BRAIN_SHELL_TIMEOUT_MS ?? "120000");
const TASKS_DIR = process.env.BRAIN_TASKS_DIR ?? join(LOG_DIR, "tasks");
const WATCHDOG_STATE_FILE = (process.env.BRAIN_WATCHDOG_STATE ?? join(STATE_DIR, "watchdog_state.json")).trim();
const UPLOAD_LEDGER = (process.env.BRAIN_UPLOAD_LEDGER ?? "").trim();
const GATEWAY_CLASSIFIER_ON = (process.env.BRAIN_REPLY_GATEWAY_CLASSIFIER ?? "off").toLowerCase() === "on";
const GATEWAY_CLASSIFIER: ReplyClassifierConfig = {
  url: process.env.BRAIN_REPLY_GATEWAY_CLASSIFIER_URL ?? "https://openrouter.ai/api/v1/chat/completions",
  model: process.env.BRAIN_REPLY_GATEWAY_CLASSIFIER_MODEL ?? "google/gemma-3-27b-it",
  key: process.env.BRAIN_REPLY_GATEWAY_CLASSIFIER_KEY ?? process.env.OPENROUTER_API_KEY ?? "",
  timeoutMs: Number(process.env.BRAIN_REPLY_GATEWAY_CLASSIFIER_TIMEOUT_MS ?? "8000"),
};
const CONTROL_TOKEN = process.env.BRAIN_CONTROL_TOKEN ?? "";
const CONTROL_PORT = Number(process.env.BRAIN_CONTROL_PORT ?? "3910");
export const PIPE_PROFILE_KEYS = [
  "BRAIN_CLAUDE_SETTINGS", "BRAIN_CLAUDE_SETTING_SOURCES", "BRAIN_CLAUDE_CWD", "BRAIN_CLAUDE_BIN",
  "BRAIN_PIPE_MCP_CONFIG", "BRAIN_PIPE_PERMISSION", "BRAIN_APPROVAL", "BRAIN_APPROVAL_RULES", "BRAIN_APPROVAL_TOOLS", "BRAIN_APPROVAL_SCRATCH",
  "BRAIN_ENABLE_TOOLS", "BRAIN_DISALLOWED_TOOLS", "BRAIN_NOTES_DIR", "BRAIN_NOTES_MAX_BYTES",
  "BRAIN_TOOL_RULES_FILE", "BRAIN_CONTEXT_FILE_MAX_BYTES",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE", "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  ...HEAD_NAMES.flatMap((head) => ["SYSTEM_PROMPT_MODE", "ENABLE_TOOLS", "DISALLOWED_TOOLS"].map((suffix) => `BRAIN_${head.toUpperCase()}_${suffix}`)),
];

/** Compare contents, not mtime: replacing a settings file at the same path counts. */
function reloadFileStamp(path: string): string {
  try {
    if (!statSync(path).isFile()) return "not_file";
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    // A path or parser error can expose private settings; only retain an error code.
    return (error as NodeJS.ErrnoException).code ?? "unreadable";
  }
}

export interface PipeProfile {
  env: Record<string, string | undefined>;
  stamps: Record<string, string>;
}

export function readPipeProfile(env: Record<string, string | undefined>): PipeProfile {
  const selected = Object.fromEntries(PIPE_PROFILE_KEYS.map((key) => [key, env[key]]));
  const stamps = Object.fromEntries(PIPE_PROFILE_KEYS.map((key) => [key, createHash("sha256").update(env[key] ?? "").digest("hex")]));
  const cwd = env.BRAIN_CLAUDE_CWD ?? HERE;
  for (const [key, value] of [
    ["BRAIN_CLAUDE_SETTINGS", env.BRAIN_CLAUDE_SETTINGS ?? "{}"],
    ["BRAIN_PIPE_MCP_CONFIG", env.BRAIN_PIPE_MCP_CONFIG ?? ""],
  ]) {
    // Inline JSON has no backing file. Relative CLI paths belong to its cwd.
    if (value && !value.trimStart().startsWith("{")) stamps[key] += reloadFileStamp(resolve(cwd, value));
  }
  for (const [key, path] of [
    ["BRAIN_SYSTEM", SYSTEM_PROMPT_FILE], ["BRAIN_SELF_FILE", SELF_FILE], ["BRAIN_USER_FILE", USER_FILE],
    ["BRAIN_TOOL_RULES_FILE", env.BRAIN_TOOL_RULES_FILE],
    ["BRAIN_NOTES_DIR", env.BRAIN_NOTES_DIR ? join(env.BRAIN_NOTES_DIR, "NOTES.md") : undefined],
  ]) {
    if (path && key) stamps[key] = (stamps[key] ?? "") + reloadFileStamp(path);
  }
  return { env: selected, stamps };
}

export function changedPipeProfile(before: PipeProfile, after: PipeProfile): string[] {
  return [...new Set([...Object.keys(before.stamps), ...Object.keys(after.stamps)])]
    .filter((key) => before.stamps[key] !== after.stamps[key]);
}

const INITIAL_PIPE_PROFILE = readPipeProfile(process.env);
function pipeEnvironment(state: RuntimeState): Record<string, string | undefined> {
  return { ...process.env, ...state.pipeProfile?.env };
}
export const CACHE_PING_TAG = "[system:cache-ping]";
const CACHE_PING_MODE = (process.env.BRAIN_CACHE_PING ?? "auto").toLowerCase();
const CACHE_PING_PROMPT = process.env.BRAIN_CACHE_PING_PROMPT ?? `${tr(CACHE_PING_TAG)} ${tr("Stay here.")}`;
const CACHE_PING_REPLY_CHARS = Number(process.env.BRAIN_CACHE_PING_REPLY_CHARS ?? "160");
const IDLE_TICK_MS = Number(process.env.BRAIN_IDLE_TICK_MS ?? "60000");
const HOUSE_MAP_ON = (process.env.BRAIN_HOUSE_MAP ?? "on").toLowerCase() !== "off";
const HOUSE_MAP_EXTRA_FILE = process.env.BRAIN_HOUSE_MAP_EXTRA_FILE ?? "";
// Nonresident invocations must not contend with the house's resident.
const PROMPT_RUN = process.argv.slice(2).some((arg) => arg === "--prompt" || arg.startsWith("--prompt="));
if (PROMPT_RUN || (STERILE && process.env.BRAIN_LOCK_FILE === undefined)) process.env.BRAIN_LOCK_FILE = "";
const LOCK_FILE = lockFileFromEnv(STATE_DIR);
const PARALLEL_PATTERN = PROMPT_RUN ? "" : process.env.BRAIN_PARALLEL_PATTERN ?? "";
export const ACCOUNT = accountSeamFromEnv(process.env, STATE_DIR, homedir());
export const PROJECTION = projectionSeamFromEnv(process.env);
export const JUMP = jumpSeamFromEnv(process.env, { logDir: LOG_DIR, sterile: STERILE, log: logEvent });

const SESSION_START_MS = Date.now();
const SESSION_ID = `${SESSION_START_MS}-${Math.random().toString(36).slice(2, 8) || "0"}`;
const SESSION_LOG = join(LOG_DIR, `session-${SESSION_ID}.jsonl`);
const CONVERSATION_LOG = join(LOG_DIR, `conversation-${SESSION_ID}.jsonl`);
const APPROVAL_RULES = loadApprovalRules(APPROVAL_MODE === "app" ? process.env.BRAIN_APPROVAL_RULES ?? "default" : "off", process.env.BRAIN_APPROVAL_TOOLS ?? "", logEvent);
const DOCTOR_CMD = (process.env.BRAIN_DOCTOR_CMD ?? "").trim();
const houseFindings = new Map<string, HouseFinding>();
let houseCheckStarted = false;
let startupDoctorFinished = false;
let houseCheckReported = false;
let houseCheckPending: string | null = null;
const approvalSettings = process.env.BRAIN_APPROVAL_SETTINGS
  ? createApprovalSettingsReader(process.env.BRAIN_APPROVAL_SETTINGS, logEvent, (finding) => {
    houseFindings.set(finding.id, finding);
    if (!DOCTOR_CMD || startupDoctorFinished) publishHouseCheck();
  }) : null;

function publishHouseCheck(): void {
  if (houseCheckReported || !houseFindings.size) return;
  houseCheckReported = true;
  const findings = [...houseFindings.values()];
  houseCheckPending = houseCheckBlock(findings);
  logEvent({ type: "house_check", findings });
  notifyApp(houseCheckMessage(findings));
}

function startupFallback(id: string, label: string, detail: string, fix: string): void {
  if (DOCTOR_CMD && !houseCheckReported) houseFindings.set(id, { id, label, detail, fix });
}

function startHouseCheck(): void {
  if (houseCheckStarted) return;
  houseCheckStarted = true;
  if (!DOCTOR_CMD) return;
  void runStartupDoctor(DOCTOR_CMD).then((findings) => {
    startupDoctorFinished = true;
    for (const finding of findings) houseFindings.set(finding.id, finding);
    publishHouseCheck();
  }).catch((error) => logEvent({ type: "startup_doctor_failed", error: String(error) }));
}

function takeHouseCheck(): string | null {
  const block = houseCheckPending;
  houseCheckPending = null;
  return block;
}

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatResponse {
  model?: string;
  choices?: Array<{ message: Message; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ModelPricing {
  prompt: number;
  completion: number;
}

export interface RuntimeState {
  model: string;
  systemPrompt: string;
  tools: OpenAIToolDef[];
  history: Message[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
  lastPromptTokens: number;
  liveTurn?: LiveTokensSnapshot | null;
  apiTool?: string | null;
  watchdogWarnedAt: number;
  wakeLoaded: boolean;
  rolledIndex: number;
  rolledSegments: number;
  liveSegmentNames: string[];
  inletBlocks: Record<number, string>;
  initialWakeContext?: string;
  pricing: ModelPricing | null;
  cutoffRequested: boolean;
  archiveStarted: boolean;
  head?: HeadSpec;
  headStateActive?: boolean;
  move?: { target: HeadState; bridgeSessions?: number; effort?: string | null };
  watchdog?: WatchdogThresholds;
  pipe?: ClaudePipe | null;
  claudeAuth?: { profile: ClaudeAuthProfile; stamp: string; lastProbe: number; watcher?: FSWatcher; timer?: ReturnType<typeof setInterval> };
  pipeBirths?: number;
  pipeFirstSendPending?: boolean;
  claudeTurnSteers?: QueueItem[];
  wakeSentToPipe?: boolean;
  bridgeText?: string | null;
  sessionStartIndex?: number;
  servedModel?: string;
  drift?: DriftGuardState;
  pendingDriftMarker?: { marker: "drift" | "healed"; ordered: string; served: string } | null;
  senseState?: SenseState | null;
  pinsShownSig?: string;
  lastModelCallAt?: number;
  // A failed later hop must not make an already answered first turn deliver again.
  modelAnswers?: number;
  lastCachePingAt?: number;
  lastRateLimit?: RateLimitInfo | null;
  mcpClients?: Map<string, StdioMcpClient>;
  gptAdapterVerified?: string;
  effort?: string | null;
  appliedEffort?: string | null;
  pendingRebirth?: string | null;
  pipeProfile?: PipeProfile;
}

const DEFAULT_SYSTEM_PROMPT = `You are a worker runtime. Keep the conversation useful, precise, and grounded in the available context. Use tools when they provide facts instead of guessing. Do not claim to have performed an action that a tool did not confirm.`;

function ensureLogDirectory(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Logging is best effort and must not stop a conversation.
  }
}

export function logEvent(event: Record<string, unknown>): void {
  try {
    ensureLogDirectory();
    appendFileSync(SESSION_LOG, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  } catch {
    // A log failure must not turn into a conversation failure.
  }
}

export type UsageScope = "session" | "today" | "week";
export interface UsageRecord extends UsageTokens {
  type: "usage"; id: string; ts: string; head: string; model: string; source: UsageSource;
  helper_id?: string; partial?: boolean; reason?: string;
}
export type UsagePrices = Record<string, Partial<Record<keyof UsageTokens, number>>>;
const USAGE_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;

export function apiUsageTokens(u: any): UsageTokens {
  if (!u || typeof u !== "object") return anthropicUsage(null);
  if (u.prompt_tokens === undefined) return anthropicUsage(u);
  const total = usageNumber(u.prompt_tokens);
  const read = usageNumber(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0);
  const write = usageNumber(u.cache_creation_input_tokens ?? 0);
  return { input: total !== null && read !== null && write !== null && total >= read + write ? total - read - write : null,
    output: usageNumber(u.completion_tokens), cache_read: read, cache_write: write };
}
export function apiUsageRecord(response: any, head: string, source: UsageSource): UsageRecord {
  return { type: "usage", id: randomUUID(), ts: new Date().toISOString(), head, source,
    model: typeof response?.model === "string" && response.model.trim() ? response.model : UNKNOWN_MODEL,
    ...apiUsageTokens(response?.usage), ...(!response?.usage ? { reason: "usage_not_reported" } : {}) };
}

export function readUsagePrices(path: string | undefined): UsagePrices | null {
  if (!path?.trim()) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected model-to-rates object");
    return value;
  } catch (error) { logEvent({ type: "usage_prices_invalid", error: String(error) }); return null; }
}

export function usageDateFilter(scope: UsageScope, now = new Date(), zone = brainTimezone()): (ts: unknown) => boolean {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const key = (date: Date) => {
    const p = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const today = key(now), weekStart = new Date(`${today}T12:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const from = scope === "week" ? weekStart.toISOString().slice(0, 10) : today;
  return (ts) => {
    if (scope === "session") return true;
    if (typeof ts !== "string") return false;
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || t > now.getTime()) return false;
    const day = key(new Date(t));
    return day >= from && day <= today;
  };
}

export async function readUsageRecords(logDir: string, sessionFile: string, scope: UsageScope, now = new Date(), zone = brainTimezone()): Promise<any[]> {
  const records: any[] = [], accepts = usageDateFilter(scope, now, zone);
  let files: string[];
  try { files = scope === "session" ? [sessionFile] : readdirSync(logDir).filter((f) => /^session-.+\.jsonl$/.test(f)).map((f) => join(logDir, f)); }
  catch { return [{ type: "usage_coverage", reason: "log_directory_unreadable" }]; }
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const stream = createReadStream(file, { encoding: "utf8" });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      stream.once("error", () => { records.push({ type: "usage_coverage", reason: "log_file_unreadable" }); lines.close(); });
      try {
        for await (const line of lines) {
          if (!line.includes('"usage"') && !line.includes('"usage_coverage"')) continue;
          try {
            const row = JSON.parse(line);
            if ((row.type === "usage" || row.type === "usage_coverage") && accepts(row.ts)) records.push(row);
          } catch { records.push({ type: "usage_coverage", reason: "incomplete_usage_line" }); }
        }
      } finally { lines.close(); stream.destroy(); }
    } catch { records.push({ type: "usage_coverage", reason: "log_file_unreadable" }); }
  }
  return records;
}

export function renderUsage(records: readonly any[], scope: UsageScope, prices: UsagePrices | null = null): string {
  type Totals = { counts: Record<keyof UsageTokens, number>; unknown: Set<keyof UsageTokens>; partial: boolean };
  const empty = (): Totals => ({ counts: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, unknown: new Set(), partial: false });
  const models = new Map<string, Totals>(), sum = empty(), seen = new Set<string>();
  const sources: Record<UsageSource, number> = { turn: 0, helper: 0, cache_ping: 0, internal: 0 };
  let gap = false, responses = 0;
  const add = (totals: Totals, row: any) => {
    for (const field of USAGE_FIELDS) {
      const value = usageNumber(row[field]);
      if (value === null) totals.unknown.add(field);
      else {
        totals.counts[field] += value;
        if (!Number.isSafeInteger(totals.counts[field])) totals.unknown.add(field);
      }
    }
    totals.partial ||= row.partial === true;
  };
  for (const stored of records) {
    if (stored?.type === "usage_coverage") { gap = true; continue; }
    if (stored?.type !== "usage") continue;
    const row = { ...stored, source: ALIASES.stored("source", stored.source), model: ALIASES.stored("model", stored.model) };
    if (typeof row.model !== "string" || !row.model || typeof row.id !== "string" || !row.id || !["turn", "cache_ping", "helper", "internal"].includes(row.source)) { gap = true; continue; }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const totals = models.get(row.model) ?? empty();
    models.set(row.model, totals);
    add(totals, row); add(sum, row); responses++;
    sources[row.source as UsageSource] += USAGE_FIELDS.reduce((n, field) => n + (usageNumber(row[field]) ?? 0), 0);
  }
  const cost = (model: string, totals: Totals): number | null => {
    if (totals.unknown.size || totals.partial || !prices || !Object.hasOwn(prices, model)) return null;
    const rates = prices[model];
    if (!rates || USAGE_FIELDS.some((f) => typeof rates[f] !== "number" || !Number.isFinite(rates[f]) || rates[f]! < 0)) return null;
    const value = USAGE_FIELDS.reduce((n, f) => n + totals.counts[f] / 1_000_000 * rates[f]!, 0);
    return Number.isFinite(value) ? value : null;
  };
  const wrap = (text: string): string[] => {
    const chars = Array.from(text.replace(/[\x00-\x1f\x7f]/g, "?")), rows: string[] = [];
    do { rows.push(chars.splice(0, 40).join("")); } while (chars.length);
    return rows;
  };
  const row = (label: string, value: string) => `${label.padEnd(12)}${value.padStart(28)}`;
  const money = (n: number | null) => n === null ? "—" : `$${n.toFixed(4)}`;
  const labels = { input: "Input", output: "Output", cache_read: "Cache read", cache_write: "Cache write" };
  const table = (totals: Totals, dollars: number | null): string[] => [
    ...USAGE_FIELDS.map((f) => row(labels[f], totals.unknown.has(f)
      ? (totals.counts[f] ? `${totals.counts[f].toLocaleString(brainLocale())} + ?` : "—") : totals.counts[f].toLocaleString(brainLocale()))),
    row("API-$", money(dollars)),
  ];
  const lines = [`Usage · ${scope}`];
  let allPriced = prices !== null && models.size > 0 && !gap, totalCost = 0;
  for (const [model, totals] of [...models].sort(([a], [b]) => a.localeCompare(b))) {
    const dollars = cost(model, totals);
    if (dollars === null) allPriced = false; else totalCost += dollars;
    lines.push("", ...wrap(model === UNKNOWN_MODEL ? tr("unknown") : model), ...table(totals, dollars));
  }
  if (!responses) lines.push(tr("No usage recorded yet."));
  lines.push("", tr("Total (recorded)"), ...table(sum, allPriced && Number.isFinite(totalCost) ? totalCost : null));
  const inputTotal = sum.counts.input + sum.counts.cache_read + sum.counts.cache_write;
  const tokens = Object.values(sum.counts).reduce((a, b) => a + b, 0);
  const incomplete = gap || sum.unknown.size > 0 || sum.partial;
  const pct = (n: number, d: number) => d > 0 ? `${(100 * n / d).toFixed(1).replace(".", tr("decimal.point"))}%${incomplete ? "*" : ""}` : "—";
  lines.push(row(tr("Cache ratio"), pct(sum.counts.cache_read, inputTotal)), row(tr("Helpers"), pct(sources.helper, tokens)), row(tr("Cache pings"), pct(sources.cache_ping, tokens)));
  if (incomplete) lines.push(tr("* Incomplete; recorded tokens only."));
  lines.push(tr("Helpers: reported usage only."), tr("API-$ is not subscription quota."));
  return lines.flatMap(wrap).join("\n");
}

const toolRecords = new ToolRecordPolicy(process.env.BRAIN_TOOL_REFERENCES, logEvent);

// Logged as `internal_input`, not as an `origin`: the bridge skips every record
// that carries an origin, and an internal input still belongs in the bridge.
const syntheticInputs = new WeakSet<object>();
// Archive-only metadata must not become part of model-facing messages.
const outreachTexts = new WeakMap<object, string>();

function logTurn(message: Message | Record<string, unknown>, fields: Record<string, unknown> = {}): void {
  try {
    ensureLogDirectory();
    const now = new Date();
    if (message.role === "assistant" && !speechIds.has(message)) speechIds.set(message, randomUUID());
    appendFileSync(CONVERSATION_LOG, JSON.stringify({ ts: now.toISOString(), ...toolRecords.record(message), ...fields, ...(mailCalls.has(message) ? { mail_calls: mailCalls.get(message) } : {}), ...(speechIds.has(message) ? { speech_id: speechIds.get(message) } : {}), ...(syntheticInputs.has(message) ? { internal_input: true } : {}), ...(outreachTexts.has(message) ? { outreach_text: outreachTexts.get(message) } : {}) }) + "\n");
    noteLoggedAt(message, now.getTime());
  } catch (error) {
    logEvent({ type: "conversation_log_failure", error: String(error) });
  }
}

function readBlockFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

async function writeBlockFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content.trim() + "\n");
}

export async function renderSystemPrompt(template: string): Promise<string> {
  const selfText = readBlockFile(SELF_FILE) ?? "(empty — not yet written)";
  const userText = readBlockFile(USER_FILE) ?? "(empty — not yet written)";
  if (template.includes("[SELF-BLOCK]") || template.includes("[USER-BLOCK]")) {
    return template.replace("[SELF-BLOCK]", selfText).replace("[USER-BLOCK]", userText);
  }
  return template;
}

function readSystemPromptFile(): string | null {
  try {
    if (existsSync(SYSTEM_PROMPT_FILE)) return readFileSync(SYSTEM_PROMPT_FILE, "utf8");
  } catch (error) {
    logEvent({ type: "system_prompt_read_failure", error: String(error) });
  }
  return null;
}

function readSystemPrompt(): string {
  const text = readSystemPromptFile();
  // Only a house with the startup doctor (an Embervy installation) refuses; other
  // runtimes keep their built-in prompt and report the fallback.
  if (!text?.trim() && DOCTOR_CMD) {
    throw new Error(`Brain cannot start: identity file is missing, unreadable or empty: ${SYSTEM_PROMPT_FILE}. Restore the identity file and restart Brain.`);
  }
  if (!text?.trim() && process.env.BRAIN_SYSTEM) logEvent({ type: "system_prompt_missing", file: SYSTEM_PROMPT_FILE });
  if (!text?.trim()) startupFallback("identity-default", "No identity file", "The agent is using the built-in runtime prompt instead of its identity.", `Set BRAIN_SYSTEM to a readable, nonempty identity file (${SYSTEM_PROMPT_FILE}).`);
  return text?.trim() ? text : DEFAULT_SYSTEM_PROMPT;
}

/** Read afresh at every pipe start and API turn, so an edit takes effect
 * without a restart. A file that went missing keeps the last text; the
 * refusal for a missing identity belongs to the start alone. */
export function currentSystemPrompt(state: RuntimeState): string {
  const text = readSystemPromptFile();
  if (text?.trim()) state.systemPrompt = text;
  return state.systemPrompt;
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function memoryCall(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!MEMORY_URL || !MEMORY_KEY) throw new Error("memory MCP is not configured");
  const response = await fetch(`${MEMORY_URL.replace(/\/$/, "")}/mcp`, {
    method: "POST",
    headers: { ...authHeaders(MEMORY_KEY), "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`memory MCP HTTP ${response.status}: ${await response.text()}`);
  const data: any = await response.json();
  if (data.error) throw new Error(`memory MCP error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function memoryListTools(): Promise<OpenAIToolDef[]> {
  if (!MEMORY_URL || !MEMORY_KEY) return [];
  const result = await memoryCall("tools/list");
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.map((tool: any) => ({
    type: "function" as const,
    function: {
      name: String(tool.name ?? ""),
      description: String(tool.description ?? "").slice(0, 1024),
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  })).filter((tool: OpenAIToolDef) => tool.function.name.length > 0);
}

async function memoryToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await memoryCall("tools/call", { name, arguments: args });
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.map((part: any) => typeof part?.text === "string" ? part.text : JSON.stringify(part)).join("\n");
}

function localToolDefs(): OpenAIToolDef[] {
  const defs: OpenAIToolDef[] = [];
  defs.push({
    type: "function",
    function: {
      name: "update_self_block",
      description: "Replace the complete self section persisted for future sessions.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "The complete new self block." } },
        required: ["content"],
      },
    },
  });
  defs.push({
    type: "function",
    function: {
      name: "update_user_block",
      description: "Replace the complete user-context section persisted for future sessions.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "The complete new user-context block." } },
        required: ["content"],
      },
    },
  });
  if (RAG_URL && RAG_AUTH_TOKEN) {
    defs.push({
      type: "function",
      function: {
        name: "rag_search",
        description: "Search the chronicle (the long-term archive of past sessions) and return the highest-ranked matching chunks.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "A concrete search query." },
            top_k: { type: "number", description: "Number of results, from 1 to 15." },
          },
          required: ["query"],
        },
      },
    });
  }
  if (WORKSPACE_READ) {
    defs.push({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the configured read-only workspace jail.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root." },
            offset: { type: "number", description: "One-based starting line." },
            limit: { type: "number", description: "Maximum number of lines." },
          },
          required: ["path"],
        },
      },
    });
    defs.push({
      type: "function",
      function: {
        name: "list_dir",
        description: "List entries inside the configured read-only workspace jail.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    });
    if (WRITE_LIST_PATH) {
      defs.push({
        type: "function",
        function: {
          name: "edit_file",
          description: "Replace one exact string in a file released on the write allowlist.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
            required: ["path", "old_string", "new_string"],
          },
        },
      });
      defs.push({
        type: "function",
        function: {
          name: "write_file",
          description: "Create or replace a file released on the write allowlist.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      });
    }
  }
  defs.push(...webToolDefs({ search: Boolean(WEB.search), fetch: WEB.fetch, render: Boolean(WEB.browser) }));
  defs.push(...pinToolDefs());
  defs.push(effortToolDef());
  if (BROWSER_COMMAND) defs.push(browseToolDef());
  defs.push(...residentToolDefs(residentConfig()));
  return defs;
}

let residentConfigCache: ResidentConfig | null = null;
function residentConfig(): ResidentConfig {
  if (!residentConfigCache) {
    residentConfigCache = {
      root: WORKSPACE_READ ? resolve(WORKSPACE_READ) : null,
      shell: SHELL_ON,
      env: shellEnv(process.env),
      tasksDir: TASKS_DIR,
      bashTimeoutMs: SHELL_TIMEOUT_MS,
    };
  }
  return residentConfigCache;
}

let liveResidentSnapshot: ResidentTaskEntry[] = [];
function syncResidentLiveView(): void {
  if (!LIVE_VIEW_ON) return;
  const next = taskRegistry.tasks.slice();
  const events = residentTaskActivity(liveResidentSnapshot, next);
  liveResidentSnapshot = next;
  for (const event of events) liveHelper("resident", event);
}

const taskRegistry = new TaskRegistry(join(STATE_DIR, "resident-tasks.json"), (task, opts) => {
  syncResidentLiveView();
  queue.push({ kind: "internal", source: "internal", text: `[task] ${buildCompletionMessage(task, opts)}` });
  logEvent({ type: "task_done_announced", id: task.id, label: task.label, exit: task.exit });
  setTimeout(() => { if (shutdownState) void processQueue(shutdownState); }, 0);
  return true;
});

function residentToolOffered(name: string): boolean {
  return residentToolDefs(residentConfig()).some((def) => def.function.name === name);
}

export function pinToolDefs(): OpenAIToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: "pin",
        description: 'Set a transient reminder ("do not forget") that appears in the prompt until it expires. NOT the working memory, NOT persistent knowledge — just a sticky note in the current context. Returns the pin id.',
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The reminder text." },
            ttl: { type: "string", description: 'Expiry: "end_of_day"/"eod" (default, midnight in the house time zone), "<N>h", "<N>m", or "YYYY-MM-DD HH:MM" (local time).' },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: { name: "pins", description: "List active pins (id, text, expires-at).", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: {
        name: "unpin",
        description: "Remove a pin by id.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
  ];
}

export function effortToolDef(): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: "effort",
      description: "Read or set your own reasoning effort: low | medium | high | xhigh | max | default. Raise it before a heavy task and set it back afterwards. Applies from your next model request; history is kept. Without level: the current setting.",
      parameters: {
        type: "object",
        properties: { level: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "default"] } },
      },
    },
  };
}

function toolsForHead(state: RuntimeState, head: HeadSpec): OpenAIToolDef[] {
  if (headEffortSupport(head).via === "request") return state.tools;
  return state.tools.filter((tool) => tool.function.name !== "effort");
}

function browseToolDef(): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: "browse",
      description: "Drive the persistent headless browser (logged-in consoles, SPAs, forms). ops: goto <url>, read [selector], links, click <sel>, fill <sel> <text>, press <key>, snap (aria refs [ref=eN]), shot, url, back, eval <js>, net [n] [filter], state, stop. Text output is capped.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", description: "Operation, e.g. goto, read, snap, click, fill, press, shot, links, url, back, eval." },
          arg: { type: "string", description: "First argument (url, selector, key, js)." },
          arg2: { type: "string", description: "Second argument (e.g. text for fill)." },
        },
        required: ["op"],
      },
    },
  };
}

export function normalizePinTtl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const value = String(raw).trim();
  if (value === "eod") return "end_of_day";
  const minutes = /^(\d+)m$/i.exec(value);
  if (minutes) return `${Number(minutes[1]) / 60}h`;
  return value;
}

export function estimateRequestTokens(
  baseTokens: number,
  inletTokens: number,
  toolSchemaTokens: number,
  callHistory: Message[],
): number {
  return baseTokens + inletTokens + toolSchemaTokens + callHistory.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function workspaceRoot(): string | null {
  return WORKSPACE_READ ? resolve(WORKSPACE_READ) : null;
}

/** Symlinks and new paths under linked folders are resolved before the check. */
function jailResolve(path: unknown): string | null {
  const root = workspaceRoot();
  return root ? residentJailResolve(root, path) : null;
}

/**
 * The write list judges the resolved path, never the typed one: "REPORT.md/../src/x" or
 * "REPORT.md/../.git/config" must not pass as REPORT.md. Returns the canonical path inside the
 * workspace, or null for anything that climbs out, touches .git, or is the root itself.
 */
function writeTarget(full: string): string | null {
  const root = workspaceRoot();
  if (!root) return null;
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* the jail already resolved against the same root */ }
  const rel = relative(realRoot, full);
  const parts = rel.split("/");
  if (!rel || rel.startsWith("..") || parts.includes("..") || parts.includes(".git")) return null;
  return rel;
}

function writeAllowed(relativePath: string): boolean {
  if (!WRITE_LIST_PATH) return false;
  try {
    const lines = readFileSync(WRITE_LIST_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return lines.some((entry) => relativePath === entry || relativePath.startsWith(entry.endsWith("/") ? entry : entry + "/"));
  } catch {
    return false;
  }
}

async function backupBeforeWrite(fullPath: string, relativePath: string): Promise<void> {
  if (!existsSync(fullPath)) return;
  mkdirSync(WRITE_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await Bun.write(join(WRITE_BACKUP_DIR, `${stamp}__${relativePath.replace(/\//g, "__")}`), await Bun.file(fullPath).text());
}

async function ragSearch(query: string, topK: number): Promise<string> {
  if (!RAG_URL || !RAG_AUTH_TOKEN) return "";
  const response = await fetch(`${RAG_URL.replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: { ...authHeaders(RAG_AUTH_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK, ...(RAG_FILENAME_PREFIX ? { filenamePrefix: RAG_FILENAME_PREFIX } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return `error: memory search HTTP ${response.status}`;
  const data: any = await response.json();
  const hits = data?.results ?? data?.matches ?? [];
  if (!Array.isArray(hits) || !hits.length) return "no matches";
  return hits.map((hit: any, index: number) => {
    const source = hit.source ?? hit.filename ?? "unknown";
    const score = typeof hit.score === "number" ? hit.score.toFixed(3) : "?";
    const text = String(hit.text ?? hit.content ?? "").slice(0, 1800);
    return `[${index + 1}] ${source} (score ${score})\n${text}`;
  }).join("\n\n---\n\n");
}

/** Split a browse command line into argv without a shell (no injection surface). */
export function browseArgv(command: string, op: string, arg?: string, arg2?: string): string[] {
  const base = command.trim().split(/\s+/).filter(Boolean);
  const argv = [...base, op];
  if (arg !== undefined && arg !== "") argv.push(arg);
  if (arg2 !== undefined && arg2 !== "") argv.push(arg2);
  return argv;
}

async function runBrowse(args: Record<string, any>): Promise<string> {
  if (!BROWSER_COMMAND) return "error: browser is not configured";
  const op = String(args.op ?? "").trim();
  if (!/^[a-z][a-z_-]*$/.test(op)) return "error: op is required";
  const argv = browseArgv(BROWSER_COMMAND, op, args.arg === undefined ? undefined : String(args.arg), args.arg2 === undefined ? undefined : String(args.arg2));
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch { /* gone */ } }, 120_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  const text = (out || err).trim();
  return (proc.exitCode === 0 ? text : `error (rc=${proc.exitCode}): ${text}`).slice(0, 12_000) || "(no output)";
}

const pinsRefGlobal: { current: PinsState } = { current: initialPinsState() };

export async function dispatchLocalTool(name: string, args: Record<string, any>, pinsRef: { current: PinsState } | null = pinsRefGlobal): Promise<string> {
  if (name === "update_self_block" || name === "update_user_block") {
    const content = String(args.content ?? "").trim();
    if (!content) return "error: content is required";
    const path = name === "update_self_block" ? SELF_FILE : USER_FILE;
    await writeBlockFile(path, content);
    return `${name} updated (${content.length} characters)`;
  }
  if (name === "pin") {
    if (!pinsRef) return "error: pins unavailable in this context";
    const text = String(args?.text ?? "").trim();
    if (!text) return "error: text required";
    try {
      const { state: nextState, pin } = addPin(pinsRef.current, text, normalizePinTtl(args?.ttl), new Date());
      pinsRef.current = nextState;
      savePinsAny(PINS_FORMAT, PINS_FILE, nextState, new Date());
      return `pinned as ${pin.id}, expires ${pin.expiresAt}`;
    } catch (error) {
      if (error instanceof PinLimitError || error instanceof PinTtlError) return `error: ${error.message}`;
      throw error;
    }
  }
  if (name === "pins") {
    if (!pinsRef) return "error: pins unavailable in this context";
    const active = listActivePins(pinsRef.current, new Date());
    if (!active.length) return "no active pins";
    return active.map((pin) => `${pin.id}: ${pin.text} (expires ${pin.expiresAt})`).join("\n");
  }
  if (name === "unpin") {
    if (!pinsRef) return "error: pins unavailable in this context";
    const id = String(args?.id ?? "").trim();
    if (!id) return "error: id required";
    const nextState = removePin(pinsRef.current, id);
    const removed = nextState.pins.length !== pinsRef.current.pins.length;
    pinsRef.current = nextState;
    savePinsAny(PINS_FORMAT, PINS_FILE, nextState, new Date());
    return removed ? `unpinned ${id}` : `${id}: not found (already gone)`;
  }
  if (name === "browse") {
    try {
      return await runBrowse(args);
    } catch (error) {
      return `error: browser failed: ${String(error)}`;
    }
  }
  if (RESIDENT_TOOL_NAMES.has(name)) {
    try {
      return (await dispatchResidentTool(name, args, residentConfig(), taskRegistry)) ?? `error: unknown resident tool: ${name}`;
    } catch (error) {
      return `error: ${name} failed: ${String(error)}`;
    } finally {
      syncResidentLiveView();
    }
  }
  if (name === "rag_search") {
    const query = String(args.query ?? "").trim();
    if (!query) return "error: query is required";
    const topK = Math.max(1, Math.min(15, Number(args.top_k) || 6));
    try {
      return await ragSearch(query, topK);
    } catch (error) {
      return `error: memory search failed: ${String(error)}`;
    }
  }
  if (WEB_TOOL_NAMES.has(name)) return runWebTool(WEB, name, args);
  if (name === "read_file") {
    const full = jailResolve(args.path);
    if (!full) return "error: path is outside the read-only workspace jail";
    if (!existsSync(full)) return `error: file not found: ${args.path}`;
    const lines = readFileSync(full, "utf8").split("\n");
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Math.min(600, Number(args.limit) || 250));
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected.map((line, index) => `${offset + index}\t${line}`).join("\n");
    const more = offset - 1 + limit < lines.length ? `\n… (${lines.length} lines total; continue at offset=${offset + limit})` : "";
    return numbered + more;
  }
  if (name === "list_dir") {
    const full = jailResolve(args.path ?? ".");
    if (!full) return "error: path is outside the read-only workspace jail";
    try {
      return readdirSync(full)
        .filter((entry) => entry !== ".git" && entry !== "node_modules")
        .map((entry) => {
          try { return statSync(join(full, entry)).isDirectory() ? `${entry}/` : entry; } catch { return entry; }
        })
        .sort()
        .join("\n") || "(empty)";
    } catch (error) {
      return `error: ${String(error)}`;
    }
  }
  if (name === "edit_file" || name === "write_file") {
    const relativePath = String(args.path ?? "").replace(/^\.\//, "");
    const full = jailResolve(relativePath);
    if (!full) return "error: path is outside the workspace jail";
    const target = writeTarget(full);
    if (!target || !writeAllowed(target)) return `error: '${relativePath}' is not on the write allowlist`;
    if (name === "edit_file") {
      if (!existsSync(full)) return `error: file not found: ${relativePath}`;
      const text = readFileSync(full, "utf8");
      const oldString = String(args.old_string ?? "");
      const newString = String(args.new_string ?? "");
      if (!oldString) return "error: old_string is required";
      const count = text.split(oldString).length - 1;
      if (count === 0) return "error: old_string was not found";
      if (count > 1) return `error: old_string matched ${count} times`;
      await backupBeforeWrite(full, relativePath);
      await Bun.write(full, text.replace(oldString, () => newString));
      return `edited ${relativePath}`;
    }
    const content = String(args.content ?? "");
    if (!content) return "error: content is required";
    await backupBeforeWrite(full, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    await Bun.write(full, content);
    return `wrote ${relativePath}`;
  }
  return `error: unknown local tool: ${name}`;
}

const LOCAL_TOOL_NAMES = new Set([
  "update_self_block",
  "update_user_block",
  "rag_search",
  "read_file",
  "list_dir",
  "edit_file",
  "write_file",
  "web_search",
  "web_fetch",
  "pin",
  "pins",
  "unpin",
  "browse",
  ...RESIDENT_TOOL_NAMES,
]);

const mailCalls = new WeakMap<object, any[]>();
const pipeMails = new WeakMap<ClaudePipe, any[]>();
const gatewayTexts = new WeakMap<Message, string>();
const speechIds = new WeakMap<object, string>();

// Model continuity includes terminal prose; exported speech requires delivery evidence.
function contextSpeechText(message: Message): string {
  const content = (message.content ?? "").trim();
  const { texts, rooms, peers } = toolCallSpeech(message.tool_calls);
  return [content && content !== "." ? content : texts.join("\n\n"), ...rooms, ...peers].filter(Boolean).join("\n\n").trim();
}

function speechRecord(message: Message): Record<string, any> {
  return {
    ...toolRecords.record(message),
    ...(mailCalls.has(message) ? { mail_calls: mailCalls.get(message) } : {}),
    ...(outreachTexts.has(message) ? { outreach_text: outreachTexts.get(message) } : {}),
    ...(gatewayTexts.has(message) ? { gateway_text: gatewayTexts.get(message) } : {}),
  };
}

export function assistantSpeechText(message: Message): string {
  return outreachSpeech(speechRecord(message));
}

export function mergeReplyAndProse(appReplyTexts: string[], prose: string): string {
  const replies = appReplyTexts.map((text) => text.trim()).filter(Boolean);
  const rest = (prose ?? "").trim();
  if (!replies.length) return rest;
  const joined = replies.join("\n\n");
  if (!rest || rest === "." || joined.includes(rest)) return joined;
  return `${joined}\n\n${rest}`;
}

export function pipeTurnSpeech(result: Pick<SendResult, "appReplyTexts" | "assistantText" | "finalContent"> & { undeliveredReplyTexts?: string[]; roomTexts?: string[]; peerTexts?: string[]; gatewaySilent?: boolean }, roomTurn = false, peerTurn = false): TurnSpeech & { answer: string } {
  const delivered = result.appReplyTexts;
  const undelivered = owedReplies(delivered, result.undeliveredReplyTexts ?? []);
  const spoken = [...delivered, ...undelivered];
  const rooms = result.roomTexts ?? [];
  const peers = result.peerTexts ?? [];
  const merged = mergeReplyAndProse(spoken, result.assistantText || (spoken.length ? "" : result.finalContent));
  const answer = [(rooms.length || peers.length) && merged.trim() === "." ? "" : merged, ...rooms, ...peers].filter(Boolean).join("\n\n");
  const prose = result.assistantText || result.finalContent || "";
  return { answer, ...(result.gatewaySilent ? { silent: true } : {}), ...settleTurnSpeech(delivered.length > 0 || (roomTurn && rooms.length > 0) || (peerTurn && peers.length > 0), delivered, undelivered, prose) };
}

export function settleTurnSpeech(replied: boolean, delivered: string[], undelivered: string[], prose: string): TurnSpeech {
  const owed = owedReplies(delivered, undelivered);
  return replied
    ? { replied: true, prose, missing: owed }
    : { replied: false, prose: mergeReplyAndProse(owed, prose), missing: [] };
}

/** Each reply counts on its own: an early "I'll check" that arrived does not
 * hide a later answer that did not. */
export interface TurnSpeech { replied: boolean; prose: string; missing: string[]; silent?: boolean; message?: Message }

export function owedReplies(delivered: string[], undelivered: string[]): string[] {
  const arrived = new Set(delivered.map((text) => text.trim()));
  return [...new Set(undelivered.map((text) => text.trim()).filter(Boolean))].filter((text) => !arrived.has(text));
}

export function gatewayOwed(source: string, missing: string[]): string | null {
  if (source !== "app") return null;
  const texts = missing.map((text) => text.trim()).filter(Boolean);
  return texts.length ? `⚡ ${texts.join("\n\n")}` : null;
}

export function replyToolDelivered(name: string, toolResult: string): boolean {
  return isReplyToolName(name) && !/^error\b/i.test(toolResult.trimStart());
}

/** An app turn that ended without any reply tool call still reaches the app,
 * prefixed ⚡, unless it is marked [still] or holds only status lines. */
export function gatewayText(source: string, replied: boolean, prose: string): string | null {
  if (source !== "app" || replied) return null;
  const text = (prose ?? "").trim();
  if (!text || text === ".") return null;
  if (text.includes("[still]") || ALIASES.quietTags.some((tag) => text.includes(tag))) return null;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length && lines.every((line) => line.startsWith("*"))) return null;
  return `⚡ ${text}`;
}

export interface ReplyClassifierConfig {
  url: string;
  model: string;
  key: string;
  timeoutMs: number;
}

export const REPLY_CLASSIFIER_PROMPT = "This is the text portion of a complete AI-agent turn (possibly start and end, middle omitted). The text may be in ANY language — judge the content, not the language. Does it ANYWHERE contain a message DIRECTED AT THE HUMAN in front of the screen (addressing them, reporting to them, asking them something, telling them what to do)? Then answer REPLY. Only if EVERYTHING is purely an internal work note (status log, the agent talking to itself about its work steps): answer NOTE. When in doubt: REPLY. Answer ONLY with REPLY or NOTE.\n\n---\n";

/** Long turns are shown as their first 700 and last 800 characters, so a
 * reply at the end of a long work turn is still seen. */
export function replyClassifierSnippet(text: string): string {
  if (text.length <= 1600) return text;
  return `${text.slice(0, 700)}\n[…]\n${text.slice(-800)}`;
}

/** Fail-open: no key, an HTTP error, a timeout or an unreadable answer all
 * mean "send". Only an answer containing NOTE suppresses. */
export async function classifyReplyOrNote(text: string, config: ReplyClassifierConfig, fetchImpl: typeof fetch = fetch): Promise<{ verdict: "REPLY" | "NOTE"; reason: string }> {
  if (!config.key) return { verdict: "REPLY", reason: "no-key" };
  if (/claude|anthropic/i.test(config.model)) return { verdict: "REPLY", reason: "claude-model-refused" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, Math.max(1, config.timeoutMs));
  });
  try {
    const call = (async () => {
      const response = await fetchImpl(config.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, ...(TEMPERATURE !== undefined ? { temperature: TEMPERATURE } : {}), max_tokens: 5, messages: [{ role: "user", content: REPLY_CLASSIFIER_PROMPT + replyClassifierSnippet(text) }] }),
        signal: controller.signal,
      });
      if (!response.ok) {
        logEvent({ type: "usage_coverage", head: "internal", source: "internal", component: "reply_classifier", reason: "failed_request_no_usage" });
        return { verdict: "REPLY" as const, reason: `http-${response.status}` };
      }
      const data: any = await response.json().catch(() => null);
      logEvent({ ...apiUsageRecord(data, "internal", "internal"), component: "reply_classifier" });
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") return { verdict: "REPLY" as const, reason: "no-content" };
      return content.includes("NOTE") ? { verdict: "NOTE" as const, reason: "classifier" } : { verdict: "REPLY" as const, reason: "classifier" };
    })();
    return await Promise.race([call, timeout]);
  } catch (error) {
    logEvent({ type: "usage_coverage", head: "internal", source: "internal", component: "reply_classifier", reason: "failed_request_no_usage" });
    return { verdict: "REPLY", reason: String((error as Error)?.message ?? error) === "timeout" ? "timeout" : "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isReplyToolName(name: string): boolean {
  return isAppReplyTool(name);
}

/** Lines that Brain or the harness wrote in the user role are labelled
 * "System" wherever history is written out: relabelled, never deleted. */
const SYSTEM_LINE_BASE = String.raw`\[(?:task|wake|self|reminder)\]|<task-notification>|Stop hook feedback:|\[system:cache-ping\]`;
const SCHEDULED_LINE = /^\s*\[gateway(?::[a-z-]+)?\]/i;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const systemLines = new Map<string, RegExp>();
export function systemLinePattern(): RegExp {
  const tags = [...new Set([REMINDER_TAG, CACHE_PING_TAG].map((tag) => tr(tag)).concat(ALIASES.systemTags))].filter((tag) => tag.trim());
  const key = tags.join("\n");
  let pattern = systemLines.get(key);
  if (!pattern) {
    pattern = new RegExp(`^\\s*(?:${[SYSTEM_LINE_BASE, ...tags.map(escapeRegExp)].join("|")})`, "i");
    systemLines.set(key, pattern);
  }
  return pattern;
}
export function userLineSpeaker(content: string, userName = USER_NAME): string {
  if (SCHEDULED_LINE.test(content)) return tr(SCHEDULED_SPEAKER);
  if (systemLinePattern().test(content)) return "System";
  return roomUserSpeaker(content, userName);
}

export function countSubstantiveTurns(history: Message[]): number {
  return history.filter((message) => message.role === "user" && Boolean((message.content ?? "").trim()) && !String(message.content).startsWith("[bridge ")).length;
}

function realAssistantSpeech(message: Message): string {
  const calls = message.tool_calls?.filter((call) => isReplyToolName(call.function.name) || isRoomTool(call.function.name) || isPeerTool(call.function.name));
  // Session eligibility counts model turns independently of what is exported.
  const content = (message.content ?? "").trim();
  const { texts, rooms, peers } = toolCallSpeech(calls);
  const speech = content && content !== "." ? content : texts.join("\n\n").trim();
  return [speech, ...rooms, ...peers].filter(Boolean).join("\n\n").trim();
}

export function countRealTurns(history: Message[]): number {
  return history.filter((message) => {
    if (message.role === "assistant") return Boolean(realAssistantSpeech(message));
    const content = (message.content ?? "").trim();
    return message.role === "user" && !syntheticInputs.has(message) && Boolean(content) && !content.startsWith("[bridge ") && !systemLinePattern().test(content) && !SCHEDULED_LINE.test(content);
  }).length;
}

// Prompts the house types itself in fixed words: moments and the birth prompt ([gateway:*]),
// cache pings and idle nudges (the cache-ping tag and the house's older names for it).
const housePromptLines = new Map<string, RegExp>();
function housePromptLine(): RegExp {
  // A reminder line carries the agent's own todo, so it stays a System line in the chronicle.
  const reminder = new Set([REMINDER_TAG, tr(REMINDER_TAG)]);
  const tags = [...new Set([CACHE_PING_TAG, tr(CACHE_PING_TAG), ...ALIASES.systemTags])].filter((tag) => tag.trim() && !reminder.has(tag));
  const key = tags.join("\n");
  let pattern = housePromptLines.get(key);
  if (!pattern) {
    // Case-sensitive on purpose: a person's sentence that merely starts with the same word stays.
    pattern = new RegExp([String.raw`^\s*(?:\[silent\]\s*)?\[gateway(?::[a-z-]+)?\]`, ...tags.map((tag) => String.raw`^\s*` + escapeRegExp(tag))].join("|"));
    housePromptLines.set(key, pattern);
  }
  return pattern;
}

// The chronicle keeps conversation; the same prompt repeated in every session would come back through the inlet as memory.
export function isHousePrompt(message: Message, content: string): boolean {
  return syntheticInputs.has(message) || isScheduledTurn(content) || housePromptLine().test(content);
}

export function historyToMarkdown(history: Message[], header: { name: string; date: string }, style: "brain" | "house" = ARCHIVE_PARK_DIR ? "house" : "brain"): string {
  const records = resolveOutreachRecords(history.map(speechRecord));
  const speech = new Map(history.map((message, index) => [message, records[index]]));
  const archiveSpeech = (message: Message): string => outreachSpeech(speech.get(message)!);
  if (style === "house") {
    const number = header.name.match(/(\d+(?:\.\d+)?)/)?.[1] ?? "0";
    let out = [
      `# [${header.name}] [DATE: ${header.date}]`,
      "",
      `SESSION=${number} | TYPE=CHAT | DATE=${header.date}`,
      "THEMES=—",
      "SUMMARY=—",
      "EMOTIONAL_ARC=—",
      "KEY_MOMENTS=—",
      "DYNAMIC=—",
    ].join("\n") + "\n";
    for (const message of history) {
      if (message.role === "user") {
        const content = (message.content ?? "").trim();
        if (isHousePrompt(message, content)) continue;
        if (!content || content.startsWith("[bridge ")) continue;
        out += `\n---\n\n**${userLineSpeaker(content)}**\n\n${content}\n`;
      } else if (message.role === "assistant") {
        const content = archiveSpeech(message);
        if (content) out += `\n---\n\n**${WORKER_NAME}**\n\n${content}\n`;
      }
    }
    return out;
  }
  const lines = [
    `# [${header.name}] [DATE: ${header.date}]`,
    "",
    `SESSION=${header.name} | TYPE=BRAIN | DATE=${header.date}`,
    "THEMES=placeholder",
    "SUMMARY=placeholder.",
    "EMOTIONAL_ARC=placeholder",
    "KEY_MOMENTS=placeholder",
    "DYNAMIC=placeholder.",
    "",
    "---",
    "",
  ];
  for (const message of history) {
    if (message.role === "user") {
      const content = (message.content ?? "").trim();
      if (isHousePrompt(message, content)) continue;
      if (!content || content.startsWith("[bridge ")) continue;
      lines.push(`**${userLineSpeaker(content)}**`, "", content, "");
    } else if (message.role === "assistant") {
      const content = archiveSpeech(message);
      if (!content) continue;
      lines.push(`**${WORKER_NAME}**`, "", content, "");
    }
  }
  return lines.join("\n");
}

export function extractBridge(history: Message[], turns = 40, speech = assistantSpeechText): string {
  const visible = history.filter((message) => {
    if (message.role === "user") return Boolean((message.content ?? "").trim());
    if (message.role === "assistant") return Boolean(speech(message));
    return false;
  });
  const userIndexes = visible.map((message, index) => message.role === "user" ? index : -1).filter((index) => index >= 0);
  const start = userIndexes.length <= turns ? 0 : userIndexes[userIndexes.length - turns];
  const lines: string[] = [];
  for (const message of visible.slice(start)) {
    if (message.role === "user") {
      const content = (message.content ?? "").trim();
      if (content.startsWith("[bridge ")) continue;
      lines.push(`**${userLineSpeaker(content)}**`, "", content, "");
    } else {
      const content = speech(message);
      if (content) lines.push(`**${WORKER_NAME}**`, "", content, "");
    }
  }
  return lines.join("\n").trim() + "\n";
}

export function mergeBridgeSegments(current: string, previousRaw: string, maxPreviousCharacters = 60_000): string {
  const previous = tailWholeTurns(previousRaw.trim(), maxPreviousCharacters, bridgeSpeakers());
  if (!previous) return current;
  return `[bridge segment 1 — earlier session]\n\n${previous}\n\n---\n\n[bridge segment 2 — most recent session]\n\n${current}`;
}

function wakeBridgeConfig(bridgeSessions?: number): WakeBridgeConfig {
  const shape = bridgeShape();
  return {
    bridgeFile: BRIDGE_FILE, stateDir: STATE_DIR, logDir: LOG_DIR, sessionPrefix: SESSION_PREFIX,
    noBridgeMarker: BRIDGE_NO_BRIDGE_MARKER,
    mode: bridgeSessions === undefined ? shape.mode : "sessions", n: bridgeSessions ?? shape.sessions,
    turns: shape.turns, minUserTurns: shape.minUserTurns,
    userName: USER_NAME, workerName: WORKER_NAME, systemLine: systemLinePattern(), scheduledLine: SCHEDULED_LINE,
    cleaning: PROJECTION.bridgeCleaning,
    jump: JUMP.bridge,
    freshZone: shape.freshChars > 0
      ? (log) => freshZoneCut(log, { userName: USER_NAME, workerName: WORKER_NAME, systemLine: systemLinePattern(), scheduledLine: SCHEDULED_LINE }, { maxChars: shape.freshChars })
      : null,
  };
}

function bridgeCutShare(raw: string | undefined): number {
  const share = Number.parseFloat((raw ?? "").trim());
  return Number.isFinite(share) && share >= 0 ? Math.min(share, 1) : 0.5;
}

function bridgeMaxBytes(raw: string | undefined): number {
  const max = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(max) && max >= 0 ? max : 500_000;
}

let windowShareNoticed = false;
function noticeWindowShare(env: Record<string, string | undefined>): void {
  const value = (env.BRAIN_BRIDGE_WINDOW_SHARE ?? "").trim();
  if (!value || windowShareNoticed) return;
  windowShareNoticed = true;
  logEvent({ type: "bridge_window_share_ignored", value, use: "BRAIN_BRIDGE_CUT_SHARE" });
  console.warn("bridge: BRAIN_BRIDGE_WINDOW_SHARE is superseded and ignored; the ceiling is BRAIN_BRIDGE_CUT_SHARE of the watchdog cut");
}

export function bridgeCapFor(head: HeadSpec, env: Record<string, string | undefined> = headEnvironment()): number | null {
  noticeWindowShare(env);
  return bridgeCapBytes(watchdogThresholds(head, env).cut, bridgeCutShare(env.BRAIN_BRIDGE_CUT_SHARE), bridgeMaxBytes(env.BRAIN_BRIDGE_MAX_BYTES));
}

export function bridgeSpeakers(): string[] {
  return [...new Set([USER_NAME, WORKER_NAME, "System", SCHEDULED_SPEAKER, tr(SCHEDULED_SPEAKER)])];
}

const BRIDGE_PREFIX = "[bridge — prior session context; do not respond to this block directly]\n\n";

export function capBridgeMessage<T extends { role: string; content?: unknown }>(messages: T[], head: HeadSpec): T[] {
  const cap = bridgeCapFor(head);
  if (cap === null) return messages;
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content !== "string" || !message.content.startsWith(BRIDGE_PREFIX)) return message;
    const clipped = clipBridge(message.content.slice(BRIDGE_PREFIX.length), cap, bridgeSpeakers());
    return clipped.clipped ? { ...message, content: BRIDGE_PREFIX + clipped.text } : message;
  });
}

function houseModelLine(state: RuntimeState): string {
  const head = currentHead(state);
  const served = state.servedModel && !head.model.startsWith(state.servedModel) ? tr` (last served: ${state.servedModel})` : "";
  return tr`${head.model}${served} · head ${head.name}`;
}

function houseCutInfo(state: RuntimeState, reason: string): CutInfo {
  return {
    sessionId: SESSION_ID,
    // a log that could not be written: the in-memory history stands in for it
    ownLogFallback: existsSync(CONVERSATION_LOG) ? undefined : state.history.map((message) => JSON.stringify(speechRecord(message))).join("\n"),
    reason,
    model: houseModelLine(state),
    nextHead: state.move ? tr`${state.move.target.head} · model ${state.move.target.model} · window ${state.move.target.window}` : undefined,
    now: new Date(),
    wakeByBrain: Boolean(MEMORY_URL && MEMORY_KEY),
  };
}

/** If the bridge cannot be built at all, the plain bridge below is used: a cut
 * never leaves the next session without one. */
function writeBridgeFileSync(state: RuntimeState, reason = "exit", strict = false): WakeBuilt | null {
  try {
    const built = writeWakeBridgeSync(wakeBridgeConfig(state.move?.bridgeSessions), houseCutInfo(state, state.move ? "move" : reason), logEvent);
    if (built === "empty") return null;
    if (built) return built;
    if (existsSync(BRIDGE_FILE)) return null;
  } catch (error) {
    logEvent({ type: "bridge_build_failed", error: String(error) });
    if (strict) throw error;
  }
  const history = resolveOutreachRecords(state.history.map(speechRecord)) as Message[];
  const bridge = extractBridge(history, bridgeShape().turns);
  if (!bridge.trim()) return null;

  let combined = bridge;
  const usedPath = BRIDGE_FILE.replace(/\.md$/, ".used.md");
  if (existsSync(usedPath)) {
    try {
      combined = mergeBridgeSegments(bridge, readFileSync(usedPath, "utf8"));
    } catch {
      // A stale or unreadable prior bridge must not block the new bridge.
    }
  }
  mkdirSync(dirname(BRIDGE_FILE), { recursive: true });
  writeFileSync(BRIDGE_FILE, combined, "utf8");
  try { markOwnBridge(STATE_DIR, combined, SESSION_ID, new Date()); } catch (error) { if (strict) throw error; }
  logEvent({ type: "bridge_written_plain", characters: combined.length });
  return null;
}

function hasEarlierLife(): boolean {
  try { if (archiveLedger().size) return true; } catch {}
  try { if (readFileSync(ARCHIVED_MARKER(), "utf8").trim()) return true; } catch {}
  if (readPendingUploads(PENDING_UPLOADS()).length) return true;
  try { readFileSync(BRIDGE_FILE.replace(/\.md$/, ".used.md"), "utf8"); return true; } catch {}
  try {
    return readdirSync(LOG_DIR, { withFileTypes: true }).some((entry) => {
      const match = /^(?:session|conversation)-(.+)\.jsonl$/.exec(entry.name);
      return entry.isFile() && match !== null && match[1] !== SESSION_ID;
    });
  } catch { return false; }
}

async function loadWakeAndBridge(state: RuntimeState): Promise<void> {
  if (state.wakeLoaded) return;
  if (MEMORY_URL && MEMORY_KEY) {
    try {
      const wake = await memoryToolCall("wake", {});
      const id = `wake_${Date.now()}`;
      const call: Message = {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "wake", arguments: "{}" } }],
      };
      const result: Message = { role: "tool", tool_call_id: id, name: "wake", content: wake };
      state.history.push(call, result);
      logTurn(call);
      logTurn(result);
      state.initialWakeContext = wake;
      logEvent({ type: "wake_loaded", characters: wake.length });
    } catch (error) {
      logEvent({ type: "wake_failed", error: String(error) });
    }
  }
  // A process killed without its exit hook (SIGKILL, out of memory) leaves no
  // bridge behind; build it now.
  try {
    const dead = birthRebuildNeeded(wakeBridgeConfig(), SESSION_ID);
    if (dead) {
      const built = writeWakeBridgeSync(wakeBridgeConfig(), { ...houseCutInfo(state, "birth-rebuild"), ownLogFallback: undefined, manifestSessionId: dead }, logEvent);
      logEvent({ type: "bridge_birth_rebuild", for_life: dead, written: Boolean(built && built !== "empty") });
    }
  } catch (error) {
    logEvent({ type: "bridge_birth_rebuild_failed", error: String(error) });
  }
  if (existsSync(BRIDGE_FILE)) {
    try {
      const raw = readFileSync(BRIDGE_FILE, "utf8");
      const bridge = raw.trim();
      if (bridge) {
        let jump = false;
        try { jump = captureJumpIfForeign(STATE_DIR, raw, { sessionId: SESSION_ID, startMs: SESSION_START_MS, now: new Date() }); } catch (error) { logEvent({ type: "bridge_jump_capture_failed", error: String(error) }); }
        const message: Message = { role: "user", content: `${BRIDGE_PREFIX}${bridge}` };
        state.history.push(message);
        logTurn(message);
        state.bridgeText = bridge;
        const usedPath = BRIDGE_FILE.replace(/\.md$/, ".used.md");
        renameSync(BRIDGE_FILE, usedPath);
        logEvent({ type: "bridge_loaded", characters: bridge.length, jump_unit: jump });
      }
    } catch (error) {
      logEvent({ type: "bridge_load_failed", error: String(error) });
    }
  }
  if (!state.initialWakeContext?.trim()) startupFallback("wake", "Wake memory is unavailable", "The agent starts without its current memory snapshot.", "Restore the wake tool in the memory service; check BRAIN_MEMORY_URL and BRAIN_MEMORY_API_KEY.");
  if (!state.bridgeText?.trim() && hasEarlierLife()) startupFallback("bridge", "Conversation bridge is unavailable", "The agent cannot see the end of its previous conversation at this start.", `Check BRAIN_BRIDGE_FILE (${BRIDGE_FILE}) and restore the previous conversation bridge.`);
  state.sessionStartIndex = state.history.length;
  state.wakeLoaded = true;
}

export function estimateTokens(message: Message): number {
  let characters = typeof message.content === "string" ? message.content.length : JSON.stringify(message.content ?? "").length;
  if (message.tool_calls) characters += JSON.stringify(message.tool_calls).length;
  return Math.ceil(characters / 3.6);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const inletTurnCounter = { value: 0 };
const inletLastSeen = new Map<string, number>();
const INLET_DEDUPE_TTL = Number.parseInt(process.env.BRAIN_INLET_DEDUPE_TURN_TTL ?? "300", 10);

// "empty" means the worker found nothing to add. Only a real failure may fall
// back; a configured worker never falls back to a raw search dump, which would
// bypass its relevance filter.
type InletWorkerResult = { kind: "text"; text: string } | { kind: "empty" } | { kind: "fail"; reason: string };

const modelCatalogCache = new ModelCatalogCache(() => Date.now(), logEvent);
const claudeCatalogKey = (account: string | null) => JSON.stringify(["claude", account]);

async function claudeModelsCached(mode: CatalogReadMode = "cached"): Promise<ModelInfo[] | null> {
  const selectedEnv = headEnvironment();
  if (resolveHead("claude", selectedEnv).unavailable) return null;
  const vars = ACCOUNT.pipeEnv();
  const account = vars.name;
  const env: Record<string, string | undefined> = { ...selectedEnv, ...vars.set };
  for (const key of vars.unset) delete env[key];
  return modelCatalogCache.get(claudeCatalogKey(account), async () => {
    const models = await probeClaudeModels({ bin: selectedEnv.BRAIN_CLAUDE_BIN || "claude", env });
    logEvent({ type: "claude_models_probe", account, ok: Boolean(models?.length), count: models?.length ?? 0 });
    return models;
  }, mode);
}

async function listModelsCached(name: string, mode: CatalogReadMode = "cached"): Promise<ModelInfo[] | null> {
  const env = headEnvironment();
  const head = resolveHead(name, env);
  // Read the subscription catalog even while the adapter is down, when the menu is most useful.
  const authFile = name === "gpt" && !head.unavailable
    ? (env.CHATGPT_AUTH_FILE?.trim() || join(homedir(), ".codex", "auth.json")) : "";
  const request = name === "gpt" ? null : modelsListRequest(head);
  if (!request && !(authFile && existsSync(authFile))) return null;
  const key = `${name} ${request?.url ?? authFile}`;
  return modelCatalogCache.get(key, async () => {
    const models = await (request ? probeListModels(request) : probeGptModels(authFile));
    logEvent({ type: "head_models_probe", head: name, ok: Boolean(models?.length), count: models?.length ?? 0 });
    return models;
  }, mode);
}

async function probedCatalogs(refresh = false) {
  const mode = modelCatalogCache.readMode(refresh);
  const [claude, gpt, grok, kimi] = await Promise.all([claudeModelsCached(mode), listModelsCached("gpt", mode), listModelsCached("grok", mode), listModelsCached("kimi", mode)]);
  const probed: Partial<Record<string, ModelInfo[]>> = {};
  if (claude) probed.claude = claude;
  if (gpt) probed.gpt = gpt;
  if (grok) probed.grok = grok;
  if (kimi) probed.kimi = kimi;
  return { claude, probed, catalogsUpdatedAt: modelCatalogCache.updatedAt };
}

function catalogEffortLevels(head: HeadSpec): string[] {
  if (head.name !== "claude" || head.pipeEnv.ANTHROPIC_BASE_URL) return [];
  const models = modelCatalogCache.peek(claudeCatalogKey(ACCOUNT.pipeEnv().name));
  return [...new Set((models ?? []).flatMap((m) => m.supportedEffortLevels ?? []))];
}

function cleanupInletSessionState(now = Date.now()): void {
  const cutoff = now - 3 * 86_400_000;
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.startsWith("inlet-turn-counter-") || f.endsWith(SESSION_ID)) continue;
      try { if (statSync(join(STATE_DIR, f)).mtimeMs < cutoff) unlinkSync(join(STATE_DIR, f)); } catch { /* gone */ }
    }
    const cacheRoot = join(STATE_DIR, "inlet-chunk-cache");
    for (const d of existsSync(cacheRoot) ? readdirSync(cacheRoot) : []) {
      if (d === SESSION_ID) continue;
      try { if (statSync(join(cacheRoot, d)).mtimeMs < cutoff) rmSync(join(cacheRoot, d), { recursive: true, force: true }); } catch { /* gone */ }
    }
  } catch { /* housekeeping is never a blocker */ }
}

async function runInletViaWorker(userText: string, recent: string): Promise<InletWorkerResult> {
  if (!INLET_WORKER) return { kind: "fail", reason: "no worker configured" };
  try {
    let timedOut = false;
    // A turn counter and a chunk cache per session, so the same archive chunk
    // does not come back on every turn.
    const counterFile = join(STATE_DIR, `inlet-turn-counter-${SESSION_ID}`);
    const cacheDir = join(STATE_DIR, "inlet-chunk-cache", SESSION_ID);
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(`${counterFile}.tmp`, String(Math.max(0, inletTurnCounter.value - 1)));
      renameSync(`${counterFile}.tmp`, counterFile);
    } catch { /* fail-open: the worker then runs without lockout */ }
    const proc = Bun.spawn(["bun", INLET_WORKER, userText.slice(0, 4000), recent], {
      cwd: INLET_WORKER_CWD, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...(process.env as Record<string, string>), INLET_COUNTER_FILE: counterFile, INLET_CHUNK_CACHE_DIR: cacheDir },
    });
    const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGTERM"); } catch { /* gone */ } }, INLET_WORKER_TIMEOUT_MS);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    if (INLET_WORKER_LOG && err) {
      try {
        if (existsSync(INLET_WORKER_LOG) && statSync(INLET_WORKER_LOG).size > 5_000_000) {
          const raw = readFileSync(INLET_WORKER_LOG);
          writeFileSync(`${INLET_WORKER_LOG}.tmp`, raw.subarray(raw.length - 2_000_000));
          renameSync(`${INLET_WORKER_LOG}.tmp`, INLET_WORKER_LOG);
        }
        appendFileSync(INLET_WORKER_LOG, err.endsWith("\n") ? err : `${err}\n`);
      } catch { /* a log is never a blocker */ }
    }
    const text = out.trim();
    logEvent({ type: "usage_coverage", source: "helper", helper_id: `inlet:${SESSION_ID}:${inletTurnCounter.value}`, reason: "external_inlet_has_no_usage_protocol" });
    if (timedOut) return { kind: "fail", reason: `timeout ${INLET_WORKER_TIMEOUT_MS} ms; ${err.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` };
    if (proc.exitCode !== 0) return { kind: "fail", reason: `exit ${proc.exitCode}; ${err.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` };
    if (!text || text === "BYPASS") return { kind: "empty" };
    return { kind: "text", text };
  } catch (error) {
    return { kind: "fail", reason: String(error).slice(0, 300) };
  }
}

export function recentTurnsText(history: Message[], pairs = 3, maxChars = 280): string {
  const lines: string[] = [];
  const push = (speaker: string, text: string) => {
    const flat = text.split(/\s+/).join(" ");
    lines.push(`${speaker}: ${flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat}`);
  };
  for (const message of history) {
    if (message.role === "user") {
      const text = (message.content ?? "").trim();
      if (!text || text.startsWith("[bridge ")) continue;
      // The channel wrapper with its ids would take half of each line; only what was said counts.
      const bodies = [...text.matchAll(/<channel[^>]*>([\s\S]*?)<\/channel>/g)].map((match) => match[1].trim()).filter(Boolean);
      for (const body of bodies.length ? bodies : [text]) push(userLineSpeaker(body), body);
    } else if (message.role === "assistant") {
      const text = contextSpeechText(message);
      if (text) push(WORKER_NAME, text);
    }
  }
  return lines.slice(-pairs * 2).join("\n");
}

export async function runInlet(userText: string, recent = ""): Promise<string | null> {
  inletTurnCounter.value += 1;
  let result: string | null = null;
  const worker = await runInletViaWorker(userText, recent);
  const viaWorker = worker.kind === "text" ? worker.text : null;
  if (worker.kind === "text") {
    result = `<inlet>\n${worker.text}\n</inlet>`;
  } else if (INLET_WORKER) {
    logEvent({ type: worker.kind === "empty" ? "inlet_worker_empty" : "inlet_worker_failed", ...(worker.kind === "fail" ? { reason: worker.reason } : {}) });
    return null;
  } else {
    const searches: Promise<string>[] = [];
    if (RAG_URL && RAG_AUTH_TOKEN) searches.push(ragSearch(userText.slice(0, 2000), 10).catch(() => ""));
    if (MEMORY_URL && MEMORY_KEY) {
      searches.push(memoryToolCall("scan", { query: userText, hot_limit: 5, cold_limit: 0 }).catch(() => ""));
      searches.push(memoryToolCall("find", { query: userText, limit: 5 }).catch(() => ""));
    }
    if (!searches.length) return null;
    const results = await Promise.all(searches);
    const blocks = results.filter((result) => result && !/found 0 events|"total":\s*0|no events/i.test(result));
    if (!blocks.length) return null;
    result = `<inlet>\n${blocks.map((block, index) => `${index === 0 ? "### Retrieved context" : "### Additional resonance"}\n${block}`).join("\n\n")}\n</inlet>`;
  }
  const hash = sha256Hex(result);
  const last = inletLastSeen.get(hash);
  if (last !== undefined && inletTurnCounter.value - last < INLET_DEDUPE_TTL) {
    logEvent({ type: "inlet_dedupe_suppressed", hash: hash.slice(0, 12), turn_difference: inletTurnCounter.value - last });
    return null;
  }
  inletLastSeen.set(hash, inletTurnCounter.value);
  logEvent({ type: "inlet_injected", via: viaWorker !== null ? "worker" : "builtin", characters: result.length, block: result.slice(0, 4000) });
  if (inletLastSeen.size > 1000) {
    const cutoff = inletTurnCounter.value - 2 * INLET_DEDUPE_TTL;
    for (const [key, turn] of inletLastSeen) if (turn < cutoff) inletLastSeen.delete(key);
  }
  return result;
}

export function messageTokens(history: Message[]): number {
  return history.reduce((total, message) => total + estimateTokens(message), 0);
}

async function uploadToRAG(name: string, content: string, timeoutMs = 60_000): Promise<{ ok: boolean; error?: string }> {
  if (!RAG_URL || !RAG_AUTH_TOKEN) return { ok: false, error: "memory archive is not configured" };
  try {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/markdown" }), name);
    const response = await fetch(`${RAG_URL.replace(/\/$/, "")}/upload`, {
      method: "POST",
      headers: authHeaders(RAG_AUTH_TOKEN),
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${await response.text()}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function deleteFromRAG(name: string): Promise<boolean> {
  if (!RAG_URL || !RAG_AUTH_TOKEN) return false;
  try {
    const response = await fetch(`${RAG_URL.replace(/\/$/, "")}/delete`, {
      method: "POST",
      headers: { ...authHeaders(RAG_AUTH_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ filename: name }),
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Counts as uploaded only when every part landed. After a failure the whole
 * archive is retried under the same names; the archive replaces a file of the
 * same name. */
async function uploadArchiveToRAG(name: string, markdown: string): Promise<{ ok: boolean; error?: string; parts: number }> {
  const parts = splitArchive(name, markdown);
  for (const part of parts) {
    const result = await uploadToRAG(part.name, part.content, 120_000);
    if (!result.ok) return { ok: false, error: parts.length > 1 ? `${part.name}: ${result.error}` : result.error, parts: parts.length };
  }
  if (parts.length > 1) await removeStaleUnsplit(name, markdown);
  return { ok: true, parts: parts.length };
}

/** An earlier attempt may have left a half copy under the unsplit name. It is
 * deleted only when its beginning is this archive's own. Never fatal. */
async function removeStaleUnsplit(name: string, markdown: string): Promise<void> {
  const whole = `${name}.md`;
  try {
    const response = await fetch(`${RAG_URL.replace(/\/$/, "")}/head?filename=${encodeURIComponent(whole)}&bytes=4000`, {
      headers: authHeaders(RAG_AUTH_TOKEN), signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: any = await response.json();
    if (data?.filename !== whole) return;
    // A byte range may end inside a character; the decoder marks it with U+FFFD.
    const head = String(data?.head ?? "").replace(/\uFFFD+$/, "");
    if (Buffer.byteLength(head, "utf8") < 4000 - 3 || !markdown.startsWith(head)) {
      logEvent({ type: "rag_unsplit_kept", name: whole, reason: "not this archive" });
      return;
    }
    const deleted = await deleteFromRAG(whole);
    logEvent({ type: "rag_unsplit_removed", name: whole, ok: deleted });
  } catch (error) {
    logEvent({ type: "rag_unsplit_check_failed", name: whole, error: String(error) });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function nextSessionName(): Promise<string> {
  return (await sessionNumbering()).name;
}

export interface SessionNumbering {
  name: string;
  source: "override" | "rag" | "local";
  ragNums: number[] | null;
  ragFiles?: Array<{ num: number; name: string }>;
  ragError?: string;
}

export function isHouseBirth(numbering: SessionNumbering): boolean {
  return numbering.source === "rag" && (numbering.ragNums?.length ?? 0) === 0 && /_0*1$/.test(numbering.name);
}

export async function sessionNumbering(config = {
  prefix: SESSION_PREFIX, override: SESSION_NAME_OVERRIDE,
  localDirs: [SESSION_ARCHIVE_DIR, ARCHIVE_PARK_DIR], ragUrl: RAG_URL, ragToken: RAG_AUTH_TOKEN,
}): Promise<SessionNumbering> {
  if (config.override) return { name: config.override, source: "override", ragNums: null };
  const pattern = new RegExp(`^${escapeRegex(config.prefix)}_(\\d+)(?:_part\\d+)?\\.md$`);
  let highest = 0, padding = 0;
  const observe = (name: string): number | null => {
    const match = pattern.exec(name);
    if (!match) return null;
    const num = Number(match[1]);
    if (!Number.isSafeInteger(num)) return null;
    highest = Math.max(highest, num);
    if (match[1].length > 1 && match[1].startsWith("0")) padding = Math.max(padding, match[1].length);
    return num;
  };
  const nextName = () => `${config.prefix}_${String(highest + 1).padStart(padding, "0")}`;
  for (const dir of config.localDirs.filter(Boolean)) {
    try { for (const file of readdirSync(dir)) observe(file); }
    catch { /* The local archive directory may not exist yet. */ }
  }
  if (config.localDirs.includes(SESSION_ARCHIVE_DIR)) {
    for (const receipt of archiveLedger().values()) observe(`${receipt.name}.md`);
  }
  const fallback = nextName();
  if (!config.ragUrl) return { name: fallback, source: "local", ragNums: null, ragError: tr("no RAG configured") };
  try {
    const response = await fetch(`${config.ragUrl.replace(/\/$/, "")}/list`, {
      headers: authHeaders(config.ragToken), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { name: fallback, source: "local", ragNums: null, ragError: `HTTP ${response.status}` };
    const data: any = await response.json();
    const files = Array.isArray(data?.files) ? data.files : [];
    const ragFiles: Array<{ num: number; name: string }> = [];
    const seen = new Set<string>();
    for (const file of files) {
      const name = typeof file === "string" ? file : String(file?.name ?? "");
      const num = observe(name);
      if (num !== null && !seen.has(name)) { ragFiles.push({ num, name }); seen.add(name); }
    }
    ragFiles.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name, "en", { numeric: true }));
    return { name: nextName(), source: "rag", ragNums: [...new Set(ragFiles.map((f) => f.num))], ragFiles };
  } catch (error) {
    return { name: fallback, source: "local", ragNums: null, ragError: String((error as Error)?.message ?? error) };
  }
}

export async function capsuleArc(numbering: SessionNumbering, ending: number, archived: boolean, config = {
  ragUrl: RAG_URL, ragToken: RAG_AUTH_TOKEN, prefix: SESSION_PREFIX, sessions: bridgeShape().sessions,
}): Promise<string> {
  if (!config.ragUrl) return tr("(no RAG configured)");
  if (numbering.source === "override") return tr`(archive name fixed: ${numbering.name} — RAG not queried)`;
  if (!numbering.ragNums) return tr`(RAG unreachable: ${numbering.ragError ?? tr("no answer")})`;
  const nums = numbering.ragNums;
  if (!nums.length) return tr`(no ${config.prefix}_N files in RAG)`;
  const selected = new Set(config.sessions > 1 ? nums.slice(-(config.sessions - 1)) : []);
  // Every part of a split session carries the same header, so one file per session is enough.
  const files = (numbering.ragFiles ?? []).filter((file) => selected.delete(file.num));
  const lines: string[] = [];
  for (const file of files) {
    try {
      const response = await fetch(`${config.ragUrl.replace(/\/$/, "")}/head?filename=${encodeURIComponent(file.name)}&bytes=800`, {
        headers: authHeaders(config.ragToken), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: any = await response.json();
      lines.push(String(data?.head ?? "").replace(/�/g, "").split("\n---\n")[0].trim());
    } catch {
      lines.push(tr`# [${file.name.replace(/\.md$/, "")}] (header unavailable)`);
    }
  }
  lines.push(archived && Number.isFinite(ending)
    ? tr`# [${numbering.name}] — the session ending now. Its header is created on export (see RAG).`
    : tr("# (the session ending now gets no archive of its own)"));
  return lines.join("\n\n");
}

async function completeWakeBridge(built: WakeBuilt, numbering: SessionNumbering, archived: boolean, strict = false): Promise<void> {
  try {
    const ending = Number(/(\d+)(?!.*\d)/.exec(numbering.name)?.[1] ?? Number.NaN);
    const trusted = (numbering.source === "rag" || numbering.source === "override") && Number.isFinite(ending);
    const line = trusted ? numberLine({ sessionPrefix: SESSION_PREFIX, workerName: WORKER_NAME }, ending, archived, MIN_TURNS_FOR_UPLOAD) : undefined;
    const arc = await capsuleArc(numbering, ending, archived);
    const done = finishWakeBridge(wakeBridgeConfig(), built, { numberLine: line, arc, now: new Date() });
    logEvent({ type: "bridge_facts", ok: done, number: trusted ? ending : null, source: numbering.source });
    if (strict && !done) throw new Error(tr("Bridge finalization not confirmed"));
  } catch (error) {
    logEvent({ type: "bridge_facts_failed", error: String(error) });
    if (strict) throw error;
  }
}

export async function maybeRollToRag(state: RuntimeState): Promise<void> {
  if (!ROLLING_TOKENS || ROLLING_TOKENS <= 0) return;
  if (Number.isFinite(ROLLING_KEEP_VALUE) && ROLLING_KEEP_VALUE >= ROLLING_TOKENS && !rollingKeepFallbackLogged) {
    rollingKeepFallbackLogged = true;
    logEvent({ type: "rolling_keep_fallback", configured_keep_tokens: ROLLING_KEEP_VALUE,
      rolling_tokens: ROLLING_TOKENS, keep_tokens: ROLLING_KEEP_TOKENS });
  }
  await settleGateway();
  const base = state.rolledIndex;
  const visible = state.history.slice(base);
  const visibleTokens = messageTokens(visible);
  if (visibleTokens <= ROLLING_TOKENS) return;
  if (!RAG_URL || !RAG_AUTH_TOKEN) {
    logEvent({ type: "rolling_blocked", reason: "no configured memory archive", visible_tokens: visibleTokens });
    return;
  }

  // Each roll invalidates the provider's cached prefix, so leave room for many hops.
  const targetTokens = Math.max(visibleTokens - ROLLING_KEEP_TOKENS, ROLLING_SEGMENT_TOKENS);
  let accumulated = 0;
  let end = base;
  for (let index = base; index < state.history.length; index += 1) {
    accumulated += estimateTokens(state.history[index]);
    end = index + 1;
    if (accumulated >= targetTokens) break;
  }
  const filledEnd = end;
  // Prefer a complete user turn. A single long tool turn has no such edge:
  // keep each assistant call and ALL of its results together, cutting before
  // the next assistant hop (never before or between tool results).
  const startsHop = (index: number): boolean => {
    const message = state.history[index];
    return message?.role === "assistant"
      && (Boolean(message.tool_calls?.length) || state.history[index - 1]?.role === "tool");
  };
  let boundary: "user" | "hop" | null = null;
  while (end < state.history.length
    && !(state.history[end].role === "user" && typeof state.history[end].content === "string")) end += 1;
  if (end < state.history.length) {
    boundary = "user";
  } else {
    for (let index = filledEnd; index < state.history.length; index += 1) {
      if (startsHop(index)) { end = index; boundary = "hop"; break; }
    }
    // The target may fall inside the last (large) result. Retain that whole
    // hop, rather than swallowing the entire visible window or blocking it.
    if (!boundary) {
      for (let index = Math.min(filledEnd - 1, state.history.length - 1); index > base; index -= 1) {
        if (startsHop(index)) { end = index; boundary = "hop"; break; }
      }
    }
  }
  if (!boundary || end <= base || end >= state.history.length) {
    logEvent({ type: "rolling_blocked", reason: "no complete segment boundary (user or hop)", visible_tokens: visibleTokens });
    return;
  }

  const segment = state.history.slice(base, end);
  const segmentNumber = state.rolledSegments + 1;
  const name = `${WORKER_NAME}_${SESSION_ID}_live${String(segmentNumber).padStart(2, "0")}.md`;
  const markdown = historyToMarkdown(segment, { name, date: localDateKey(firstLoggedAt(segment) ?? Date.now()) }, "brain");

  // The order is deliberate: upload and receive confirmation before moving
  // the cut edge. A failed upload leaves every message in the visible window.
  const uploaded = await uploadToRAG(name, markdown);
  if (!uploaded.ok) {
    logEvent({ type: "rolling_upload_failed", segment: name, error: uploaded.error, visible_tokens: visibleTokens });
    return;
  }
  state.rolledIndex = end;
  for (const key of Object.keys(state.inletBlocks)) {
    if (Number(key) < end) delete state.inletBlocks[Number(key)];
  }
  state.rolledSegments = segmentNumber;
  state.liveSegmentNames.push(name);
  logEvent({ type: "rolling_completed", segment: name, messages: segment.length, rolled_index: end, boundary,
    visible_tokens: visibleTokens, visible_tokens_after: messageTokens(state.history.slice(end)) });
}

/** A session is never held back for its header: anything short of a real
 * header keeps the archive as it was. */
export async function enrichArchiveHeader(name: string, markdown: string, opts: { cmd?: string; timeoutMs?: number } = {}): Promise<string> {
  const cmd = opts.cmd ?? HEADER_ENRICH_CMD;
  if (!cmd) return markdown;
  const dir = mkdtempSync(join(tmpdir(), "brain-header-"));
  const file = join(dir, `${name.replace(/[^\w.-]/g, "_")}.md`);
  try {
    writeFileSync(file, markdown, { encoding: "utf8", mode: 0o600 });
    const proc = Bun.spawn([cmd, file], { cwd: dir, stdout: "ignore", stderr: "ignore", env: { ...process.env, EMBERVY_BRAIN_SUBTURN: "1" } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((done) => { timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} done(-1); }, opts.timeoutMs ?? HEADER_ENRICH_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (code !== 0) {
      logEvent({ type: "archive_header_kept", name, reason: code === -1 ? "timeout" : `exit ${code}` });
      return markdown;
    }
    const enriched = readFileSync(file, "utf8");
    const header = enriched.split("\n---\n")[0] ?? "";
    if (!enriched.startsWith("# [") || !/^THEMES=(?!placeholder|—)\S/m.test(header)) {
      logEvent({ type: "archive_header_kept", name, reason: "no real header in the answer" });
      return markdown;
    }
    logEvent({ type: "archive_header_enriched", name });
    return enriched;
  } catch (error) {
    logEvent({ type: "archive_header_kept", name, reason: String(error).slice(0, 200) });
    return markdown;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function writeSessionArchive(name: string, markdown: string): string {
  mkdirSync(SESSION_ARCHIVE_DIR, { recursive: true });
  const path = join(SESSION_ARCHIVE_DIR, `${name}.md`);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, markdown, "utf8");
  renameSync(temp, path);
  return path;
}

function parkForHeader(name: string, markdown: string, strict = false): void {
  if (!ARCHIVE_PARK_DIR) return;
  try {
    mkdirSync(ARCHIVE_PARK_DIR, { recursive: true });
    writeFileSync(join(ARCHIVE_PARK_DIR, `${name}.md`), markdown, { encoding: "utf8", mode: 0o600 });
    logEvent({ type: "session_archive_parked", name, dir: ARCHIVE_PARK_DIR });
  } catch (error) {
    logEvent({ type: "session_archive_park_failed", name, error: String(error) });
    if (strict) throw error;
  }
}

export function uploadLedgerLine(sourceFile: string, name: string): string {
  let size = 0;
  let mtime = Math.floor(Date.now() / 1000);
  try {
    const info = statSync(sourceFile);
    size = info.size;
    mtime = Math.floor(info.mtimeMs / 1000);
  } catch { /* no transcript on disk: size 0, now */ }
  return `${sourceFile.split("/").pop() ?? sourceFile}:${size}:${mtime}:${name}`;
}

function appendUploadLedger(sourceFile: string, name: string, strict = false): void {
  if (!UPLOAD_LEDGER) return;
  try {
    mkdirSync(dirname(UPLOAD_LEDGER), { recursive: true });
    const line = uploadLedgerLine(sourceFile, name);
    appendFileSync(UPLOAD_LEDGER, `${line}\n`);
    logEvent({ type: "upload_ledger_appended", line });
  } catch (error) {
    logEvent({ type: "upload_ledger_failed", name, error: String(error) });
    if (strict) throw error;
  }
}

const ARCHIVED_MARKER = () => join(STATE_DIR, "archived_sessions.txt");
const ARCHIVE_LEDGER = () => join(STATE_DIR, "archive-ledger.jsonl");
let archiveReceipts: Map<string, ArchiveReceipt> | undefined;
function archiveLedger() {
  if (!archiveReceipts) {
    seedArchiveLedger(ARCHIVE_LEDGER(), LOG_DIR, SESSION_ARCHIVE_DIR, UPLOAD_LEDGER, readPendingUploads(PENDING_UPLOADS()));
    archiveReceipts = readArchiveLedger(ARCHIVE_LEDGER());
  }
  return archiveReceipts;
}
function archiveReceipt(session: string, name: string, path: string, uploaded = false, reserved = false): void {
  const previous = archiveLedger().get(session);
  const now = new Date().toISOString();
  const receipt = { session, name, path, archived_at: previous?.archived_at ?? (reserved ? null : now), uploaded_at: uploaded ? now : previous?.uploaded_at ?? null };
  recordArchive(ARCHIVE_LEDGER(), receipt);
  archiveLedger().set(session, receipt);
}

// Serialize archive reservations so every writer sees the other's receipts.
let archiveWork: Promise<unknown> = Promise.resolve();
function withArchiveLock<T>(work: () => Promise<T>): Promise<T> {
  const result = archiveWork.then(work);
  archiveWork = result.catch(() => undefined);
  return result;
}

// A session archived locally is owed to the archive from before its first
// part goes out until every part landed. A failed upload, or a process killed
// mid-upload, is retried at every start under the same name.
const PENDING_UPLOADS = () => join(STATE_DIR, "pending_uploads.jsonl");
interface PendingArchiveUpload extends PendingUpload {
  headerPending?: boolean;
}

/** brain-cutoff.sh writes the pid it is about to cut; the loop then starts the
 * next session, which uploads what is owed in the background. Waiting for the
 * upload here would only keep the agent away for the upload's length. A jump
 * or a stop writes no marker, so those sessions still upload before they go. */
export const CUT_RESPAWN_MARKER = () => join(STATE_DIR, "cut-respawn");
export function respawnFollows(pid = process.pid): boolean {
  let named = NaN;
  try { named = Number(readFileSync(CUT_RESPAWN_MARKER(), "utf8").trim()); } catch { return false; }
  try { rmSync(CUT_RESPAWN_MARKER(), { force: true }); } catch { /* the cutoff removes it too */ }
  return named === pid;
}

function notePendingUpload(entry: Omit<PendingArchiveUpload, "since">): void {
  try {
    const list = readPendingUploads(PENDING_UPLOADS()).filter((p) => p.name !== entry.name);
    writePendingUploads(PENDING_UPLOADS(), [...list, { ...entry, since: new Date().toISOString() }]);
    logEvent({ type: "upload_pending", name: entry.name, session: entry.session });
  } catch (error) { logEvent({ type: "upload_pending_note_failed", name: entry.name, error: String(error) }); }
}

function clearPendingUpload(name: string): void {
  try {
    writePendingUploads(PENDING_UPLOADS(), readPendingUploads(PENDING_UPLOADS()).filter((p) => p.name !== name));
  } catch (error) { logEvent({ type: "upload_pending_clear_failed", name, error: String(error) }); }
}

export async function retryPendingUploads(): Promise<void> {
  if (!RAG_URL || !RAG_AUTH_TOKEN) return;
  const queued = new Set(readPendingUploads(PENDING_UPLOADS()).map((entry) => entry.session));
  for (const receipt of archiveLedger().values()) {
    if (!receipt.uploaded_at && existsSync(receipt.path) && !queued.has(receipt.session)) {
      notePendingUpload({ session: receipt.session, name: receipt.name, path: receipt.path, log: join(LOG_DIR, `conversation-${receipt.session}.jsonl`) });
    }
  }
  const pending: PendingArchiveUpload[] = readPendingUploads(PENDING_UPLOADS());
  if (!pending.length) return;
  for (const entry of pending) {
    let markdown = "";
    try { markdown = readFileSync(entry.path, "utf8"); }
    catch { logEvent({ type: "upload_retry_missing_file", name: entry.name, path: entry.path }); continue; }
    const receipt = archiveLedger().get(entry.session);
    if (entry.headerPending && !receipt?.uploaded_at) {
      try { markdown = await enrichArchiveHeader(entry.name, markdown); }
      catch (error) { logEvent({ type: "archive_header_kept", name: entry.name, reason: String(error) }); }
      // Persist the upload bytes first; a failed upload must not rerun enrichment.
      try {
        const temp = `${entry.path}.tmp-${process.pid}`;
        writeFileSync(temp, markdown, "utf8");
        renameSync(temp, entry.path);
        writePendingUploads(PENDING_UPLOADS(), readPendingUploads(PENDING_UPLOADS()).map((pending) =>
          pending.name === entry.name ? { ...pending, headerPending: false } : pending));
      } catch (error) {
        logEvent({ type: "upload_retry_local_write_failed", name: entry.name, error: String(error) });
        continue;
      }
    }
    const result = receipt?.uploaded_at ? { ok: true, parts: 0 } : await uploadArchiveToRAG(entry.name, markdown);
    logEvent({ type: "upload_retry", name: entry.name, ok: result.ok, parts: result.parts, error: result.error });
    if (!result.ok) continue;
    parkForHeader(entry.name, markdown);
    if (entry.log) appendUploadLedger(entry.log, entry.name);
    archiveReceipt(entry.session, entry.name, entry.path, true);
    for (const segment of entry.segments ?? []) {
      const deleted = await deleteFromRAG(segment);
      logEvent({ type: "rolling_segment_replaced", segment, ok: deleted, via: "upload_retry" });
    }
    clearPendingUpload(entry.name);
  }
}

function markArchived(sessionId: string, strict = false): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(ARCHIVED_MARKER(), `${sessionId}\n`);
  } catch (error) { if (strict) throw error; }
}

function wasArchived(sessionId: string): boolean {
  const receipt = archiveLedger().get(sessionId);
  return Boolean(receipt && (receipt.uploaded_at || (receipt.archived_at && existsSync(receipt.path))));
}

export async function archiveSession(state: RuntimeState, reason = "exit", strict = false, deferUpload = false): Promise<void> {
  return withArchiveLock(() => archiveSessionLocked(state, reason, strict, deferUpload && !strict));
}

async function archiveSessionLocked(state: RuntimeState, reason: string, strict: boolean, deferUpload: boolean): Promise<void> {
  if (reason === "move" && (!RAG_URL.trim() || !RAG_AUTH_TOKEN.trim())) throw new Error(tr("/move requires complete RAG configuration (BRAIN_RAG_URL and BRAIN_RAG_AUTH_TOKEN)"));
  if (state.archiveStarted) return;
  state.archiveStarted = true;
  try {
    await settleGateway();
    const built = writeBridgeFileSync(state, reason, strict);
    const turns = countRealTurns(state.history);
    let archived = turns > 0 && (reason === "move" || turns >= MIN_TURNS_FOR_UPLOAD);
    let numbering: SessionNumbering | null = null;
    // The very first session goes into the archive however short it was.
    if (!archived && turns > 0) {
      numbering = await sessionNumbering();
      if (isHouseBirth(numbering)) { archived = true; logEvent({ type: "session_archive_birth", turns }); }
    }
    if (built) {
      numbering ??= await sessionNumbering();
      await completeWakeBridge(built, numbering, archived, strict);
    }
    if (!archived) {
      logEvent({ type: "session_archive_skipped", reason: "below turn threshold", turns });
      markArchived(SESSION_ID, strict);
      return;
    }
    const name = numbering?.name ?? await nextSessionName();
    const basicMarkdown = historyToMarkdown(state.history, { name, date: localDateKey(firstLoggedAt(state.history) ?? Date.now()) });
    const markdown = deferUpload ? basicMarkdown : await enrichArchiveHeader(name, basicMarkdown);
    const localPath = join(SESSION_ARCHIVE_DIR, `${name}.md`);
    archiveReceipt(SESSION_ID, name, localPath, false, true);
    writeSessionArchive(name, markdown);
    const toRag = Boolean(RAG_URL && RAG_AUTH_TOKEN);
    if (toRag) notePendingUpload({ session: SESSION_ID, name, path: localPath, segments: [...state.liveSegmentNames], log: CONVERSATION_LOG, ...(deferUpload ? { deferred: true, headerPending: true } : {}) });
    archiveReceipt(SESSION_ID, name, localPath);
    markArchived(SESSION_ID, strict);
    let uploaded = false;
    if (toRag && deferUpload) {
      logEvent({ type: "session_archive_upload_deferred", name });
    } else if (toRag) {
      const result = await uploadArchiveToRAG(name, markdown);
      uploaded = result.ok;
      logEvent({ type: "session_archive_upload", name, ok: result.ok, parts: result.parts, error: result.error });
      if (strict && !result.ok) throw new Error(tr`RAG export failed: ${result.error}`);
      if (result.ok) {
        parkForHeader(name, markdown, strict);
        appendUploadLedger(CONVERSATION_LOG, name, strict);
        archiveReceipt(SESSION_ID, name, localPath, true);
        for (const segment of state.liveSegmentNames) {
          const deleted = await deleteFromRAG(segment);
          logEvent({ type: "rolling_segment_replaced", segment, ok: deleted });
          if (strict && !deleted) throw new Error(tr`RAG segment finalization failed: ${segment}`);
        }
        state.liveSegmentNames = [];
        clearPendingUpload(name);
      }
    }
    logEvent({ type: "session_archived", name, local_path: localPath, uploaded, reason });
  } finally {
    state.archiveStarted = true;
  }
}

export function historyFromConversationLog(text: string): Message[] {
  const history: Message[] = [];
  let orphanSpeech: Message[] = [];
  const records = text.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  for (const entry of resolveOutreachRecords(records)) {
    if (isCachePingRecord(entry) || entry.intermediate) continue;
    if (entry.origin === "claude_pipe") {
      // A killed pipe may have sent a reply before its aggregate answer was logged.
      if (entry.role === "assistant" && Array.isArray(entry.tool_calls)) {
        const message: Message = { role: "assistant", content: entry.content ?? null, tool_calls: entry.tool_calls };
        if (assistantSpeechText(message)) orphanSpeech.push(message);
      }
      continue;
    }
    if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "tool") continue;
    const message: Message = { role: entry.role, content: typeof entry.content === "string" ? entry.content : entry.content == null ? null : JSON.stringify(entry.content) };
    if (Array.isArray(entry.tool_calls)) message.tool_calls = entry.tool_calls;
    if (entry.tool_call_id) message.tool_call_id = entry.tool_call_id;
    if (entry.name) message.name = entry.name;
    if (entry.internal_input === true) syntheticInputs.add(message);
    if (Array.isArray(entry.mail_calls)) mailCalls.set(message, entry.mail_calls);
    if (typeof entry.outreach_text === "string") outreachTexts.set(message, entry.outreach_text);
    if (typeof entry.gateway_text === "string") gatewayTexts.set(message, entry.gateway_text);
    if (entry.role === "assistant") orphanSpeech = [];
    history.push(message);
  }
  return [...history, ...orphanSpeech];
}

async function catchUpSessionName(session: string): Promise<string> {
  const receipts = archiveLedger();
  const reserved = receipts.get(session)?.name;
  if (reserved) return reserved;
  const files: string[] = [];
  for (const dir of [SESSION_ARCHIVE_DIR, ARCHIVE_PARK_DIR].filter(Boolean)) {
    try { files.push(...readdirSync(dir)); }
    catch { /* The local archive directory may not exist yet. */ }
  }
  try {
    if (!RAG_URL) throw new Error("no RAG configured");
    const response = await fetch(`${RAG_URL.replace(/\/$/, "")}/list`, {
      headers: authHeaders(RAG_AUTH_TOKEN), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: any = await response.json();
    if (!Array.isArray(data?.files)) throw new Error("invalid RAG list");
    for (const file of data.files) files.push(typeof file === "string" ? file : String(file?.name ?? ""));
  } catch (error) {
    logEvent({ type: "catch_up_numbering_local", session, error: String((error as Error)?.message ?? error) });
  }
  return catchUpArchiveName(session, SESSION_PREFIX, receipts, files);
}

/** A previous process that died without archiving left its conversation log
 * behind: export it once so nothing falls into the gap. */
export async function catchUpArchive(): Promise<void> {
  if ((process.env.BRAIN_CATCHUP ?? "on").toLowerCase() === "off") return;
  archiveLedger();
  for (const pending of readPendingUploads(PENDING_UPLOADS())) {
    logEvent({ type: "catch_up_skipped", session: pending.session, reason: "owed" });
  }
  let files: string[] = [];
  try { files = readdirSync(LOG_DIR).filter((f) => /^conversation-.+\.jsonl$/.test(f)); } catch { return; }
  const own = `conversation-${SESSION_ID}.jsonl`;
  const candidates = files.filter((f) => f !== own)
    .map((f) => ({ f, id: f.replace(/^conversation-/, "").replace(/\.jsonl$/, ""), mtime: (() => { try { return statSync(join(LOG_DIR, f)).mtimeMs; } catch { return 0; } })() }))
    .filter((c) => !wasArchived(c.id))
    .sort((a, b) => a.mtime - b.mtime || a.f.localeCompare(b.f));
  logEvent({ type: "catch_up_backlog", remaining: candidates.length });
  // A session owed to the RAG already has its name and archive file; it is
  // retried under that name, never exported again under a new one.
  const owed = new Set(readPendingUploads(PENDING_UPLOADS()).filter((p) => existsSync(p.path)).map((p) => p.session));
  let remaining = candidates.length, failed = 0;
  for (const candidate of candidates) {
    await Bun.sleep(0);
    try { await withArchiveLock(async () => {
      if (wasArchived(candidate.id) || owed.has(candidate.id)) return;
      let history: Message[] = [];
      let logText = "";
      logText = readFileSync(join(LOG_DIR, candidate.f), "utf8");
      history = historyFromConversationLog(logText);
      const substantive = countRealTurns(history);
      if (!substantive || (substantive < MIN_TURNS_FOR_UPLOAD && !isHouseBirth(await sessionNumbering()))) return;
      const name = await catchUpSessionName(candidate.id);
      const markdown = await enrichArchiveHeader(name, historyToMarkdown(history, { name, date: localDateKey(firstMessageAtInLog(logText) ?? (candidate.mtime || Date.now())) }));
      const localPath = join(SESSION_ARCHIVE_DIR, `${name}.md`);
      // Reserve the name before writing so a killed recovery resumes the same archive.
      archiveReceipt(candidate.id, name, localPath, false, true);
      writeSessionArchive(name, markdown);
      const toRag = Boolean(RAG_URL && RAG_AUTH_TOKEN);
      if (toRag) notePendingUpload({ session: candidate.id, name, path: localPath, log: join(LOG_DIR, candidate.f) });
      archiveReceipt(candidate.id, name, localPath);
      markArchived(candidate.id);
      let uploaded = false;
      if (toRag) {
        const result = await uploadArchiveToRAG(name, markdown);
        uploaded = result.ok;
        if (result.ok) {
          archiveReceipt(candidate.id, name, localPath, true);
          parkForHeader(name, markdown);
          appendUploadLedger(join(LOG_DIR, candidate.f), name);
          clearPendingUpload(name);
        } else logEvent({ type: "catch_up_upload_failed", session: candidate.id, error: result.error });
      }
      logEvent({ type: "catch_up_archived", session: candidate.id, name, uploaded });
    }); } catch (error) { failed += 1; logEvent({ type: "catch_up_archive_failed", session: candidate.id, error: String(error) }); }
    logEvent({ type: "catch_up_backlog", remaining: --remaining + failed, failed, pending_uploads: readPendingUploads(PENDING_UPLOADS()).length });
  }
}

function estimatePromptTokens(messages: Message[]): number {
  return messageTokens(messages);
}

function isRequestTimeout(error: any): boolean {
  return error?.name === "TimeoutError" || error?.name === "AbortError";
}

async function chatRequest(model: string, messages: Message[], tools: OpenAIToolDef[], head?: HeadSpec, toolChoice?: "auto" | "none", reasoningEffort?: string, usageSource: UsageSource = "turn"): Promise<ChatResponse> {
  const endpoint = head?.endpoint || ENDPOINT;
  const apiKey = head ? head.apiKey : API_KEY;
  if (!endpoint) throw new Error("BRAIN_ENDPOINT is not configured");
  const body: Record<string, unknown> = {
    model,
    ...(TEMPERATURE !== undefined ? { temperature: TEMPERATURE } : {}),
    messages,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? (toolChoice ?? "auto") : undefined,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MIN * 60_000),
      // Disable the runtime's own idle timeout (Bun caps fetch at ~5 minutes
      // by default); long non-streaming completions are legitimate here and
      // only the request watchdog above may abort them.
      timeout: false,
    } as any);
    if (!response.ok) throw Object.assign(new Error(`model endpoint HTTP ${response.status}: ${toolRecords.diagnostic(await response.text())}`), { status: response.status });
    const data = await response.json() as ChatResponse;
    logEvent({ ...apiUsageRecord(data, head?.name ?? "api", usageSource) });
    return data;
  } catch (error: any) {
    logEvent({ type: "usage_coverage", head: head?.name ?? "api", source: usageSource, reason: "failed_request_no_usage" });
    if (isRequestTimeout(error)) {
      logEvent({ type: "turn_request_timeout", timeout_minutes: REQUEST_TIMEOUT_MIN, model });
      throw new Error(`model request timed out after ${REQUEST_TIMEOUT_MIN} minutes`);
    }
    const diagnostic = toolRecords.diagnostic(String(error));
    if (diagnostic !== String(error)) throw Object.assign(new Error(diagnostic), { status: error?.status });
    throw error;
  }
}

export function currentVisibleMessages(state: RuntimeState, inletBlock: string | null, persist = INLET_PERSIST): Message[] {
  const visible = state.history.slice(state.rolledIndex);
  if (!visible.length) return visible;
  const lastIndex = state.history.length - 1;
  if (inletBlock && state.history[lastIndex]?.role === "user" && persist) {
    state.inletBlocks[lastIndex] = inletBlock;
  }
  return visible.map((message, offset) => {
    const index = state.rolledIndex + offset;
    if (message.role !== "user") return message;
    const block = persist ? state.inletBlocks[index] : (index === lastIndex ? inletBlock : null);
    if (!block) return message;
    return { role: "user", content: `${block}\n\n${message.content ?? ""}` };
  });
}

// The canonical history, the logs, the bridge and the archive are never
// changed here: only what goes out to this model, this time.

export function projectForHead<T extends { role: string; content?: unknown }>(messages: T[], model: string, substrateDrift: boolean): { messages: T[]; event: Record<string, number> | null } {
  return PROJECTION.messages(messages, model, substrateDrift);
}

export function projectTextForHead(text: string, model: string, substrateDrift: boolean): string {
  return PROJECTION.text(text, model, substrateDrift);
}

async function approvalGate(name: string, args: Record<string, unknown>): Promise<string | null> {
  const match = approvalMatch(approvalSettings?.() ?? APPROVAL_RULES, APPROVAL_MODE, name, args, { cwd: workspaceRoot() ?? process.cwd() });
  if (!match) return null;
  if (RESIDENT_TOOL_NAMES.has(name) && !residentToolOffered(name)) return null; // refuses on its own
  if (!APP_URL) return "error: approval required but BRAIN_APP_URL is not set — action not performed";
  const detail = JSON.stringify(toolRecords.input(name, undefined, args), null, 2).slice(0, 1500);
  const title = tr("{0}: {1} — {2}", WORKER_NAME, name, tr(match.label));
  const { decision } = await askApproval({ baseUrl: APP_URL, token: APP_TOKEN }, title, detail, "brain");
  logEvent({ type: "approval_decision", tool: name, decision, ...match });
  if (decision === "allow") return null;
  return `error: ${USER_NAME} did not approve '${name}' (${decision}) — action not performed`;
}

async function dispatchTool(name: string, args: Record<string, unknown>, state?: RuntimeState): Promise<string> {
  const refusal = await approvalGate(name, args);
  if (refusal) return refusal;
  if (name === "effort" && state) return (await applyEffort(state, args?.level === undefined ? undefined : String(args.level), "agent")).text;
  if (LOCAL_TOOL_NAMES.has(name)) return dispatchLocalTool(name, args);
  const split = splitPrefixedToolName(name);
  if (split && state?.mcpClients?.has(split.server)) {
    const client = state.mcpClients.get(split.server)!;
    if (!client.alive()) return `error: MCP server ${split.server} is not running`;
    return client.callTool(split.tool, args);
  }
  if (MEMORY_URL && MEMORY_KEY) return memoryToolCall(name, args);
  return `error: tool '${name}' is not available because memory MCP is not configured`;
}

function currentHead(state: RuntimeState): HeadSpec {
  if (!state.head) state.head = resolveHead(process.env.BRAIN_HEAD ?? "api", process.env);
  return state.head;
}

/** Thresholds follow the config file from the next model call on, without a cut. */
let thresholdStamp = "";
function configStamp(): string {
  const file = process.env.BRAIN_ENV_FILE?.trim() || join(HERE, "brain.env");
  try { return String(statSync(file).mtimeMs); } catch { return "none"; }
}
function thresholds(state: RuntimeState): WatchdogThresholds {
  const stamp = configStamp();
  if (!state.watchdog || stamp !== thresholdStamp) {
    state.watchdog = headThresholds(currentHead(state));
    thresholdStamp = stamp;
  }
  return state.watchdog;
}

let clampNoticeKey = "";
function headThresholds(head: HeadSpec): WatchdogThresholds {
  const t = watchdogThresholds(head, headEnvironment());
  const key = t.clamped ? `${head.name}:${t.clamped.window}:${t.clamped.configuredCut}` : "";
  if (t.clamped && key !== clampNoticeKey) {
    logEvent({ type: "watchdog_clamped", head: head.name, window: t.clamped.window,
      configured_cut: t.clamped.configuredCut, cut_tokens: t.cut, warn_tokens: t.warn });
    console.warn(`context watchdog: configured cut ${t.clamped.configuredCut} is above ${Math.round(WATCHDOG_CUT_CEILING * 100)} % of the ${head.name} window (${t.clamped.window}); cutting at ${t.cut}`);
  }
  clampNoticeKey = key;
  return t;
}

export function clampNote(t: WatchdogThresholds): string {
  return t.clamped ? ` (configured ${t.clamped.configuredCut}, clamped to ${Math.round(WATCHDOG_CUT_CEILING * 100)} % of the window)` : "";
}

function writeContextState(state: RuntimeState, promptTokens: number, immediate = false): void {
  const head = currentHead(state);
  const t = thresholds(state);
  const record = {
    ts: new Date().toISOString(), pid: process.pid, session_id: SESSION_ID,
    head: head.name, transport: head.transport, model: head.model, served_model: state.servedModel ?? null,
    effort: state.effort ?? null, applied_effort: effortLabel(state),
    tokens: promptTokens, window: head.contextWindow, warn_tokens: t.warn, cut_tokens: t.cut,
    account: head.transport === "pipe" ? ACCOUNT.name() : null,
    ...(state.liveTurn ? turnFields(state.liveTurn) : {}),
    ...pendingTaskFields(pendingTasks),
  };
  try {
    mkdirSync(dirname(CONTEXT_STATE_FILE), { recursive: true });
    const tmp = `${CONTEXT_STATE_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, CONTEXT_STATE_FILE);
  } catch { /* best effort */ }
  writeWatchdogState(state, promptTokens, immediate);
}

export interface WatchdogStateInput {
  now: Date;
  tokens: number;
  warn: number;
  cut: number;
  window?: number;
  sessionFile: string;
  lastWarnTs: string;
  lastCutTs: string;
  pid: number;
  head: string;
  model: string;
  effort?: string;
  turn?: LiveTokensSnapshot | null;
  pending?: ReadonlyMap<string, PendingTask> | null;
  tool?: string | null;
  queued?: number;
  last_event_ts?: string;
}

export function watchdogStateRecord(input: WatchdogStateInput): Record<string, unknown> {
  return {
    source: "brain",
    last_check_ts: input.now.toISOString(),
    tokens: input.tokens,
    window: input.window ?? null,
    percent: input.window && Number.isFinite(input.window) && input.window > 0
      ? Math.floor((input.tokens * 100) / input.window) : null,
    warn_tokens: input.warn,
    cut_tokens: input.cut,
    session_file: input.sessionFile,
    warn_active: input.tokens >= input.warn,
    last_warn_ts: input.lastWarnTs,
    last_cut_ts: input.lastCutTs,
    pid: input.pid,
    head: input.head,
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.turn ? turnFields(input.turn) : {}),
    ...(input.pending ? pendingTaskFields(input.pending) : {}),
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    ...(input.queued !== undefined ? { queued: input.queued } : {}),
    ...(input.turn && input.last_event_ts ? { last_event_ts: input.last_event_ts } : {}),
  };
}

export function turnFields(turn: LiveTokensSnapshot): Record<string, unknown> {
  return {
    turn_output_tokens: turn.main,
    turn_output_estimated: turn.estimated === true,
    turn_helper_tokens: turn.helpers,
    ...(typeof turn.cold === "number" ? { turn_cold_tokens: turn.cold } : {}),
    ...(typeof turn.window === "number" ? { window_live_tokens: turn.window } : {}),
    turn_started_at: turn.startedAt ? new Date(turn.startedAt).toISOString() : null,
  };
}

const watchdogMarks = { lastWarnTs: "", lastCutTs: "", loaded: false };

export function createStatusTrigger(intervalMs = 1000): (write: () => void, final?: boolean) => void {
  let lastWrite = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  const flush = (): void => {
    timer = null;
    const write = pending;
    pending = null;
    lastWrite = Date.now();
    write?.();
  };
  return (write, final = false) => {
    pending = write;
    // Answer/cut checkpoints and shutdown must not leave state pending.
    if (final) { if (timer) clearTimeout(timer); flush(); return; }
    if (timer) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastWrite));
    if (!wait) flush();
    else { timer = setTimeout(flush, wait); timer.unref(); }
  };
}

const requestWatchdogWrite = createStatusTrigger();

function writeWatchdogState(state: RuntimeState, tokens: number, final = false): void {
  if (!WATCHDOG_STATE_FILE || WATCHDOG_STATE_FILE === "off") return;
  requestWatchdogWrite(() => flushWatchdogState(state, tokens), final);
}

function flushWatchdogState(state: RuntimeState, tokens: number): void {
  if (!watchdogMarks.loaded) {
    watchdogMarks.loaded = true;
    if (!watchdogMarks.lastCutTs) {
      try { watchdogMarks.lastCutTs = String(JSON.parse(readFileSync(WATCHDOG_STATE_FILE, "utf8"))?.last_cut_ts ?? ""); } catch { /* first start */ }
    }
  }
  const head = currentHead(state);
  const t = thresholds(state);
  const record = watchdogStateRecord({
    now: new Date(), tokens, warn: t.warn, cut: t.cut, window: head.contextWindow,
    sessionFile: CONVERSATION_LOG.split("/").pop() ?? "",
    lastWarnTs: watchdogMarks.lastWarnTs, lastCutTs: watchdogMarks.lastCutTs, pid: process.pid,
    head: head.name, model: state.servedModel ?? head.model, effort: effortLabel(state) ?? undefined,
    turn: state.liveTurn ?? null,
    pending: pendingTasks,
    tool: currentHead(state).transport === "pipe"
      ? (pipeTurnOpen(state) ? state.liveTurn?.tool : null) : (state.apiTool ?? null),
    queued: queuedMessageCount(queue, steeringInFlight),
    last_event_ts: pipeTurnOpen(state) && state.liveTurn?.lastEventAt !== undefined
      ? new Date(state.liveTurn.lastEventAt).toISOString() : undefined,
  });
  try {
    mkdirSync(dirname(WATCHDOG_STATE_FILE), { recursive: true });
    const tmp = `${WATCHDOG_STATE_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, WATCHDOG_STATE_FILE);
  } catch { /* best effort */ }
}

function updateWatchdog(state: RuntimeState, promptTokens: number): void {
  state.lastPromptTokens = promptTokens;
  const t = thresholds(state);
  logEvent({
    type: "context_watchdog",
    tokens: promptTokens,
    warn_tokens: t.warn,
    cut_tokens: t.cut,
    warn_active: promptTokens >= t.warn,
  });
  if (promptTokens >= t.warn && !watchdogMarks.lastWarnTs) watchdogMarks.lastWarnTs = new Date().toISOString();
  if (promptTokens < t.warn) watchdogMarks.lastWarnTs = "";
  if (promptTokens >= t.cut) watchdogMarks.lastCutTs = new Date().toISOString();
  // Preserve the existing synchronous answer/cut checkpoint. Only display
  // triggers (stream/queue/idle) are coalesced; never delay safety thresholds.
  writeContextState(state, promptTokens, true);
  if (promptTokens >= t.cut) {
    state.cutoffRequested = true;
    return;
  }
  if (promptTokens >= t.warn && promptTokens > state.watchdogWarnedAt) {
    state.watchdogWarnedAt = promptTokens;
    console.warn(`context watchdog warning: ${promptTokens} tokens; cut at ${t.cut}`);
  }
}

function notifyApp(text: string): void {
  if (!APP_URL || STERILE) return;
  void appBroadcast({ baseUrl: APP_URL, token: APP_TOKEN }, text, "reply").catch(() => undefined);
}

export function mainHopPromptTokens(sample: Pick<PipeUsageSample, "helper_id" | "input" | "cache_read" | "cache_write">): number {
  if (sample.helper_id) return 0;
  return (sample.input ?? 0) + (sample.cache_read ?? 0) + (sample.cache_write ?? 0);
}

/** The window state follows every model call, not only the end of a turn, so
 * long turns keep a current window bar. */
function noteLiveHop(state: RuntimeState, sample: PipeUsageSample): void {
  const tokens = mainHopPromptTokens(sample);
  if (tokens <= 0) return;
  state.lastPromptTokens = tokens;
  writeContextState(state, tokens);
}

function afterModelAnswer(state: RuntimeState, head: HeadSpec, servedModel: string | undefined, promptTokens: number, rateLimit?: RateLimitInfo | null): void {
  state.lastModelCallAt = Date.now();
  state.servedModel = servedModel?.trim() || undefined; // blank = unknown, not the previous delivery
  const observation = PROJECTION.drift.observe(state.drift ?? PROJECTION.drift.initial(), head.model, servedModel);
  state.drift = observation.state;
  if (observation.marker) {
    state.pendingDriftMarker = { marker: observation.marker, ordered: observation.state.ordered ?? head.model, served: observation.state.served ?? String(servedModel) };
    logEvent({ type: "substrate_drift", marker: observation.marker, ordered: head.model, served: servedModel });
    if (observation.marker === "drift") notifyApp(tr`⚠️ Model fallback: last turn ran on ${servedModel} instead of ${head.model}.`);
  }
  if (rateLimit) {
    state.lastRateLimit = rateLimit;
    if (head.transport === "pipe" && !head.pipeEnv.ANTHROPIC_BASE_URL) {
      const outcome = ACCOUNT.onRateLimit(rateLimit, Date.now(), STERILE);
      if (outcome.kind === "flipped") {
        logEvent({ type: "account_flip", from: outcome.from, to: outcome.to, why: outcome.why });
        notifyApp(outcome.notice);
        void stopPipe(state, "account_limit_flip");
      } else if (outcome.kind === "skipped") {
        if (outcome.reason !== "no_limit") logEvent({ type: "account_flip_skipped", reason: outcome.reason, status: rateLimit.status });
        if (outcome.notice) notifyApp(outcome.notice);
      }
    }
  }
  updateWatchdog(state, promptTokens);
}

function readWeather(): { line: string; wclass: string } | null {
  if (!WEATHER_URL) return null;
  const cacheFile = join(STATE_DIR, "weather-cache.json");
  let cache: WeatherCache | null = null;
  try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch { cache = null; }
  if (cache && typeof cache.ts === "number") return weatherLine(cache, WEATHER_PLACE);
  return null;
}

async function refreshWeather(): Promise<void> {
  if (!WEATHER_URL) return;
  const cacheFile = join(STATE_DIR, "weather-cache.json");
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (Date.now() / 1000 - Number(cached?.ts ?? 0) <= 1800) return;
  } catch { /* no cache yet */ }
  try {
    const response = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return;
    const cache = weatherCacheFromOpenMeteo(await response.json(), Math.floor(Date.now() / 1000));
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  } catch { /* fail-open: no weather line this time */ }
}

function currentPinsBlock(state: RuntimeState): string | null {
  const now = new Date();
  pinsRefGlobal.current = loadPinsAny(PINS_FORMAT, PINS_FILE, now);
  const block = PINS_FORMAT === "house" ? renderHousePinBlock(pinsRefGlobal.current, now) : renderPinBlock(pinsRefGlobal.current, now);
  if (!block) { state.pinsShownSig = ""; return null; }
  const signature = `${state.pipeBirths ?? 0}|${sha256Hex(block)}`;
  if (state.pinsShownSig === signature) return null;
  state.pinsShownSig = signature;
  return block;
}

export async function buildContextBlock(state: RuntimeState, userText: string, inletEnabled: boolean): Promise<string | null> {
  const parts: string[] = [];
  approvalSettings?.();
  const pins = currentPinsBlock(state);
  if (pins) parts.push(pins);
  if (SENSE_ON) {
    const head = currentHead(state);
    const reminders = readPendingReminders(REMINDERS_PENDING);
    const warning = readFreshWarning(CONTEXT_WARNING_FILE, PROCESS_STARTED_MS);
    const delivered = state.servedModel ?? head.model;
    const previous = state.senseState && head.name === "gpt" && gptServedModelMatches(head.model, delivered)
      && gptServedModelMatches(head.model, state.senseState.model) ? { ...state.senseState, model: delivered } : state.senseState;
    const sense = renderSense({
      now: new Date(),
      model: delivered,
      effort: head.name === "gpt" && head.transport === "pipe" ? effortLabel(state) : state.effort ?? null,
      effortApplied: effortLabel(state),
      tokens: state.lastPromptTokens || null,
      contextLimit: head.contextWindow,
      prev: previous ?? null,
      calendar: readCalendars(CALENDAR_FILE, CALENDAR_EXTERNAL_FILE, USER_NAME),
      weather: readWeather(),
      reminders,
      warning,
      drift: state.pendingDriftMarker ?? null,
    });
    state.senseState = sense.state;
    state.pendingDriftMarker = null;
    if (sense.deliveredReminderIds.length) markRemindersDelivered(REMINDERS_PENDING, sense.deliveredReminderIds, "sense", new Date());
    if (sense.text) parts.push(sense.text);
  }
  if (inletEnabled) {
    const inlet = await runInlet(userText, recentTurnsText(state.history.slice(state.sessionStartIndex ?? 0)));
    if (inlet) parts.push(inlet);
  }
  return parts.length ? parts.join("\n\n---\n\n") : null;
}

let cutInProgress = false;
let lastTurnSpeech: TurnSpeech = { replied: false, prose: "", missing: [] };
let apiReplies: { delivered: string[]; undelivered: string[] } = { delivered: [], undelivered: [] };
export function replyGatewayOffPath(env: Record<string, string | undefined> = process.env): string {
  return env.BRAIN_REPLY_GATEWAY_OFF_FILE?.trim() || join(
    env.EMBERVY_HOME?.trim() ? join(env.EMBERVY_HOME.trim(), "state") : env.BRAIN_STATE_DIR?.trim() || join(HERE, "state"),
    "reply-gateway-off",
  );
}

const REPLY_GATEWAY_OFF_FILE = replyGatewayOffPath();

// Migration preserves the environment setting's opt-in default: only explicit
// "on" enables the gateway. The stamp prevents subsequent starts from undoing
// a deliberate change to the file switch.
export function migrateReplyGateway(env: Record<string, string | undefined> = process.env, log: (event: Record<string, unknown>) => void = logEvent): void {
  const file = replyGatewayOffPath(env);
  const stamp = `${file}.migrated`;
  if (existsSync(stamp)) return;
  mkdirSync(dirname(file), { recursive: true });
  if (env.BRAIN_REPLY_GATEWAY?.trim().toLowerCase() !== "on") {
    try {
      writeFileSync(file, "", { flag: "wx" });
      log({ type: "reply_gateway_migrated", file });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  writeFileSync(stamp, "");
}

export function isRoomTurn(prompt: string): boolean {
  return /<channel\b[^>]*\bkind="room"[^>]*>/.test(prompt);
}

export function isPeerTurn(prompt: string): boolean {
  return /<channel\b[^>]*\bkind="peer"[^>]*>/.test(prompt);
}

export { isScheduledTurn } from "./wake-bridge";

export function gatewayRoomReply(roomTurn: boolean, toolName: string): boolean {
  return roomTurn && isRoomTool(toolName);
}

export function gatewayPeerReply(peerTurn: boolean, toolName: string): boolean {
  return peerTurn && isPeerTool(toolName);
}

export function gatewayPlan(source: string, speech: TurnSpeech, prompt = "", file = REPLY_GATEWAY_OFF_FILE, replyExpected = false): { forward: string | null; owed: string | null } {
  if (existsSync(file) || speech.silent || isCliNoOutputPrompt(prompt)) return { forward: null, owed: null };
  // Startup greetings owe the person an answer without making other internal prose public.
  const replySource = replyExpected ? "app" : source;
  if (isScheduledTurn(prompt)) return { forward: null, owed: gatewayOwed(replySource, speech.missing) };
  return { forward: gatewayText(replySource, speech.replied, speech.prose), owed: gatewayOwed(replySource, speech.missing) };
}

async function stopPipe(state: RuntimeState, reason: string): Promise<void> {
  if (!state.pipe) return;
  logEvent({ type: "claude_pipe_stop_requested", reason });
  try { await state.pipe.stop(5000); } catch (error) { logEvent({ type: "claude_pipe_stop_error", reason, error: String(error) }); }
  state.pipe = null;
}

export function headWebPlan(head: HeadSpec): WebToolPlan {
  return webToolPlan(head, WEB, Boolean(CONTROL_TOKEN));
}

function brainMcpConfigPath(): string {
  const path = join(STATE_DIR, "brain-mcp.json");
  const config = { mcpServers: { brain: { command: process.execPath, args: [join(HERE, "brain-mcp.ts")] } } };
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
  } catch { /* best effort */ }
  return path;
}

/** The static part first, so it stays cached, then what changes. */
export async function buildPipeSystemPrompt(state: RuntimeState, head: HeadSpec, reason: string, mode = systemPromptMode(head, pipeEnvironment(state))): Promise<string> {
  const parts: string[] = [
    await renderSystemPrompt(currentSystemPrompt(state)),
    ...await loadSystemPromptExtras(head, { ...pipeEnvironment(state), BRAIN_STATE_DIR: STATE_DIR }, logEvent, mode),
  ];
  if (HOUSE_MAP_ON) parts.push(houseMapText(state));
  const drift = Boolean(state.drift?.substrateDrift);
  const own = state.history.slice(state.sessionStartIndex ?? 0);
  // One ceiling for everything a start carries from before: switching to a
  // model with a smaller window never overflows, today's turns win, and only
  // whole turns are kept.
  const env = headEnvironment();
  const cap = bridgeCapFor(head, env);
  const fitted = fitBirthMaterial(state.bridgeText ?? null, countSubstantiveTurns(own) > 0 ? extractBridge(own, bridgeShape(env).turns, contextSpeechText) : null, cap, bridgeSpeakers());
  if (fitted.clipped) logEvent({ type: "bridge_capped", head: head.name, window: head.contextWindow, cut_tokens: watchdogThresholds(head, env).cut, cap_bytes: cap, where: "pipe_birth" });
  if (fitted.bridge) {
    parts.push(`${BRIDGE_PREFIX}${projectTextForHead(fitted.bridge, head.model, drift)}`);
  }
  if (fitted.soFar) {
    parts.push(`[this session so far — the pipe restarted (${reason}); continue from here, do not answer this block]\n\n${projectTextForHead(fitted.soFar, head.model, drift)}`);
  }
  parts.push([
    tr("## FACTS (refreshed at every pipe start)"),
    tr`- Time: ${new Date().toLocaleString(brainLocale(), { timeZone: brainTimezone() })} (${brainTimezone()}) · Brain session ${SESSION_ID}`,
    tr`- Head: ${head.name} · model ordered: ${head.model}${state.servedModel ? tr` · last served: ${state.servedModel}` : ""}${state.drift?.substrateDrift ? " · ⚠ DRIFT" : ""}`,
    tr`- ${ACCOUNT.factsLead(head.pipeEnv.ANTHROPIC_BASE_URL)}Pipe start #${state.pipeBirths ?? 0} (${reason})`,
  ].join("\n"));
  return parts.filter(Boolean).join("\n\n");
}

/** A pipe must never hang on an unanswered permission prompt: "app" sends it
 * to the approval card, otherwise prompts are denied; "cli" leaves the CLI's
 * default for settings hooks that decide on their own. */
export function pipePermissionArgs(mode: string, controlEndpoint: boolean, env: Record<string, string | undefined> = process.env): { permissionPrompts?: "none"; permissionPromptTool?: string; disallowedTools?: string[]; approvalHook?: ApprovalHookOptions } {
  const scratch = env.BRAIN_APPROVAL_SCRATCH === undefined ? {} : { scratch: env.BRAIN_APPROVAL_SCRATCH };
  if (env.BRAIN_APPROVAL_SETTINGS) {
    if (!controlEndpoint) return { permissionPrompts: "none" };
    return { permissionPromptTool: "mcp__brain__approve", disallowedTools: ["AskUserQuestion"],
      approvalHook: { rules: "default", tools: "", settings: resolve(env.BRAIN_APPROVAL_SETTINGS), ...scratch } };
  }
  if (mode === "app" && controlEndpoint) {
    const rules = env.BRAIN_APPROVAL_RULES ?? "default";
    const approvalHook = (env.BRAIN_APPROVAL ?? "off").toLowerCase() === "app" && rules !== "off"
      ? { rules: rules === "default" ? rules : resolve(rules), tools: env.BRAIN_APPROVAL_TOOLS ?? "", ...scratch }
      : undefined;
    return { permissionPromptTool: "mcp__brain__approve", disallowedTools: ["AskUserQuestion"], ...(approvalHook ? { approvalHook } : {}) };
  }
  if (mode === "cli") return {};
  return { permissionPrompts: "none" };
}

/** Built-ins this product does not use, disabled the same way on every pipe
 * rather than guessed from the model name. */
export const DEFAULT_DISALLOWED_BUILTINS: readonly string[] = Object.freeze([
  "DesignSync", "CronCreate", "CronDelete", "CronList", "RemoteTrigger",
  "NotebookEdit", "EnterWorktree", "ExitWorktree", "ScheduleWakeup",
]);

/** ENABLE_TOOLS only opts out of the product defaults, never out of a
 * permission or an explicit deny. */
export function pipeBuiltinDisallowedTools(head: { name: string }, env: Record<string, string | undefined>): string[] | undefined {
  const list = (suffix: string): string[] => {
    const raw = env[`BRAIN_${head.name.toUpperCase()}_${suffix}`]?.trim() || env[`BRAIN_${suffix}`]?.trim() || "";
    return raw.split(",").map((name) => name.trim()).filter(Boolean);
  };
  const enabled = new Set(list("ENABLE_TOOLS"));
  return mergeDisallowedTools(DEFAULT_DISALLOWED_BUILTINS.filter((name) => !enabled.has(name)), list("DISALLOWED_TOOLS"));
}

async function ensurePipe(state: RuntimeState, head: HeadSpec, reason = "turn"): Promise<ClaudePipe> {
  if (state.pipe?.isAlive()) return state.pipe;
  if (state.pipe) { try { await state.pipe.stop(0); } catch { /* ignore */ } }
  if (cutInProgress) throw new Error("cut in progress — no new pipe; the message stays in the history and reaches the next head via the bridge");
  if (head.unavailable) throw new Error(`head ${head.name} unavailable: ${head.unavailable}`);
  await verifyGptAdapter(state, head);
  state.pipeBirths = (state.pipeBirths ?? 0) + 1;
  startHouseCheck();
  const birthReason = state.pipeBirths === 1 ? "start" : reason;
  const account = ACCOUNT.pipeEnv();
  const accountVars = head.pipeEnv.ANTHROPIC_BASE_URL ? { set: {}, unset: [] as string[] } : account;
  const env = pipeEnvironment(state);
  if (env.BRAIN_APPROVAL_SETTINGS && !CONTROL_TOKEN) throw new Error("Approval settings require BRAIN_CONTROL_TOKEN for pipe approval cards; head not started.");
  const permissionMode = (env.BRAIN_PIPE_PERMISSION ?? "none").toLowerCase();
  const extraMcp = [env.BRAIN_PIPE_MCP_CONFIG ?? "", CONTROL_TOKEN ? brainMcpConfigPath() : ""].filter(Boolean);
  const permission = pipePermissionArgs(permissionMode, Boolean(CONTROL_TOKEN), env);
  if (permissionMode === "app" && !CONTROL_TOKEN) logEvent({ type: "pipe_permission_fallback", reason: "BRAIN_CONTROL_TOKEN missing — approval cards need the control endpoint; prompts are denied instead" });
  // Claude Code's own web tools work on Anthropic and through the ChatGPT
  // adapter; on other engines Brain's pair comes in through brain-mcp.ts.
  const webPlan = headWebPlan(head);
  const web = pipeWebWiring(webPlan, WEB);
  logEvent({ type: "web_tools_plan", head: head.name, via: webPlan.via, tools: webPlan.tools, disallowed: webPlan.disallowNative, note: webPlan.note });
  const pipeLiveSource = `pipe:${state.pipeBirths}`;
  forgetPendingTasks("pipe:");
  const usagePipeId = `${SESSION_ID}:${pipeLiveSource}`;
  if (head.name === "claude" && state.effort && !parseEffort(state.effort)) await claudeModelsCached();
  const promptMode = systemPromptMode(head, env);
  let settingsPath = env.BRAIN_CLAUDE_SETTINGS ?? "{}";
  if (permission.approvalHook?.settings) {
    settingsPath = approvalSettingsArg(settingsPath, env.BRAIN_CLAUDE_CWD ?? HERE, permission.approvalHook);
    permission.approvalHook = undefined;
  }
  const pendingMails = new Map<string, any>();
  const completedMails: any[] = [];
  const pipe = new ClaudePipe({
    authProfile: head.name === "claude" && !head.pipeEnv.ANTHROPIC_BASE_URL ? { configDir: account.set.CLAUDE_CONFIG_DIR ?? null, account: account.name } : undefined,
    model: head.model,
    // Only a caller that asks for it (the builder) caps the Claude pipe; a resident keeps long turns.
    maxToolHops: head.name === "claude" ? Number(env.BRAIN_PIPE_MAX_TOOL_HOPS) : 0,
    systemPrompt: await buildPipeSystemPrompt(state, head, birthReason, promptMode),
    systemPromptMode: promptMode,
    settingsPath,
    settingSources: env.BRAIN_CLAUDE_SETTING_SOURCES ?? "user,project,local",
    cwd: env.BRAIN_CLAUDE_CWD ?? HERE,
    binary: env.BRAIN_CLAUDE_BIN,
    mcpConfig: extraMcp.length ? extraMcp : undefined,
    birthEnv: env,
    env: { ...head.pipeEnv, ...accountVars.set, ...web.env },
    unsetEnv: [...pipeUnsetEnv(head), ...accountVars.unset],
    permissionPrompts: permission.permissionPrompts,
    permissionPromptTool: permission.permissionPromptTool,
    approvalHook: permission.approvalHook,
    disallowedTools: mergeDisallowedTools(permission.disallowedTools, web.disallowedTools, pipeBuiltinDisallowedTools(head, env)),
    effort: birthEffort(head, state.effort, catalogEffortLevels(head)),
    logEvent,
    toolRecords,
    onCanonicalEvent: (event) => {
      logTurn({ ...(event as unknown as Record<string, unknown>), origin: "claude_pipe" });
      if (event.role === "assistant" && "tool_calls" in event) {
        for (const call of event.tool_calls) {
          if (isMailCall(call)) pendingMails.set(call.id, toolRecords.record({ tool_calls: [call] }).tool_calls[0]);
        }
      } else if (event.role === "tool") {
        const mail = pendingMails.get(event.tool_call_id);
        pendingMails.delete(event.tool_call_id);
        if (mail && toolOutreachDelivered(event.content)) completedMails.push({ ...mail, mail_result: event.content });
      }
    },
    onSelfTurn: (event) => onPipeSelfTurn(state, pipe, event),
    onUsage: (sample) => {
      logEvent({ type: "usage", head: head.name, ...sample,
        id: JSON.stringify([usagePipeId, sample.helper_id ?? "main", sample.message_id]) });
      if (state.pipe === pipe) noteLiveHop(state, sample);
      if (notePendingTaskUsage(pendingTasks, pendingTaskUsage, sample.helper_id, sample)) onPendingTasksChanged?.();
    },
    onLiveTokens: (snapshot) => {
      if (state.pipe !== pipe) return;
      state.liveTurn = snapshot;
      writeContextState(state, state.lastPromptTokens);
    },
    onToolUse: (tool) => {
      state.modelAnswers = (state.modelAnswers ?? 0) + 1;
      if (LIVE_VIEW_ON) liveLine(formatToolUse(tool.name, toolRecords.input(tool.name, tool.id, tool.input)));
    },
    onTuiStep: (step) => {
      if (step.kind === "term-out" && step.body?.trim()) state.modelAnswers = (state.modelAnswers ?? 0) + 1;
    },
    onHelperActivity: (event) => liveHelper(pipeLiveSource, event),
  });
  pipeMails.set(pipe, completedMails);
  await pipe.start();
  state.pipe = pipe;
  state.pipeProfile = readPipeProfile(env);
  state.pipeFirstSendPending = true;
  state.appliedEffort = undefined;
  logEvent({ type: "claude_pipe_birth", births: state.pipeBirths, reason: birthReason, head: head.name, model: head.model, account: account.name, effort: state.effort ?? null, ...(birthReason === "reload" ? {} : { system_prompt_mode: promptMode }) });
  void pipe.appliedSettings().then((applied) => {
    if (applied.ok && state.pipe === pipe && state.appliedEffort === undefined) state.appliedEffort = applied.effort ?? null;
  });
  return pipe;
}

export function pipeOutgoingText(model: string, text: string): string {
  return PROJECTION.outgoing(model, text);
}

/** The user message enters the history when the pipe writes it — after any
 * turn the CLI started by itself in the meantime, so the history keeps the
 * order the CLI saw. A send that never gets written (dead pipe, cut) still
 * leaves the message in the history: it reaches the next head via the bridge. */
async function pipeTurn(state: RuntimeState, head: HeadSpec, userText: string, block: string | null, userMessage: Message, usageSource: "turn" | "internal" = "turn"): Promise<string> {
  let pushed = state.history.includes(userMessage);
  const pushUser = (): void => {
    if (pushed) return;
    pushed = true;
    state.history.push(userMessage);
    logTurn(userMessage);
  };
  let pipe: ClaudePipe;
  const recovery: GptRecoveryBudget = { used: false, epoch: adapterGate.epoch() };
  // A live change the CLI refused (effort): rebirth now, at the turn boundary,
  // with --effort — the history rides along in "this session so far".
  let birthReason = "dead_pipe";
  if (state.pendingRebirth && !state.pipe?.isBusy()) {
    birthReason = state.pendingRebirth;
    state.pendingRebirth = null;
    await stopPipe(state, birthReason);
  }
  try {
    pipe = await withGptRecovery(state, head, () => ensurePipe(state, head, birthReason), recovery);
  } catch (error) {
    pushUser();
    throw error;
  }
  const outgoingText = pipeOutgoingText(head.model, userText);
  let payload = block ? `${block}\n\n${outgoingText}` : outgoingText;
  if (state.pipeFirstSendPending) {
    if (state.initialWakeContext && !state.wakeSentToPipe) {
      payload = `[wake context — current memory snapshot at session start]\n\n${state.initialWakeContext}\n\n---\n\n${payload}`;
      state.wakeSentToPipe = true;
    }
    state.pipeFirstSendPending = false;
  }
  const check = takeHouseCheck();
  if (check) payload = `${check}\n\n---\n\n${payload}`;
  let result: SendResult;
  try {
    result = await withGptRecovery(state, head, () => pipe.send(payload, { onWritten: pushUser, usageSource }), recovery, false);
  } catch (error) {
    pushUser();
    if (!pipe.isAlive()) state.pipe = null;
    if (error instanceof ClaudeAuthExpiredError) Object.assign(error, { retryText: userText, retryMessage: userMessage });
    throw error;
  }
  state.modelAnswers = (state.modelAnswers ?? 0) + 1;
  pushUser();
  const { answer, ...speech } = pipeTurnSpeech(result, isRoomTurn(userText), isPeerTurn(userText));
  const message: Message = { role: "assistant", content: answer || "." };
  lastTurnSpeech = { ...speech, message };
  mailCalls.set(message, pipeMails.get(pipe)?.splice(0) ?? []);
  outreachTexts.set(message, [...result.appReplyTexts, ...(result.roomTexts ?? []), ...(result.peerTexts ?? [])].filter(Boolean).join("\n\n").trim());
  state.history.push(message);
  logTurn(message, { via: "pipe", pipe_final_text: result.finalText ?? "" });
  state.totalPromptTokens += result.sumHopPromptTokens;
  state.totalCompletionTokens += result.resultUsage.output_tokens;
  afterModelAnswer(state, head, result.servedModel, pipeWatchdogTokens(result, pipe, logEvent), result.rateLimitInfo ?? null);
  logEvent({ type: "assistant", via: "pipe", characters: answer.length, app_replies: result.appReplyTexts.length, app_replies_undelivered: result.undeliveredReplyTexts?.length ?? 0, last_hop: result.lastHopPromptTokens, result_index: result.resultIndex ?? null });
  return answer;
}

export const SELF_TURN_TAGS: Record<SelfTurnKind, string> = { task: "[task]", wake: "[wake]", steer: "[steer]", self: "[self]" };

export function selfTurnNotice(event: Pick<SelfTurnEvent, "kind" | "notices" | "wakePrompt">): string | null {
  if (event.kind === "steer") return null;
  const tag = SELF_TURN_TAGS[event.kind];
  if (event.kind === "wake") return `${tag} ScheduleWakeup${event.wakePrompt ? `: ${event.wakePrompt.replace(/\s+/g, " ").trim().slice(0, 300)}` : " fired"}`;
  if (event.notices.length) return `${tag} ${event.notices.join(" · ")}`;
  return event.kind === "task" ? `${tag} background event (Monitor or task notification)` : `${tag} turn started by the CLI`;
}

const selfTurnStarts = new WeakMap<ClaudePipe, Map<number, number>>();

/** A turn the CLI started by itself is a full turn: Brain waits for it, logs it,
 * and its text goes through the reply gateway like any other. */
function onPipeSelfTurn(state: RuntimeState, pipe: ClaudePipe, event: SelfTurnEvent): void {
  if (state.pipe !== pipe) { void processQueue(state); return; } // an old pipe's last words
  let starts = selfTurnStarts.get(pipe);
  if (!starts) { starts = new Map(); selfTurnStarts.set(pipe, starts); }
  if (event.phase === "start") {
    starts.set(event.turn, state.history.length);
    // Where the notice belongs in the log's order (it is written at the end).
    logTurn({ role: "system", content: null, self_turn_start: event.kind, turn: event.turn });
    logEvent({ type: "self_turn_start", turn: event.turn, kind: event.kind, notices: event.notices.length });
    return;
  }
  const startIndex = starts.get(event.turn);
  starts.delete(event.turn);
  if (shuttingDown) {
    logEvent({ type: "self_turn_during_shutdown", turn: event.turn, kind: event.kind, status: event.status ?? null });
    return;
  }
  try {
    if (event.status === "absorbed") {
      logEvent({ type: "self_turn_absorbed", turn: event.turn, kind: event.kind });
      return;
    }
    const result = event.result;
    if (event.status !== "done" || !result) {
      if (event.authExpired) {
        expireClaudeAuth(state);
        queue.unshift(...(state.claudeTurnSteers ?? []));
        state.claudeTurnSteers = undefined;
        return;
      }
      logEvent({ type: "self_turn_failed", turn: event.turn, kind: event.kind, status: event.status ?? null, error: event.error ?? null });
      return;
    }
    state.claudeTurnSteers = undefined;
    const head = currentHead(state);
    const speech = pipeTurnSpeech(result);
    const answer = speech.answer;
    const notice = selfTurnNotice(event);
    if (notice) {
      const noticeMessage: Message = { role: "user", content: notice };
      const at = startIndex === undefined ? state.history.length : Math.min(startIndex, state.history.length);
      state.history.splice(at, 0, noticeMessage);
      logTurn({ ...noticeMessage, self_turn: event.kind, turn: event.turn });
    }
    const message: Message = { role: "assistant", content: answer || "." };
    mailCalls.set(message, pipeMails.get(pipe)?.splice(0) ?? []);
    outreachTexts.set(message, [...result.appReplyTexts, ...(result.roomTexts ?? []), ...(result.peerTexts ?? [])].filter(Boolean).join("\n\n").trim());
    state.history.push(message);
    logTurn(message, { self_turn: event.kind, via: "pipe", pipe_final_text: result.finalText ?? "" });
    state.totalPromptTokens += result.sumHopPromptTokens;
    state.totalCompletionTokens += result.resultUsage.output_tokens;
    afterModelAnswer(state, head, result.servedModel, pipeWatchdogTokens(result, pipe, logEvent), result.rateLimitInfo ?? null);
    logEvent({ type: "self_turn", turn: event.turn, kind: event.kind, origin: event.originKind ?? null, result_index: event.resultIndex ?? null, characters: answer.length, app_replies: result.appReplyTexts.length, app_replies_undelivered: result.undeliveredReplyTexts?.length ?? 0, last_hop: result.lastHopPromptTokens });
    console.log(`\n${WORKER_NAME} ${SELF_TURN_TAGS[event.kind]}:\n${answer}\n`);
    gatewayAfterTurn({ source: "app", text: "" }, { ...speech, message });
  } catch (error) {
    logEvent({ type: "self_turn_handler_error", turn: event.turn, error: String(error) });
  } finally {
    void processQueue(state);
  }
}

function pipeTurnOpen(state: RuntimeState): boolean {
  return Boolean(state.pipe?.hasOpenTurn());
}

/** Before the first send to a gpt model, the adapter's /health must report
 * backend=chatgpt-oauth, otherwise nothing is sent: another program may be
 * listening on that port. A failed check is retried next turn. */
const adapterPaths = (): AdapterPaths => ({ home: homedir(), brainHome: process.env.BRAIN_HOME || HERE, logDir: LOG_DIR, bun: process.execPath });

/** Linux socket table, never a pidfile/pgrep or a health-supplied PID. Include
 * all listeners on the port: multiple bind addresses/owners fail closed. */
function adapterSocketInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(table, "utf8").trim().split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "0A" && parseInt(cols[1]?.split(":")[1] ?? "", 16) === port) inodes.add(cols[9]);
    }
  }
  return inodes;
}
function adapterListener(port: number): number {
  const inodes = adapterSocketInodes(port);
  const owners = new Set<number>(), found = new Set<string>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${name}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${name}/fd/${fd}`))?.[1];
        if (inode && inodes.has(inode)) { owners.add(Number(name)); found.add(inode); }
      } catch { /* process/fd may already be gone */ }
    }
  }
  const pid = [...owners][0];
  if (owners.size !== 1 || found.size !== inodes.size || pid <= 1) throw new Error(tr("GPT port has no unit listener that can be proven unambiguously"));
  return pid; // READ ONLY: never used as a signal target
}
async function probeGptAdapter(origin: string, timeoutMs: number): Promise<AdapterProbe> {
  try {
    const response = await fetch(`${origin}/health`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    return { kind: "health", httpOk: response.ok, data: await response.json().catch(() => null) };
  } catch {
    // Timeout, TLS/HTTP errors etc. do not prove a free port. Socket-table
    // access failure is unknown too (platform/permissions), never permission to kill.
    try { if (adapterSocketInodes(Number(new URL(origin).port || 80)).size === 0) return { kind: "absent" }; } catch { /* fail closed */ }
    return { kind: "unknown", reason: "health unreachable, port not proven free" };
  }
}

/** No success cache. The marker is diagnostic only and invalidated before every
 * proof; request/model/identity/port must all match at the time of use. */
export async function verifyGptAdapter(state: Pick<RuntimeState, "gptAdapterVerified">, head: HeadSpec,
  env: Record<string, string | undefined> = headEnvironment(), paths = adapterPaths()): Promise<void> {
  if (head.name !== "gpt") return;
  state.gptAdapterVerified = undefined;
  const expected = gptAdapterContract(head, env, paths);
  await requireAdapterSystemd(env);
  const probe = await probeGptAdapter(expected.origin, 3000);
  const observed = assessAdapter(probe, expected);
  if (observed === "ready" || observed === "owned") {
    const unit = await inspectAdapterUnit(expected, env);
    if (!unit?.active || !unit.ownsPort) { adapterMigrationNotice(expected); throw new Error(tr(LEGACY_ADAPTER)); }
    if (unit.plan.env.ADAPTER_MODEL !== expected.model) throw new Error(tr("Unit plan model disagrees with expected/health model — no intervention"));
    const fields = adapterKnobMismatches(probe, unit.plan);
    if (head.transport === "pipe" && head.effort !== undefined && (unit.plan.env.ADAPTER_EFFORT ?? null) !== (head.effort === "max" ? "xhigh" : head.effort)) fields.push("selected_effort");
    if (fields.length) throw Object.assign(new Error(tr`GPT adapter not ready: health fields do not match unit plan (different/missing): ${fields.join(", ")}`), { adapterRepairable: true });
  }
  if (observed !== "ready") throw Object.assign(new Error(tr`GPT contract not satisfied (${observed}): requires ok=true, backend=chatgpt-oauth, own port/identity and model ${head.model}`), { adapterRepairable: observed === "absent" || observed === "owned" });
  state.gptAdapterVerified = `${expected.origin}:${expected.identity}:${expected.model}`;
}

function systemdCall(command: "systemctl" | "systemd-run", args: string[], env: Record<string, string | undefined> = process.env) {
  try {
    return Bun.spawnSync([command, ...args], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  } catch { throw new Error(tr("systemd unavailable (systemctl/systemd-run or system bus missing) — no intervention")); }
}
async function requireAdapterSystemd(env: Record<string, string | undefined> = process.env): Promise<void> {
  adapterCacheKey(env);
  if (!Bun.which("systemd-run", { PATH: env.PATH ?? process.env.PATH })) throw new Error(tr("systemd unavailable (systemd-run missing) — no intervention"));
  const result = systemdCall("systemctl", ["--system", "show", "--property=Version", "--value"], env);
  if (result.exitCode !== 0 || !result.stdout.toString().trim()) throw new Error(tr("systemd unavailable (no system bus) — no intervention"));
}
const adapterOwners = new Map<string, { unit: string; launchId: string; invocation: string }>();
const adapterOwnerFile = (unit: string, env: Record<string, string | undefined>) => join(env.BRAIN_STATE_DIR || STATE_DIR, `${unit}.owner.json`);
async function inspectAdapterUnit(expected: AdapterContract, env: Record<string, string | undefined> = process.env, ownStart?: AdapterStartPlan): Promise<AdapterUnitSnapshot | null> {
  const key = adapterCacheKey(env);
  const unit = adapterUnitName(expected.identity);
  const result = systemdCall("systemctl", ["--system", "show", unit, "--property=Id,LoadState,ActiveState,Transient,Description,MainPID,InvocationID,Environment"], env);
  const p = Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (p.LoadState === "not-found") return null;
  if (result.exitCode !== 0) throw new Error(tr("systemd unit cannot be inspected — no intervention"));
  if (p.Id !== unit || p.Transient !== "yes" || p.Description !== `Brain GPT adapter ${expected.identity}`) throw new Error(tr(LEGACY_ADAPTER));
  const plan = adapterPlanFromUnit(p.Environment || "", expected);
  if (plan.env.ADAPTER_CACHE_KEY !== key) throw new Error(tr("Unit cache key does not match resident — no intervention"));
  const file = adapterOwnerFile(unit, env);
  if (ownStart) {
    if (plan.launchId !== ownStart.launchId || !p.InvocationID) throw new Error(tr("Own start cannot be proven as an invocation — no intervention"));
    ownStart.invocation = p.InvocationID;
    const record = { unit, launchId: ownStart.launchId, invocation: p.InvocationID };
    adapterOwners.set(file, record); // cleanup remains possible even if persistence fails
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}`;
    try { writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: "wx" }); renameSync(tmp, file); }
    finally { rmSync(tmp, { force: true }); }
  }
  let owner = adapterOwners.get(file);
  if (!owner) { try { owner = JSON.parse(readFileSync(file, "utf8")); } catch { /* fail closed */ } }
  if (!owner?.invocation || owner.unit !== unit || owner.launchId !== plan.launchId || owner.invocation !== p.InvocationID) {
    throw new Error(tr("Unit invocation replaced or unproven — no takeover, no stop"));
  }
  plan.invocation = owner.invocation;
  const active = p.ActiveState === "active" || p.ActiveState === "activating";
  let ownsPort = false;
  try { ownsPort = active && Number(p.MainPID) > 1 && adapterListener(expected.port) === Number(p.MainPID); } catch { /* absent/ambiguous listener: not proof */ }
  return { plan, active, ownsPort, invocation: p.InvocationID || "" };
}
const adapterMigrationShown = new Set<string>();
function adapterMigrationNotice(expected: AdapterContract): void {
  const unit = adapterUnitName(expected.identity);
  if (adapterMigrationShown.has(unit)) return;
  adapterMigrationShown.add(unit);
  const text = tr`GPT migration: manually retire the previous adapter/autostart on port ${expected.port}; Brain will not stop it. Then /head gpt: start as ${unit} with explicit BRAIN_GPT_CACHE_KEY.`;
  logEvent({ type: "gpt_adapter_migration_required", unit, text });
  console.log(text);
}
async function stopAdapterUnit(plan: AdapterStartPlan, env = headEnvironment()): Promise<void> {
  const expected = gptAdapterContract(resolveHeadChoice("gpt", env, { model: plan.env.ADAPTER_MODEL }), env, adapterPaths());
  await requireAdapterSystemd(env);
  const unit = await inspectAdapterUnit(expected, env);
  if (!unit) return;
  if (!plan.invocation || unit.invocation !== plan.invocation || unit.plan.launchId !== plan.launchId || unit.plan.unit !== plan.unit) throw new Error(tr("Unit has been replaced — no stop"));
  // systemd owns the process handle and its cgroup. Never signal a bare PID.
  logEvent({ type: "gpt_adapter_stopping", unit: plan.unit, invocation: unit.invocation, identity: expected.identity });
  const result = systemdCall("systemctl", ["--system", "stop", plan.unit], env);
  if (result.exitCode !== 0 && await inspectAdapterUnit(expected, env)) throw new Error(tr("systemctl stop failed"));
  for (let n = 0; n < 20; n++) { if (!await inspectAdapterUnit(expected, env)) return; await Bun.sleep(100); }
  throw new Error(tr("Transient unit not collected after stop — no new start"));
}
async function startGptAdapter(plan: AdapterStartPlan, env = headEnvironment()): Promise<void> {
  const expected = gptAdapterContract(resolveHeadChoice("gpt", env, { model: plan.env.ADAPTER_MODEL }), env, adapterPaths());
  await requireAdapterSystemd(env);
  if (plan.unit !== adapterUnitName(expected.identity) || plan.env.ADAPTER_CACHE_KEY !== adapterCacheKey(env)) throw new Error(tr("Start plan does not match resident"));
  if (await inspectAdapterUnit(expected, env)) throw new Error(tr("Unit already exists — no takeover/overwrite"));
  mkdirSync(dirname(plan.logFile), { recursive: true });
  const result = systemdCall("systemd-run", adapterUnitArgs(plan, homedir()), env);
  // Capture once, immediately after OUR start, including a broken-health unit.
  // Subsequent inspections must match the durable, independently stored ID.
  await inspectAdapterUnit(expected, env, plan);
  if (result.exitCode !== 0) throw new Error(tr("systemd-run failed; inspecting/cleaning up own unit"));
  logEvent({ type: "gpt_adapter_started", unit: plan.unit, port: plan.env.ADAPTER_PORT, model: plan.env.ADAPTER_MODEL, log: plan.logFile });
}
const adapterGate = createAdapterGate();
// A signal must not run a second, best-effort shutdown through a pending cut.
// It is remembered instead: a refused move runs it afterwards, a successful
// move exits anyway. Otherwise the cut script's KILL would find a Brain that
// swallowed its TERM and take it down without an archive.
let pendingMove = false;
let pendingHeadChoices = 0;
let deferredShutdown: string | null = null;
async function adapterOperation(head: HeadSpec, commit?: HeadStateCommit) {
  const env = headEnvironment(); // one snapshot for the entire transaction, including rollback
  const result = await ensureGptAdapterReady(head, env, adapterPaths(),
    { probe: probeGptAdapter, systemd: () => requireAdapterSystemd(env), inspect: (expected) => inspectAdapterUnit(expected, env),
      start: (plan) => startGptAdapter(plan, env), stop: (plan) => stopAdapterUnit(plan, env), sleep: (ms) => Bun.sleep(ms),
      report: (message) => { console.log(message); logEvent({ type: "gpt_adapter_health_mismatch", message }); },
      validateStart: async (plan) => {
        if (shuttingDown || cutInProgress) throw new Error(tr("Brain is already shutting down"));
        if (!statSync(plan.script).isFile()) throw new Error(tr("BRAIN_GPT_ADAPTER is not a file"));
      } }, commit);
  if (!result.ok && result.error.includes(tr(LEGACY_ADAPTER))) adapterMigrationNotice(gptAdapterContract(head, env, adapterPaths()));
  logEvent({ type: result.ok ? "gpt_adapter_ready" : "gpt_adapter_unavailable", endpoint: head.endpoint,
    ...(result.ok ? { started: result.value.started, model: head.model } : { error: result.error }) });
  return result;
}
interface GptRecoveryBudget { used: boolean; epoch: number }
/** One recovery per turn, one replay per failed API request. Pipe sends may
 * already have run tools: repair the adapter, but NEVER replay that whole turn. */
async function withGptRecovery<T>(state: RuntimeState, head: HeadSpec, call: () => Promise<T>,
  budget: GptRecoveryBudget = { used: false, epoch: adapterGate.epoch() }, replay = true): Promise<T> {
  if (head.name !== "gpt") return call();
  let sent = false;
  try { await verifyGptAdapter(state, head); sent = true; return await call(); }
  catch (error) {
    state.gptAdapterVerified = undefined;
    if (budget.used || (!(error as any)?.adapterRepairable && !isGptConnectionFailure(error))) throw error;
    budget.used = true;
    logEvent({ type: "gpt_adapter_recovery", model: head.model, epoch: budget.epoch });
    const repaired = await adapterGate.recover(budget.epoch, () => adapterOperation(head));
    if (!repaired.ok) throw new Error(tr`${String(error)}; recovery failed: ${repaired.error}`);
    if (sent && !replay) throw new Error(tr`${String(error)}; adapter checked/repaired, pipe turn not replayed (possible tool side effects)`);
    try { await verifyGptAdapter(state, head); return await call(); }
    catch (second) { state.gptAdapterVerified = undefined; throw new Error(tr`GPT still failing after one recovery: ${String(second)}`); }
  }
}

function steerableAppMessages(): QueueItem[] {
  const taken: QueueItem[] = [];
  for (let i = 0; i < queue.length; ) {
    if (queue[i].kind === "user" && queue[i].source === "app") taken.push(...queue.splice(i, 1));
    else i += 1;
  }
  return taken;
}

async function apiTurn(state: RuntimeState, head: HeadSpec, block: string | null, usageSource: "turn" | "internal" = "turn"): Promise<string> {
  if (head.unavailable) throw new Error(`head ${head.name} unavailable: ${head.unavailable}`);
  const recovery: GptRecoveryBudget = { used: false, epoch: adapterGate.epoch() };
  const systemPrompt = await apiSystemPrompt(state);
  const check = takeHouseCheck();
  const initialVisible = currentVisibleMessages(state, block);
  const contextIndex = state.history.findLastIndex((message) => message.role === "user");
  const contextMessage = initialVisible[contextIndex - state.rolledIndex];
  // Snapshot this turn's context once, including non-persistent inlet and
  // one-shot repair instructions. Rolling must not rerun retrieval or promote
  // retrieved user-level content into system-level instructions.
  const turnContext = [check, state.inletBlocks[contextIndex] ?? block].filter(Boolean).join("\n\n---\n\n");
  const buildMessages = (visible: Message[]): Message[] => {
    const outgoing = visible.map((message, offset) => {
      if (state.rolledIndex + offset !== contextIndex || !contextMessage) return message;
      return check ? { ...contextMessage, content: `${check}\n\n---\n\n${contextMessage.content ?? ""}` } : contextMessage;
    });
    return [
      { role: "system", content: systemPrompt },
      // Once its original user anchor is archived, keep only the active
      // context as a request-local user preface, not the archived user text.
      ...(contextIndex < state.rolledIndex && turnContext ? [{ role: "user" as const, content: turnContext }] : []),
      ...capBridgeMessage(outgoing, head),
    ];
  };
  let messages = buildMessages(initialVisible);
  lastTurnSpeech = { replied: false, prose: "", missing: [] };
  apiReplies = { delivered: [], undelivered: [] };
  const prompt = messages.findLast((message) => message.role === "user")?.content ?? "";
  let roomTurn = isRoomTurn(prompt);
  let peerTurn = isPeerTurn(prompt);
  let gatewayMessage: Message | undefined;
  let ending = ""; // what the turn ends with: the answer, the limit note, nothing on an error
  try {
    for (let hop = 0; hop < MAX_TOOL_HOPS; hop += 1) {
      if (hop > 0) {
        for (const item of steerableAppMessages()) {
          roomTurn ||= isRoomTurn(item.text);
          peerTurn ||= isPeerTurn(item.text);
          const steer: Message = { role: "user", content: item.text };
          messages.push(steer);
          state.history.push(steer);
          logTurn(steer);
          commitAppItem(item);
          logEvent({ type: "api_steering_injected", characters: item.text.length });
        }
        // All results of the preceding assistant call are now appended. Only
        // a confirmed upload moves the edge; failed/missing RAG keeps both
        // the canonical history and the in-flight request view untouched.
        const previousIndex = state.rolledIndex;
        await maybeRollToRag(state);
        if (state.rolledIndex !== previousIndex) messages = buildMessages(currentVisibleMessages(state, null));
        writeWatchdogState(state, state.lastPromptTokens);
      }
      const projected = projectForHead(messages, head.model, Boolean(state.drift?.substrateDrift));
      if (projected.event) logEvent({ type: "substrate_projection", ...projected.event, model: head.model });
      const response = await withGptRecovery(state, head,
        () => chatRequest(head.model, projected.messages, toolsForHead(state, head), head, undefined, requestEffort(head, state.effort), usageSource), recovery);
      const choice = response.choices?.[0];
      if (!choice?.message) throw new Error("model returned no message");
      state.modelAnswers = (state.modelAnswers ?? 0) + 1;
      const promptTokens = response.usage?.prompt_tokens ?? estimatePromptTokens(messages);
      state.totalPromptTokens += response.usage?.prompt_tokens ?? promptTokens;
      state.totalCompletionTokens += response.usage?.completion_tokens ?? estimateTokens(choice.message);
      afterModelAnswer(state, head, response.model, promptTokens, null);

      messages.push(choice.message);
      state.history.push(choice.message);
      gatewayMessage = choice.message;
      outreachTexts.set(choice.message, "");
      logTurn(choice.message);
      mailCalls.set(choice.message, []);
      if (!choice.message.tool_calls?.length) {
        const answer = choice.message.content ?? "";
        ending = answer;
        logEvent({ type: "assistant", characters: answer.length });
        return answer;
      }
      for (const toolCall of choice.message.tool_calls) {
        if (gatewayRoomReply(roomTurn, toolCall.function.name) || gatewayPeerReply(peerTurn, toolCall.function.name)) lastTurnSpeech.replied = true;
        state.apiTool = toolCall.function.name;
        writeWatchdogState(state, state.lastPromptTokens);
        let result: string;
        let args: any;
        try {
          try { args = JSON.parse(toolCall.function.arguments || "{}"); }
          finally { if (LIVE_VIEW_ON) liveLine(formatToolUse(toolCall.function.name, toolRecords.input(toolCall.function.name, toolCall.id, args))); }
          result = await dispatchTool(toolCall.function.name, args, state);
          logEvent({ type: "tool", name: toolCall.function.name, result: toolLogPreview(toolRecords.reference(toolCall.id, result, toolCall.function.name, args) ?? result) });
          // A reply counts once the app took it, not when the head asked for it.
          if (isReplyToolName(toolCall.function.name)) {
            const text = appReplySpeech(toolCall.function.name, args);
            if (replyToolDelivered(toolCall.function.name, result)) {
              lastTurnSpeech.replied = true;
              if (text) apiReplies.delivered.push(text);
            } else if (text) apiReplies.undelivered.push(text);
          }
        } catch (error) {
          result = `error: ${String(error)}`;
          logEvent({ type: "tool_error", name: toolCall.function.name, error: toolLogPreview(toolRecords.reference(toolCall.id, String(error), toolCall.function.name, args) ?? String(error), Infinity) });
          const speech = isReplyToolName(toolCall.function.name) ? appReplySpeech(toolCall.function.name, args) : "";
          if (speech) apiReplies.undelivered.push(speech);
        }
        if (isMailCall(toolCall) && toolOutreachDelivered(result)) {
          const calls = mailCalls.get(choice.message) ?? [];
          calls.push({ ...toolRecords.record({ tool_calls: [toolCall] }).tool_calls[0], mail_result: result });
          mailCalls.set(choice.message, calls);
        }
        if (toolOutreachDelivered(result) && !isMailCall(toolCall)) {
          const delivered = outreachSpeech({ tool_calls: toolRecords.record({ tool_calls: [toolCall] }).tool_calls });
          if (delivered) {
            const text = [outreachTexts.get(choice.message), delivered].filter(Boolean).join("\n\n");
            outreachTexts.set(choice.message, text);
            logTurn({ role: "system", content: null, speech_update: speechIds.get(choice.message), outreach_text: text });
          }
        }
        const toolMessage: Message = {
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: result,
        };
        messages.push(toolMessage);
        state.history.push(toolMessage);
        logTurn(toolMessage);
        state.apiTool = null;
        writeWatchdogState(state, state.lastPromptTokens);
      }
    }

    const note = `(Tool-call limit reached after ${MAX_TOOL_HOPS} model requests. The saved state is ready for the next turn.)`;
    const limitMessage: Message = { role: "assistant", content: note };
    gatewayMessage = limitMessage;
    state.history.push(limitMessage);
    logTurn(limitMessage);
    logEvent({ type: "tool_hop_limit", hops: MAX_TOOL_HOPS });
    ending = note;
    return note;
  } finally {
    state.apiTool = null;
    writeWatchdogState(state, state.lastPromptTokens);
    // Every exit: answer, limit, error. Replies already taken never go twice.
    lastTurnSpeech = { ...settleTurnSpeech(lastTurnSpeech.replied, apiReplies.delivered, apiReplies.undelivered, ending), message: gatewayMessage };
  }
}

export async function apiSystemPrompt(state: RuntimeState): Promise<string> {
  const base = await renderSystemPrompt(currentSystemPrompt(state));
  const extras = await loadSystemPromptExtras(currentHead(state), { ...process.env, BRAIN_STATE_DIR: STATE_DIR }, logEvent);
  const prompt = extras.length ? [base, ...extras].join("\n\n") : base;
  return HOUSE_MAP_ON ? `${prompt}\n\n${houseMapText(state)}` : prompt;
}

let houseMapCache: string | null = null;
function houseMapText(state: RuntimeState): string {
  if (houseMapCache) return houseMapCache;
  const head = currentHead(state);
  const extra = houseMapExtra(HOUSE_MAP_EXTRA_FILE, STATE_DIR);
  houseMapCache = renderHouseMap({
    userName: process.env.BRAIN_USER_NAME,
    root: HERE, stateDir: STATE_DIR, logDir: LOG_DIR, head: head.name, model: head.model,
    commands: ["/status", "/heads", "/head", "/model", "/effort", ...ACCOUNT.commands, ...PROJECTION.commands, "/pins", "/unpin", "/inlet", tr("/ping"), ...JUMP.mapCommands, "/respawn", "/reload", "/stop", "/help", "/usage"],
    extra,
    capabilities: houseCapabilities(HERE, process.env.BRAIN_CAPABILITIES_FILE),
  });
  return houseMapCache;
}

export interface TurnOptions {
  skipInlet?: boolean;
  retryMessage?: Message;
  kind?: "user" | "cache_ping" | "internal";
  source?: "terminal" | "app" | "internal";
}

export async function runTurn(state: RuntimeState, userText: string, inletEnabled = INLET_ENABLED, opts: TurnOptions = {}): Promise<string> {
  await loadWakeAndBridge(state);
  const head = currentHead(state);
  if (head.transport === "api") startHouseCheck();
  if ((opts.kind ?? "user") === "cache_ping") return runCachePing(state, head, userText);

  const drift = PROJECTION.drift.beginTurn(state.drift ?? PROJECTION.drift.initial());
  state.drift = drift.state;
  if (drift.recycle) await stopPipe(state, drift.recycle);

  if (head.transport === "api") await maybeRollToRag(state);
  const block = await buildContextBlock(state, userText, inletEnabled && !opts.skipInlet);
  if (drift.modelCall && !opts.retryMessage) {
    const joined = joinLateAppMessages(queue, userText, opts);
    userText = joined.text;
    queue.splice(0, joined.items.length);
    for (const item of joined.items) commitAppItem(item);
    if (joined.items.length) logEvent({ type: "app_messages_joined_late", count: joined.items.length });
  }
  const userMessage: Message = opts.retryMessage ?? { role: "user", content: userText };
  if (opts.kind === "internal" || opts.source === "internal") syntheticInputs.add(userMessage);
  if (drift.modelCall && head.transport === "pipe") {
    return pipeTurn(state, head, userText, block, userMessage, opts.kind === "internal" || opts.source === "internal" ? "internal" : "turn");
  }
  state.history.push(userMessage);
  logTurn(userMessage);
  if (!drift.modelCall) {
    const hint = drift.hint ?? tr("[Substrate drift] no model call");
    const message: Message = { role: "assistant", content: hint };
    state.history.push(message);
    logTurn(message);
    return hint;
  }
  return apiTurn(state, head, block, opts.kind === "internal" || opts.source === "internal" ? "internal" : "turn");
}

/** A bare sentence that keeps the prompt cache warm: no retrieval, no pins,
 * never in the history, never exported. */
async function runCachePing(state: RuntimeState, head: HeadSpec, text: string): Promise<string> {
  state.lastCachePingAt = Date.now();
  if (head.transport === "pipe") {
    // Warming means refreshing an existing cache — never birth a pipe for it.
    if (!state.pipe?.isAlive()) { logEvent({ type: "cache_ping_skipped", reason: "no_live_pipe" }); return tr("(cache ping: no live pipe)"); }
    if (state.pendingRebirth) { logEvent({ type: "cache_ping_skipped", reason: "pending_rebirth" }); return tr("(cache ping: the pipe restarts at the next turn)"); }
    const result = await withGptRecovery(state, head, () => state.pipe!.send(text, { steerable: false, usageSource: "cache_ping" }), undefined, false);
    logTurn({ role: "user", content: text, origin: CACHE_PING_ORIGIN });
    const reply = (result.assistantText || result.finalContent || "").slice(0, CACHE_PING_REPLY_CHARS);
    logTurn({ role: "assistant", content: reply, origin: CACHE_PING_ORIGIN });
    afterModelAnswer(state, head, result.servedModel, pipeWatchdogTokens(result, state.pipe, logEvent), result.rateLimitInfo ?? null);
    logEvent({ type: "cache_ping", via: "pipe", last_hop: result.lastHopPromptTokens, reply: reply.slice(0, 160) });
    return reply;
  }
  const messages: Message[] = [
    { role: "system", content: await apiSystemPrompt(state) },
    ...capBridgeMessage(currentVisibleMessages(state, null), head),
    { role: "user", content: text },
  ];
  const response = await withGptRecovery(state, head, () => chatRequest(head.model, projectForHead(messages, head.model, Boolean(state.drift?.substrateDrift)).messages, toolsForHead(state, head), head, "none", requestEffort(head, state.effort), "cache_ping"));
  const reply = String(response.choices?.[0]?.message?.content ?? "").slice(0, CACHE_PING_REPLY_CHARS);
  logTurn({ role: "user", content: text, origin: CACHE_PING_ORIGIN });
  logTurn({ role: "assistant", content: reply, origin: CACHE_PING_ORIGIN });
  afterModelAnswer(state, head, response.model, response.usage?.prompt_tokens ?? estimatePromptTokens(messages), null);
  logEvent({ type: "cache_ping", via: "api", prompt_tokens: response.usage?.prompt_tokens ?? null });
  return reply;
}

export function cachePingDue(input: {
  nowMs: number; lastModelCallAt: number; idleMin: number; busy: boolean; queued: number;
  enabled: boolean; pipeAlive: boolean; transport: Transport; overage: boolean; lastCachePingAt?: number;
}): boolean {
  if (!input.enabled || input.busy || input.queued > 0 || input.overage) return false;
  if (!input.lastModelCallAt) return false; // no cache to keep warm yet
  if (input.transport === "pipe" && !input.pipeAlive) return false;
  // A cache ping that failed (no model answer since) waits a whole idle period
  // before the next try, to avoid retrying every minute during a rate limit.
  if (input.lastCachePingAt && input.lastCachePingAt > input.lastModelCallAt
    && input.nowMs - input.lastCachePingAt < input.idleMin * 60_000) return false;
  return input.nowMs - input.lastModelCallAt >= input.idleMin * 60_000;
}

/** A rejected rate limit blocks the cache ping until its reset time (or until the
 * next model answer replaces it); without a reset time, until that answer. */
export function rateLimitBlocks(info: RateLimitInfo | null | undefined, nowMs: number): boolean {
  if (!info) return false;
  if (info.isUsingOverage) return true;
  if (info.status !== "rejected") return false;
  return typeof info.resetsAt === "number" ? nowMs < info.resetsAt * 1000 : true;
}

/** auto: on for the Anthropic pipe (1 h cache TTL), off for engines and API heads. */
export function cachePingEnabled(mode: string, head: HeadSpec): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return head.transport === "pipe" && !head.pipeEnv.ANTHROPIC_BASE_URL;
}

export function makeInitialState(tools: OpenAIToolDef[]): RuntimeState {
  return {
    model: DEFAULT_MODEL,
    systemPrompt: readSystemPrompt(),
    tools,
    history: [],
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    lastPromptTokens: 0,
    watchdogWarnedAt: 0,
    wakeLoaded: false,
    rolledIndex: 0,
    rolledSegments: 0,
    liveSegmentNames: [],
    inletBlocks: {},
    pricing: null,
    cutoffRequested: false,
    archiveStarted: false,
    pipe: null,
    pipeBirths: 0,
    drift: PROJECTION.drift.initial(),
    senseState: null,
    lastModelCallAt: 0,
    mcpClients: new Map(),
    effort: loadEffort(),
  };
}

interface QueueItem {
  kind: "user" | "cache_ping" | "internal" | "command";
  source: "terminal" | "app" | "internal";
  text: string;
  commitOffset?: number;
  messageId?: string;
  firstTurnMarker?: string;
  skipInlet?: boolean;
  replyExpected?: boolean;
  mergedCount?: number;
  retryMessage?: Message;
}

/** App messages waiting next to each other go in as one turn, so a burst is
 * read as a whole. Only what is already queued is joined. */
export function takeTurnItem(queue: QueueItem[]): QueueItem {
  const first = queue.shift()!;
  if (first.kind !== "user" || first.source !== "app" || first.retryMessage) return first;
  const joined = [first];
  while (queue.length && queue[0].kind === "user" && queue[0].source === "app" && !queue[0].retryMessage) joined.push(queue.shift()!);
  if (joined.length === 1) return first;
  const last = joined[joined.length - 1];
  return { ...first, text: joined.map((item) => item.text).join("\n\n"), commitOffset: last.commitOffset, messageId: last.messageId, mergedCount: joined.length };
}

export function joinLateAppMessages(queue: readonly QueueItem[], text: string, turn: TurnOptions): { text: string; items: QueueItem[] } {
  const items: QueueItem[] = [];
  if ((turn.kind ?? "user") !== "user" || turn.source !== "app" || turn.retryMessage) return { text, items };
  for (const item of queue) {
    if (item.kind !== "user" || item.source !== "app" || item.retryMessage) break;
    items.push(item);
  }
  return { text: [text, ...items.map((item) => item.text)].join("\n\n"), items };
}

export function firstTurnItem(file = process.env.BRAIN_FIRST_TURN_FILE ?? "", stateDir = STATE_DIR): QueueItem | null {
  const marker = join(stateDir, "first-turn-delivered");
  if (!file || existsSync(marker)) return null;
  try { return { kind: "internal", source: "internal", text: readFileSync(file, "utf8"), firstTurnMarker: marker, replyExpected: true }; }
  catch { return null; }
}

/** False if another start already consumed it; a write error must prevent the turn. */
export function commitFirstTurn(item: QueueItem): boolean {
  if (!item.firstTurnMarker) return true;
  mkdirSync(dirname(item.firstTurnMarker), { recursive: true });
  try { writeFileSync(item.firstTurnMarker, `${new Date().toISOString()}\n`, { flag: "wx" }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}

function releaseFirstTurn(item: QueueItem): void {
  if (!item.firstTurnMarker) return;
  try {
    unlinkSync(item.firstTurnMarker);
    logEvent({ type: "first_turn_released", reason: "failed_before_model_answer" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logEvent({ type: "first_turn_release_failed", error: String(error) });
  }
}

export function queuedMessageCount(items: ReadonlyArray<Pick<QueueItem, "kind" | "source">>, steering = 0): number {
  return items.filter((item) => item.kind === "user" && (item.source === "app" || item.source === "terminal")).length + steering;
}

const queue: QueueItem[] = [];
let busy = false;
let currentKind: QueueItem["kind"] | null = null;
let shuttingDown = false;
let committedCursor: InboxCursor | null = null;

function commitAppItem(item: QueueItem): void {
  if (item.source !== "app" || item.commitOffset === undefined || !committedCursor) return;
  committedCursor = commitCursor(committedCursor, item.commitOffset, item.messageId);
  try { saveCursor(APP_CURSOR_FILE, committedCursor); } catch { /* best effort */ }
}

export const APP_COMMANDS = new Set(["/status", "/usage", "/head", "/model", "/effort", ...ACCOUNT.commands, ...PROJECTION.commands, "/pins", "/unpin", "/inlet", "/ping", ...JUMP.commands, "/respawn", "/reload", "/move", "/exit", "/heads", "/help"]);

const LOCALIZED_COMMANDS = ["/move", "/ping"] as const;
export function canonicalCommand(typed: string): string {
  const command = typed.toLowerCase();
  for (const name of LOCALIZED_COMMANDS) if (command === tr(name).toLowerCase()) return name;
  return command;
}

/** Commands Brain runs itself; they never reach the model. */
export function isAppCommand(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? "";
  return APP_COMMANDS.has(canonicalCommand(first));
}

const HELP = () => `commands:
  /heads             which heads are set up, their models, and why one is not available
  /heads refresh     fetch all model catalogs again
  /exit              archive and quit (the loop respawns with the bridge)
  /respawn           same as /exit
  /reload            Reload settings; restart at the next turn, no cut
${tr("  /move <head> [model] [bridge=N] [window=K] [effort=X]  archive, then restart on the selected head (target effort, bridge once, window persists)\n")}  /stop              archive and quit, the loop does NOT respawn
  /reset             clear the conversation state
  /head [name [model] [pipe|api] [effort=X]]  show or switch the head (claude, gpt, grok, kimi, glm, api)
  /model <name>      switch the model of the current head (claude pipe: live, no restart)
  /effort [low|medium|high|xhigh|max|default]  show or set the reasoning effort (claude pipe: live)
${ACCOUNT.helpLine}${PROJECTION.helpLines}  /status            head, model, window, ${ACCOUNT.helpStatusWord}drift, queue
  /pins | /unpin <id>
${tr("  /ping              send a cache ping now\n")}${JUMP.helpLine}  /system            print the loaded system prompt
  /tools             list available tools
  /history           print the conversation
${tr("  /usage [session|today|week]  per-model tokens, cache, helpers, cache pings and optional API-$\n")}  /inlet on|off      toggle pre-turn retrieval
  /save <path>       save the current conversation as JSON
  /help              print this list
`;

let inletOn = INLET_ENABLED;

async function startMcpClients(state: RuntimeState, head: HeadSpec): Promise<void> {
  if (head.transport !== "api" || !MCP_CONFIG) return;
  const specs = loadMcpConfig(MCP_CONFIG, MCP_SERVERS.length ? MCP_SERVERS : undefined);
  for (const [name, spec] of Object.entries(specs)) {
    if (state.mcpClients?.get(name)?.alive()) continue;
    const client = new StdioMcpClient(name, spec, logEvent);
    try {
      await client.start();
      state.mcpClients!.set(name, client);
    } catch (error) {
      logEvent({ type: "mcp_stdio_failed", server: name, error: String(error) });
      client.stop();
    }
  }
  const mcpTools: OpenAIToolDef[] = [];
  for (const [name, client] of state.mcpClients ?? []) {
    for (const tool of client.tools) {
      mcpTools.push({ type: "function", function: {
        name: prefixedToolName(name, tool.name),
        description: String(tool.description ?? "").slice(0, 1024),
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      } });
    }
  }
  state.tools = [...state.tools.filter((tool) => !tool.function.name.startsWith("mcp__")), ...mcpTools];
}

function stopMcpClients(state: RuntimeState): void {
  for (const [, client] of state.mcpClients ?? []) client.stop();
  state.mcpClients?.clear();
  state.tools = state.tools.filter((tool) => !tool.function.name.startsWith("mcp__"));
}

/** Start level: the saved state, then BRAIN_EFFORT, then
 * CLAUDE_CODE_EFFORT_LEVEL, then the model's default. The pipe itself never
 * inherits that variable: it would pin the CLI's level. */
function storedEffort(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" && /^[a-z][a-z0-9_-]{0,19}$/.test(value) && value !== "default" ? value : undefined;
}

export function loadEffort(file = EFFORT_FILE, env: Record<string, string | undefined> = process.env, head?: string, allowLegacy = true): string | null {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (head && saved?.perHead && typeof saved.perHead === "object") {
      const level = Object.hasOwn(saved.perHead, head) ? storedEffort(saved.perHead[head]) : undefined;
      if (level !== undefined) return level;
    } else if (allowLegacy && saved && typeof saved === "object" && "effort" in saved) {
      if (saved.effort === null) return null;
      const parsed = parseEffort(saved.effort);
      if (parsed && parsed !== "default") return parsed;
    }
  } catch { /* no file yet */ }
  // The head's own configured level (ADAPTER_EFFORT for the GPT pipe) always
  // counts; only the global BRAIN_EFFORT is legacy and never leaks to another head.
  const native = head === "claude" ? env.CLAUDE_CODE_EFFORT_LEVEL : head === "gpt" ? env.ADAPTER_EFFORT : undefined;
  const defaults = head ? [env[`BRAIN_${head.toUpperCase()}_EFFORT`], ...(allowLegacy ? [env.BRAIN_EFFORT] : []), native]
    : [env.BRAIN_EFFORT, env.CLAUDE_CODE_EFFORT_LEVEL];
  for (const raw of defaults) {
    const parsed = parseEffort(raw);
    if (parsed === "default") return null;
    if (parsed) return parsed;
  }
  return null;
}

/** Atomic per-head update. Migration seeds ONLY the current/source head, never
 * all heads from the old global level. Errors propagate to the transaction. */
export function saveHeadEfforts(file: string, updates: Record<string, string | null>, by: string): void {
  let saved: any = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* first write/migration */ }
  const perHead: Record<string, string | null> = {};
  for (const name of HEAD_NAMES) {
    const level = storedEffort(saved?.perHead?.[name]);
    if (level !== undefined) perHead[name] = level;
    if (Object.hasOwn(updates, name)) perHead[name] = updates[name];
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 2, perHead, set_at: new Date().toISOString(), by }, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

async function targetEffort(state: RuntimeState, head: HeadSpec, raw?: string): Promise<{ ok: true; level: string | null } | { ok: false; error: string }> {
  const level = raw ?? (head.name === currentHead(state).name ? state.effort ?? "default" : loadEffort(EFFORT_FILE, headEnvironment(), head.name, false) ?? "default");
  if (level === "default") return { ok: true, level: null };
  const catalog = head.name === "claude" ? await claudeModelsCached() : await listModelsCached(head.name);
  const model = catalogModel(catalog, head.model);
  if (catalog?.length && !model) return { ok: false, error: tr`effort=${level}: target model ${head.name}/${head.model} missing from target catalog — unchanged` };
  if (head.name === "claude" && model && model.supportsEffort === undefined && !model.supportedEffortLevels?.length) {
    return { ok: false, error: tr`effort=${level}: target model ${head.model} reports no effort levels — unchanged` };
  }
  return validateTargetEffort(head, level, model);
}

export function effortLabel(state: Pick<RuntimeState, "effort" | "appliedEffort" | "head">): string | null {
  const head = state.head ?? resolveHead(process.env.BRAIN_HEAD ?? "api", process.env);
  const support = headEffortSupport(head);
  if (head.name === "gpt" && head.transport === "pipe" && head.effort !== undefined) return head.effort === "max" ? "xhigh" : head.effort;
  if (support.via === "none") return "n/a";
  if (support.via === "request") return requestEffort(head, state.effort) ?? null;
  if (state.appliedEffort === undefined) return state.effort ?? null;
  return state.appliedEffort ?? "n/a";
}

function effortStatusText(state: RuntimeState): string {
  const head = currentHead(state);
  const support = headEffortSupport(head);
  const applied = effortLabel(state);
  return [
    `effort: ${state.effort ?? "default"}${applied && applied !== state.effort ? ` (runs as ${applied})` : ""} · head ${head.name} (${head.transport}, ${head.model})${state.pendingRebirth ? ` · pipe restart pending (${state.pendingRebirth})` : ""}`,
    `  ${support.note}`,
    "  /effort low|medium|high|xhigh|max|default",
  ].join("\n");
}

/** Stores the level first, then applies it: live on the Claude pipe, falling
 * back to a restart at the next turn boundary when the CLI refuses. */
export async function applyEffort(state: RuntimeState, raw: string | undefined, by: "terminal" | "app" | "agent" | "internal"): Promise<{ ok: boolean; text: string }> {
  if (raw === undefined || !String(raw).trim()) return { ok: true, text: effortStatusText(state) };
  if (pendingMove || pendingHeadChoices) return { ok: false, text: tr("Head switch in progress — effort unchanged; set again after commit") };
  const extra = catalogEffortLevels(currentHead(state));
  const parsed = parseEffort(raw, extra);
  if (!parsed) return { ok: false, text: `effort: unknown level '${String(raw).trim()}' — ${[...new Set(["low", "medium", "high", "xhigh", "max", ...extra])].join("|")}|default` };
  const level = parsed === "default" ? null : parsed;
  const shown = level ?? "default";
  const previous = state.effort ?? null;
  const head = currentHead(state);
  if (head.name === "gpt" && head.transport === "pipe") {
    const checked = await targetEffort(state, head, parsed);
    if (!checked.ok) return { ok: false, text: checked.error };
  }
  if (pendingMove || pendingHeadChoices || (state.head && state.head !== head)) return { ok: false, text: tr("Head switch in progress — effort unchanged; set again after commit") };
  try { saveHeadEfforts(EFFORT_FILE, { [head.name]: level }, by); }
  catch (error) { logEvent({ type: "effort_save_failed", error: String(error) }); return { ok: false, text: tr("Could not save effort — unchanged") }; }
  state.effort = level;
  if (head.name === "gpt" && head.transport === "pipe") {
    logEvent({ type: "effort_set", from: previous, to: level, by, head: head.name, via: "adapter-birth", applied: effortLabel(state) });
    return { ok: true, text: tr`effort = ${shown} — saved for GPT; running adapter unchanged (${effortLabel(state) ?? "default"}). Takes effect with a new adapter: /head gpt ${head.model} pipe effort=${shown}` };
  }
  const support = headEffortSupport(head);
  logEvent({ type: "effort_set", from: previous, to: level, by, head: head.name, via: support.via });
  if (support.via === "none") {
    return { ok: true, text: `effort = ${shown} — stored; head ${head.name} (${head.transport}) has no effort control: ${support.note}. It is remembered only for this head.` };
  }
  if (support.via === "request") {
    return { ok: true, text: `effort = ${shown} — head ${head.name}: ${requestEffort(head, level) ? `reasoning_effort=${requestEffort(head, level)}` : "no reasoning_effort field (the model's default)"} from the next request on.` };
  }
  const pipe = state.pipe;
  if (!pipe?.isAlive()) {
    state.appliedEffort = undefined;
    return { ok: true, text: `effort = ${shown} — the next pipe start uses ${level ? `--effort ${level}` : "the model's default"}.` };
  }
  const live = await pipe.setEffort(level);
  if (live.ok) {
    state.appliedEffort = live.effort ?? null;
    const runs = live.effort ?? null;
    const caveat = runs === null
      ? ` — the model ${live.model ?? head.model} takes no effort parameter (stored for the next one that does)`
      : level && runs !== level ? ` — the CLI runs it as ${runs} on ${live.model ?? head.model}` : "";
    logEvent({ type: "effort_live", requested: level, applied: runs, by });
    return { ok: true, text: `effort = ${shown} — live, no restart, history kept (from the next model request)${caveat}.` };
  }
  state.pendingRebirth = "effort";
  logEvent({ type: "effort_live_refused", requested: level, error: live.error ?? null, by });
  return { ok: true, text: `effort = ${shown} — the CLI refused a live change (${live.error ?? "no answer"}); the pipe restarts with ${level ? `--effort ${level}` : "the model's default"} at the next turn boundary, history kept.` };
}

/** Switches the model on the running pipe; the conversation stays. Returns
 * false (restart instead) when there is no idle pipe or the CLI refuses. */
async function switchModelLive(state: RuntimeState, head: HeadSpec, model: string): Promise<boolean> {
  const pipe = state.pipe;
  if (head.name === "gpt" || head.transport !== "pipe" || !pipe?.isAlive() || pipe.isBusy()) return false;
  const live = await pipe.setModel(model);
  if (!live.ok) {
    logEvent({ type: "model_switch_live_refused", head: head.name, model, error: live.error ?? null });
    return false;
  }
  state.head = { ...head, model };
  state.model = model;
  state.drift = PROJECTION.drift.initial();
  state.servedModel = undefined;
  state.appliedEffort = live.effort ?? null;
  houseMapCache = null;
  logEvent({ type: "model_switch_live", head: head.name, model, applied_model: live.model ?? null, applied_effort: live.effort ?? null });
  return true;
}

async function persistHeadChoice(state: RuntimeState, head: HeadSpec, move?: { target: HeadState; bridgeSessions?: number; effort?: string | null }, effort: string | null = state.effort ?? null): Promise<string | null> {
  pendingHeadChoices++;
  try {
    const selected = headStateFor(head);
    const result = await adapterGate.run(`choice:${JSON.stringify([selected, effort])}`,  async () => {
      // Snapshot AFTER entering the lock: a preceding queued switch may have
      // committed another state while this command was waiting.
      const transaction = headStateCommit(HEAD_FILE, selected);
      const restoreEffort = snapshotFileBytes(EFFORT_FILE);
      const effortUpdates = { [currentHead(state).name]: state.effort ?? null, [head.name]: effort };
      const cfg = wakeBridgeConfig(move?.bridgeSessions);
      const artifacts = move ? [BRIDGE_FILE, ...(JUMP.bridge ? [JUMP.bridge.livesFile(BRIDGE_FILE)] : []),
        join(STATE_DIR, "bridge-written.json"), ARCHIVED_MARKER(), ...(UPLOAD_LEDGER ? [UPLOAD_LEDGER] : []), ...(cfg.noBridgeMarker ? [cfg.noBridgeMarker] : [])]
        .map(snapshotFileBytes) : [];
      const before = { move: state.move, archiveStarted: state.archiveStarted, liveSegmentNames: [...state.liveSegmentNames] };
      return adapterOperation(head, {
        finalize: move ? async () => {
          state.move = move; // The old head still owns history/model-at-cut.
          await archiveSession(state, "move", true);
        } : undefined,
        commit: () => {
          if (shuttingDown || cutInProgress) throw new Error(tr("Brain is already shutting down"));
          saveHeadEfforts(EFFORT_FILE, effortUpdates, move ? "move" : "head");
          return transaction.commit();
        },
        rollback: async () => {
          Object.assign(state, before);
          const failures: string[] = [];
          for (const restore of [transaction.rollback, restoreEffort, ...artifacts]) {
            try { await restore(); } catch (error) { failures.push(String(error)); }
          }
          if (failures.length) throw new Error(failures.join("; "));
        },
      });
    });
    if (!result.ok) return result.error;
    state.headStateActive = true;
    return null;
  } catch (error) {
    logEvent({ type: "head_state_save_failed", head: head.name, error: String(error) });
    return tr("Could not save head selection — not switched");
  } finally { pendingHeadChoices--; }
}

function statusText(state: RuntimeState): string {
  const head = currentHead(state);
  const t = thresholds(state);
  const pct = state.lastPromptTokens ? Math.round((100 * state.lastPromptTokens) / head.contextWindow) : 0;
  return [
    `head: ${head.name} (${head.transport}) · model: ${head.model}${state.servedModel ? ` · served: ${state.servedModel}` : ""}${head.unavailable ? ` · UNAVAILABLE: ${head.unavailable}` : ""}`,
    `effort: ${state.effort ?? "default"} · runs as ${effortLabel(state) ?? "the model's default"} (${headEffortSupport(head).via})${state.pendingRebirth ? ` · restart pending (${state.pendingRebirth})` : ""}`,
    `system prompt mode: ${systemPromptMode(head, process.env)}${head.transport === "api" ? " (API: Brain supplies the system message directly)" : ""}`,
    `head state: ${state.headStateActive ? `active (${HEAD_FILE}); overrides BRAIN_HEAD` : "environment (no persisted choice active)"}`,
    `window: ${state.lastPromptTokens}/${head.contextWindow} (${pct}%) · warn ${t.warn} · cut ${t.cut}${clampNote(t)}`,
    `${ACCOUNT.statusField(head.transport === "pipe" && !head.pipeEnv.ANTHROPIC_BASE_URL)}drift: ${state.drift?.substrateDrift ? "YES" : "no"} · pipe: ${state.pipe?.isAlive() ? `alive (births ${state.pipeBirths})` : "none"}`,
    `queue: ${queue.length} · busy: ${busy || pipeTurnOpen(state)}${!busy && pipeTurnOpen(state) ? " (self-started pipe turn)" : ""} · inlet: ${inletOn ? "on" : "off"} · ${tr("cache ping")}: ${cachePingEnabled(CACHE_PING_MODE, head) ? "on" : "off"} (${cachePingMinutes(head, process.env)} min)`,
    ...(APPROVAL_MODE === "app" ? [`approvals: app · rules ${APPROVAL_RULES.source === "off" ? "off" : "on"} (${APPROVAL_RULES.rules.length}) · always ask: ${[...APPROVAL_RULES.alwaysAsk].join(",") || "none"}`] : []),
    webStatusLine(headWebPlan(head)),
  ].join("\n");
}

export async function handleCommand(state: RuntimeState, line: string, source: "terminal" | "app" | "internal"): Promise<{ text: string; exit?: "respawn" | "stop" }> {
  const [commandRaw, ...rest] = line.trim().split(/\s+/);
  const command = canonicalCommand(commandRaw);
  const argument = rest.join(" ");
  if (source === "app" && !APP_COMMANDS.has(command)) return { text: tr`${command}: not allowed in the app channel` };
  switch (command) {
    case "/exit": case "/quit": case "/respawn":
      return { text: "Respawn.", exit: "respawn" };
    case "/stop":
      return { text: "archiving; the loop stops", exit: "stop" };
    case "/move": {
      const prepared = prepareMove(argument, { ...headEnvironment(), BRAIN_RAG_URL: RAG_URL, BRAIN_RAG_AUTH_TOKEN: RAG_AUTH_TOKEN });
      if (!prepared.ok) {
        logEvent({ type: "move_refused", reason: prepared.error, source });
        return { text: tr`Move refused: ${prepared.error} — no cut` };
      }
      const { target, state: selected, bridgeSessions } = prepared.value;
      const chosenEffort = await targetEffort(state, target, prepared.value.effort);
      if (!chosenEffort.ok) return { text: tr`Move refused: ${chosenEffort.error} — no cut` };
      if (target.name === "gpt" && target.transport === "pipe") target.effort = chosenEffort.level;
      pendingMove = true;
      let moveError: string | null;
      try { moveError = await persistHeadChoice(state, target, { target: selected, bridgeSessions, effort: chosenEffort.level }, chosenEffort.level); }
      finally { pendingMove = false; }
      const deferred = deferredShutdown;
      deferredShutdown = null;
      if (moveError) {
        logEvent({ type: "move_refused", reason: moveError === tr("Could not save head selection — not switched") ? "head_state_save_failed" : "gpt_adapter_unavailable", error: moveError, source });
        if (deferred) void shutdown(state, deferred);
        return { text: tr`Move refused: ${moveError.replace(tr(" — not switched"), "")} — no cut` };
      }
      // Do not replace state.head: archive/model-at-cut belong to THIS life.
      state.move = { target: selected, bridgeSessions, effort: chosenEffort.level };
      const bridge = wakeBridgeConfig(bridgeSessions);
      logEvent({ type: "move_requested", from: currentHead(state).name, head: target.name, model: target.model,
        transport: target.transport, window: target.contextWindow, bridge_mode: bridge.mode, bridge_sessions: bridge.n,
        bridge_override: bridgeSessions ?? null, source });
      const depth = bridge.mode === "sessions" ? tr`${bridge.n} sessions` : tr`${bridge.turns} turns`;
      return { text: tr`move → ${target.name} (${target.transport}, ${target.model}); window ${target.contextWindow}; bridge ${depth}${tr(bridgeSessions !== undefined ? " (once)" : " (default)")}; archiving, next start on ${target.name}`, exit: "respawn" };
    }
    case "/reload": {
      const restart = "BRAIN_SYSTEM (path), the head's window and other startup settings need a cut; a changed socket or unit environment needs a unit restart";
      if (currentHead(state).transport === "api") {
        currentSystemPrompt(state);
        return { text: `reload: API head has no pipe; prompt files are reread at the next request; ${restart}.` };
      }
      let next: PipeProfile;
      try { next = readPipeProfile(headEnvironment()); }
      catch {
        logEvent({ type: "pipe_reload_failed", source });
        return { text: "reload: could not read the profile; nothing changed" };
      }
      const changed = changedPipeProfile(state.pipeProfile ?? INITIAL_PIPE_PROFILE, next);
      if (!changed.length) return { text: `reload: nothing changed; ${state.pendingRebirth ? "one restart is already pending; " : "no restart; "}${restart}.` };
      state.pipeProfile = next;
      state.pendingRebirth ??= "reload";
      logEvent({ type: "pipe_reload", keys: changed, source });
      return { text: `reload: changed ${changed.join(", ")}; the pipe restarts at the next turn boundary, history kept; ${restart}.` };
    }
    case "/help": return { text: HELP() };
    case "/status": return { text: statusText(state) };
    case "/reset":
      await stopPipe(state, "reset");
      state.history = [];
      state.rolledIndex = 0;
      state.rolledSegments = 0;
      state.liveSegmentNames = [];
      state.inletBlocks = {};
      state.wakeLoaded = false;
      state.sessionStartIndex = 0;
      return { text: "conversation state cleared" };
    case "/effort": return { text: (await applyEffort(state, argument || undefined, source)).text };
    case "/heads": {
      const { claude: claudeModels, probed } = await probedCatalogs(argument === "refresh");
      const head = currentHead(state);
      const current = { name: head.name, model: head.model };
      return { text: headChoicesText(headChoices(headEnvironment(), probed, current), current) + (claudeModels ? "" : "\n(claude did not report its catalog; configured list shown)") };
    }
    case "/head": {
      const parsed = parseHeadCommand(argument);
      if (!parsed) return { text: statusText(state) };
      if (parsed.error) return { text: parsed.error };
      if (!(HEAD_NAMES as readonly string[]).includes(parsed.name)) return { text: tr`Unknown target head: ${parsed.name}` };
      const current = currentHead(state);
      const keepWindow = parsed.name === current.name && !(parsed.name === "claude" && !parsed.model && !parsed.transport);
      const next = resolveHeadChoice(parsed.name, headEnvironment(), { ...parsed, contextWindow: keepWindow ? current.contextWindow : undefined });
      if (next.unavailable) return { text: `head ${parsed.name}: ${next.unavailable} — not switched` };
      const chosenEffort = await targetEffort(state, next, parsed.effort);
      if (!chosenEffort.ok) return { text: chosenEffort.error };
      const previousEffort = state.effort ?? null;
      if (next.name === "gpt" && next.transport === "pipe") next.effort = chosenEffort.level;
      const persistError = await persistHeadChoice(state, next, undefined, chosenEffort.level);
      if (persistError) return { text: `head ${next.name}: ${persistError} — not switched` };
      state.effort = chosenEffort.level;
      if (chosenEffort.level === previousEffort && next.name !== "gpt" && next.name === current.name && next.transport === "pipe" && current.transport === "pipe" && next.endpoint === current.endpoint && next.contextWindow === current.contextWindow && state.pipe?.isAlive()) {
        // Same model: nothing to do — unless the drift guard reports a fallback
        // model, in which case rebirth restores the requested model.
        if (next.model === current.model && !state.drift?.substrateDrift) {
          return { text: `head = ${current.name} (${current.transport}, ${current.model}); unchanged, the running pipe stays` };
        }
        if (next.model !== current.model && await switchModelLive(state, current, next.model)) {
          return { text: `head = ${current.name} (${current.transport}, ${next.model}); history preserved; switched live, no restart (the new model reads the conversation uncached once); watchdog warn ${thresholds(state).warn} / cut ${thresholds(state).cut}` };
        }
      }
      await stopPipe(state, "head_switch");
      stopMcpClients(state);
      state.head = next;
      state.appliedEffort = undefined;
      state.pendingRebirth = null;
      state.model = next.model;
      state.watchdog = headThresholds(next);
      state.drift = PROJECTION.drift.initial();
      state.servedModel = undefined;
      state.gptAdapterVerified = undefined;
      houseMapCache = null;
      await startMcpClients(state, next);
      logEvent({ type: "head_switch", head: next.name, transport: next.transport, model: next.model });
      return { text: `head = ${next.name} (${next.transport}, ${next.model}); history preserved; watchdog warn ${state.watchdog.warn} / cut ${state.watchdog.cut}` };
    }
    case "/model": {
      const head = currentHead(state);
      if (!argument) return { text: `current model: ${head.model}` };
      if ((head.name === "gpt" && /^claude-/i.test(argument)) || (head.name === "claude" && /^(gpt-|o\d)/i.test(argument))) {
        return { text: `model ${argument} does not fit head ${head.name} — not switched. Use /head ${/^claude-/i.test(argument) ? "claude" : "gpt"} ${argument}` };
      }
      const persistError = await persistHeadChoice(state, { ...head, model: argument });
      if (persistError) return { text: `model ${argument}: ${persistError} — not switched` };
      if (argument === head.model && !state.drift?.substrateDrift) return { text: `model = ${argument} (head ${head.name}); unchanged` };
      if (await switchModelLive(state, head, argument)) {
        return { text: `model = ${argument} (head ${head.name}); switched live, no restart, history kept (the new model reads the conversation uncached once)` };
      }
      await stopPipe(state, "model_switch");
      state.head = { ...head, model: argument };
      state.model = argument;
      state.drift = PROJECTION.drift.initial();
      state.servedModel = undefined;
      return { text: `model = ${argument} (head ${head.name})${head.transport === "pipe" ? "; the pipe restarts at the next turn, history kept" : ""}` };
    }
    case "/pins": return { text: await dispatchLocalTool("pins", {}) };
    case "/unpin": return { text: await dispatchLocalTool("unpin", { id: argument }) };
    case "/inlet":
      if (argument === "on") inletOn = true;
      if (argument === "off") inletOn = false;
      return { text: `inlet is ${inletOn ? "on" : "off"}` };
    case "/ping":
      queue.push({ kind: "cache_ping", source: "internal", text: CACHE_PING_PROMPT });
      return { text: tr("cache ping queued") };
    case "/system": return { text: currentSystemPrompt(state) };
    case "/tools": return { text: state.tools.map((tool) => `  ${tool.function.name} — ${tool.function.description}`).join("\n") };
    case "/history": return { text: state.history.map((m) => toolRecords.record(m)).map((m) => `[${m.role}] ${(m.content ?? "").slice(0, 300)}`).join("\n") };
    case "/usage": {
      const scope = (argument || "session").toLowerCase();
      if (!["session", "today", "week"].includes(scope)) return { text: "/usage [session|today|week]" };
      state.pipe?.flushUsage();
      const report = renderUsage(await readUsageRecords(LOG_DIR, SESSION_LOG, scope as UsageScope), scope as UsageScope,
        readUsagePrices(process.env.BRAIN_PRICES_FILE));
      return { text: source === "app" ? `\`\`\`text\n${report.replaceAll("```", "'''")}\n\`\`\`` : report };
    }
    case "/save": {
      const path = argument || join(LOG_DIR, `session-${SESSION_ID}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ model: currentHead(state).model, history: state.history.map((message) => toolRecords.record(message)) }, null, 2), "utf8");
      return { text: `saved to ${path}` };
    }
    default: {
      const jumped = JUMP.command(command, source);
      if (jumped) return { text: await jumped };
      const own = ACCOUNT.command(command, argument, STERILE);
      if (own) {
        if (own.switched) await stopPipe(state, "account_switch");
        return { text: own.text };
      }
      const projected = PROJECTION.command(command, argument, currentHead(state));
      if (projected) {
        if (projected.rebirth) await stopPipe(state, projected.rebirth);
        return { text: projected.text };
      }
      return { text: `unknown command: ${command}; try /help` };
    }
  }
}

function pollApp(state: RuntimeState, readCursor: { current: InboxCursor }): void {
  if (!APP_INBOX_FILE || shuttingDown) return;
  let read;
  try { read = readInbox(APP_INBOX_FILE, readCursor.current, APP_BATCH_BYTES); } catch (error) { logEvent({ type: "app_inbox_read_failed", error: String(error) }); return; }
  readCursor.current = read.cursor;
  if (read.collapsed.length) {
    logEvent({ type: "app_inbox_repeats_collapsed", senders: read.collapsed });
    notifyApp(`[Brain] Collapsed exact repeats: ${read.collapsed.map(({ sender, count }) => `${count} from ${sender}`).join(", ")}.`);
  }
  read.entries.forEach((entry, index) => {
    const endOffset = read.endOffsets[index];
    const text = String(entry.text ?? "").trim();
    console.log(inboxConsoleLine(entry, APP_USER));
    const item: QueueItem = { kind: "user", source: "app", text: channelTag(entry, APP_SOURCE, APP_USER), commitOffset: endOffset, messageId: entry.id };
    // Foreign messages are never the user's commands or the user speaking.
    const command = !isForeignEntry(entry) && text.startsWith("/") && isAppCommand(text);
    if (!command && !isForeignEntry(entry)) personSpokeSinceStart = true;
    if (command) {
      const first = text.split(/\s+/)[0].toLowerCase();
      if (JUMP.commands.includes(first)) {
        commitAppItem(item);
        void JUMP.command(first, "app")?.then((reply) => notifyApp(reply));
        return;
      }
      queue.push({ ...item, kind: "command", text });
      return;
    }
    // A message that arrives mid-turn goes in now, also into a turn the CLI
    // started by itself, but never into a cache-ping turn.
    if (!claudeAuthBlocked(state) && currentKind !== "cache_ping" && (steeringInFlight > 0 || state.pipe?.canSteer())) {
      steeringInFlight += 1;
      steerChain = steerChain
        .then(() => steerWithContext(state, item))
        .catch((error) => { logEvent({ type: "pipe_steering_error", error: String(error) }); queue.push(item); })
        .finally(() => { steeringInFlight -= 1; void processQueue(state); });
      return;
    }
    // The same silent nudge arriving again while one still waits adds nothing but length.
    if (text.startsWith("[gateway:silent]") && text.length > 80 && queue.some((queued) => queued.text.includes(text))) {
      commitAppItem(item);
      logEvent({ type: "silent_nudge_deduplicated", characters: text.length });
      return;
    }
    queue.push(item);
  });
  void processQueue(state);
}

let steerChain: Promise<void> = Promise.resolve();
let steeringInFlight = 0;

/** Steers one app message into the running turn with its context block; if
 * the turn ended meanwhile, the message takes the normal way (never lost). */
async function steerWithContext(state: RuntimeState, item: QueueItem): Promise<void> {
  const block = state.pipe?.canSteer() ? await buildContextBlock(state, item.text, INLET_ENABLED) : null;
  const outgoing = pipeOutgoingText(currentHead(state).model, item.text);
  if (!claudeAuthBlocked(state) && currentKind !== "cache_ping" && state.pipe?.canSteer() && state.pipe.steer(block ? `${block}\n\n${outgoing}` : outgoing)) {
    const message: Message = { role: "user", content: item.text };
    state.history.push(message);
    logTurn(message);
    commitAppItem(item);
    if (claudeAuthProfile(state)) (state.claudeTurnSteers ??= []).push({ ...item, retryMessage: message });
    logEvent({ type: "pipe_steering_sent", characters: item.text.length, context_characters: block?.length ?? 0 });
    return;
  }
  queue.push(item);
}

let exitRequest: "respawn" | "stop" | null = null;

function claudeAuthProfile(state: RuntimeState): ClaudeAuthProfile | null {
  const head = currentHead(state);
  if (head.name !== "claude" || head.transport !== "pipe" || head.pipeEnv.ANTHROPIC_BASE_URL) return null;
  const account = ACCOUNT.pipeEnv();
  return { configDir: account.set.CLAUDE_CONFIG_DIR ?? null, account: account.name };
}

function claudeAuthBlocked(state: RuntimeState): boolean {
  const profile = claudeAuthProfile(state);
  return Boolean(profile && state.claudeAuth && profile.configDir === state.claudeAuth.profile.configDir && profile.account === state.claudeAuth.profile.account);
}

function authSystemNotice(text: string): void {
  console.log(text);
  logTurn({ role: "system", content: text });
  notifyApp(text);
}

function expireClaudeAuth(state: RuntimeState): void {
  if (claudeAuthBlocked(state)) return;
  const profile = claudeAuthProfile(state);
  if (!profile) return;
  state.claudeAuth?.watcher?.close();
  if (state.claudeAuth?.timer) clearInterval(state.claudeAuth.timer);
  const auth: NonNullable<RuntimeState["claudeAuth"]> = { profile, stamp: credentialsStamp(profile), lastProbe: Date.now() };
  state.claudeAuth = auth;
  writeClaudeAuthState(STATE_DIR, "expired", profile);
  authSystemNotice(tr("[Brain] Your agent is here; only its Claude sign-in has expired. Your message is kept. Tap “Sign in again” in the app."));
  // Watch the directory so an atomic credentials replacement keeps being observed.
  try {
    auth.watcher = watch(dirname(credentialsPath(profile)), () => { void recoverClaudeAuth(state); });
    auth.watcher.on("error", () => { auth.watcher?.close(); auth.watcher = undefined; });
  } catch { /* The periodic check also covers a missing profile directory. */ }
  auth.timer = setInterval(() => { void recoverClaudeAuth(state); }, 60_000);
}

async function recoverClaudeAuth(state: RuntimeState): Promise<void> {
  const auth = state.claudeAuth;
  if (!auth || !claudeAuthBlocked(state) || shuttingDown || busy || pipeTurnOpen(state)) return;
  const stamp = credentialsStamp(auth.profile);
  // An unchanged credentials file cannot have healed; probing it every minute only
  // repeats the same failed call. A rewrite is probed at once, otherwise rarely.
  if (stamp === auth.stamp && Date.now() - auth.lastProbe < 30 * 60_000) return;
  auth.stamp = stamp;
  auth.lastProbe = Date.now();
  busy = true;
  try {
    const pipe = await ensurePipe(state, currentHead(state), "auth_probe");
    await pipe.send(CACHE_PING_PROMPT, { steerable: false, usageSource: "cache_ping" });
    if (shuttingDown || state.claudeAuth !== auth) return;
    writeClaudeAuthState(STATE_DIR, "ok");
    auth.watcher?.close();
    if (auth.timer) clearInterval(auth.timer);
    state.claudeAuth = undefined;
    turnFailureNoticeSent = false;
    authSystemNotice(tr("[Brain] The Claude sign-in works again. Your kept message is on its way."));
  } catch { /* A failed probe keeps the same state and never repeats the notice. */ }
  finally { busy = false; void processQueue(state); }
}

let turnFailureNoticeSent = false;
export function turnFailureNotice(error: unknown, rateLimit: RateLimitInfo | null, nowMs = Date.now(), timeZone = brainTimezone()): string {
  const resetMs = typeof rateLimit?.resetsAt === "number" ? rateLimit.resetsAt * 1000 : NaN;
  if (rateLimit?.status === "rejected" && Number.isFinite(resetMs)) {
    const parts = (ms: number) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const at = parts(resetMs), today = parts(nowMs);
    const when = `${at.day === today.day && at.month === today.month ? "" : `${at.day}.${at.month}. `}${at.hour}:${at.minute}`;
    return tr`[Brain] Your message arrived but got no answer: the limit is reached, free again at ${when}. Please send it again after that.`;
  }
  const reason = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").trim().slice(0, 160);
  return tr`[Brain] Your message arrived but got no answer: the head stopped with an error (${reason}). Please send it again; /status shows more.`;
}

async function handleItem(state: RuntimeState, item: QueueItem): Promise<void> {
  if (item.kind === "command") {
    commitAppItem(item);
    let result: Awaited<ReturnType<typeof handleCommand>>;
    try {
      result = await handleCommand(state, item.text, item.source);
    } catch (error) {
      // A command that throws must not take the queue down, and the app hears it.
      const reason = String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").trim().slice(0, 160);
      logEvent({ type: "command_error", error: String(error), source: item.source });
      if (item.source === "app") notifyApp(tr`[Brain] The command failed: ${reason}`);
      else console.error(`command error: ${String(error)}`);
      return;
    }
    if (item.source === "app") notifyApp(result.text);
    else console.log(result.text);
    if (result.exit) exitRequest = result.exit;
    return;
  }
  if (item.kind === "cache_ping") {
    if (claudeAuthBlocked(state)) return;
    terminalLine(item.text);
    try {
      const reply = await runTurn(state, item.text, false, { kind: "cache_ping", source: "internal" });
      if (item.source === "terminal") console.log(`(${tr("cache ping")}) ${reply}`);
    } catch (error) {
      // The pipe's error carries the turn's rate_limit_event when the CLI sent
      // one: a rejection then holds the cache ping until its reset time.
      if (error instanceof ClaudeAuthExpiredError) { expireClaudeAuth(state); return; }
      const rateLimit = (error as { rateLimitInfo?: RateLimitInfo | null })?.rateLimitInfo;
      if (rateLimit) state.lastRateLimit = rateLimit;
      logEvent({ type: "cache_ping_failed", error: String(error), rate_limit: rateLimit ? { status: rateLimit.status ?? null, resets_at: rateLimit.resetsAt ?? null } : null });
    }
    return;
  }
  commitAppItem(item);
  let turnStarted = false;
  let turnCompleted = false;
  let firstTurnClaimed = false;
  const modelAnswers = state.modelAnswers ?? 0;
  try {
    if (!item.retryMessage) {
      if (!commitFirstTurn(item)) return;
      firstTurnClaimed = Boolean(item.firstTurnMarker);
    }
    lastTurnSpeech = { replied: false, prose: "", missing: [] };
    turnStarted = true;
    const answer = await runTurn(state, item.text, inletOn, { kind: item.kind === "internal" ? "internal" : "user", source: item.source, retryMessage: item.retryMessage, skipInlet: item.skipInlet });
    turnCompleted = true;
    console.log(`\n${WORKER_NAME}:\n${answer}\n`);
    state.claudeTurnSteers = undefined;
    turnFailureNoticeSent = false; // a turn that works ends a run of failures
    gatewayAfterTurn(item);
  } catch (error) {
    if (error instanceof ClaudeAuthExpiredError) {
      // The auth retry delivers the claimed first turn in this life once the sign-in is back.
      expireClaudeAuth(state);
      const retry = error as ClaudeAuthExpiredError & { retryText?: string; retryMessage?: Message };
      queue.unshift({ ...item, text: retry.retryText ?? item.text, retryMessage: retry.retryMessage ?? item.retryMessage }, ...(state.claudeTurnSteers ?? []));
      state.claudeTurnSteers = undefined;
      return;
    }
    if (firstTurnClaimed && !turnCompleted && (state.modelAnswers ?? 0) === modelAnswers) releaseFirstTurn(item);
    console.error(`turn error: ${String(error)}`);
    logEvent({ type: "turn_error", error: String(error), source: item.source });
    state.claudeTurnSteers = undefined;
    const rateLimit = (error as { rateLimitInfo?: RateLimitInfo | null })?.rateLimitInfo ?? null;
    if (rateLimit) state.lastRateLimit = rateLimit;
    // A reply that did not arrive before the error is still owed.
    if (turnStarted) gatewayAfterTurn(item);
    if (item.source === "app" && !(turnStarted && lastTurnSpeech.replied)) {
      if (turnFailureNoticeSent) logEvent({ type: "turn_error_notice_suppressed" });
      else {
        turnFailureNoticeSent = true;
        notifyApp(turnFailureNotice(error, rateLimit));
        logEvent({ type: "turn_error_notice", rate_limited: rateLimit?.status === "rejected" });
      }
    }
    while (state.history.length) {
      const last = state.history[state.history.length - 1];
      if (last.role === "user") break;
      if (last.role === "assistant" && !last.tool_calls?.length) break;
      state.history.pop();
    }
  }
}

const pendingGateway = new Set<Promise<void>>();
// An export waits briefly for gateway receipts; a slow or absent app must not hold a cut.
// A receipt that misses this window leaves its text out, which errs towards less, never wrong.
const GATEWAY_SETTLE_MS = Number(process.env.BRAIN_GATEWAY_SETTLE_MS ?? "5000");
async function settleGateway(): Promise<void> {
  if (!pendingGateway.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...pendingGateway]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, GATEWAY_SETTLE_MS); }),
  ]);
  if (timer) clearTimeout(timer);
}

function gatewayAfterTurn(item: Pick<QueueItem, "source" | "text" | "replyExpected">, speech = lastTurnSpeech): void {
  if (!APP_URL) return;
  const { forward, owed } = gatewayPlan(item.source, speech, item.text, REPLY_GATEWAY_OFF_FILE, item.replyExpected);
  // Classification stays off the queue, but exports wait for its delivery receipt.
  for (const job of [
    ...(forward ? [gatewayForward(forward, speech.prose.trim(), speech.message)] : []),
    ...(owed ? [gatewaySend(owed, speech.message)] : []),
  ]) {
    pendingGateway.add(job);
    void job.finally(() => pendingGateway.delete(job));
  }
}

async function gatewayForward(forward: string, prose: string, message?: Message): Promise<void> {
  if (GATEWAY_CLASSIFIER_ON) {
    const { verdict, reason } = await classifyReplyOrNote(prose, GATEWAY_CLASSIFIER);
    if (verdict === "NOTE") {
      logEvent({ type: "reply_gateway_suppressed", reason: `classifier:NOTE`, characters: forward.length });
      return;
    }
    if (reason !== "classifier") logEvent({ type: "reply_gateway_classifier_fail_open", reason });
  }
  await gatewaySend(forward, message);
}

export function recordGatewayDelivery(message: Message | undefined, text: string, delivery: { ok: boolean }, write: (record: Record<string, unknown>) => void = logTurn): void {
  if (!delivery.ok || !message) return;
  let id = speechIds.get(message);
  if (!id) { id = randomUUID(); speechIds.set(message, id); }
  const previous = gatewayTexts.get(message);
  const delivered = previous ? `${previous}\n\n${text}` : text;
  gatewayTexts.set(message, delivered);
  write({ role: "system", content: null, speech_update: id, gateway_text: delivered });
}

async function gatewaySend(forward: string, message?: Message): Promise<void> {
  // The switch is checked again because classification can outlive a turn.
  if (existsSync(REPLY_GATEWAY_OFF_FILE)) return;
  let delivery: { ok: boolean; status: number } = { ok: false, status: 0 };
  try { delivery = await appBroadcast({ baseUrl: APP_URL, token: APP_TOKEN }, forward, "send"); } catch { /* app down */ }
  recordGatewayDelivery(message, forward, delivery);
  if (delivery.ok) logEvent({ type: "reply_gateway_sent", characters: forward.length });
  else logEvent({ type: "reply_gateway_failed", status: delivery.status, characters: forward.length });
}

async function processQueue(state: RuntimeState): Promise<void> {
  writeWatchdogState(state, state.lastPromptTokens);
  // A turn the CLI started by itself keeps Brain busy; its end handler
  // (onPipeSelfTurn) calls processQueue again.
  if (busy || shuttingDown || pipeTurnOpen(state)) return;
  busy = true;
  try {
    while (queue.length && !shuttingDown && !exitRequest && !state.cutoffRequested && !pipeTurnOpen(state)) {
      if (claudeAuthBlocked(state) && queue[0].kind !== "command") {
        // Commands remain usable without letting waiting messages overtake each other.
        const command = queue.findIndex((item) => item.kind === "command");
        if (command < 0) break;
        await handleItem(state, queue.splice(command, 1)[0]);
        continue;
      }
      const item = takeTurnItem(queue);
      if (item.mergedCount) logEvent({ type: "app_messages_merged", count: item.mergedCount });
      writeWatchdogState(state, state.lastPromptTokens);
      currentKind = item.kind;
      await handleItem(state, item);
      currentKind = null;
    }
  } finally {
    busy = false;
    currentKind = null;
    writeWatchdogState(state, state.lastPromptTokens);
  }
  if (!shuttingDown && (exitRequest || state.cutoffRequested) && !pipeTurnOpen(state)) {
    const why = exitRequest ?? "context watchdog";
    if (exitRequest === "stop") {
      try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STOP_MARKER, new Date().toISOString()); } catch { /* best effort */ }
    }
    await shutdown(state, state.move ? "move" : why === "respawn" ? "command" : why);
  }
}

let shutdownState: RuntimeState | null = null;

async function shutdown(state: RuntimeState, reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  if (pendingMove) {
    deferredShutdown ??= reason;
    logEvent({ type: "shutdown_deferred", reason });
    return;
  }
  shuttingDown = true;
  cutInProgress = true;
  state.claudeAuth?.watcher?.close();
  if (state.claudeAuth?.timer) clearInterval(state.claudeAuth.timer);
  // The loop restarts after a cut, after the inner watchdog and after /respawn.
  const respawn = reason === "SIGTERM" ? respawnFollows() : reason === "context watchdog" || reason === "command";
  const deferUpload = respawn && !existsSync(STOP_MARKER);
  logEvent({ type: "shutdown", reason, ...(deferUpload ? { respawn: true } : {}) });
  try { await archiveSession(state, reason, false, deferUpload); } catch (error) { logEvent({ type: "archive_failed", error: String(error) }); }
  await stopPipe(state, `shutdown_${reason}`);
  stopMcpClients(state);
  writeWatchdogState(state, state.lastPromptTokens, true);
  process.exit(code);
}

function registerExitBridge(state: RuntimeState): void {
  process.on("exit", () => {
    try {
      if (!state.archiveStarted) writeBridgeFileSync(state, "exit");
    } catch {
      // The synchronous exit hook is a last-resort continuity safeguard.
    }
  });
}

function idleTick(state: RuntimeState): void {
  if (shuttingDown) return;
  if (state.claudeAuth) void recoverClaudeAuth(state);
  void refreshWeather();
  writeWatchdogState(state, state.lastPromptTokens);
  if (SHELL_ON) taskRegistry.tick();
  if (REMINDERS_COLLECT) void collectReminders();
  const pipeBusy = Boolean(state.pipe?.isBusy());
  const late = lateReminders(readPendingReminders(REMINDERS_PENDING), new Date(), REMINDERS_ESCALATE_MIN);
  if (late.length && !busy && !pipeBusy && queue.length === 0) {
    markRemindersDelivered(REMINDERS_PENDING, late.map((row) => row.id), "brain", new Date());
    queue.push({ kind: "internal", source: "internal", text: reminderEscalationText(late, REMINDERS_ESCALATE_MIN) });
    logEvent({ type: "reminders_escalated", ids: late.map((row) => row.id) });
  }
  const head = currentHead(state);
  const overage = rateLimitBlocks(state.lastRateLimit, Date.now());
  if (cachePingDue({
    nowMs: Date.now(), lastModelCallAt: state.lastModelCallAt ?? 0, idleMin: cachePingMinutes(head, process.env), busy: busy || pipeBusy, queued: queue.length,
    enabled: !claudeAuthBlocked(state) && cachePingEnabled(CACHE_PING_MODE, head), pipeAlive: Boolean(state.pipe?.isAlive()), transport: head.transport, overage,
    lastCachePingAt: state.lastCachePingAt,
  })) {
    queue.push({ kind: "cache_ping", source: "internal", text: CACHE_PING_PROMPT });
  }
  void processQueue(state);
}

let lastRemindersCollect = 0;
async function collectReminders(): Promise<void> {
  if (!MEMORY_URL || !MEMORY_KEY || Date.now() - lastRemindersCollect < 5 * 60_000) return;
  lastRemindersCollect = Date.now();
  try {
    const base = MEMORY_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/due?until=${Date.now()}&limit=10`, { headers: authHeaders(MEMORY_KEY), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return;
    const data: any = await response.json();
    const due = Array.isArray(data?.due) ? data.due : [];
    const ids = appendDueReminders(REMINDERS_PENDING, due, new Date());
    if (ids.length) {
      await fetch(`${base}/due/ack`, { method: "POST", headers: { ...authHeaders(MEMORY_KEY), "Content-Type": "application/json" }, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(15_000) });
      logEvent({ type: "reminders_collected", ids });
    }
  } catch (error) {
    logEvent({ type: "reminders_collect_failed", error: String(error) });
  }
}

export async function loadHeadsSnapshot(state: RuntimeState, refresh = false) {
  const { claude, probed, catalogsUpdatedAt } = await probedCatalogs(refresh);
  return headsSnapshot(state, claude, probed, catalogsUpdatedAt);
}

export function headsSnapshot(state: RuntimeState, claudeModels: ModelInfo[] | null, others: Partial<Record<string, ModelInfo[]>> = {}, catalogsUpdatedAt: number | null = null) {
  const head = currentHead(state);
  const current = { name: head.name, model: head.model };
  const heads = headChoices(headEnvironment(), { ...others, ...(claudeModels ? { claude: claudeModels } : {}) }, current);
  const running = heads.find((h) => h.name === head.name)?.models.find((m) => modelMatches(m, head.model));
  const effort = effortLevelsFor(head, running);
  return {
    current: {
      head: head.name,
      model: head.model,
      transport: head.transport,
      effort: head.name === "gpt" && head.transport === "pipe" ? effortLabel(state) : state.effort ?? null,
      effortApplied: effortLabel(state),
      effortVia: headEffortSupport(head).via,
      supportsEffort: effort.supported,
      effortLevels: effort.levels,
    },
    heads,
    commands: [...APP_COMMANDS].map((command) => ({ command, label: command === "/reload" ? "Reload settings" : command.slice(1) })),
    claudeCatalog: Boolean(claudeModels),
    catalogsUpdatedAt,
  };
}

export async function handleControlTool(state: RuntimeState, name: string, args: any): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (name === "approval_settings_check") {
    approvalSettings?.();
    return { ok: true, text: "checked" };
  }
  if (name === "pins" || name === "pin" || name === "unpin") {
    return { ok: true, text: await dispatchLocalTool(name, args ?? {}) };
  }
  if (name === "status") return { ok: true, text: statusText(state) };
  if (WEB_TOOL_NAMES.has(name)) {
    const text = await runWebTool(WEB, name, args ?? {});
    return text.startsWith("error:") ? { ok: false, error: text.slice("error:".length).trim() } : { ok: true, text };
  }
  if (name === "effort") {
    const result = await applyEffort(state, args?.level === undefined || args?.level === null ? undefined : String(args.level), "agent");
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.text };
  }
  if (name === "approve") {
    const toolName = String(args?.tool_name ?? "tool");
    const detail = JSON.stringify(toolRecords.input(toolName, args?.tool_use_id, args?.input ?? {}), null, 2).slice(0, 1500);
    const match = pipeApprovalMatch(approvalSettings?.() ?? APPROVAL_RULES, APPROVAL_MODE, toolName, args?.input ?? {}, { cwd: pipeEnvironment(state).BRAIN_CLAUDE_CWD ?? HERE, scratch: pipeEnvironment(state).BRAIN_APPROVAL_SCRATCH ?? "" });
    if (approvalSettings && !match) return { ok: true, text: JSON.stringify({ behavior: "allow", updatedInput: args?.input ?? {} }) };
    if (!APP_URL) return { ok: true, text: JSON.stringify({ behavior: "deny", message: "no app configured for approvals (BRAIN_APP_URL)" }) };
    const title = match ? tr("{0}: {1} — {2}", WORKER_NAME, toolName, tr(match.label)) : `${WORKER_NAME}: ${toolName}`;
    const { decision } = await askApproval({ baseUrl: APP_URL, token: APP_TOKEN }, title, detail, "claude-code");
    logEvent({ type: "approval_decision", tool: toolName, decision, via: "pipe", ...match });
    return {
      ok: true,
      text: decision === "allow"
        ? JSON.stringify({ behavior: "allow", updatedInput: args?.input ?? {} })
        : JSON.stringify({ behavior: "deny", message: `${USER_NAME} did not approve (${decision})` }),
    };
  }
  return { ok: false, error: `unknown tool: ${name}` };
}

/** The log, the archives and the bridge are the whole conversation in plain
 * text, so everything Brain creates is readable by its owner only. */
function keepToOwner(): void {
  process.umask(0o077);
  for (const dir of [LOG_DIR, STATE_DIR, SESSION_ARCHIVE_DIR, ARCHIVE_PARK_DIR]) {
    try { if (dir && existsSync(dir)) chmodSync(dir, 0o700); } catch { /* not ours: leave it */ }
  }
  for (const file of [BRIDGE_FILE, UPLOAD_LEDGER]) {
    try { if (file && existsSync(file)) chmodSync(file, 0o600); } catch { /* not ours: leave it */ }
  }
}

async function main(): Promise<void> {
  keepToOwner();
  ensureLogDirectory();
  if (LOCK_FILE === join(STATE_DIR, "brain.pid")) {
    try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* claimLock reports the failure */ }
  }
  const preflight = checkParallel({ lockFile: LOCK_FILE, ownPid: process.pid, sterile: STERILE, parallelPattern: PARALLEL_PATTERN, allowParallel: process.env.BRAIN_ALLOW_PARALLEL === "1" });
  const guard = preflight.blocked ? preflight : claimLock(LOCK_FILE);
  if (guard.blocked) {
    console.error(`brain refuses to start: ${guard.reason}`);
    logEvent({ type: "parallel_guard_blocked", reason: guard.reason });
    // The restart loop tells the user when the refusals do not stop.
    try { writeFileSync(join(STATE_DIR, "guard_refused"), String(guard.reason ?? "")); } catch { /* the loop says it without a reason */ }
    process.exit(2);
  }
  const ignoredBacklogSettings = ["BRAIN_INBOX_BACKLOG_CAP", "BRAIN_INBOX_BACKLOG_KEEP"]
    .filter((key) => process.env[key] !== undefined);
  if (ignoredBacklogSettings.length) logEvent({ type: "app_inbox_backlog_settings_ignored",
    message: `${ignoredBacklogSettings.join(", ")} ignored; use BRAIN_INBOX_BATCH_BYTES (no message dropping)` });
  migrateReplyGateway();
  try { sweepOrphanedClaudePipeTempDirs(); } catch { /* best effort */ }
  try { readSystemPrompt(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    logEvent({ type: "identity_start_refused", file: SYSTEM_PROMPT_FILE, error: message });
    if (APP_URL && !STERILE) {
      await appBroadcast({ baseUrl: APP_URL, token: APP_TOKEN }, message, "reply").catch(() => undefined);
    }
    process.exit(2);
  }
  if (!DOCTOR_CMD) logEvent({ type: "startup_doctor_unset", detail: "BRAIN_DOCTOR_CMD is not set; no startup doctor will run" });
  approvalSettings?.();

  const memoryTools = MEMORY_URL && MEMORY_KEY ? await memoryListTools().catch((error) => {
    logEvent({ type: "memory_tool_discovery_failed", error: String(error) });
    return [] as OpenAIToolDef[];
  }) : [];
  if (!memoryTools.length) startupFallback("memory-tools", "Memory tools are unavailable", "The agent cannot look up or save long-term memories through memory tools.", "Check BRAIN_MEMORY_URL and BRAIN_MEMORY_API_KEY, then restore the memory service.");
  // The chronicle is read through the memory service's recall tool; no tool carries the chronicle's own name.
  if (!memoryTools.some((tool) => tool.function.name === "recall")) startupFallback("chronicle", "Chronicle is unavailable", "The agent cannot read the chronicle of its past sessions.", "Restore the chronicle tool in the memory service and check BRAIN_MEMORY_URL.");
  const tools = [...memoryTools, ...localToolDefs()];
  const state = makeInitialState(tools);
  const selected = loadHeadState(HEAD_FILE, process.env);
  state.head = selected.head;
  state.effort = loadEffort(EFFORT_FILE, process.env, selected.head.name);
  if (selected.head.name === "gpt" && selected.head.transport === "pipe") selected.head.effort = state.effort;
  state.headStateActive = selected.source === "state";
  logEvent({ type: "head_state_loaded", file: HEAD_FILE, source: selected.source, status: selected.status,
    head: selected.head.name, model: selected.head.model, window: selected.head.contextWindow,
    transport: selected.head.transport, error: selected.error ?? null });
  shutdownState = state;
  const head = currentHead(state);
  state.model = head.model;
  pinsRefGlobal.current = loadPinsAny(PINS_FORMAT, PINS_FILE, new Date());
  if (SHELL_ON && WORKSPACE_READ) {
    taskRegistry.load();
    syncResidentLiveView();
  }
  registerExitBridge(state);
  await startMcpClients(state, head);
  logEvent({ type: "session_started", head: head.name, transport: head.transport, model: head.model, memory: Boolean(memoryTools.length), rag: Boolean(RAG_URL && RAG_AUTH_TOKEN), app_inbox: Boolean(APP_INBOX_FILE) });
  logEvent({ type: "web_tools", search: WEB.search?.backend ?? null, search_off: WEB.searchOff, fetch: WEB.fetch, browser: WEB.browser?.script ?? null, browser_off: WEB.browserOff });
  // Ledger migration and recovery must not hold up the runtime's ready signal.
  setTimeout(() => {
    void retryPendingUploads()
      .catch((error) => logEvent({ type: "upload_retry_failed", error: String(error) }))
      .then(() => catchUpArchive())
      .catch((error) => logEvent({ type: "catch_up_failed", error: String(error) }));
  }, 0);

  if (CONTROL_TOKEN) {
    startAuthenticatedControlEndpoint({
      token: CONTROL_TOKEN, port: CONTROL_PORT,
      handle: (name, args) => handleControlTool(state, name, args),
      serve: (options) => Bun.serve(options as any),
      log: logEvent,
      tools: ["pins", "pin", "unpin", "status", "effort", "approve", "approval_settings_check", "web_search", "web_fetch"],
      heads: (refresh) => loadHeadsSnapshot(state, refresh),
    });
  }

  if (INLET_WORKER) cleanupInletSessionState();
  // A fresh cursor starts at the inbox's end, so it is taken before "ready":
  // a message written after that line can never fall behind the starting offset.
  if (APP_INBOX_FILE) {
    committedCursor = loadCursor(APP_CURSOR_FILE, APP_INBOX_FILE);
    saveCursor(APP_CURSOR_FILE, committedCursor);
    const readCursor = { current: committedCursor };
    setInterval(() => pollApp(state, readCursor), APP_POLL_MS);
    logEvent({ type: "app_inbox_listening", file: APP_INBOX_FILE, offset: committedCursor.offset });
  }
  console.log(`Worker runtime ready (head ${head.name}, ${head.transport}, ${head.model}). Type /help for commands.`);
  if (head.unavailable) console.log(`head ${head.name} unavailable: ${head.unavailable}`);
  writeContextState(state, 0);
  onPendingTasksChanged = () => {
    writeContextState(state, state.lastPromptTokens);
    writeWatchdogState(state, state.lastPromptTokens);
  };

  process.on("SIGTERM", () => { void shutdown(state, "SIGTERM"); });
  process.on("SIGINT", () => { void shutdown(state, "SIGINT"); });
  process.on("SIGHUP", () => { void shutdown(state, "SIGHUP"); });

  setInterval(() => idleTick(state), IDLE_TICK_MS);

  const firstTurn = firstTurnItem();
  if (firstTurn) {
    queue.unshift(firstTurn);
    logEvent({ type: "first_turn_queued" });
    void processQueue(state);
  }

  // A greeting after a cut or restart, after a short grace: if a person already
  // wrote, their message wakes the model and no greeting is needed.
  if (GREET_PROMPT && !firstTurn && (!GREET_FLAG_FILE || existsSync(GREET_FLAG_FILE))) {
    setTimeout(() => {
      if (shuttingDown || personSpokeSinceStart) return;
      queue.push({ kind: "internal", source: "internal", text: GREET_PROMPT, replyExpected: true, skipInlet: true });
      logEvent({ type: "greet_queued" });
      void processQueue(state);
    }, GREET_DELAY_MS);
  }

  const rl = readline.createInterface({ input, output, prompt: "> " });
  liveReadline = rl;
  const brainEcho = createBrainEcho();
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }
    if (isTerminalReply(raw)) { logEvent({ type: "terminal_reply_dropped" }); console.log(tr("(a reply from the terminal, not from you — not sent)")); rl.prompt(); return; }
    if (isBrainEcho(line)) { console.log(brainEcho()); rl.prompt(); return; }
    if (line.startsWith("/")) queue.push({ kind: "command", source: "terminal", text: line });
    else { personSpokeSinceStart = true; queue.push({ kind: "user", source: "terminal", text: line }); }
    if (busy || pipeTurnOpen(state)) console.log(`(queued — ${queue.length} waiting)`);
    void processQueue(state).then(() => { if (!shuttingDown) rl.prompt(); });
  });
  rl.on("close", () => {
    liveReadline = null;
    // stdin gone (no terminal): keep living for the app channel.
    logEvent({ type: "stdin_closed" });
  });
  rl.prompt();
}

if (import.meta.main) {
  void main();
}
