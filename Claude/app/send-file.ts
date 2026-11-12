import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { appReplyId, isSafeMessageId } from "./message-fields";
import { positiveFiniteSetting } from "./security-config";

export function mediaPolicy(env: Record<string, string | undefined> = process.env) {
  return {
    extensions: new Set((env.ALLOWED_IMAGE_EXTS ?? "jpg,jpeg,png,gif,webp,heic,pdf,txt,md,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,csv")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean)),
    maxBytes: positiveFiniteSetting(env.MAX_IMAGE_BYTES, 20 * 1024 * 1024),
  };
}

type Delivery = { ok: true } | { ok: false; reason: string };
type Options = {
  mediaDir: string;
  deliver: (message: { id: string } & Record<string, unknown>) => Promise<Delivery>;
  env?: Record<string, string | undefined>;
};

export async function sendFile(args: Record<string, unknown> | undefined, options: Options) {
  const error = (reason: string) => ({ isError: true, content: [{ type: "text" as const, text: `error: ${reason}` }] });
  if (typeof args?.path !== "string" || !isAbsolute(args.path)) return error("path must be an absolute file path");
  if (args.caption !== undefined && typeof args.caption !== "string") return error("caption must be text");
  if (args.id !== undefined && args.id !== "" && !(typeof args.id === "string" && isSafeMessageId(args.id))) return error("id must be the unchanged retry id (at most 64 letters, digits, . _ : -)");
  const id = String(args.id || crypto.randomUUID());
  const policy = mediaPolicy(options.env);
  const ext = extname(args.path).slice(1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext) || !policy.extensions.has(ext)) return error(`extension .${ext} not allowed`);
  // Keep the original basename as plain text; the client escapes it at render time.
  const name = basename(args.path).split("\\").pop()!.replace(/[\u0000-\u001f\u007f-\u009f]/g, "_");
  const filename = `${crypto.randomUUID()}.${ext}`;
  const destination = join(options.mediaDir, filename);
  let copied = false;
  try {
    // Nonblocking open allows FIFO rejection without waiting for a writer.
    // Symlinks could disguise a sensitive file as an allowed extension.
    let source;
    try {
      source = await open(args.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") return error("path must not be a symbolic link");
      throw err;
    }
    try {
      const stat = await source.stat();
      if (!stat.isFile()) return error("path must be a regular file");
      if (stat.size > policy.maxBytes) return error(`file too large (max ${policy.maxBytes} bytes)`);
      await mkdir(options.mediaDir, { recursive: true });
      const target = await open(destination, "wx");
      copied = true;
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > policy.maxBytes) throw new Error(`file too large (max ${policy.maxBytes} bytes)`);
          await target.writeFile(buffer.subarray(0, bytesRead));
        }
      } finally { await target.close(); }
    } finally { await source.close(); }
  } catch (err) {
    if (copied) await unlink(destination).catch(() => {});
    return error(`could not copy file: ${(err as Error).message}`);
  }

  const image = /^(jpg|jpeg|png|gif|webp|heic)$/.test(ext);
  const message = {
    id,
    text: (args.caption as string | undefined)?.trim() || (image ? "[Image]" : `[File: ${name}]`),
    ts: new Date().toISOString(),
    type: image ? "image" : "file",
    file_name: name,
    ...(image ? { image_url: `/api/images/${filename}` } : { file_url: `/api/images/${filename}` }),
    reply_to: appReplyId(args.reply_to),
  };
  try {
    const delivery = await options.deliver(message);
    if (delivery.ok) return { content: [{ type: "text" as const, text: `Sent file: ${name} (id ${id})` }] };
    // A lost acknowledgement may already have stored the URL: keep its file intact.
    return error(`NOT delivered: ${delivery.reason}. Retry send_file with the same path, caption, reply_to and id "${id}".`);
  } catch (err) {
    return error(`NOT delivered: ${(err as Error).message}. Retry send_file with the same path, caption, reply_to and id "${id}".`);
  }
}
