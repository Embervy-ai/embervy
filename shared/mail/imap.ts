// Reads mail and manages drafts over IMAP.

import { ImapFlow } from "imapflow";
import { deriveSmtpHost, sendRaw, envelope } from "./smtp";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { houseHome } from "../scripts/legacy-names";

export interface MailAccount {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  appPassword: string;
}

export interface MailMessage {
  messageId?: string;
  uid: number;
  from: string;
  subject: string;
  date: Date | null;
  text: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

function client(account: MailAccount): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.appPassword },
    logger: false,
  });
}

export async function probe(account: MailAccount): Promise<ProbeResult> {
  const c = client(account);
  try {
    await c.connect();
    const mailbox = await c.mailboxOpen("INBOX");
    await c.logout();
    return { ok: true, detail: `INBOX reachable (${mailbox.exists} messages)` };
  } catch (e: any) {
    try { c.close(); } catch {}
    return { ok: false, detail: e?.message || String(e) };
  }
}

function pickBodyPart(node: any): { part: string; isHtml: boolean } | null {
  if (!node) return null;
  const type = (node.type || "").toLowerCase();
  const isAttachment = (node.disposition || "").toLowerCase() === "attachment";
  if (node.part && !isAttachment && (type === "text/plain" || type === "text/html")) {
    return { part: node.part, isHtml: type === "text/html" };
  }
  if (Array.isArray(node.childNodes)) {
    let htmlFallback: { part: string; isHtml: boolean } | null = null;
    for (const child of node.childNodes) {
      const found = pickBodyPart(child);
      if (found && !found.isHtml) return found;
      if (found && found.isHtml && !htmlFallback) htmlFallback = found;
    }
    return htmlFallback;
  }
  return null;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  auml: "\u00e4", ouml: "\u00f6", uuml: "\u00fc", Auml: "\u00c4", Ouml: "\u00d6", Uuml: "\u00dc",
  szlig: "\u00df", euro: "€", copy: "©", reg: "®", mdash: "—", ndash: "–",
  hellip: "…", laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”",
};

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6]|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, n) => {
      const value = /^x/i.test(n) ? parseInt(n.slice(1), 16) : Number(n);
      return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
    })
    .replace(/&([a-z]+);/gi, (m, name) => (name in HTML_ENTITIES ? HTML_ENTITIES[name] : m))
    .replace(/[ \t]*\n[ \t]*/g, "\n") 
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// IMAP SINCE has no time-of-day precision; repeated polls need a UID cursor to avoid duplicates.
export async function fetchSince(account: MailAccount, since: Date, maxBodyChars = 2000): Promise<MailMessage[]> {
  const c = client(account);
  const out: MailMessage[] = [];
  try {
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    try {
      const metas = await fetchMetas(c, { since });
      for (const meta of await downloadBodies(c, metas, maxBodyChars)) out.push(meta);
    } finally {
      lock.release();
    }
    await c.logout();
  } catch (e: any) {
    try { c.close(); } catch {}
    throw new Error(`fetchSince failed: ${e?.message || e}`);
  }
  return out;
}

export interface UidCursor {
  uidValidity: string; // JSON cannot serialize BigInt.
  lastUid: number;
}

export interface UidFetchResult {
  messages: MailMessage[];
  cursor: UidCursor;
}

export async function fetchSinceUid(
  account: MailAccount,
  cursor: UidCursor | null,
  maxBodyChars = 2000,
): Promise<UidFetchResult> {
  const c = client(account);
  const out: MailMessage[] = [];
  try {
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    let newCursor: UidCursor;
    try {
      const mailbox = c.mailbox;
      if (!mailbox || typeof mailbox === "boolean") throw new Error("mailboxOpen did not return mailbox status");
      const uidValidity = String(mailbox.uidValidity);
      const uidNext = mailbox.uidNext ?? 1;

      const validityChanged = cursor !== null && cursor.uidValidity !== uidValidity;
      if (cursor === null) {
        newCursor = { uidValidity, lastUid: Math.max(0, uidNext - 1) };
      } else if (validityChanged) {
        // An overlapping date scan preserves arrivals across mailbox renumbering.
        const metas = await fetchMetas(c, { since: new Date(Date.now() - 86400000) });
        for (const meta of await downloadBodies(c, metas, maxBodyChars)) out.push(meta);
        newCursor = { uidValidity, lastUid: metas.reduce((max, m) => Math.max(max, m.uid), Math.max(0, uidNext - 1)) };
      } else {
        const rangeStart = cursor.lastUid + 1;
        const metas = await fetchMetas(c, { uid: `${rangeStart}:*` }, { uid: true });
        // Some servers match the highest UID for "*" even when the range starts above it.
        const fresh = metas.filter((m) => m.uid >= rangeStart);
        for (const meta of await downloadBodies(c, fresh, maxBodyChars)) out.push(meta);
        const highest = fresh.reduce((max, m) => Math.max(max, m.uid), cursor.lastUid);
        newCursor = { uidValidity, lastUid: highest };
      }
    } finally {
      lock.release();
    }
    await c.logout();
    return { messages: out, cursor: newCursor };
  } catch (e: any) {
    try { c.close(); } catch {}
    throw new Error(`fetchSinceUid failed: ${e?.message || e}`);
  }
}

interface RawMeta {
  messageId?: string;
  uid: number;
  from: string;
  subject: string;
  date: Date | null;
  pick: { part: string; isHtml: boolean } | null;
}

async function fetchMetas(
  c: ImapFlow,
  range: { since: Date } | { uid: string },
  fetchOptions?: { uid?: boolean },
): Promise<RawMeta[]> {
  const metas: RawMeta[] = [];
  const query = "since" in range ? await c.search({ since: range.since }, { uid: true }) : range.uid;
  if (!query || (Array.isArray(query) && query.length === 0)) return metas;
  for await (const msg of c.fetch(query, { envelope: true, bodyStructure: true, uid: true }, "since" in range ? { uid: true } : fetchOptions)) {
    const from = msg.envelope?.from?.map((a) => a.address || a.name).filter(Boolean).join(", ") || "unknown";
    const subject = msg.envelope?.subject || "(no subject)";
    const date = msg.envelope?.date || null;
    metas.push({ messageId: msg.envelope?.messageId, uid: msg.uid, from, subject, date, pick: pickBodyPart(msg.bodyStructure) });
  }
  return metas;
}

// Separate downloads keep attachments and full MIME messages out of memory.
async function downloadBodies(c: ImapFlow, metas: RawMeta[], maxBodyChars: number): Promise<MailMessage[]> {
  const out: MailMessage[] = [];
  for (const meta of metas) {
    let text = "";
    if (meta.pick) {
      try {
        const dl = await c.download(String(meta.uid), meta.pick.part, { uid: true });
        if (dl?.content) {
          const buf = await new Response(dl.content as any).arrayBuffer();
          const raw = Buffer.from(buf).toString("utf8");
          text = meta.pick.isHtml ? htmlToText(raw) : raw.trim();
        }
      } catch {
        text = ""; 
      }
    }
    out.push({ messageId: meta.messageId, uid: meta.uid, from: meta.from, subject: meta.subject, date: meta.date, text: text.slice(0, maxBodyChars) });
  }
  return out;
}

// Caller-supplied line breaks would inject additional headers into the raw MIME message.
function stripHeaderInjection(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// Colons can look like header boundaries to downstream parsers.
function sanitizeAddress(value: string): string {
  const clean = stripHeaderInjection(value);
  if (/[:\n\r]/.test(clean)) throw new Error(`invalid address/header value: ${JSON.stringify(value)}`);
  return clean;
}

export async function appendDraft(
  account: MailAccount,
  opts: { to: string; subject: string; body: string; inReplyTo?: string },
  draftsFolder = "Drafts",
): Promise<ProbeResult & { id: string | null }> {
  const c = client(account);
  try {
    const to = sanitizeAddress(opts.to);
    const subject = stripHeaderInjection(opts.subject);
    const inReplyTo = opts.inReplyTo ? sanitizeAddress(opts.inReplyTo) : undefined;
    await c.connect();
    const headers = [
      `From: ${account.user}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
      `Date: ${new Date().toUTCString()}`,
      `Content-Type: text/plain; charset=utf-8`,
      "MIME-Version: 1.0",
    ].filter(Boolean).join("\r\n");
    const raw = `${headers}\r\n\r\n${opts.body}`;
    const res = await c.append(draftsFolder, raw, ["\\Draft"]);
    const id = res && Number.isSafeInteger(res.uid) && Number(res.uid) > 0 ? String(res.uid) : null;
    // Without UIDPLUS the draft may exist, but guessing its UID could send a different message.
    const detail = id ? `draft saved to ${draftsFolder}` : `draft append not identified in ${draftsFolder}; inspect the mailbox; do not create another draft`;
    try { await c.logout(); } catch (e: any) {
      try { c.close(); } catch {}
      if (res) return { ok: true, id, detail: `${detail}; logout failed; do not create another draft` };
      throw e;
    }
    return res
      ? { ok: true, id, detail }
      : { ok: false, id: null, detail: `append to ${draftsFolder} returned false` };
  } catch (e: any) {
    try { c.close(); } catch {}
    return { ok: false, id: null, detail: e?.message || String(e) };
  }
}

export async function readDraft(account: MailAccount, draftUid: number, draftsFolder = "Drafts") {
  if (!Number.isSafeInteger(draftUid) || draftUid < 1) throw new Error("invalid draft UID");
  const c = client(account);
  try {
    await c.connect();
    const lock = await c.getMailboxLock(draftsFolder);
    try {
      const validity = String(c.mailbox && c.mailbox.uidValidity || "");
      if (!validity) throw new Error("missing UIDVALIDITY");
      const dl = await c.download(String(draftUid), undefined, { uid: true });
      const raw = Buffer.from(await new Response(dl.content as any).arrayBuffer());
      const parsed = envelope(raw.toString("utf8"));
      const message = await c.fetchOne(String(draftUid), { envelope: true, bodyStructure: true }, { uid: true });
      if (!message) throw new Error("draft no longer exists");
      const structure = message.bodyStructure;
      const part = pickBodyPart(structure) || (structure?.type === "text/plain" || structure?.type === "text/html" ? { part: "1", isHtml: structure.type === "text/html" } : null);
      let preview = "No readable text body";
      if (part) {
        const body = await c.download(String(draftUid), part.part, { uid: true });
        preview = await new Response(body.content as any).text();
        if (part.isHtml) preview = htmlToText(preview);
      }
      return { hash: createHash("sha256").update(validity).update(raw).digest("hex"),
        detail: `To: ${parsed.recipients.join(", ")}\nSubject: ${message.envelope?.subject || ""}\n\n${preview.slice(0, 800)}` };
    } finally { lock.release(); }
  } finally { try { await c.logout(); } catch { try { c.close(); } catch {} } }
}

export async function sendDraft(
  account: MailAccount,
  draftUid: number,
  draftsFolder = "Drafts",
  sentFolder = "Sent",
  expectedHash?: string,
  filingOnly = false,
): Promise<ProbeResult> {
  if (!Number.isSafeInteger(draftUid) || draftUid < 1) return { ok: false, detail: "invalid draft UID" };
  const c = client(account);
  let accepted = false;
  try {
    await c.connect();
    const lock = await c.getMailboxLock(draftsFolder);
    try {
      const validity = String(c.mailbox && c.mailbox.uidValidity || "");
      if (!validity) throw new Error("missing UIDVALIDITY");
      const key = createHash("sha256").update(JSON.stringify([account.host, account.port, account.user, draftsFolder, validity, draftUid])).digest("hex");
      const dir = join(houseHome(process.env, existsSync), "state", "mail-draft-sends");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, key + ".json");
      const save = (status: string) => {
        writeFileSync(path + ".tmp", JSON.stringify({ status }), { mode: 0o600 });
        renameSync(path + ".tmp", path);
      };
      let previous: any;
      try { previous = JSON.parse(readFileSync(path, "utf8")); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (previous?.status === "filed") return { ok: true, detail: "draft already sent and filed; do not resend" };
      if (previous && previous.status !== "sent") return { ok: false, detail: "draft sending or possibly sent; do not resend; inspect the mailbox" };
      if (!previous && filingOnly) return { ok: false, detail: "No confirmed send record; filing recovery does not send mail" };
      if (!previous) {
        const dl = await c.download(String(draftUid), undefined, { uid: true });
        const raw = Buffer.from(await new Response(dl.content as any).arrayBuffer());
        const hash = createHash("sha256").update(validity).update(raw).digest("hex");
        if (expectedHash && hash !== expectedHash) throw new Error("draft changed since approval; not sent");
        // Exclusive creation reserves the draft across processes before SMTP can accept it.
        try { writeFileSync(path, JSON.stringify({ status: "sending" }), { flag: "wx", mode: 0o600 }); }
        catch (e: any) { if (e.code === "EEXIST") return { ok: false, detail: "draft already sending or sent; do not resend" }; throw e; }
        const smtp = await sendRaw({ host: deriveSmtpHost(account.host), port: 465, secure: true, user: account.user, password: account.appPassword }, raw);
        if (!smtp.ok) {
          // A failure before the message bytes left releases the reservation, because nothing can have been sent.
          if (!smtp.maybeSent) { rmSync(path, { force: true }); return { ok: false, detail: `${smtp.detail}; not sent` }; }
          save("unknown"); return { ok: false, detail: `${smtp.detail}; possibly sent; do not resend; inspect the mailbox` };
        }
        accepted = true;
        save("sent");
      } else accepted = true;
      // Filing is retried independently because SMTP acceptance must never be replayed.
      const moved = await c.messageMove(String(draftUid), sentFolder, { uid: true });
      if (!moved) throw new Error("messageMove returned false");
      save("filed");
      return { ok: true, detail: `draft already sent or sent now and moved to ${sentFolder}; do not resend` };
    } finally { lock.release(); }
  } catch (e: any) {
    return { ok: accepted, detail: `${e?.message || String(e)}${accepted ? "; draft sent; filing incomplete; do not resend" : ""}` };
  } finally { try { await c.logout(); } catch { try { c.close(); } catch {} } }
}

export const KNOWN_PROVIDERS: Record<string, { host: string; port: number; secure: boolean; draftsFolder?: string }> = {
  gmail: { host: "imap.gmail.com", port: 993, secure: true, draftsFolder: "[Gmail]/Drafts" },
  gmx: { host: "imap.gmx.net", port: 993, secure: true },
  "web.de": { host: "imap.web.de", port: 993, secure: true },
  "mailbox.org": { host: "imap.mailbox.org", port: 993, secure: true },
  posteo: { host: "posteo.de", port: 993, secure: true },
  icloud: { host: "imap.mail.me.com", port: 993, secure: true },
};
