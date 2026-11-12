import { join } from "node:path";
// Builds the model menu and validates its commands.

export type BridgeDepth = { mode: "turns" | "sessions"; count: number };
export type BrainControl = { port: number; token: string; bridge: BridgeDepth };

export const BRAIN_CONTROL_DEFAULT_PORT = 3910;
export const DEFAULT_BRIDGE_TURNS = 40;
export const DEFAULT_BRIDGE_SESSIONS = 2;
export const OTHER_FAMILY = "Other";
export const NOT_SET_UP = "not set up";

// Model IDs become command arguments, so separators and assignments must not pass.
export const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(\[1m\])?$/;
const SAFE_HEAD_NAME = /^[a-z][a-z0-9_-]{0,19}$/;
const EFFORT_NAME = /^[a-z][a-z0-9_-]{0,19}$/;
const STANDARD_EFFORT = ["low", "medium", "high", "xhigh", "max"];

export function envValues(text: string, keys: readonly string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !keys.includes(m[1]!)) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    if (!found[m[1]!] && value.trim()) found[m[1]!] = value;
  }
  return found;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

// Use the control listener's credential rules so the menu never offers an unusable connection.
export function brainControlFrom(envText: string): BrainControl | null {
  const v = envValues(envText, ["BRAIN_CONTROL_PORT", "BRAIN_CONTROL_TOKEN", "BRAIN_BRIDGE_MODE", "BRAIN_BRIDGE_TURNS", "BRAIN_BRIDGE_SESSIONS"]);
  const token = v.BRAIN_CONTROL_TOKEN ?? "";
  if (!token || token.length < 16) return null;
  if (/^(REPLACE_ME|REPLACEME|CHANGE_?ME|TODO|SET_?ME|PLACEHOLDER|EXAMPLE|XXX+)$/i.test(token) || /^<.*>$/.test(token)) return null;
  const port = Number(v.BRAIN_CONTROL_PORT);
  const sessions = (v.BRAIN_BRIDGE_MODE ?? "").trim().toLowerCase() === "sessions";
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : BRAIN_CONTROL_DEFAULT_PORT,
    token,
    bridge: sessions
      ? { mode: "sessions", count: positiveInt(v.BRAIN_BRIDGE_SESSIONS, DEFAULT_BRIDGE_SESSIONS) }
      : { mode: "turns", count: positiveInt(v.BRAIN_BRIDGE_TURNS, DEFAULT_BRIDGE_TURNS) },
  };
}

export type SwitchKind = "current" | "model" | "head";

export interface MenuModel {
  id: string;
  version: string;
  note: string | null;
  more: boolean;
  current: boolean;
  kind: SwitchKind;
  effortLevels: string[];
}
export interface MenuFamily { name: string; current: boolean; models: MenuModel[] }
export interface MenuHead { name: string; label: string; available: boolean; reason: string | null; current: boolean; families: MenuFamily[] }
export interface BrainMenu {
  current: {
    head: string;
    headLabel: string;
    model: string;
    modelLabel: string;
    family: string | null;
    effort: string | null;
    effortApplied: string | null;
    effortVia: string | null;
    supportsEffort: boolean;
    effortLevels: string[];
  };
  heads: MenuHead[];
  claudeCatalog: boolean;
}

const str = (value: unknown, max = 120): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const idList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && SAFE_MODEL_ID.test(x)) : []);
const levelList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((l): l is string => typeof l === "string" && EFFORT_NAME.test(l)))] : [];

function effortOf(cur: Record<string, any>): { supportsEffort: boolean; effortLevels: string[] } {
  const levels = levelList(cur.effortLevels);
  return { supportsEffort: cur.supportsEffort === true && levels.length > 0, effortLevels: levels };
}

// Unknown heads offer no effort choice, preserving their last setting instead of guessing support.
export function targetEffortLevels(head: string, model: unknown): string[] {
  const m = model && typeof model === "object" ? (model as Record<string, unknown>) : {};
  if (m.supportsEffort === false) return [];
  const listed = levelList(m.supportedEffortLevels);
  if (listed.length) return listed;
  if (head === "claude") return [...STANDARD_EFFORT];
  if (head === "gpt") return STANDARD_EFFORT.filter((l) => l !== "max");
  return [];
}

export function shapeBrainHeads(raw: unknown, labels: { otherFamily?: string; notSetUp?: string } = {}): BrainMenu | null {
  if (!raw || typeof raw !== "object") return null;
  // Project only menu fields so optional catalog metadata does not tie the app to a Brain version.
  const r = raw as Record<string, any>;
  const cur = r.current && typeof r.current === "object" ? r.current : null;
  const curHead = str(cur?.head, 20);
  const curModel = str(cur?.model, 80);
  if (!curHead || !curModel || !Array.isArray(r.heads)) return null;
  const otherFamily = labels.otherFamily ?? OTHER_FAMILY;

  const heads: MenuHead[] = [];
  for (const h of r.heads) {
    const name = str(h?.name, 20);
    if (!name || !SAFE_HEAD_NAME.test(name) || heads.some((x) => x.name === name)) continue;
    const isCurrentHead = name === curHead;
    const families: MenuFamily[] = [];
    const seen = new Set<string>();
    const models: Array<MenuModel & { family: string }> = [];
    for (const m of Array.isArray(h?.models) ? h.models : []) {
      const id = str(m?.id, 90);
      if (!id || !SAFE_MODEL_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      const label = str(m?.label) ?? id;
      const version = str(m?.version) ?? label;
      const family = str(m?.family, 40) ?? otherFamily;
      const note = label !== version && label.toLowerCase() !== family.toLowerCase() ? label : null;
      const current = isCurrentHead && (id === curModel || m?.resolvedModel === curModel || idList(m?.aliases).includes(curModel));
      const kind: SwitchKind = current ? "current" : isCurrentHead ? "model" : "head";
      models.push({
        id, version, note, family, more: m?.group === "more", current, kind,
        effortLevels: kind === "head" ? targetEffortLevels(name, m) : [],
      });
    }
    for (const m of [...models.filter((x) => !x.more), ...models.filter((x) => x.more)]) {
      let fam = families.find((f) => f.name === m.family);
      if (!fam) { fam = { name: m.family, current: false, models: [] }; families.push(fam); }
      const { family: _family, ...model } = m;
      fam.models.push(model);
      if (model.current) fam.current = true;
    }
    heads.push({
      name,
      label: str(h?.label, 40) ?? name,
      available: h?.available === true,
      reason: h?.available === true ? null : (str(h?.reason, 200) ?? labels.notSetUp ?? NOT_SET_UP),
      current: isCurrentHead,
      families,
    });
  }

  const head = heads.find((h) => h.current);
  let modelLabel = curModel;
  let family: string | null = null;
  for (const f of head?.families ?? []) {
    const hit = f.models.find((m) => m.current);
    if (hit) { modelLabel = hit.version; family = f.name; }
  }
  return {
    current: {
      head: curHead,
      headLabel: head?.label ?? curHead,
      model: curModel,
      modelLabel,
      family,
      effort: str(cur.effort, 20),
      effortApplied: str(cur.effortApplied, 20),
      effortVia: str(cur.effortVia, 20),
      ...effortOf(cur),
    },
    heads,
    claudeCatalog: r.claudeCatalog === true,
  };
}

export type BrainSwitch = { head: string; model: string; move: boolean; cmd: string };

// A move chooses effort for the target head; a live model change keeps the running level.
export function brainSwitchCommand(head: unknown, model: unknown, move: unknown = false, effort: unknown = undefined): BrainSwitch | null {
  if (typeof head !== "string" || typeof model !== "string") return null;
  const h = head.trim().toLowerCase();
  const m = model.trim();
  if (!SAFE_HEAD_NAME.test(h) || !SAFE_MODEL_ID.test(m)) return null;
  const fullMove = move === true;
  const e = typeof effort === "string" ? effort.trim() : effort == null ? "" : null;
  if (e === null || (e && (!fullMove || !EFFORT_NAME.test(e)))) return null;
  return { head: h, model: m, move: fullMove, cmd: fullMove ? `/move ${h} ${m}${e ? ` effort=${e}` : ""}` : `/head ${h} ${m}` };
}

export function brainEffortCommand(level: unknown): string | null {
  if (typeof level !== "string") return null;
  const l = level.trim();
  return EFFORT_NAME.test(l) ? `/effort ${l}` : null;
}

export const BRAIN_RESTART_COMMAND = "/respawn";

export type BrainMenuCommand = { action: "switch" | "effort" | "restart"; cmd: string; move?: boolean };

export function brainMenuCommand(body: unknown): BrainMenuCommand | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.action === "switch") {
    const sw = brainSwitchCommand(b.head, b.model, b.move, b.effort);
    return sw ? { action: "switch", cmd: sw.cmd, move: sw.move } : null;
  }
  if (b.action === "effort") {
    const cmd = brainEffortCommand(b.level);
    return cmd ? { action: "effort", cmd } : null;
  }
  if (b.action === "restart") return { action: "restart", cmd: BRAIN_RESTART_COMMAND };
  return null;
}

export function brainHeadsError(status: number): "notReady" | "refused" | "status" {
  if (status === 404) return "notReady";
  if (status === 401) return "refused";
  return "status";
}

// Prefer the configured installation root because the app may run from a nested checkout.
export function brainDirFor(appDir: string, home: string | undefined, exists: (path: string) => boolean): string {
  const beside = join(appDir, "..", "..", "Brain");
  const own = home?.trim() ? join(home.trim(), "Brain") : "";
  if (own && (exists(join(own, "brain.env")) || exists(join(own, ".env")) || !exists(beside))) return own;
  return beside;
}
