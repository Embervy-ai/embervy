// SMTP transport for sending an EXISTING raw IMAP draft only.
// No compose API is exported: callers supply bytes fetched from Drafts.
// Custom providers should set an explicit SMTP host and port rather than rely on derivation.
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface SmtpAccount { host: string; port: number; secure: boolean; user: string; password: string }
/** `maybeSent` is true when the message bytes reached the server but no acceptance came back. */
export interface SmtpResult { ok: boolean; detail: string; maybeSent?: boolean }

/** No answer from the server within this long ends the attempt. */
export const SMTP_TIMEOUT_MS = 30_000;

export function deriveSmtpHost(imapHost: string): string {
  if (imapHost.startsWith("imap.")) return `smtp.${imapHost.slice(5)}`;
  const known: Record<string,string> = { "posteo.de": "posteo.de" };
  return known[imapHost] || imapHost;
}

/** One address list ("a@x, \"Doe, J\" <j@y>") → bare addresses. Commas inside
 * quotes or angle brackets do not split. */
function addresses(value: string): string[] {
  const parts: string[] = [];
  let cur = "", quoted = false, angle = false;
  for (const ch of value) {
    if (ch === '"' ) quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if (ch === "," && !quoted && !angle) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.match(/<([^>]+)>/)?.[1]?.trim() || p.replace(/"[^"]*"/g, "").trim()).filter(Boolean);
}

/** Read recipients only from headers so quoted body text cannot add recipients.
 * Join folded headers and remove Bcc from the transmitted message. */
export function envelope(raw: string): { from: string | null; recipients: string[]; data: string } {
  const lf = raw.indexOf("\n\n"), crlf = raw.indexOf("\r\n\r\n");
  const cut = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf >= 0 ? lf : raw.length;
  const header = raw.slice(0, cut), rest = raw.slice(cut);
  const nl = header.includes("\r\n") ? "\r\n" : "\n";
  const fields: string[] = [];
  for (const line of header.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1] += nl + line;
    else fields.push(line);
  }
  const value = (field: string) => field.slice(field.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  const named = (name: string) => fields.filter((f) => f.toLowerCase().startsWith(name.toLowerCase() + ":"));
  const fromFields = named("From");
  if (fromFields.length > 1) throw new Error("draft has multiple From headers");
  const from = fromFields.map(value)[0] ?? null;
  if (from !== null && addresses(from).length !== 1) throw new Error("draft must have exactly one From address");
  const recipients = [...named("To"), ...named("Cc"), ...named("Bcc")].flatMap((f) => addresses(value(f)));
  const data = fields.filter((f) => !/^bcc:/i.test(f)).join(nl) + rest;
  return { from: from ? (addresses(from)[0] ?? from) : null, recipients: [...new Set(recipients)], data };
}

/** Lines in arrival order, kept until read: a server sends a multi-line answer
 * in one packet, and a line nobody was waiting for yet must not be lost. A
 * timeout, an error or a closed connection fails every pending and later read. */
function lineReader(socket: any, timeoutMs: number) {
  let buf = ""; let failed: Error | null = null;
  const lines: string[] = [];
  const waiters: Array<{ resolve: (s: string) => void; reject: (e: Error) => void }> = [];
  const fail = (e: Error) => { failed ??= e; for (const w of waiters.splice(0)) w.reject(failed); };
  socket.on("data", (b: Buffer) => {
    buf += b.toString("utf8"); let i;
    while ((i = buf.indexOf("\r\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); const w = waiters.shift(); if (w) w.resolve(l); else lines.push(l); }
  });
  socket.on("error", (e: Error) => fail(e));
  socket.on("close", () => fail(new Error("SMTP connection closed")));
  socket.setTimeout(timeoutMs, () => { fail(new Error("SMTP timeout")); socket.destroy(); });
  return () => {
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (failed) return Promise.reject(failed);
    return new Promise<string>((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

export async function sendRaw(account: SmtpAccount, raw: Buffer, timeoutMs = SMTP_TIMEOUT_MS): Promise<SmtpResult> {
  let socket: any;
  let accepted = false;
  let dataWritten = false;
  try {
    let { from, recipients, data } = envelope(raw.toString("utf8"));
    const allowed = [account.user, ...(process.env.MAILBOX_FROM_ALIASES || "").split(",")].map(s => s.trim().toLowerCase()).filter(Boolean);
    if (from && !allowed.includes(from.toLowerCase())) throw new Error("draft From is not the account or a configured MAILBOX_FROM_ALIASES address");
    if (!from) data = `From: ${account.user}\r\n${data}`;
    if ([from || account.user, ...recipients].some(s => /[\r\n<>]/.test(s))) throw new Error("invalid envelope address");
    socket = account.secure ? tlsConnect({ host: account.host, port: account.port, servername: account.host }) : connect({ host: account.host, port: account.port });
    const read = lineReader(socket, timeoutMs);
    const response = async () => { let l=await read(); const code=Number(l.slice(0,3)); while (l[3]==="-") l=await read(); return {code,line:l}; };
    const cmd = async (s:string, ok:number[]) => { socket.write(s+"\r\n"); const r=await response(); if(!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.line}`); };
    if(!recipients.length) throw new Error("draft has no recipient headers");
    await response();
    await cmd("EHLO embervy.local", [250]);
    await cmd("AUTH LOGIN", [334]);
    await cmd(Buffer.from(account.user).toString("base64"), [334]);
    await cmd(Buffer.from(account.password).toString("base64"), [235]);
    await cmd(`MAIL FROM:<${from || account.user}>`, [250]);
    for(const to of recipients) await cmd(`RCPT TO:<${to}>`, [250,251]);
    await cmd("DATA", [354]);
    // Preserve message bytes except SMTP-required dot stuffing and terminator.
    socket.write(Buffer.from(data.replace(/(^|\r\n)\./g, "$1..")+"\r\n.\r\n"));
    dataWritten = true;
    const sent=await response();
    // An explicit answer other than 250 is a refusal, so only a missing answer leaves the outcome open.
    if(sent.code!==250) { dataWritten = false; throw new Error(`SMTP ${sent.code}: ${sent.line}`); }
    // SMTP acceptance remains success because retrying after cleanup failure duplicates delivery.
    accepted = true;
    await cmd("QUIT", [221]); socket.end();
    return { ok:true, detail:"existing raw draft sent" };
  } catch(e:any) {
    try { socket?.destroy(); } catch {}
    const detail = e?.message || String(e);
    return accepted
      ? { ok: true, detail: `existing raw draft sent; SMTP cleanup failed: ${detail}; do not resend` }
      : { ok: false, detail, maybeSent: dataWritten };
  }
}
