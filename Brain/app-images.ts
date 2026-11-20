import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isForeignEntry, type InboxEntry } from "./app-channel";
import { tr } from "./texts";

// Same vision fallback as claude-pipe.ts; encoded length is not a token count.
export const APP_IMAGE_TOKENS = 1600;
export interface AppImageRef { image_path: string; file_name?: string }
export interface AppImageConfig { enabled: boolean; root: string; maxBytes: number; maxCount: number; maxTotalBytes: number }
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type RequestMessage<T> = Omit<T, "content"> & { content: string | null | Array<{ type: "text"; text: string } | ImagePart> };
type TextMessage = { role: string; content: string | null };

const IMAGE_ERROR_CODES = [
  "unsupported_image_role", "invalid_image_part", "unsupported_image_format", "image_provider_error",
] as const;

/** Untrusted endpoint JSON: construct diagnostics only from independently checked fields.
 * Never copy message, raw text, or extra fields (which may echo the entire request).
 */
export function imageErrorDiagnostic(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const { code, phase, status } = error as Record<string, unknown>;
  const fields: string[] = [];
  if (typeof code === "string" && IMAGE_ERROR_CODES.some((allowed) => code === allowed)) fields.push(`code=${code}`);
  if (phase === "input" || phase === "provider") fields.push(`phase=${phase}`);
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) fields.push(`status=${status}`);
  return fields.join(" ");
}

export function appImageConfig(env: Record<string, string | undefined> = process.env): AppImageConfig {
  const positive = (key: string, fallback: number) => {
    const value = Number(env[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  // The product app keeps images beside inbox.jsonl; houses may override that layout.
  const root = env.BRAIN_APP_IMAGES_DIR || (env.BRAIN_APP_INBOX_FILE ? join(dirname(env.BRAIN_APP_INBOX_FILE), "images") : "");
  return { enabled: !/^(off|0|false|no)$/i.test(env.BRAIN_APP_IMAGES ?? ""), root,
    maxBytes: positive("BRAIN_APP_IMAGE_MAX_BYTES", 8 * 1024 * 1024),
    maxCount: positive("BRAIN_APP_IMAGES_MAX_COUNT", 4),
    maxTotalBytes: positive("BRAIN_APP_IMAGES_MAX_TOTAL_BYTES", 20 * 1024 * 1024) };
}

/** Called only with entries returned by readInbox, never parsed from channel text. */
export function inboxImageRefs(entry: InboxEntry): AppImageRef[] {
  if (isForeignEntry(entry) || (!entry.image_path && entry.type !== "image")) return [];
  return [{ image_path: typeof entry.image_path === "string" ? entry.image_path : "",
    file_name: typeof entry.file_name === "string" ? entry.file_name : undefined }];
}

export function imageMime(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.toString("latin1", 0, 6))) return "image/gif";
  return null;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function safeName(ref: AppImageRef): string {
  return basename(ref.file_name || ref.image_path || "unknown").replace(/[\x00-\x1f\x7f\u0085\u2028\u2029<>\[\]]/g, "_").slice(0, 160);
}
export function imageNote(name: string, mime: string, size: number | "unknown"): string {
  return `[${tr("image")}: ${name}; ${mime}; ${size} bytes]`;
}
function withNotes(text: string, notes: string[]): string {
  if (!notes.length) return text;
  // Keep notes inside the channel body: bridge/archive cleaners retain bodies only.
  const end = text.lastIndexOf("</channel>");
  return end < 0 ? `${text}\n${notes.join("\n")}` : `${text.slice(0, end).trimEnd()}\n${notes.join("\n")}\n${text.slice(end)}`;
}

/** One instance per API turn, never a RuntimeState/history/log field. */
export class AppImageTurn {
  private count = 0;
  private total = 0;
  private parts = new Map<TextMessage, ImagePart[]>();
  private originals: TextMessage[] = [];
  constructor(private readonly config: AppImageConfig, private readonly transport: string) {}

  prepare(text: string, refs: readonly AppImageRef[]): { text: string; parts: ImagePart[] } {
    if (!this.config.enabled || this.transport !== "api") return { text, parts: [] };
    const notes: string[] = [], parts: ImagePart[] = [];
    for (const ref of refs) {
      const name = safeName(ref);
      let size: number | "unknown" = "unknown", mime = "unknown", fd: number | undefined;
      let reason = "Image file could not be read safely";
      try {
        if (!this.config.root) { reason = "App images directory is not configured"; throw 0; }
        if (this.count >= this.config.maxCount) { reason = "Image count limit for this turn exceeded"; throw 0; }
        const root = realpathSync(this.config.root);
        if (!statSync(root).isDirectory()) throw 0;
        if (!ref.image_path) { reason = "Image path is missing"; throw 0; }
        const path = realpathSync(resolve(ref.image_path));
        if (!inside(root, path)) { reason = "Image path is outside the app images directory"; throw 0; }
        // NONBLOCK prevents a substituted FIFO from hanging Brain. NOFOLLOW
        // and the opened-fd check also cover a symlink/ancestor swap after realpath.
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = realpathSync(`/proc/self/fd/${fd}`);
        if (opened !== path || !inside(root, opened)) { reason = "Image path is outside the app images directory or changed"; throw 0; }
        const before = fstatSync(fd);
        if (!before.isFile()) { reason = "Image path is not a regular file"; throw 0; }
        size = before.size;
        if (size > this.config.maxBytes) { reason = "Image is too large (per-image byte limit)"; throw 0; }
        if (size > this.config.maxTotalBytes - this.total) { reason = "Total image byte limit for this turn exceeded"; throw 0; }
        // Bounded read, including one byte to detect growth rather than truncate.
        const data = Buffer.alloc(size + 1);
        let used = 0;
        while (used < data.length) {
          const n = readSync(fd, data, used, data.length - used, used);
          if (!n) break;
          used += n;
        }
        const after = fstatSync(fd);
        if (used !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          reason = "Image file changed while reading"; throw 0;
        }
        const bytes = data.subarray(0, used);
        const detected = imageMime(bytes);
        if (!detected) { reason = "Image type is not recognized (JPEG, PNG, WebP or GIF required)"; throw 0; }
        mime = detected;
        parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
        this.count += 1; this.total += size;
        notes.push(imageNote(name, mime, size));
      } catch {
        // Fixed reasons only; never stringify filesystem errors or file contents.
        notes.push(`${imageNote(name, mime, size)} Image not attached: ${reason}.`);
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    return { text: withNotes(text, notes), parts };
  }

  bind(message: TextMessage, parts: ImagePart[]): void {
    if (!parts.length) return;
    this.parts.set(message, parts); this.originals.push(message);
  }
  alias(original: TextMessage, copy: TextMessage): void {
    const parts = this.parts.get(original);
    if (parts) this.parts.set(copy, parts);
  }
  retained(history: readonly TextMessage[], rolledIndex: number): TextMessage[] {
    return this.originals.filter((message) => history.indexOf(message) < rolledIndex);
  }
  request<T extends TextMessage>(projected: T[], originals: readonly TextMessage[] = projected): RequestMessage<T>[] {
    return projected.map((message, index) => {
      const parts = this.parts.get(originals[index]);
      return parts ? { ...message, content: [{ type: "text", text: message.content ?? "" }, ...parts] } : { ...message };
    });
  }
  /** An endpoint may echo its input, even on success. Strip exact payloads before persistence. */
  redact(text: string): string {
    for (const message of this.originals) for (const part of this.parts.get(message) ?? []) {
      const url = part.image_url.url;
      text = text.replaceAll(url, "[image bytes omitted]").replaceAll(url.slice(url.indexOf(",") + 1), "[image bytes omitted]");
    }
    return text;
  }
  get hasImages(): boolean { return this.count > 0; }
  clear(): void { this.parts.clear(); this.originals = []; this.count = 0; this.total = 0; }
}

export function imageContentChars(content: unknown): number {
  if (Array.isArray(content)) return content.reduce((sum, part) => sum + imageContentChars(part), 0);
  if (content && typeof content === "object") {
    const part = content as { type?: string; text?: string };
    if (["image", "image_url", "input_image"].includes(part.type ?? "")) return APP_IMAGE_TOKENS * 3.6;
    if (part.type === "text") return (part.text ?? "").length;
  }
  return typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
}
