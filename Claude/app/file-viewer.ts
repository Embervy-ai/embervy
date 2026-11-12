// Displays text and PDF files with a way back to the app.
// Installed iOS web apps have no browser bar, so file navigation needs its own close link.

import { loadStrings, t } from "./strings";
const S = (key: string, vars?: Record<string, string | number>) => t(loadStrings().strings, key, vars);

export const VIEWER_SCRIPT_PATH = "/viewer.js";

export const VIEWER_JS = `(() => {
  const close = document.getElementById("viewer-close");
  if (!close) return;
  close.addEventListener("click", (event) => {
    if (history.length <= 1) return; // nothing to go back to: the link goes to "/"
    event.preventDefault();
    // If going back does nothing (no page left this window), go home anyway.
    // pagehide fires when the back navigation leaves this page.
    const fallback = setTimeout(() => { location.href = "/"; }, 700);
    addEventListener("pagehide", () => clearTimeout(fallback), { once: true });
    history.back();
  });
})();
`;

export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const TEXT_EXT = /\.(md|txt|json|log|csv|yaml|yml|toml|sh|py|ts|js|css)$/i;
const PDF_EXT = /\.pdf$/i;

// Without an explicit charset, browsers can interpret UTF-8 as Latin-1.
export const RAW_TEXT_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export const VIEWER_MAX_TEXT_BYTES = 5 * 1024 * 1024;

export type ViewerKind = "markdown" | "text" | "pdf";

export function viewerKind(filename: string): ViewerKind | null {
  if (/\.md$/i.test(filename)) return "markdown";
  if (TEXT_EXT.test(filename)) return "text";
  if (PDF_EXT.test(filename)) return "pdf";
  return null;
}

export function wantsViewer(accept: string | undefined, raw: string | undefined): boolean {
  return (accept ?? "").includes("text/html") && raw !== "1";
}

// Some CDNs ignore Vary; private caching prevents raw bytes from replacing the viewer page.
export function rawFileHeaders(filename: string, raw: string | undefined): Record<string, string> {
  if (!viewerKind(filename)) return {};
  return raw === "1" ? { Vary: "Accept" } : { Vary: "Accept", "Cache-Control": "private" };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
}

// Excluding nested "[" keeps scans of unclosed links linear.
const LINK_RE = /(\[[^[\]\n]+\]\(https?:\/\/[^)[\s]+\))/;
const LINK_PARTS_RE = /^\[([^[\]\n]+)\]\((https?:\/\/[^)[\s]+)\)$/;

// Limit markdown work so a hostile line cannot monopolize the server.
export const LONG_LINE = 10_000;

function inline(raw: string): string {
  if (raw.length > LONG_LINE) return escapeHtml(raw);
  return raw
    .split(/(`[^`\n]+`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return part
        .split(LINK_RE)
        .map((seg, j) => {
          if (j % 2 === 0) return emphasis(escapeHtml(seg));
          const m = seg.match(LINK_PARTS_RE)!;
          return `<a href="${escapeHtml(m[2])}" target="_blank" rel="noopener noreferrer">${emphasis(escapeHtml(m[1]))}</a>`;
        })
        .join("");
    })
    .join("");
}

// A separate trailing-marker scan avoids quadratic regex backtracking on spaces.
export function parseHeading(line: string): { level: number; text: string } | null {
  const open = line.match(/^(#{1,6})\s+/);
  if (!open) return null;
  let text = line.slice(open[0].length).trimEnd();
  let j = text.length;
  while (j > 0 && text[j - 1] === "#") j--;
  if (j > 0 && j < text.length && /\s/.test(text[j - 1])) text = text.slice(0, j).trimEnd();
  if (/[\u2028\u2029]/.test(text)) return null;
  return { level: open[1].length, text };
}

// File content is untrusted; only markup generated here may become HTML.
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; start: number; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>\n")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
    out.push(`<${list.tag}${start}>\n${list.items.map((it) => `<li>${inline(it)}</li>`).join("\n")}\n</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++; 
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }

    if (line.length > LONG_LINE) {
      flush();
      out.push(`<p>${escapeHtml(line)}</p>`);
      i++;
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      flush();
      out.push(`<h${heading.level}>${inline(heading.text)}</h${heading.level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${quoted.map(inline).join("<br>\n")}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = ul ? null : line.match(/^\s*(\d{1,9})[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, start: ol ? Number(ol[1]) : 1, items: [] };
      list.items.push(ul ? ul[1] : ol![2]);
      i++;
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    flushList();
    para.push(line);
    i++;
  }
  flush();
  return out.join("\n");
}

const PAGE_CSS = `:root{color-scheme:light dark}
html,body{margin:0}
body{background:#F5F0EB;color:#2C2C2C;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:760px;margin:0 auto;box-sizing:border-box;overflow-wrap:anywhere;padding:calc(env(safe-area-inset-top) + 68px) calc(env(safe-area-inset-right) + 20px) calc(env(safe-area-inset-bottom) + 48px) calc(env(safe-area-inset-left) + 20px)}
h1,h2,h3,h4,h5,h6{line-height:1.3}
h1{font-size:1.5em;margin-top:0}
a{color:#8B7355}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
code{background:rgba(0,0,0,.06);border-radius:4px;padding:.1em .3em}
pre{background:#fff;border:1px solid #E0D8D0;border-radius:8px;padding:12px;overflow-x:auto;overflow-wrap:normal}
pre code{background:none;padding:0;font-size:1em}
pre.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #E0D8D0;color:#6B6560}
hr{border:0;border-top:1px solid #E0D8D0;margin:1.5em 0}
.viewer-note{color:#6B6560;font-size:.9em}
.viewer-close{position:fixed;top:calc(env(safe-area-inset-top) + 12px);right:calc(env(safe-area-inset-right) + 16px);z-index:10;width:44px;height:44px;border-radius:22px;background:rgba(44,44,44,.88);color:#fff;font-size:28px;line-height:44px;text-align:center;text-decoration:none;-webkit-tap-highlight-color:transparent}
.pdf,.pdf body{height:100%;background:#2C2C2C}
.pdf iframe{position:fixed;inset:0;width:100%;height:100%;border:0}
@media (prefers-color-scheme:dark){
body{background:#151515;color:#E8E4DF}
a{color:#C9A97F}
code{background:rgba(255,255,255,.08)}
pre{background:#1E1E1E;border-color:#333}
blockquote,.viewer-note{color:#A8A29C;border-color:#333}
hr{border-color:#333}
.viewer-close{background:rgba(70,70,70,.92)}
}`;

function page(title: string, body: string, htmlClass = ""): string {
  return `<!doctype html>
<html lang="${escapeHtml(loadStrings().language)}"${htmlClass ? ` class="${htmlClass}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
<script src="${VIEWER_SCRIPT_PATH}" defer></script>
</head><body>
<a class="viewer-close" id="viewer-close" href="/" aria-label="${escapeHtml(S("viewer.close"))}">&times;</a>
${body}
</body></html>`;
}

export function textViewerPage(filename: string, text: string, truncatedFrom?: number): string {
  const note = truncatedFrom
    ? `<p class="viewer-note">${escapeHtml(S("viewer.truncated", { shown: Math.round(VIEWER_MAX_TEXT_BYTES / 1048576), total: (truncatedFrom / 1048576).toFixed(1) }))}</p>\n`
    : "";
  if (viewerKind(filename) === "markdown") {
    const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || filename;
    return page(title, `<main>\n${note}${renderMarkdown(text)}\n</main>`);
  }
  let shown = text;
  if (/\.json$/i.test(filename) && !truncatedFrom) {
    try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not valid JSON: show it as written */ }
  }
  return page(filename, `<main>\n<h1>${escapeHtml(filename)}</h1>\n${note}<pre class="wrap">${escapeHtml(shown)}</pre>\n</main>`);
}

export function pdfViewerPage(filename: string, rawUrl: string): string {
  return page(filename, `<iframe src="${escapeHtml(rawUrl)}" title="${escapeHtml(filename)}"></iframe>`, "pdf");
}

export function viewerResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": VIEWER_CSP,
      "Cache-Control": "no-store",
      Vary: "Accept",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function fileViewer(
  accept: string | undefined,
  raw: string | undefined,
  filename: string,
  file: Blob,
  rawUrl: string,
): Promise<Response | null> {
  if (!wantsViewer(accept, raw)) return null;
  const kind = viewerKind(filename);
  if (kind === "pdf") return viewerResponse(pdfViewerPage(filename, rawUrl));
  if (!kind) return null;
  const truncated = file.size > VIEWER_MAX_TEXT_BYTES;
  const text = await (truncated ? file.slice(0, VIEWER_MAX_TEXT_BYTES) : file).text();
  return viewerResponse(textViewerPage(filename, text, truncated ? file.size : undefined));
}
