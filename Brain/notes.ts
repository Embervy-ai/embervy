import { isAbsolute } from "node:path";

type Env = Record<string, string | undefined>;

/** A relative path counts as unset rather than throwing, since a throw here would fail every birth. */
export function notesDirectory(env: Env): string | null {
  const dir = env.BRAIN_NOTES_DIR?.trim();
  return dir && isAbsolute(dir) ? dir : null;
}

export function notesMaxBytes(env: Env): number {
  const n = Number(env.BRAIN_NOTES_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : 25000;
}

export function notesCliEnvironment(env: Env): Record<string, string> {
  return notesDirectory(env) ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {};
}

export function notesSection(env: Env, text: string | null, truncated: boolean): string {
  const dir = notesDirectory(env);
  if (!dir) return "";
  return `## Notes

This directory is your persistent notebook: keep one file per note, with frontmatter name, description and type (user, feedback, project or reference). Keep one line per note in NOTES.md, linking to the file with a short cue; update an existing note instead of creating a duplicate, and delete incorrect notes. Save rules, corrections and facts that should be in view at every start, not code, history or material the house already keeps in Lore; memories and experiences belong in Lore.

Directory: ${dir}

### NOTES.md

${text?.trim() ? text : "The index is still empty."}${truncated ? "\n\n[The index is truncated; read NOTES.md for the rest.]" : ""}`;
}
