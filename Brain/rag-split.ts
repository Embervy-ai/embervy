// Splits session archives into upload-sized parts.
// The worker writes chunks sequentially, so a large single upload can repeatedly time out.

export const SPLIT_THRESHOLD_BYTES = 81920;
export const PART_TARGET_BYTES = 80000;

const SEPARATOR = "\n---\n";
const CUT_POINTS = ["\n\n**", "\n\n", "\n"];
// Even a header close to the part size leaves room for some conversation.
const MIN_BODY_BYTES = 1024;

export interface ArchivePart { name: string; content: string }

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function prefixWithin(text: string, limit: number): number {
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (used + size > limit) break;
    used += size;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}

function cutTurn(turn: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = turn;
  while (utf8Bytes(rest) > limit) {
    const end = prefixWithin(rest, limit);
    let cut = end;
    for (const marker of CUT_POINTS) {
      const at = rest.lastIndexOf(marker, end);
      if (at > end / 2) { cut = at; break; }
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

export function splitArchive(name: string, markdown: string, limits = { threshold: SPLIT_THRESHOLD_BYTES, target: PART_TARGET_BYTES }): ArchivePart[] {
  const whole = [{ name: `${name}.md`, content: markdown }];
  if (utf8Bytes(markdown) <= limits.threshold) return whole;
  const first = markdown.indexOf(SEPARATOR);
  if (first === -1) return whole;
  const header = markdown.slice(0, first);
  const headerBytes = utf8Bytes(header);
  const room = Math.max(limits.target - headerBytes, MIN_BODY_BYTES);
  const pieces = markdown.slice(first + SEPARATOR.length).split(SEPARATOR)
    .flatMap((turn) => cutTurn(SEPARATOR + turn, room));

  const groups: string[][] = [];
  let current: string[] = [];
  let size = headerBytes;
  for (const piece of pieces) {
    const bytes = utf8Bytes(piece);
    if (size + bytes > limits.target && current.length) {
      groups.push(current);
      current = [piece];
      size = headerBytes + bytes;
    } else {
      current.push(piece);
      size += bytes;
    }
  }
  if (current.length) groups.push(current);
  if (groups.length < 2) return whole;

  const title = `# ${name.replaceAll("_", " ")}`;
  return groups.map((group, index) => ({
    name: `${name}_part${String(index + 1).padStart(2, "0")}.md`,
    content: header.split(title).join(`${title} Part ${index + 1}`) + group.join(""),
  }));
}
