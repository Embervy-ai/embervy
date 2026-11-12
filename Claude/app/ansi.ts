export type AnsiStyle = {
  bold: boolean;
  dim: boolean;
  invert: boolean;
  fg: string | null;
  bg: string | null;
};

const BASIC = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function color256(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return BASIC[index];
  if (index < 232) {
    const n = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const r = levels[Math.floor(n / 36)];
    const g = levels[Math.floor((n % 36) / 6)];
    const b = levels[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

function cssFor(style: AnsiStyle): string {
  let fg = style.fg;
  let bg = style.bg;
  if (style.invert) [fg, bg] = [bg || "#0b1228", fg || "#ece8e1"];
  const css: string[] = [];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background-color:${bg}`);
  if (style.bold) css.push("font-weight:700");
  if (style.dim) css.push("opacity:.65");
  return css.join(";");
}

function stringControlEnd(input: string, start: number): number {
  const ends = [input.indexOf("\x07", start), input.indexOf("\x1b\\", start), input.indexOf("\u009c", start)].filter((index) => index >= 0);
  if (ends.length === 0) return input.length;
  const end = Math.min(...ends);
  return input.startsWith("\x1b\\", end) ? end + 2 : end + 1;
}

function applySgr(style: AnsiStyle, raw: string): void {
  const codes = raw === "" ? [0] : raw.split(";").map((part) => Number(part || 0));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(style, { bold: false, dim: false, invert: false, fg: null, bg: null });
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 7) style.invert = true;
    else if (code === 22) { style.bold = false; style.dim = false; }
    else if (code === 27) style.invert = false;
    else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
    else if (code >= 30 && code <= 37) style.fg = BASIC[code - 30];
    else if (code >= 40 && code <= 47) style.bg = BASIC[code - 40];
    else if (code >= 90 && code <= 97) style.fg = BASIC[8 + code - 90];
    else if (code >= 100 && code <= 107) style.bg = BASIC[8 + code - 100];
    else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
      const color = color256(codes[i + 2]);
      if (color) code === 38 ? style.fg = color : style.bg = color;
      i += 2;
    }
  }
}

/** Converts terminal SGR to safe HTML. All non-SGR controls are discarded. */
export function ansiToHtml(input: string): string {
  const style: AnsiStyle = { bold: false, dim: false, invert: false, fg: null, bg: null };
  let output = "";
  let text = "";
  const flush = () => {
    if (!text) return;
    const escaped = escapeHtml(text);
    const css = cssFor(style);
    output += css ? `<span style="${css}">${escaped}</span>` : escaped;
    text = "";
  };
  for (let i = 0; i < input.length;) {
    const code = input.charCodeAt(i);
    if (code === 0x1b) {
      flush();
      const next = input[i + 1];
      if (next === "[") {
        const match = input.slice(i + 2).match(/^([0-9:;<=>?]*)([ -/]*)?([@-~])/);
        if (match) {
          if (match[3] === "m") applySgr(style, match[1].replace(/:/g, ";"));
          i += 2 + match[0].length;
          continue;
        }
      } else if (next === "]" || next === "P" || next === "_" || next === "^") {
        i = stringControlEnd(input, i + 2);
        continue;
      }
      i += Math.min(2, input.length - i);
      continue;
    }
    if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
      i = stringControlEnd(input, i + 1);
      continue;
    }
    if ((code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f)) { i++; continue; }
    text += input[i++];
  }
  flush();
  return output;
}
