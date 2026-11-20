import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

function safeTitleFont(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200 || /[^\p{L}\p{Nd} ,_'"-]/u.test(value)) return false;
  let quote = "";
  for (const char of value) {
    if (char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'")) quote = char;
  }
  return quote === "";
}
// The client reduces photos to 1600px JPEG at quality 0.85. Allow ample headroom.
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_LOOK_BODY_BYTES = Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 4096;
export type HouseLook = { titleText?: string; titleFont?: string; bgMode?: string; bgPhoto?: string };
export class HouseLookInputError extends Error {}
const invalid = (field: string): never => { throw new HouseLookInputError(`Invalid ${field}`); };
export function imageType(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
}
function validate(value: unknown): { look: HouseLook; photo?: Buffer } {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("appearance");
  const input = value as Record<string, unknown>, look: HouseLook = {};
  for (const key of Object.keys(input)) if (!["titleText", "titleFont", "bgMode", "bgPhoto"].includes(key)) invalid(key);
  if (Object.hasOwn(input, "titleText")) {
    if (typeof input.titleText !== "string" || input.titleText.length > 24 || /[\x00-\x1f\x7f]/.test(input.titleText)) invalid("titleText");
    look.titleText = input.titleText as string;
  }
  if (Object.hasOwn(input, "titleFont")) {
    if (!safeTitleFont(input.titleFont)) invalid("titleFont");
    look.titleFont = input.titleFont as string;
  }
  if (Object.hasOwn(input, "bgMode")) {
    if (!["color", "photo", "default"].includes(input.bgMode as string)) invalid("bgMode");
    look.bgMode = input.bgMode as string;
  }
  if (!Object.hasOwn(input, "bgPhoto")) return { look };
  if (input.bgPhoto === "") return { look: { ...look, bgPhoto: "" } };
  if (typeof input.bgPhoto !== "string" || input.bgPhoto.length > MAX_LOOK_BODY_BYTES) invalid("bgPhoto");
  const match = /^data:image\/(?:jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.bgPhoto as string);
  if (!match || match[1].length % 4 !== 0) invalid("bgPhoto");
  const photo = Buffer.from(match![1], "base64");
  // Trust the signature, not the client's MIME label; never accept active SVG content.
  if (!photo.length || photo.length > MAX_PHOTO_BYTES || !imageType(photo)) invalid("bgPhoto");
  look.bgPhoto = `house-look-photo-${createHash("sha256").update(photo).digest("hex")}`;
  return { look, photo };
}

export class HouseLookStore {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, "house-look.json"); }
  read(): HouseLook | null {
    try { return JSON.parse(readFileSync(this.path, "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  }
  publicLook(look = this.read()): HouseLook | null {
    return look && { ...look, ...(look.bgPhoto ? { bgPhoto: `/api/house-look/photo?v=${look.bgPhoto.slice("house-look-photo-".length)}` } : {}) };
  }
  private atomic(path: string, value: string | Buffer) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, value, { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  write(value: unknown, migrate = false): HouseLook {
    // No await between the existence check and commit: concurrent HTTP requests
    // in the app's single server process cannot both adopt a legacy device look.
    const previous = this.read();
    if (migrate && previous !== null) return previous;
    const { look, photo } = validate(value);
    if (photo) this.atomic(join(this.directory, look.bgPhoto!), photo);
    // Immutable photo first, JSON last: failure never changes the old visible pair.
    this.atomic(this.path, JSON.stringify(look) + "\n");
    if (previous?.bgPhoto && previous.bgPhoto !== look.bgPhoto && /^house-look-photo-[a-f0-9]{64}$/.test(previous.bgPhoto)) {
      try { unlinkSync(join(this.directory, previous.bgPhoto)); } catch { /* Orphan cleanup is not a failed commit. */ }
    }
    return look;
  }
  photo(version: string): { bytes: Buffer; type: string } | null {
    const name = this.read()?.bgPhoto;
    if (!name || !/^house-look-photo-[a-f0-9]{64}$/.test(name) || name !== `house-look-photo-${version}`) return null;
    const bytes = readFileSync(join(this.directory, name)), type = imageType(bytes);
    return type ? { bytes, type } : null;
  }
}

// Bound streamed bodies as well as Content-Length, before allocating a JSON string.
export async function readLookBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_LOOK_BODY_BYTES) {
    void request.body?.cancel().catch(() => {});
    invalid("body size");
  }
  const reader = request.body?.getReader();
  if (!reader) invalid("body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader!.read();
      if (done) break;
      size += value.length;
      if (size > MAX_LOOK_BODY_BYTES) { void reader!.cancel().catch(() => {}); invalid("body size"); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { invalid("JSON"); }
  } finally { reader!.releaseLock(); }
}
