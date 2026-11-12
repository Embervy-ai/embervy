// Reads and writes environment files without executing their contents.
// Values must survive systemd and Bun unchanged; unsupported quoting combinations are rejected.

export class EnvValueError extends Error {}

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\x00-\x1f\x7f]/;

// These escapes differ between systemd and Bun, so double quotes cannot preserve them.
function backslashesSurviveDoubleQuotes(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && (i === v.length - 1 || '\\"`$n'.includes(v[i + 1]))) return false;
  }
  return true;
}

// Bun preserves the backslash of a final \$ but reads a final bare $ literally.
const escapeDollars = (v: string) => v.replace(/\$(?!$)/g, "\\$");

// Bun expands variables even in single quotes, unlike systemd.
export function formatEnvValue(value: string): string {
  if (CONTROL.test(value)) throw new EnvValueError("it contains a line break or another control character");
  if (value === "" || BARE.test(value)) return value;
  if (!/['$]/.test(value) && !value.endsWith("\\")) return `'${value}'`;
  if (!value.includes('"') && backslashesSurviveDoubleQuotes(value)) return `"${escapeDollars(value)}"`;
  if (!/[\\#]/.test(value) && !/^['"`\s]/.test(value) && !/\s$/.test(value)) return escapeDollars(value);
  throw new EnvValueError(value.endsWith("\\")
    ? "it ends with a backslash, which no line of the configuration file can carry so that every program reads it back unchanged"
    : `it mixes a " or \\ with a ' or $ in a way no line of the configuration file can carry so that every program reads it back unchanged — leave out one of the two groups`);
}

export function envValueProblem(value: string): string | undefined {
  try {
    formatEnvValue(value);
    return undefined;
  } catch (err) {
    if (err instanceof EnvValueError) return err.message;
    throw err;
  }
}

export function envLine(key: string, value: string): string {
  if (!KEY.test(key)) throw new EnvValueError(`'${key}' is not a valid variable name`);
  try {
    return `${key}=${formatEnvValue(value)}`;
  } catch (err) {
    if (err instanceof EnvValueError) throw new EnvValueError(`${key}: ${err.message}`);
    throw err;
  }
}

export type EnvAssignment = { key: string; value: string };
export type EnvLineResult = EnvAssignment | { key: string; unterminated: true } | null;

export function parseEnvLine(line: string): EnvLineResult {
  let s = line.replace(/^[ \t]+/, "");
  if (!s || s[0] === "#" || s[0] === ";") return null;
  const exp = /^export[ \t]+/.exec(s);
  if (exp) s = s.slice(exp[0].length);
  const eq = s.indexOf("=");
  if (eq < 0) return null;
  const key = s.slice(0, eq).replace(/[ \t]+$/, "");
  if (!KEY.test(key)) return null;
  const rest = s.slice(eq + 1);
  let val = "";
  let state: "pre" | "val" | "sq" | "dq" = "pre";
  let ws = false; 
  let chomp = -1; 
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (state === "sq") {
      if (c === "'") { state = "pre"; ws = false; } else val += c;
      continue;
    }
    if (state === "dq") {
      if (c === '"') { state = "pre"; ws = false; }
      else if (c === "\\") {
        if (i + 1 >= rest.length) return { key, unterminated: true };
        const n = rest[++i];
        val += '"\\`$'.includes(n) ? n : "\\" + n;
      } else val += c;
      continue;
    }
    if (c === "\r") break;
    if (c === " " || c === "\t") {
      if (state === "val") { if (chomp < 0) chomp = val.length; val += c; }
      ws = true;
      continue;
    }
    if (c === "#" && ws) break;
    ws = false;
    if (state === "pre" && c === "'") { state = "sq"; continue; }
    if (state === "pre" && c === '"') { state = "dq"; continue; }
    if (c === "\\") {
      if (i + 1 < rest.length) val += rest[++i];
      state = "val";
      chomp = -1;
      continue;
    }
    state = "val";
    val += c;
    chomp = -1;
  }
  if (state === "sq" || state === "dq") return { key, unterminated: true };
  if (state === "val" && chomp >= 0) val = val.slice(0, chomp);
  return { key, value: val };
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null); // a key named __proto__ stays a key
  for (const line of text.split("\n")) {
    const a = parseEnvLine(line);
    if (a && "value" in a) out[a.key] = a.value;
  }
  return out;
}

export function envGet(text: string, key: string): string | undefined {
  const env = parseEnv(text);
  return Object.hasOwn(env, key) ? env[key] : undefined;
}

export function envLineKey(line: string): string | undefined {
  return parseEnvLine(line)?.key;
}
