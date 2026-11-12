// Match the inlet's 500-character archive excerpts without allowing new context lines.
export const CONTEXT_TEXT_MAX = 500;

export function defuseChannelTags(text: string): string {
  return text.replace(/<\/?channel\b/gi, m => m.replace("<", "‹"));
}

export function contextLine(value: unknown, max = CONTEXT_TEXT_MAX): string {
  const clean = defuseChannelTags(String(value ?? ""))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : clean;
}

// Reuse the channel envelope used for incoming mail and room messages.
export function foreignContext(kind: "calendar" | "weather", text: string): string {
  return `<channel source="${kind}" kind="${kind}">\n${defuseChannelTags(text)}\n</channel>`;
}

if (import.meta.main) {
  const text = await Bun.stdin.text();
  if (text.trim()) console.log(foreignContext("weather", contextLine(text)));
}
