import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const STRINGS = JSON.parse(readFileSync(join(import.meta.dir, "strings/en.json"), "utf8"));
const start = SOURCE.indexOf("  function uploadRefusal(status, name) {");
const end = SOURCE.indexOf("  async function sendMessage() {");
const t = (key: string, vars: { name: string }) => `${key}|${vars.name}`;
const uploadRefusal = new Function("t", `${SOURCE.slice(start, end)}\nreturn uploadRefusal;`)(t) as (status: number, name: string) => string;

describe("a refused upload says why", () => {
  test("size, type and everything else map to their own message", () => {
    expect(uploadRefusal(413, "clip.mp4")).toBe("chat.uploadTooLarge|clip.mp4");
    expect(uploadRefusal(415, "clip.mkv")).toBe("chat.uploadNotAllowed|clip.mkv");
    for (const status of [400, 401, 500, 502]) expect(uploadRefusal(status, "a.png")).toBe("chat.uploadFailed|a.png");
  });
  test("every message exists and names the file", () => {
    for (const key of ["chat.uploadTooLarge", "chat.uploadNotAllowed", "chat.uploadFailed"]) expect(STRINGS[key]).toContain("{name}");
  });
  test("the upload loop shows the refusal instead of dropping it, also without a JSON body", () => {
    const loop = SOURCE.slice(SOURCE.indexOf('await fetch("/api/image"'), SOURCE.indexOf("uploadsInFlight--;"));
    expect(loop).toContain("res.json().catch(() => null)");
    expect(loop).toContain("res.ok && data?.ok");
    expect(loop).toContain("uploadRefusal(res.status, file.name)");
  });
});
