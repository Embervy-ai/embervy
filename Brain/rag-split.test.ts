import { describe, expect, test } from "bun:test";
import { PART_TARGET_BYTES, SPLIT_THRESHOLD_BYTES, splitArchive, type ArchivePart } from "./rag-split";

// The archive the way historyToMarkdown writes it: a header block, then each
// turn opened by the separator (house style) or all turns after one separator.
const HEADER = "# [Session_7] [DATE: 2026-10-02]\n\nSESSION=7 | TYPE=CHAT | DATE=2026-10-02\nTHEMES=—\nSUMMARY=—\nEMOTIONAL_ARC=—\nKEY_MOMENTS=—\nDYNAMIC=—\n";
const turn = (speaker: string, text: string) => `\n---\n\n**${speaker}**\n\n${text}\n`;
const paragraphs = (tag: string, count: number) => Array.from({ length: count }, (_, i) => `${tag} ${i}: ${"word ".repeat(30)}`).join("\n\n");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
/** A turn of exactly size bytes. */
const turnOfSize = (size: number) => turn("User", "a".repeat(size - bytes(turn("User", ""))));

/** Every part starts with the header; the bodies in order. */
function bodies(parts: ArchivePart[], header = HEADER): string[] {
  return parts.map((part) => {
    expect(part.content.startsWith(header)).toBe(true);
    return part.content.slice(header.length);
  });
}
const turnsIn = (body: string) => body.split("\n---\n").length - 1;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("rag-split: an archive over 80 KB goes to the RAG in parts (smart_upload.sh rule)", () => {
  test("up to 81920 bytes the archive goes whole under its own name; one byte more splits", () => {
    const small = HEADER + turn("User", "hello") + turn("Worker", "hi");
    expect(splitArchive("Session_7", small)).toEqual([{ name: "Session_7.md", content: small }]);
    const atLimit = HEADER + turnOfSize(SPLIT_THRESHOLD_BYTES - bytes(HEADER));
    expect(bytes(atLimit)).toBe(SPLIT_THRESHOLD_BYTES);
    expect(splitArchive("Session_7", atLimit)).toEqual([{ name: "Session_7.md", content: atLimit }]);
    const over = HEADER + turnOfSize(SPLIT_THRESHOLD_BYTES + 1 - bytes(HEADER));
    expect(splitArchive("Session_7", over).map((p) => p.name)).toEqual(["Session_7_part01.md", "Session_7_part02.md"]);
  });

  test("whole turns packed in order up to 80000 bytes, header on every part, stable names; header + bodies is the archive", () => {
    let archive = HEADER;
    for (let i = 0; i < 12; i += 1) archive += turn(i % 2 ? "Worker" : "User", paragraphs(`turn ${i}`, 75));
    const parts = splitArchive("Session_7", archive);
    expect(parts.map((p) => p.name)).toEqual(["Session_7_part01.md", "Session_7_part02.md"]);
    const body = bodies(parts);
    expect(HEADER + body.join("")).toBe(archive);
    for (const [index, part] of parts.entries()) {
      expect(bytes(part.content)).toBeLessThanOrEqual(PART_TARGET_BYTES);
      expect(body[index].startsWith("\n---\n")).toBe(true);
    }
    // Packed as far as it goes: the next part's first turn would not have fit.
    const firstOfNext = `\n---\n${body[1].split("\n---\n")[1]}`;
    expect(bytes(parts[0].content) + bytes(firstOfNext)).toBeGreaterThan(PART_TARGET_BYTES);
    expect(splitArchive("Session_7", archive)).toEqual(parts);
  });

  test("greedy like the script: a part may fill exactly 80000 bytes, the next turn opens a new part", () => {
    const room = PART_TARGET_BYTES - bytes(HEADER);
    const exact = HEADER + turnOfSize(40000) + turnOfSize(room - 40000) + turnOfSize(30000) + turnOfSize(30000) + turnOfSize(30000);
    const parts = splitArchive("Session_7", exact);
    expect(bytes(parts[0].content)).toBe(PART_TARGET_BYTES);
    expect(bodies(parts).map(turnsIn)).toEqual([2, 2, 1]);
  });

  test("a '# <name with spaces>' title gets 'Part N' as in smart_upload.sh; the bracket header stays as it is", () => {
    const header = "# Session 7\n\nTHEMES=—\n";
    let archive = header;
    for (let i = 0; i < 4; i += 1) archive += turnOfSize(30000);
    const parts = splitArchive("Session_7", archive);
    expect(parts.map((p) => p.content.split("\n")[0])).toEqual(["# Session 7 Part 1", "# Session 7 Part 2"]);
    expect(parts.map((p) => p.content.slice(p.content.indexOf("\n---\n"))).join("")).toBe(archive.slice(header.length));
  });

  test("no separator at all: the archive goes whole, as in the script", () => {
    const flat = `# [Session_7]\n\n${paragraphs("text", 700)}`;
    expect(bytes(flat)).toBeGreaterThan(SPLIT_THRESHOLD_BYTES);
    expect(splitArchive("Session_7", flat)).toEqual([{ name: "Session_7.md", content: flat }]);
  });

  test("whitespace-only turns are kept (the script drops them): nothing is lost", () => {
    const archive = HEADER + turnOfSize(50000) + "\n---\n   " + "\n---\n" + turnOfSize(50000);
    const parts = splitArchive("Session_7", archive);
    expect(parts.length).toBe(2);
    expect(HEADER + bodies(parts).join("")).toBe(archive);
  });
});

describe("rag-split: a turn larger than a part is cut, never past the limit", () => {
  test("archive style with one separator: cut before a speaker line", () => {
    const header = "# [Session_7] [DATE: 2026-10-02]\n\nSESSION=Session_7 | TYPE=BRAIN | DATE=2026-10-02\nDYNAMIC=placeholder.\n";
    let archive = `${header}\n---\n`;
    for (let i = 0; i < 8; i += 1) archive += `\n**${i % 2 ? "Worker" : "User"}**\n\n${paragraphs(`turn ${i}`, 90)}\n`;
    const parts = splitArchive("Session_7", archive);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const body = bodies(parts, header);
    expect(header + body.join("")).toBe(archive);
    for (const [index, part] of parts.entries()) {
      expect(bytes(part.content)).toBeLessThanOrEqual(PART_TARGET_BYTES);
      if (index > 0) expect(body[index]).toMatch(/^\n\n\*\*(User|Worker)\*\*\n/);
    }
  });

  test("one long message without speaker lines: cut before a paragraph", () => {
    const archive = HEADER + turn("User", paragraphs("long", 1200));
    const parts = splitArchive("Session_7", archive);
    expect(parts.length).toBe(3);
    const body = bodies(parts);
    expect(HEADER + body.join("")).toBe(archive);
    for (const [index, part] of parts.entries()) {
      expect(bytes(part.content)).toBeLessThanOrEqual(PART_TARGET_BYTES);
      if (index > 0) expect(body[index]).toMatch(/^\n\nlong \d+: /);
    }
  });

  test("one line without breaks: cut at a character, never inside one", () => {
    const archive = HEADER + turn("User", "café 🙂 ".repeat(25000));
    const parts = splitArchive("Session_7", archive);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(HEADER + bodies(parts).join("")).toBe(archive);
    for (const part of parts) {
      expect(bytes(part.content)).toBeLessThanOrEqual(PART_TARGET_BYTES);
      expect(LONE_SURROGATE.test(part.content)).toBe(false);
    }
  });
});
