// Maps repository files and declarations using lexical heuristics.
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export interface RepoSymbol { name: string; kind: string; line: number }
export interface RepoFile {
  path: string;
  lines: number;
  symbols: RepoSymbol[];
  identifiers: Map<string, number>;
}
export interface RepoScan { files: RepoFile[]; limited: boolean }
export interface RepoMapOptions { focus?: string | string[]; budget?: number }

const EXCLUDED = new Set(["node_modules", ".git", "dist", "build", "coverage", "logs", "state", ".next", ".cache", "__pycache__", ".venv", "venv", "vendor"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".bash"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_ENTRIES = 50000;
const ID = String.raw`[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*`;
const blank = (s: string) => s.replace(/[^\r\n]/g, " ");

function blankLiterals(source: string, language: string): string {
  const js = language !== ".py" && language !== ".sh" && language !== ".bash";
  const chunks: string[] = [];
  let from = 0;
  let i = 0;
  let previous = "";
  while (i < source.length) {
    const start = i;
    const c = source[i];
    let literal = false;
    if ((js && c === "/" && source[i + 1] === "/") || (!js && c === "#") || (i === 0 && source.startsWith("#!"))) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    } else if (js && c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (c === "\"" || c === "'" || (js && c === "`")) {
      literal = true;
      const triple = language === ".py" && source.slice(i, i + 3) === c.repeat(3);
      const quote = triple ? c.repeat(3) : c;
      i += quote.length;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source.startsWith(quote, i)) { i += quote.length; break; }
        // Broken single-line JS/Python strings must not hide the rest of a file.
        if (source[i] === "\n" && !triple && c !== "`" && (js || language === ".py")) break;
        i++;
      }
      i = Math.min(i, source.length);
    } else if (js && c === "/" && (!previous || /[=(:,!&|?;{}\[\]>]/.test(previous) || /\b(?:return|throw|yield|case)\s*$/.test(source.slice(Math.max(0, i - 30), i)))) {
      let j = i + 1;
      let inClass = false;
      for (; j < source.length && source[j] !== "\n"; j++) {
        if (source[j] === "\\") { j++; continue; }
        if (source[j] === "[") inClass = true;
        if (source[j] === "]") inClass = false;
        if (source[j] === "/" && !inClass) break;
      }
      if (source[j] !== "/") { previous = c; i++; continue; }
      literal = true;
      i = j + 1;
      while (/[a-z]/i.test(source[i] ?? "")) i++;
    } else {
      if (!/\s/.test(c)) previous = c;
      i++;
      continue;
    }
    chunks.push(source.slice(from, start));
    const hidden = blank(source.slice(start, i));
    // A placeholder prevents the next expression from looking like this declaration's initializer.
    chunks.push(literal ? "0" + hidden.slice(1) : hidden);
    if (literal) previous = "0";
    from = i;
  }
  chunks.push(source.slice(from));
  return chunks.join("");
}

function variableBindings(code: string, name: string, offset: number, end: number): Array<{ name: string; offset: number; tail: string }> {
  const result: Array<{ name: string; offset: number; tail: string }> = [];
  const stack: string[] = [];
  const limit = Math.min(code.length, end + 2000);
  let tailStart = end;
  const finish = (at: number) => result.push({ name, offset, tail: code.slice(tailStart, at) });
  for (let i = end; i < limit; i++) {
    const c = code[i];
    if (!stack.length && (c === ";" || /[)}\]]/.test(c) || (c === "\n" && /^\s*(?:export|const|let|var|function|class|return)\b/.test(code.slice(i, i + 80))))) {
      finish(i); return result;
    }
    if (!stack.length && c === ",") {
      finish(i);
      const next = new RegExp(`^\\s*(${ID})`, "u").exec(code.slice(i + 1, limit));
      if (!next) return result;
      name = next[1];
      offset = i + 1 + next[0].lastIndexOf(name);
      tailStart = i + 1 + next[0].length;
      i = tailStart - 1;
      continue;
    }
    if (c === "(") stack.push(")");
    else if (c === "[") stack.push("]");
    else if (c === "{") stack.push("}");
    else if (c === "<" && /^<[^;=\n]*>/.test(code.slice(i, Math.min(i + 300, limit)))) stack.push(">");
    else if (c === stack[stack.length - 1]) stack.pop();
  }
  finish(limit);
  return result;
}

export function analyzeSource(path: string, source: string): RepoFile {
  const language = extname(path).toLowerCase();
  const code = blankLiterals(source, language);
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const lineAt = (offset: number) => {
    let low = 0, high = starts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid; else high = mid;
    }
    return low + 1;
  };
  const symbols: RepoSymbol[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string, offset: number) => {
    const line = lineAt(offset);
    const key = `${line}:${name}`;
    if (!seen.has(key)) { seen.add(key); symbols.push({ name, kind, line }); }
  };
  if (language === ".py") {
    const declarations = new RegExp(`^[ \\t]*(?:async[ \\t]+)?(def|class)[ \\t]+(${ID})`, "gmu");
    for (const m of code.matchAll(declarations)) add(m[2], m[1] === "def" ? "function" : "class", m.index! + m[0].lastIndexOf(m[2]));
  } else if (language === ".sh" || language === ".bash") {
    const declarations = new RegExp(`^[ \\t]*(?:function[ \\t]+(${ID})(?:[ \\t]*\\(\\))?|(${ID})[ \\t]*\\(\\))[ \\t]*(?:\\{|$)`, "gmu");
    for (const m of code.matchAll(declarations)) add(m[1] || m[2], "function", m.index! + m[0].search(/\S/));
  } else {
    for (const m of code.matchAll(new RegExp(`\\b(function(?:\\s*\\*\\s*|\\s+)|class\\s+)(${ID})`, "gu"))) {
      add(m[2], m[1].startsWith("function") ? "function" : "class", m.index!);
    }
    const exported = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(interface|type|enum)\\s+(${ID})`, "gu");
    for (const m of code.matchAll(exported)) add(m[2], m[1], m.index! + m[0].lastIndexOf(m[1]));
    const variables = new RegExp(`\\b(?:(export)\\s+(?:declare\\s+)?)?(const|let|var)\\s+(${ID})`, "gu");
    for (const m of code.matchAll(variables)) {
      const bindings = variableBindings(code, m[3], m.index! + m[0].lastIndexOf(m[3]), m.index! + m[0].length);
      for (const binding of bindings) {
        const initializer = /^(?:\s*:[^;=]+)?\s*=\s*([\s\S]*)/.exec(binding.tail)?.[1] ?? "";
        const callable = /^(?:async\s+)?(?:function\b|(?:<[^;=]*>\s*)?(?:\([^;]*?\)|[$\w]+)\s*(?::[^;=]+)?=>)/.test(initializer);
        if (callable || (m[1] && m[2] === "const")) add(binding.name, callable ? "function" : "const", binding.offset);
      }
    }
  }
  symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const identifiers = new Map<string, number>();
  for (const m of code.matchAll(new RegExp(ID, "gu"))) identifiers.set(m[0], (identifiers.get(m[0]) ?? 0) + 1);
  return { path, lines: source.length === 0 ? 0 : starts.length - (source.endsWith("\n") ? 1 : 0), symbols, identifiers };
}

// Path checks do not provide isolation against concurrent directory renames.
export function scanRepository(directory: string): RepoScan {
  const root = realpathSync(resolve(directory));
  const files: RepoFile[] = [];
  let bytes = 0, entries = 0, limited = false;
  const walk = (folder: string) => {
    if (limited) return;
    let children;
    try {
      const real = realpathSync(folder);
      if (real !== root && !real.startsWith(root + sep)) return;
      children = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch { return; }
    for (const child of children) {
      if (++entries > MAX_ENTRIES || files.length >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) { limited = true; break; }
      const full = join(folder, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) { if (!EXCLUDED.has(child.name)) walk(full); if (limited) break; continue; }
      if (!child.isFile() || !EXTENSIONS.has(extname(child.name).toLowerCase()) || /\.(?:min|generated|bundle)\.[^.]+$/i.test(child.name)) continue;
      let fd: number | undefined;
      try {
        fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        if (bytes + stat.size > MAX_TOTAL_BYTES) { limited = true; break; }
        const buffer = Buffer.alloc(stat.size);
        let read = 0;
        while (read < buffer.length) {
          const n = readSync(fd, buffer, read, buffer.length - read, null);
          if (!n) break;
          read += n;
        }
        bytes += read;
        const source = buffer.subarray(0, read).toString("utf8");
        if (source.includes("\0") || /@generated|auto[- ]generated|do not edit/i.test(source.slice(0, 1000)) || /[^\n]{10000}/.test(source)) continue;
        files.push(analyzeSource(relative(root, full).split(sep).join("/"), source));
      } catch { /* unreadable/deleted/broken entry: the rest of the map is useful */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  };
  walk(root);
  return { files, limited };
}

export function renderRepoMap(scan: RepoScan, options: RepoMapOptions = {}): string {
  const requested = options.budget ?? 1500;
  if (!Number.isFinite(requested) || requested < 0) throw new Error("budget must be a finite nonnegative number");
  const cap = Math.floor(Math.min(requested, 20000) * 4);
  const focus = (Array.isArray(options.focus) ? options.focus.join(" ") : options.focus ?? "")
    .toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 64);
  // Test sources remain discoverable, but do not dominate the default sketch.
  const isTest = (path: string) => /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:^|\/)(?:test[-_]|conftest\.)|(?:[.-](?:test|spec)|_test)\.[^/]+$/i.test(path);
  const weight = (file: RepoFile) => isTest(file.path) ? 0.25 : 1;
  const counts = new Map<string, number>();
  const declarations = new Map<string, number>();
  for (const file of scan.files) {
    // Repetition in one caller is weaker evidence than use across callers.
    for (const [name, count] of file.identifiers) counts.set(name, (counts.get(name) ?? 0) + Math.min(count, 3) * weight(file));
    for (const name of new Set(file.symbols.map((s) => s.name))) declarations.set(name, (declarations.get(name) ?? 0) + 1);
  }
  const referenceScore = (file: RepoFile, name: string) => {
    const other = Math.max(0, (counts.get(name) ?? 0) - Math.min(file.identifiers.get(name) ?? 0, 3) * weight(file));
    // Short or multiply-defined names are ambiguous because occurrences are not resolved references.
    return Math.log2(1 + other) / Math.max(1, declarations.get(name) ?? 0) * (name.length <= 3 ? 0.25 : 1);
  };
  const bonus = (value: string) => focus.reduce((n, word) => n + (value.toLowerCase().includes(word) ? 100 : 0), 0);
  const ranked = scan.files.map((file) => {
    const pathScore = bonus(file.path) - (isTest(file.path) ? 2 : 0);
    const symbols = file.symbols.map((symbol) => ({ ...symbol, score: pathScore + bonus(symbol.name) + referenceScore(file, symbol.name) }))
      .sort((a, b) => b.score - a.score || a.line - b.line || a.name.localeCompare(b.name));
    return { file, symbols, score: symbols[0]?.score ?? pathScore };
  }).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const totalSymbols = scan.files.reduce((n, f) => n + f.symbols.length, 0);
  const notice = (symbols: number, files: number) => `… ${symbols} more symbols in ${files} files`;
  const scanNote = scan.limited ? "Scan limit reached." : "";
  // Global selection prevents a large file's weak matches from displacing stronger candidates.
  const reserve = notice(totalSymbols, scan.files.length).length + 1 + (scanNote ? scanNote.length + 1 : 0);
  const selected = new Map<string, Set<RepoSymbol>>();
  const header = (file: RepoFile) => `${JSON.stringify(file.path)} (${file.lines} lines)`;
  const symbolLine = (symbol: RepoSymbol) => `  ${symbol.line}: ${symbol.kind} ${symbol.name}`;
  const fullLines = ranked.flatMap(({ file, symbols }) => [header(file), ...symbols.map(symbolLine)]);
  if (scanNote) fullLines.push(scanNote);
  if (!fullLines.length) fullLines.push("No source files found.");
  const full = fullLines.join("\n");
  if (full.length <= cap) return full;
  const candidates = ranked.flatMap<{ entry: typeof ranked[number]; symbol: RepoSymbol | null; score: number }>((entry) => entry.symbols.length
    ? entry.symbols.map((symbol) => ({ entry, symbol, score: symbol.score }))
    : [{ entry, symbol: null, score: entry.score }]);
  candidates.sort((a, b) => b.score - a.score || a.entry.file.path.localeCompare(b.entry.file.path) || (a.symbol?.line ?? 0) - (b.symbol?.line ?? 0));
  let used = 0;
  for (const { entry, symbol } of candidates) {
    const chosen = selected.get(entry.file.path);
    const cost = (chosen ? 0 : header(entry.file).length + 1) + (symbol ? symbolLine(symbol).length + 1 : 0);
    if (used + cost > cap - reserve) continue;
    if (!chosen) selected.set(entry.file.path, new Set());
    if (symbol) selected.get(entry.file.path)!.add(symbol);
    used += cost;
  }
  const lines: string[] = [];
  let omittedSymbols = 0, omittedFiles = 0;
  for (const { file, symbols } of ranked) {
    const chosen = selected.get(file.path);
    const missing = symbols.length - (chosen?.size ?? 0);
    omittedSymbols += missing;
    if (!chosen || missing) omittedFiles++;
    if (!chosen) continue;
    lines.push(header(file));
    for (const symbol of symbols) if (chosen.has(symbol)) lines.push(symbolLine(symbol));
  }
  if (omittedFiles) lines.push(notice(omittedSymbols, omittedFiles));
  if (scanNote) lines.push(scanNote);
  if (!lines.length) lines.push("No source files found.");
  const output = lines.join("\n");
  return output.length <= cap ? output : "";
}

export function repoMap(directory: string, options: RepoMapOptions = {}): string {
  return renderRepoMap(scanRepository(directory), options);
}
