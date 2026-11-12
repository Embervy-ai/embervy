/**
 * Share configuration, paths and tool names across runtime consumers.
 * No imports: Cloudflare workers bundle this file too.
 */
export const ENV_PREFIX = "EMBERVY_";

// Preserve the exported interface for consumers without adding configuration names.
export const LEGACY_ENV_PREFIX = ENV_PREFIX;
export function legacyEnvName(_name: string): string | undefined {
  return undefined;
}
export function currentEnvName(_name: string): string | undefined {
  return undefined;
}

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (typeof process !== "undefined" ? process.env : {});

/** Read exact keys so explicitly empty settings remain meaningful. */
export function envValue(name: string, env: Env = processEnv()): string | undefined {
  return env[name];
}

export const LEGACY_BRAIN_ENV_KEYS: Readonly<Record<string, string>> = {};
export function adoptLegacyEnv(_env: Env): void {}

export const HOME_DIR = "/opt/embervy";
export const LEGACY_HOME_DIR = HOME_DIR;

export function houseHome(env: Env = processEnv(), _exists: (path: string) => boolean = () => false): string {
  return envValue("EMBERVY_HOME", env) || HOME_DIR;
}

/** Hooks stand aside for turns Brain runs through the CLI itself. */
export const SUBTURN_ENV = "EMBERVY_BRAIN_SUBTURN";
export const LEGACY_SUBTURN_ENV = SUBTURN_ENV;
export function isBrainSubturn(env: Env = processEnv()): boolean {
  return env[SUBTURN_ENV] === "1";
}

/** Lore is distinct from the CLI's own memory. */
export const APP_MCP_SERVER = "app";
export const MEMORY_MCP_SERVER = "lore";
export const LEGACY_APP_MCP_SERVERS = [] as const;
export const LEGACY_MEMORY_MCP_SERVERS = ["memory"] as const;

/** Recognize stored Lore tool calls as well as the configured server name. */
export function loreToolNames(tool: string): string[] {
  return [MEMORY_MCP_SERVER, ...LEGACY_MEMORY_MCP_SERVERS].map((server) => `mcp__${server}__${tool}`);
}

export function appToolNames(tool: string): string[] {
  return [`mcp__${APP_MCP_SERVER}__${tool}`];
}

export const MEMORY_IMAGE_PATH = "/api/memory-image";
export const MEMORY_VIDEO_PATH = "/api/memory-video";
export const LEGACY_MEMORY_IMAGE_PATH = MEMORY_IMAGE_PATH;
export const LEGACY_MEMORY_VIDEO_PATH = MEMORY_VIDEO_PATH;

export const SESSION_COOKIE = "embervy_session";
export const LEGACY_SESSION_COOKIE = SESSION_COOKIE;

export const MEMORY_REF_PREFIX = "memory:";
export const LEGACY_MEMORY_REF_PREFIX = MEMORY_REF_PREFIX;
export const MEMORY_REF_RE = /^memory:\d{1,9}$/;

export const VAR_DIR = "/var/lib/embervy";
export const LEGACY_VAR_DIR = VAR_DIR;
export function reserveFile(_exists: (path: string) => boolean = () => false): string {
  return `${VAR_DIR}/reserve.img`;
}
