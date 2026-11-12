#!/usr/bin/env bun
/** brain-doctor.ts — read-only configuration preflight, no model calls or service starts. */
import { accessSync, constants, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { gptAdapterPort, validAdapterCacheKey } from "../heads";
import { loadHeadState } from "../move";
import { webConfigFromEnv, webToolPlan } from "../web-tools";
import { tr } from "../texts";
import { readPendingUploads } from "../pending-uploads";

type Env = Record<string, string | undefined>;
export interface DoctorCheck { name: string; ok: boolean; detail: string }
export interface DoctorResult { ok: boolean; checks: DoctorCheck[] }
const ROOT = resolve(import.meta.dir, "..");

/** Injectable bus probe for tests. Configuration and credential contents are never printed. */
export function doctor(env: Env, busProbe: (env: Env) => boolean = systemBusAvailable): DoctorResult {
  const checks: DoctorCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail: tr(detail) });
  const stateDir = env.BRAIN_STATE_DIR ?? join(ROOT, "state");
  const selected = loadHeadState(env.BRAIN_HEAD_FILE || join(stateDir, "brain-head.json"), env);
  const head = selected.head;
  check("head", !head.unavailable, head.unavailable || `${head.name} / ${head.model} / ${head.transport} (${selected.source})`);
  if (selected.error) check("head-state", true, "Warning: saved head selection invalid; environment fallback active");
  if (head.name === "gpt") {
    check("gpt-cache-key", validAdapterCacheKey(env.BRAIN_GPT_CACHE_KEY), "BRAIN_GPT_CACHE_KEY: ASCII A-Z a-z 0-9 . _ -, 1–128 characters (value not shown)");
    try { check("gpt-port", true, gptAdapterPort(env)); }
    catch { check("gpt-port", false, "GPT_ADAPTER_PORT / BRAIN_GPT_ADAPTER_PORT: expected 1–65535"); }
    const home = env.HOME || homedir();
    const cwd = resolve(env.BRAIN_HOME || ROOT);
    const expand = (path: string) => path.startsWith("~/") ? join(home, path.slice(2)) : path;
    const auth = resolve(cwd, expand(env.CHATGPT_AUTH_FILE?.trim() || join(home, ".codex", "auth.json")));
    check("gpt-auth", readableFile(auth), "ChatGPT auth file must be a readable regular file (contents not checked)");
    const script = env.BRAIN_GPT_ADAPTER?.trim();
    check("gpt-adapter", Boolean(script && readableFile(resolve(cwd, expand(script)))), "BRAIN_GPT_ADAPTER must point to a readable adapter script");
  }
  let ragUrl = false;
  try { ragUrl = /^https?:$/.test(new URL(env.BRAIN_RAG_URL || "").protocol); } catch { /* absent/invalid */ }
  check("rag", ragUrl && Boolean(env.BRAIN_RAG_AUTH_TOKEN?.trim()), "BRAIN_RAG_URL (http/s) and BRAIN_RAG_AUTH_TOKEN required; no network check");
  // Sessions archived locally whose upload failed: a warning,
  // not a failure, because Brain retries them at every start by itself.
  // A cut with a restart leaves its upload to the next start on purpose, so
  // such a session is still on its way for its first ten minutes.
  const owed = readPendingUploads(join(stateDir, "pending_uploads.jsonl"));
  const stuck = owed.filter((p) => !(p.deferred && Date.now() - Date.parse(p.since) < 10 * 60_000));
  check("rag-uploads", true, stuck.length
    ? tr`Warning: ${stuck.length} session(s) wait for the RAG upload, oldest since ${stuck[0].since.slice(0, 16).replace("T", " ")}: ${stuck.map((p) => p.name).slice(0, 5).join(", ")}. Brain retries at every start; if it stays, check BRAIN_RAG_URL and BRAIN_RAG_AUTH_TOKEN`
    : owed.length
      ? tr`${owed.length} session(s) on their way to the RAG since the last cut: ${owed.map((p) => p.name).slice(0, 5).join(", ")}`
      : "no RAG uploads owed");
  check("inbox", writableInbox(env.BRAIN_APP_INBOX_FILE), "BRAIN_APP_INBOX_FILE: writable file or existing writable parent directory; creates nothing");
  let bus = false;
  try { bus = busProbe(env); } catch { /* missing executable/system bus */ }
  check("system-bus", bus, "systemctl --system show --property=Version");
  const web = webConfigFromEnv(env, ROOT);
  const plan = webToolPlan(head, web, Boolean(env.BRAIN_CONTROL_TOKEN));
  const search = plan.via === "native" || plan.tools.includes("web_search");
  check("web-backend", true, search ? plan.note : tr`Warning: no usable search backend for this head — ${plan.note}`);
  return { ok: checks.every((c) => c.ok), checks };
}

function readableFile(path: string): boolean {
  try { if (!statSync(path).isFile()) return false; accessSync(path, constants.R_OK); return true; }
  catch { return false; }
}

function writableInbox(path: string | undefined): boolean {
  if (!path?.trim()) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      if (!statSync(dirname(path)).isDirectory()) return false;
      accessSync(dirname(path), constants.W_OK | constants.X_OK);
      return true;
    } catch { return false; }
  }
}

function systemBusAvailable(env: Env): boolean {
  const result = spawnSync("systemctl", ["--system", "show", "--property=Version"], {
    env, encoding: "utf8", timeout: 5000,
  });
  return !result.error && result.status === 0 && /^Version=\S+/m.test(result.stdout || "");
}

if (import.meta.main) {
  try {
    const { headEnvironment } = await import("../brain");
    const result = doctor(headEnvironment());
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ ok: false, checks: [{ name: "configuration", ok: false, detail: tr("Could not load/check configuration") }] }));
    process.exitCode = 1;
  }
}
