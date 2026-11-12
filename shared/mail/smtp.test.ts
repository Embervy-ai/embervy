import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { envelope, sendRaw } from "./smtp";

// Read recipients only from headers, hide Bcc in transmitted data, and handle
// multiple response lines per packet with a timeout.

const CRLF = "\r\n";
const draft = [
  "From: Agent <agent@example.org>",
  "To: Alice <alice@example.org>,",
  " \"Doe, John\" <john@example.org>",
  "Cc: carol@example.org",
  "Bcc: secret@example.org",
  "Subject: Re: order",
  "",
  "Thanks, see below.",
  "",
  "-----Original Message-----",
  "From: boss@example.com",
  "To: chef@example.com, einkauf@example.com",
  "Cc: steuerberater@example.com",
  "Bcc: hidden@example.com",
  ".a line that starts with a dot",
].join(CRLF);

describe("envelope: the header alone decides", () => {
  test("recipients from To, Cc and Bcc of the header, folded lines and quoted commas included", () => {
    const e = envelope(draft);
    expect(e.from).toBe("agent@example.org");
    expect(e.recipients).toEqual(["alice@example.org", "john@example.org", "carol@example.org", "secret@example.org"]);
  });
  test("quoted headers in the body are text, and Bcc leaves the header but not the body", () => {
    const e = envelope(draft);
    expect(e.recipients).not.toContain("chef@example.com");
    expect(e.recipients).not.toContain("steuerberater@example.com");
    expect(e.data).not.toContain("secret@example.org");
    expect(e.data).toContain("Bcc: hidden@example.com"); // quoted text stays as written
    expect(e.data).toContain(" \"Doe, John\" <john@example.org>"); // folding kept
  });
  test("LF-only drafts work the same", () => {
    expect(envelope(draft.replaceAll(CRLF, "\n")).recipients).toEqual(["alice@example.org", "john@example.org", "carol@example.org", "secret@example.org"]);
  });
});

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function fakeSmtp(opts: { silent?: boolean; dropQuit?: boolean; rejectData?: boolean; silentAfterData?: boolean } = {}): Promise<{ port: number; log: string[]; data: () => string }> {
  const log: string[] = []; let data = "";
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      if (opts.silent) return; // accepts, never answers
      let buf = "", inData = false;
      sock.write("220 fake ESMTP" + CRLF);
      sock.on("data", (b) => {
        buf += b.toString();
        let i;
        while ((i = buf.indexOf(CRLF)) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (inData) {
            if (line === ".") { inData = false; if (!opts.silentAfterData) sock.write((opts.rejectData ? "554 rejected" : "250 queued") + CRLF); } else data += line + CRLF;
            continue;
          }
          log.push(line);
          // the multi-line answer goes out in ONE write, as real servers do
          if (line.startsWith("EHLO")) sock.write(["250-fake", "250-PIPELINING", "250-AUTH LOGIN", "250 8BITMIME"].join(CRLF) + CRLF);
          else if (line === "AUTH LOGIN" || log.length === 3) sock.write("334 go" + CRLF);
          else if (log.length === 4) sock.write("235 ok" + CRLF);
          else if (line === "DATA") { inData = true; sock.write("354 go" + CRLF); }
          else if (line === "QUIT") { if (opts.dropQuit) sock.destroy(); else { sock.write("221 bye" + CRLF); sock.end(); } }
          else sock.write("250 ok" + CRLF);
        }
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as any).port, log, data: () => data }));
  });
}

const account = (port: number) => ({ host: "127.0.0.1", port, secure: false, user: "agent@example.org", password: "pw" });

describe("sendRaw against a fake server", () => {
  test("foreign and ambiguous From headers fail before SMTP", async () => {
    for (const header of ["From: stranger@example.test", "From: agent@example.org, stranger@example.test", "From: agent@example.org\r\nFrom: stranger@example.test"]) {
      const result = await sendRaw(account(1), Buffer.from(`${header}\r\nTo: recipient@example.test\r\n\r\nText`));
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/From/);
    }
  });
  test("an explicit alias and a missing From use an authorized envelope and header", async () => {
    const previous = process.env.MAILBOX_FROM_ALIASES;
    process.env.MAILBOX_FROM_ALIASES = "alias@example.test,other@example.test";
    try {
      for (const from of ["alias@example.test", undefined]) {
        const srv = await fakeSmtp();
        const raw = `${from ? `From: ${from}\r\n` : ""}To: recipient@example.test\r\n\r\nText`;
        expect((await sendRaw(account(srv.port), Buffer.from(raw), 2000)).ok).toBe(true);
        const expected = from || "agent@example.org";
        expect(srv.log).toContain(`MAIL FROM:<${expected}>`);
        expect(srv.data()).toContain(`From: ${expected}`);
      }
    } finally { if (previous === undefined) delete process.env.MAILBOX_FROM_ALIASES; else process.env.MAILBOX_FROM_ALIASES = previous; }
  });
  test("accepted mail remains sent when QUIT loses the connection", async () => {
    const srv = await fakeSmtp({ dropQuit: true });
    const result = await sendRaw(account(srv.port), Buffer.from(draft), 2000);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("sent");
    expect(result.detail).toContain("cleanup failed");
    expect(result.detail).toContain("do not resend");
    expect(srv.log).toContain("QUIT");
  });

  test("DATA rejection remains a sending failure", async () => {
    const srv = await fakeSmtp({ rejectData: true });
    const result = await sendRaw(account(srv.port), Buffer.from(draft), 2000);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("554");
    // An explicit refusal is a definite outcome: nothing was sent.
    expect(result.maybeSent).toBe(false);
    expect(srv.log).not.toContain("QUIT");
  });
  test("only the header's recipients get a RCPT TO, the data carries no Bcc, multi-line answers are not lost", async () => {
    const srv = await fakeSmtp();
    const r = await sendRaw(account(srv.port), Buffer.from(draft), 2000);
    expect(r).toEqual({ ok: true, detail: "existing raw draft sent" });
    expect(srv.log.filter((l) => l.startsWith("RCPT TO"))).toEqual([
      "RCPT TO:<alice@example.org>", "RCPT TO:<john@example.org>", "RCPT TO:<carol@example.org>", "RCPT TO:<secret@example.org>",
    ]);
    expect(srv.log).toContain("MAIL FROM:<agent@example.org>");
    expect(srv.data()).not.toContain("secret@example.org");
    expect(srv.data()).toContain("..a line that starts with a dot");
  });

  test("no answer after the message bytes leaves the outcome open", async () => {
    const srv = await fakeSmtp({ silentAfterData: true });
    const r = await sendRaw(account(srv.port), Buffer.from(draft), 300);
    expect(r.ok).toBe(false);
    expect(r.maybeSent).toBe(true);
  });

  test("a server that never answers ends in a timeout, not a hang", async () => {
    const srv = await fakeSmtp({ silent: true });
    const started = Date.now();
    const r = await sendRaw(account(srv.port), Buffer.from(draft), 300);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("timeout");
    expect(r.maybeSent).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("no recipient in the header: nothing is sent", async () => {
    const r = await sendRaw(account(1), Buffer.from("Subject: x\r\n\r\nTo: someone@example.com\r\n"), 300);
    expect(r).toEqual({ ok: false, detail: "draft has no recipient headers", maybeSent: false });
  });
});
