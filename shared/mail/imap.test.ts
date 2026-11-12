import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("draft reservation survives filing failure and restart while APPEND survives logout failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imap-out-"));
  const script = `
    import { mock } from "bun:test";
    let mode = "throw", sends = 0, moves = 0, appends = [];
    mock.module("imapflow", () => ({ ImapFlow: class {
      mailbox = { uidValidity: 17n };
      async connect() {}
      async getMailboxLock() { return { release() {} }; }
      async download() { return { content: new Blob(["To: recipient@example.test\\r\\n\\r\\nbody"]).stream() }; }
      async messageMove() { moves++; if (mode === "throw") throw new Error("filing unavailable"); return true; }
      async append(_folder, raw) { appends.push(raw); return mode === "no-uid" ? {} : mode === "false" ? false : { uid: 99 }; }
      async logout() { if (mode === "logout") throw new Error("logout unavailable"); }
      close() {}
    } }));
    mock.module(${JSON.stringify(join(import.meta.dir, "smtp.ts"))}, () => ({ envelope: () => ({ recipients: [] }), deriveSmtpHost: () => "smtp.example.test", sendRaw: async () => { sends++; await Bun.sleep(10); return { ok: true, detail: "SMTP result" }; } }));
    const { sendDraft, appendDraft } = await import(${JSON.stringify(join(import.meta.dir, "imap.ts"))});
    const account = { host: "imap.example.test", port: 993, secure: true, user: "sender@example.test", appPassword: "test" };
    if (process.env.RECOVERY === "true") {
      mode = "success";
      const result = await sendDraft(account, 1);
      if (!result.ok || sends !== 0 || moves !== 1) throw new Error(JSON.stringify({ result, sends, moves }));
    } else {
      const results = await Promise.all([sendDraft(account, 1), sendDraft(account, 1)]);
      if (sends !== 1 || !results.some(r => r.ok && r.detail.includes("do not resend"))) throw new Error(JSON.stringify(results));
      mode = "logout";
      const saved = await appendDraft(account, { to: "recipient@example.test", subject: "Hello", body: "Text" });
      if (!saved.ok || saved.id !== "99" || !saved.detail.includes("logout failed")) throw new Error(JSON.stringify(saved));
      mode = "success";
      const normal = await appendDraft(account, { to: "recipient@example.test", subject: "Hello", body: "Text" });
      if (!normal.ok || normal.id !== "99") throw new Error(JSON.stringify(normal));
      mode = "no-uid";
      const unidentified = await appendDraft(account, { to: "recipient@example.test", subject: "Hello", body: "Text" });
      if (!unidentified.ok || unidentified.id !== null || !unidentified.detail.includes("do not create another")) throw new Error(JSON.stringify(unidentified));
      mode = "false";
      const refused = await appendDraft(account, { to: "recipient@example.test", subject: "Hello", body: "Text" });
      if (refused.ok || refused.id !== null) throw new Error(JSON.stringify(refused));
      const before = appends.length;
      const invalid = await appendDraft(account, { to: "bad:address", subject: "Hello", body: "Text" });
      if (invalid.ok || appends.length !== before) throw new Error("header guard bypassed");
      mode = "success";
      await appendDraft(account, { to: "recipient@example.test", subject: "Hello\\r\\nBcc: hidden@example.test", body: "<b>plain text</b>" });
      const raw = appends.at(-1);
      if (raw.includes("\\r\\nBcc:") || !raw.includes("Content-Type: text/plain") || !raw.endsWith("<b>plain text</b>")) throw new Error("draft MIME changed");
    }
  `;
  try {
    for (const recovery of [false, true]) {
      const child = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, env: { ...process.env, EMBERVY_HOME: dir, RECOVERY: String(recovery) }, stdout: "pipe", stderr: "pipe" });
      const error = await new Response(child.stderr).text();
      expect({ code: await child.exited, error }).toEqual({ code: 0, error: "" });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
