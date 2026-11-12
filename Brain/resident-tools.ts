// Provides workspace search, shell execution and background tasks.
// The shell is not sandboxed; the caller must obtain approval before dispatch.

import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  buildCompletionMessage, loadResidentTasks, markDelivered, readExitCode, reconcileOnBoot, saveResidentTasks, watcherTick,
  type ResidentTaskEntry,
} from "./resident-tasks";
import { repoMap } from "./repo-map";

export interface ResidentToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ResidentConfig {
  root: string | null;
  shell: boolean;
  env: Record<string, string>;
  tasksDir: string;
  bashTimeoutMs?: number;
  bashMaxTimeoutMs?: number;
}

export const RESIDENT_TOOL_NAMES = new Set(["grep", "glob", "repo_map", "bash", "task_start", "task_status", "task_output"]);

const BASH_OUTPUT_CAP = 60_000;
const GREP_OUTPUT_CAP = 40_000;
const GREP_TIMEOUT_MS = 60_000;
const TASK_OUTPUT_MAX = 60_000;
const GLOB_MAX_RESULTS = 500;
const GLOB_MAX_SCAN = 2000;


const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|AUTH)/i;

// Restrict inheritance to prevent credential leaks and runtime injection, not filesystem access.
export function shellEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!/^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|TMPDIR|TMP|TEMP)$/.test(key) || SECRET_NAME.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function truncateHeadTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[... ${text.length - max} characters cut ...]\n\n${text.slice(-half)}`;
}

function realpathOr(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + "/");
}

// New files inherit their parent's symlink target; dangling links cannot be checked safely.
function realOrNearest(path: string): string | null {
  const rest: string[] = [];
  let cur = path;
  for (;;) {
    let exists = false;
    try { lstatSync(cur); exists = true; } catch { /* not there yet */ }
    if (exists) {
      try { return join(realpathSync(cur), ...rest); } catch { return null; }
    }
    const parent = dirname(cur);
    if (parent === cur) return join(cur, ...rest);
    rest.unshift(basename(cur));
    cur = parent;
  }
}


export function jailResolve(root: string, path: unknown): string | null {
  const realRoot = realpathOr(root);
  const raw = String(path ?? "").trim() || ".";
  const full = resolve(realRoot, raw);
  if (!inside(realRoot, full)) return null;
  const real = realOrNearest(full);
  return real !== null && inside(realRoot, real) ? real : null;
}

// Unbounded command output must not exhaust this process's memory.
class CappedText {
  private head = "";
  private tail = "";
  private total = 0;
  private readonly half: number;
  constructor(cap: number) { this.half = Math.max(1, Math.floor(cap / 2)); }
  push(chunk: string): void {
    this.total += chunk.length;
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (chunk) this.tail = (this.tail + chunk).slice(-this.half);
  }
  text(): string {
    const dropped = this.total - this.head.length - this.tail.length;
    return dropped > 0 ? `${this.head}\n\n[... ${dropped} characters cut ...]\n\n${this.tail}` : this.head + this.tail;
  }
}

async function pump(stream: ReadableStream<Uint8Array> | null | undefined, sink: CappedText): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sink.push(decoder.decode(value, { stream: true }));
    }
  } catch { /* stream torn down by a kill */ }
}

function killGroup(pid: number, group: boolean): void {
  if (group) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone or not a leader */ } }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

export interface RunResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }

// A separate process group lets timeouts kill descendants as well as the command.
export async function runCapped(argv: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; cap: number; group?: boolean }): Promise<RunResult> {
  const useGroup = Boolean(opts.group) && Bun.which("setsid") !== null;
  const full = useGroup ? ["setsid", "-w", ...argv] : argv;
  const proc = Bun.spawn(full, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = new CappedText(opts.cap);
  const err = new CappedText(opts.cap);
  const pumps = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, out), pump(proc.stderr as ReadableStream<Uint8Array>, err)]);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killGroup(proc.pid, useGroup); }, opts.timeoutMs);
  await proc.exited;
  clearTimeout(timer);
  // A background child can keep pipes open after the command exits.
  const grace = setTimeout(() => killGroup(proc.pid, useGroup), 1000);
  await Promise.race([pumps, Bun.sleep(2500)]);
  clearTimeout(grace);
  return { stdout: out.text(), stderr: err.text(), exitCode: timedOut ? null : proc.exitCode, timedOut };
}

export class TaskRegistry {
  tasks: ResidentTaskEntry[] = [];
  constructor(
    private readonly file: string,
    private readonly announce: (task: ResidentTaskEntry, opts: { duringRestart?: boolean }) => boolean,
  ) {}

  persist(): void {
    try { saveResidentTasks(this.file, this.tasks); } catch { /* best effort */ }
  }

  private deliver(list: ResidentTaskEntry[], duringRestart: boolean): void {
    for (const task of list) {
      if (this.announce(task, { duringRestart })) this.tasks = markDelivered(this.tasks, task.id);
    }
  }

  // An unknown exit code is also null; filtering by it would repeatedly announce finished tasks.
  private static open(task: ResidentTaskEntry): boolean {
    return task.endedAt === null || !task.delivered;
  }

  private merge(updated: ResidentTaskEntry[]): void {
    const byId = new Map(updated.map((task) => [task.id, task]));
    this.tasks = this.tasks.map((task) => byId.get(task.id) ?? task);
  }

  load(now = Date.now()): void {
    this.tasks = loadResidentTasks(this.file);
    const result = reconcileOnBoot(this.tasks.filter(TaskRegistry.open), now);
    this.merge(result.tasks);
    this.tasks = this.tasks.filter((task) => task.endedAt === null || !task.delivered || now - task.endedAt < 7 * 86_400_000);
    this.deliver(result.toAnnounce, true);
    this.persist();
  }

  tick(now = Date.now()): void {
    const open = this.tasks.filter(TaskRegistry.open);
    if (!open.length) return;
    const result = watcherTick(open, now);
    this.merge(result.tasks);
    if (!result.toAnnounce.length) return;
    this.deliver(result.toAnnounce, false);
    this.persist();
  }

  start(command: string, label: string, cwd: string, env: Record<string, string>, tasksDir: string): ResidentTaskEntry {
    mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const outFile = join(tasksDir, `${id}.log`);
    const rcFile = join(tasksDir, `${id}.rc`);
    // Positional arguments prevent paths from injecting shell syntax into the wrapper.
    const wrapper = 'bash -c "$0" >> "$1" 2>&1; rc=$?; echo "$rc" > "$2"; exit "$rc"';
    const argv = Bun.which("setsid") !== null ? ["setsid", "bash", "-c", wrapper, command, outFile, rcFile] : ["bash", "-c", wrapper, command, outFile, rcFile];
    const proc = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    proc.unref();
    const task: ResidentTaskEntry = {
      id, label, command, cwd, pid: proc.pid, outFile, rcFile,
      startedAt: Date.now(), exit: null, endedAt: null, delivered: false,
    };
    this.tasks = [...this.tasks, task];
    this.persist();
    void proc.exited.then((code) => {
      const current = this.tasks.find((t) => t.id === id);
      if (!current || current.endedAt !== null) return; // the watcher was faster
      const exit = readExitCode(rcFile) ?? (typeof code === "number" ? code : null);
      const done: ResidentTaskEntry = { ...current, exit, endedAt: Date.now() };
      this.tasks = this.tasks.map((t) => (t.id === id ? done : t));
      this.deliver([done], false);
      this.persist();
    });
    return task;
  }
}


export function residentToolDefs(config: ResidentConfig): ResidentToolDef[] {
  if (!config.root) return [];
  const defs: ResidentToolDef[] = [
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents inside the workspace (extended regex). Returns matching lines as path:line:text, capped.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regular expression (extended syntax)." },
            path: { type: "string", description: "File or directory relative to the workspace root (default: the root)." },
            glob: { type: "string", description: "Only files matching this glob, e.g. *.ts (optional)." },
            ignore_case: { type: "boolean", description: "Case-insensitive search (optional)." },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find files inside the workspace by glob pattern, newest first (at most 500).",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern, e.g. **/*.test.ts" },
            path: { type: "string", description: "Directory relative to the workspace root (default: the root)." },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "repo_map",
        description: "Map workspace source files and key declarations with line numbers, ranked by cross-file usage and optional focus terms.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory relative to the workspace root (default: the root)." },
            focus: { type: "string", description: "Keywords or file names to prioritize (optional)." },
            budget: { type: "number", minimum: 0, maximum: 20000, description: "Approximate token budget, at 4 characters per token (default 1500, max 20000)." },
          },
        },
      },
    },
  ];
  if (!config.shell) return defs;
  defs.push(
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a bash command. The working directory must lie inside the workspace (default: its root). Returns stdout, stderr and the exit code; long output is cut in the middle. Secrets are not in the environment.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command line." },
            cwd: { type: "string", description: "Working directory relative to the workspace root (optional)." },
            timeout_ms: { type: "number", description: "Timeout in ms (default 120000, max 600000)." },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "task_start",
        description: "Start a bash command as a background task and keep talking. Returns a task id at once. Output goes to a log; when the task ends, a notice arrives as its own turn. Tasks survive a respawn of this process.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command line to run in the background." },
            label: { type: "string", description: "Short label for the task list." },
            cwd: { type: "string", description: "Working directory relative to the workspace root (optional)." },
          },
          required: ["command", "label"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "task_status",
        description: "List background tasks (id, label, running or exit code, runtime).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "task_output",
        description: "Read the end of a background task's output.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Task id from task_start." },
            tail_chars: { type: "number", description: "Characters from the end (default 8000, max 60000)." },
          },
          required: ["id"],
        },
      },
    },
  );
  return defs;
}


function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export async function dispatchResidentTool(name: string, args: Record<string, any>, config: ResidentConfig, tasks: TaskRegistry | null): Promise<string | null> {
  if (!RESIDENT_TOOL_NAMES.has(name)) return null;
  if (!config.root) return "error: resident tools need a workspace (BRAIN_WORKSPACE_READ)";
  const root = realpathOr(config.root);
  const rel = (path: string) => relative(root, path) || ".";

  if (name === "grep") {
    const pattern = String(args?.pattern ?? "");
    if (!pattern) return "error: pattern is required";
    const target = jailResolve(root, args?.path);
    if (!target) return "error: path is outside the workspace jail";
    if (!existsSync(target)) return `error: not found: ${String(args?.path ?? ".")}`;
    const ignoreCase = args?.ignore_case === true;
    const glob = args?.glob === undefined || args.glob === "" ? null : String(args.glob);
    // -e keeps a pattern that starts with "-" from being read as an option,
    // preventing patterns such as --pre=<cmd> from executing commands.
    const argv = Bun.which("rg") !== null
      ? ["rg", "-n", "--no-heading", "--max-columns", "400", "-m", "500", ...(ignoreCase ? ["-i"] : []), ...(glob ? ["-g", glob] : []), "-e", pattern, "--", rel(target)]
      : ["grep", "-rnE", "-m", "500", "--binary-files=without-match", "--exclude-dir=node_modules", "--exclude-dir=.git",
         ...(ignoreCase ? ["-i"] : []), ...(glob ? [`--include=${glob}`] : []), "-e", pattern, "--", rel(target)];
    let result: RunResult;
    try {
      result = await runCapped(argv, { cwd: root, env: config.env, timeoutMs: GREP_TIMEOUT_MS, cap: GREP_OUTPUT_CAP });
    } catch (error) {
      return `error: grep failed: ${String(error)}`;
    }
    if (result.timedOut) return `error: grep timed out after ${GREP_TIMEOUT_MS / 1000} s${result.stdout ? `\n${result.stdout}` : ""}`;
    if (result.exitCode === 1 && !result.stdout.trim()) return "no matches";
    if (result.exitCode !== 0 && result.exitCode !== 1) return `error: grep: ${result.stderr.slice(0, 500)}`;
    return result.stdout;
  }

  if (name === "glob") {
    const pattern = String(args?.pattern ?? "").trim();
    if (!pattern) return "error: pattern is required";
    if (pattern.startsWith("/") || pattern.split("/").includes("..")) return "error: the pattern must stay inside the workspace (no absolute paths, no ..)";
    const base = jailResolve(root, args?.path);
    if (!base) return "error: path is outside the workspace jail";
    if (!isDirectory(base)) return `error: not a directory: ${String(args?.path ?? ".")}`;
    const matches: Array<{ path: string; mtime: number }> = [];
    try {
      for (const found of new Bun.Glob(pattern).scanSync({ cwd: base, dot: false, followSymlinks: false })) {
        const full = join(base, found);
        if (!inside(root, resolve(full))) continue;
        let mtime = 0;
        try { mtime = statSync(full).mtimeMs; } catch { mtime = 0; }
        matches.push({ path: rel(full), mtime });
        if (matches.length >= GLOB_MAX_SCAN) break;
      }
    } catch (error) {
      return `error: glob failed: ${String(error)}`;
    }
    if (!matches.length) return "no matches";
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches.slice(0, GLOB_MAX_RESULTS).map((m) => m.path).join("\n");
  }

  if (name === "repo_map") {
    const target = jailResolve(root, args?.path);
    if (!target) return "error: path is outside the workspace jail";
    if (!isDirectory(target)) return `error: not a directory: ${String(args?.path ?? ".")}`;
    if (args?.focus !== undefined && typeof args.focus !== "string") return "error: focus must be a string";
    if (args?.budget !== undefined && (typeof args.budget !== "number" || !Number.isFinite(args.budget) || args.budget < 0 || args.budget > 20000)) return "error: budget must be a finite number between 0 and 20000";
    try {
      return repoMap(target, { focus: args?.focus, budget: args?.budget });
    } catch (error) {
      return `error: repo_map failed: ${String(error)}`;
    }
  }

  if (!config.shell) return `error: ${name} is off (BRAIN_SHELL)`;

  if (name === "bash") {
    const command = String(args?.command ?? "");
    if (!command.trim()) return "error: command is required";
    const cwd = jailResolve(root, args?.cwd);
    if (!cwd) return "error: cwd is outside the workspace jail";
    if (!isDirectory(cwd)) return `error: not a directory: ${String(args?.cwd)}`;
    const fallback = config.bashTimeoutMs ?? 120_000;
    const max = config.bashMaxTimeoutMs ?? 600_000;
    const timeoutMs = Math.max(1000, Math.min(Number(args?.timeout_ms) || fallback, max));
    let result: RunResult;
    try {
      result = await runCapped(["bash", "-c", command], { cwd, env: config.env, timeoutMs, cap: BASH_OUTPUT_CAP, group: true });
    } catch (error) {
      return `error: bash failed to start: ${String(error)}`;
    }
    const body = [result.stdout, result.stderr].filter(Boolean).join("\n--- stderr ---\n");
    const exit = result.timedOut ? `timeout after ${timeoutMs} ms, killed` : String(result.exitCode);
    return `${truncateHeadTail(body, BASH_OUTPUT_CAP) || "(no output)"}\n(exit ${exit})`;
  }

  if (!tasks) return `error: ${name}: task registry unavailable`;

  if (name === "task_start") {
    const command = String(args?.command ?? "").trim();
    if (!command) return "error: command is required";
    const cwd = jailResolve(root, args?.cwd);
    if (!cwd) return "error: cwd is outside the workspace jail";
    if (!isDirectory(cwd)) return `error: not a directory: ${String(args?.cwd)}`;
    const label = String(args?.label ?? "task").trim() || "task";
    const task = tasks.start(command, label, cwd, config.env, config.tasksDir);
    return `task ${task.id} ("${task.label}") is running. task_status lists it, task_output(${task.id}) reads it; a notice arrives when it ends.`;
  }

  if (name === "task_status") {
    if (!tasks.tasks.length) return "no tasks";
    return tasks.tasks.map((t) => {
      const seconds = Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000);
      const status = t.endedAt === null ? "running" : t.exit === null ? "ended, exit unknown" : `exit ${t.exit}`;
      return `${t.id} "${t.label}" — ${status}, ${seconds}s`;
    }).join("\n");
  }

  if (name === "task_output") {
    const id = String(args?.id ?? "");
    const task = tasks.tasks.find((t) => t.id === id);
    if (!task) return `error: unknown task id: ${id}`;
    const tail = Math.max(1, Math.min(Number(args?.tail_chars) || 8000, TASK_OUTPUT_MAX));
    const status = task.endedAt === null ? "running" : task.exit === null ? "ended, exit unknown" : `exit ${task.exit}`;
    let body = "";
    try { body = await Bun.file(task.outFile).text(); } catch { return `${task.id}: no output yet (${status})`; }
    const cut = body.length > tail ? `[... ${body.length - tail} characters before ...]\n${body.slice(-tail)}` : body;
    return `[${task.id} "${task.label}" — ${status}]\n${cut}`;
  }

  return null;
}

export { buildCompletionMessage };
