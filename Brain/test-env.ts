// test-env.ts — bunfig [test].preload. Runs once before any test file imports
// brain.ts. Purpose: a test run must never touch a live home.
//   - no brain.env / .env is loaded (BRAIN_NO_ENV_FILE=1)
//   - logs, state, pins and bridge go to a throw-away directory
//   - no model endpoint, no memory, no RAG, no app inbox, no control port
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const root = mkdtempSync("/tmp/brain-suite-");
// Do not let fallback config discovery see the resident's login/home either.
process.env.HOME = root;
for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[name] = join(root, name);
process.env.TMPDIR = "/tmp";
// A shell inside a running agent (its pipe, a subagent) inherits the whole
// live BRAIN_* environment: house paths for the watchdog state, the upload
// ledger and the lock. None of it may reach a test. Runtime paths and
// endpoints, adapter service knobs, provider credentials and CLI login/config
// must never be inherited. Tests opt back in only with their own fixtures,
// after this preload.
const HOUSE_PREFIXES = ["BRAIN_", "ADAPTER_", "EMBERVY_", "ANTHROPIC_", "OPENAI_", "CLAUDE_"];
for (const key of Object.keys(process.env)) {
  if (HOUSE_PREFIXES.some((prefix) => key.startsWith(prefix))) delete process.env[key];
}
for (const key of ["EMBERVY_HOME", "INTERNAL_API_TOKEN", "OPENROUTER_API_KEY", "XAI_API_KEY", "KIMI_CODE_KEY", "GLM_CODE_KEY", "ZAI_MCP_KEY", "GPT_ADAPTER_PORT", "CLAUDE_CODE_EFFORT_LEVEL", "CHATGPT_AUTH_FILE", "CODEX_HOME", "CLAUDECODE"]) {
  delete process.env[key];
}
process.env.BRAIN_NO_ENV_FILE = "1";
// The suite's fixtures use the product app server name and a fixed clock place.
// The product defaults (app, the zone's own city) are tested explicitly.
process.env.BRAIN_APP_MCP_SERVER = "app";
process.env.BRAIN_CLOCK_PLACE = "Berlin";
// The product texts are English.
process.env.BRAIN_LANG = "en";
// No house language file leaks in; local-strings.test.ts writes its own.
process.env.BRAIN_STRINGS_FILE = join(root, "state", "no-strings.local.json");
// No browser module in the suite: web_fetch render is tested with a fake CLI.
process.env.BRAIN_WEB_BROWSER = "off";
process.env.BRAIN_STERILE = "1";
process.env.BRAIN_LOG_DIR = join(root, "logs");
process.env.BRAIN_STATE_DIR = join(root, "state");
process.env.BRAIN_PINS_FILE = join(root, "state", "pins.json");
process.env.BRAIN_BRIDGE_FILE = join(root, "state", "bridge.md");
process.env.BRAIN_SESSION_ARCHIVE_DIR = join(root, "sessions");
for (const key of [
  "BRAIN_ENDPOINT", "BRAIN_API_KEY", "BRAIN_MEMORY_URL", "BRAIN_MEMORY_API_KEY",
  "BRAIN_RAG_URL", "BRAIN_RAG_AUTH_TOKEN", "BRAIN_APP_INBOX_FILE", "BRAIN_APP_URL",
  "BRAIN_APP_TOKEN", "BRAIN_CONTROL_TOKEN", "BRAIN_BROWSER_COMMAND",
  "BRAIN_WEB_SEARCH_API_KEY", "BRAIN_WEB_SEARCH_ENDPOINT", "BRAIN_WEB_SEARCH_BACKEND", "BRAIN_HEAD",
]) {
  delete process.env[key];
}
process.env.BRAIN_PIPE_SESSION_DENYLIST = join(root, "state", "brain-pipe-sessions.txt");
