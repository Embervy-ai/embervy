// Hot tools — dynamic tool registration in the resident profile.
// Reloading makes newly built tools available. Every file in
// brain-tools/*.ts exports { definition, handler }; reload_tools re-imports
// the directory via dynamic import with a cache bust. A load error becomes a
// named message and the broken file is skipped — never a crash of the resident.
//
// Safety: the caller (brain.ts) gates on BRAIN_RESIDENT; this module also
// checks the name format and collisions with reserved (built-in) tool
// names — a hot tool can never shadow a built-in.

import { tr } from "./texts";
import { readdirSync } from "fs";
import { join, resolve } from "path";

export interface HotToolDef {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface HotTool {
  name: string;
  def: HotToolDef;
  handler: (args: unknown) => string | Promise<string>;
  file: string;
}

export interface HotToolLoadResult {
  tools: HotTool[];
  errors: Array<{ file: string; error: string }>;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Loads all *.ts (except *.test.ts) from `dir` fresh (cache bust via query).
 * Reserved names (built-ins, memory, app) are refused; duplicates in the
 * directory: the alphabetically first file wins, the second is reported as
 * an error. */
export async function loadHotTools(
  dir: string,
  reservedNames: Set<string>,
): Promise<HotToolLoadResult> {
  const tools: HotTool[] = [];
  const errors: HotToolLoadResult["errors"] = [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .sort();
  } catch {
    // No directory = no hot tools. Not an error — the shelf may be empty
    // or absent.
    return { tools, errors };
  }
  const seen = new Set<string>();
  for (const file of files) {
    const full = resolve(join(dir, file));
    try {
      const mod = await import(`${full}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const def = mod.definition as HotToolDef | undefined;
      const handler = mod.handler as HotTool["handler"] | undefined;
      const name = def?.function?.name;
      if (def?.type !== "function" || typeof name !== "string") {
        errors.push({ file, error: "missing export: definition {type:'function', function:{name}}" });
        continue;
      }
      if (!NAME_RE.test(name)) {
        errors.push({ file, error: `invalid tool name '${name}' (want ${NAME_RE})` });
        continue;
      }
      if (typeof handler !== "function") {
        errors.push({ file, error: "missing export: handler(args)" });
        continue;
      }
      if (reservedNames.has(name)) {
        errors.push({ file, error: `name '${name}' collides with a built-in tool — refused` });
        continue;
      }
      if (seen.has(name)) {
        errors.push({ file, error: `duplicate tool name '${name}' — earlier file wins` });
        continue;
      }
      seen.add(name);
      tools.push({ name, def, handler, file });
    } catch (e: any) {
      errors.push({ file, error: String(e?.message ?? e) });
    }
  }
  return { tools, errors };
}

/** Human-readable summary of a reload — returned to the resident as the
 * tool result. */
export function summarizeHotToolLoad(result: HotToolLoadResult): string {
  const lines: string[] = [];
  lines.push(`hot tools loaded: ${result.tools.length}${result.tools.length ? ` (${result.tools.map((t) => t.name).join(", ")})` : ""}`);
  for (const err of result.errors) lines.push(`skipped ${err.file}: ${err.error}`);
  if (result.tools.length) lines.push(tr("New/changed tools appear in the tool list from the next turn."));
  return lines.join("\n");
}
