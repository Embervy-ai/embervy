import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

type Env = Record<string, string | undefined>;
type Log = (event: Record<string, unknown>) => void;
type Skill = { name: string; description: string; file: string };

export function skillsDirectory(env: Env): string | null {
  const override = env.BRAIN_SKILLS_DIR?.trim();
  if (override && isAbsolute(override)) return override;
  const cwd = env.BRAIN_CLAUDE_CWD?.trim();
  return cwd && isAbsolute(cwd) ? join(cwd, ".claude", "skills") : null;
}

function maxBytes(env: Env): number {
  const n = Number(env.BRAIN_SKILLS_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : 12000;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Only flat scalar metadata is supported; richer YAML must not become a misleading index entry. */
function frontmatter(text: string): Map<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line === "---") return fields;
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!match || fields.has(match[1])) return null;
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { return null; }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) return null;
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (/^[\[\]{}|>&*!%@`]/.test(value) || /(?:^|\s)#/.test(value)) {
      return null;
    }
    if (typeof value !== "string" || /[\x00-\x1f\x7f\u2028\u2029]/.test(value)) return null;
    fields.set(match[1], value);
  }
  return null;
}

function readSkill(root: string, file: string, fallback: string, log: Log): Skill | null {
  let fd: number | undefined;
  try {
    const resolved = realpathSync(file);
    if (!inside(root, resolved)) {
      log({ type: "skills_symlink_outside", file });
      return null;
    }
    // Resolve containment before opening; nonblocking regular-file reads avoid FIFOs and devices.
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(8000);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    const fields = frontmatter(new TextDecoder().decode(buffer.subarray(0, bytes), { stream: bytes === buffer.length }));
    if (!fields) {
      log({ type: "skills_frontmatter_invalid", file });
      return null;
    }
    return {
      name: fields.get("name")?.trim() || fallback,
      description: Array.from(fields.get("description") || "").slice(0, 400).join(""),
      file,
    };
  } catch (error) {
    log({ type: "skills_file_read_failed", file, error: (error as NodeJS.ErrnoException).code || String(error) });
    return null;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Reread metadata at each prompt construction so edits survive head switches without a cache. */
export function skillsSection(env: Env, log: Log): string {
  const dir = skillsDirectory(env);
  if (!dir) return "";
  const skills: Skill[] = [];
  try {
    const root = realpathSync(dir);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const folder = join(dir, entry.name);
      try {
        const resolved = realpathSync(folder);
        if (!inside(root, resolved)) {
          log({ type: "skills_symlink_outside", file: folder });
          continue;
        }
        if (!statSync(resolved).isDirectory()) continue;
      } catch (error) {
        log({ type: "skills_file_read_failed", file: folder, error: (error as NodeJS.ErrnoException).code || String(error) });
        continue;
      }
      const skill = readSkill(root, join(folder, "SKILL.md"), entry.name, log);
      if (skill) skills.push(skill);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") log({ type: "skills_dir_read_failed", dir, error: code || String(error) });
    return "";
  }
  if (!skills.length) return "";
  // Code-unit ordering and a path tie-breaker avoid locale and filesystem ordering differences.
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  skills.sort((a, b) => compare(a.name, b.name) || compare(a.file, b.file));
  const oneLine = (text: string) => text.replace(/[\r\n\t\u2028\u2029]/g, " ");
  const header = `## Skills

These are your skills, written instructions for particular kinds of tasks. When a matching task comes up, first read the full SKILL.md and follow it (read_file opens it when your workspace includes this directory). A new skill is its own directory with a SKILL.md and frontmatter name and description; you can write one yourself where your house lets you write here.

Directory: ${oneLine(dir)}`;
  const footer = "\n\nMore skills are available in the directory above.";
  const lines = skills.map(skill => `\n- ${oneLine(skill.name)} — ${skill.description} — ${oneLine(skill.file)}`);
  const cap = maxBytes(env);
  const total = Buffer.byteLength(header) + lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  if (total <= cap) return header + lines.join("");
  // Reserve the complete notice, rather than cutting a path or a UTF-8 character.
  const budget = cap - Buffer.byteLength(footer);
  let section = header;
  let bytes = Buffer.byteLength(section);
  if (bytes > budget) {
    log({ type: "skills_section_omitted", max_bytes: cap });
    return "";
  }
  for (const line of lines) {
    const size = Buffer.byteLength(line);
    if (bytes + size > budget) break;
    section += line;
    bytes += size;
  }
  return section + footer;
}
