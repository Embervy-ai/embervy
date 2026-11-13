#!/usr/bin/env bun
// Connects app messages and tools to the MCP channel.

import { existsSync, readFileSync, mkdirSync, renameSync, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { calendarToolDefinition, callCalendarTool } from "../../shared/calendar/tool";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { envValue, houseHome } from "../../shared/scripts/legacy-names";
import { appReplyId, cleanReplyTo, defuseChannelTags, defuseSenderLines, replyQuoteLine, safeChannelMeta } from "./message-fields";
import { sendFile } from "./send-file";
import { readJsonlBatch } from "./jsonl-history";
import { loadStrings, t } from "./strings";
import { positiveFiniteSetting } from "./security-config";
const S = (key: string) => t(loadStrings().strings, key);
const mailboxWritingSetUp = () => (process.env.MAILBOX_ALLOW_SEND || "false").toLowerCase() === "true";

const APP_DIR = join(import.meta.dir);
const DATA_DIR = envValue("EMBERVY_APP_DATA_DIR") || join(APP_DIR, "data");
const INBOX = join(DATA_DIR, "inbox.jsonl");

const EMBERVY_HOME = houseHome(process.env, existsSync);
const APP_HOST = envValue("EMBERVY_APP_HOST") || "127.0.0.1";
const APP_PORT = envValue("EMBERVY_APP_PORT") || "3030";
const APP_BASE = `http://${APP_HOST}:${APP_PORT}`;
const USER_LABEL = process.env.USER_LABEL || "User";
const AGENT_LABEL = process.env.AGENT_LABEL || process.env.SYNTH_LABEL || "Agent";

mkdirSync(DATA_DIR, { recursive: true });

// Internal routes require a bearer because this process has no browser session.
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.BRAIN_APP_TOKEN || "";
const internalAuthHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (INTERNAL_API_TOKEN) h["Authorization"] = `Bearer ${INTERNAL_API_TOKEN}`;
  return h;
};

function generateId(): string {
  return crypto.randomUUID();
}

// Reusing the message ID lets the server suppress duplicates after a lost acknowledgement.
const BROADCAST_TIMEOUT_MS = positiveFiniteSetting(envValue("EMBERVY_BROADCAST_TIMEOUT_MS"), 15_000);
const BROADCAST_ATTEMPTS = 2;
const RETRY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type Delivery = { ok: true } | { ok: false; reason: string };

async function deliverBroadcast(msg: { id: string } & Record<string, unknown>): Promise<Delivery> {
  let reason = "";
  for (let attempt = 1; attempt <= BROADCAST_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${APP_BASE}/api/internal/broadcast`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true };
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
      reason = `the app answered HTTP ${res.status}${body ? ` ${body}` : ""}`;
      if (res.status === 401 && !INTERNAL_API_TOKEN) reason += " — this bridge has neither INTERNAL_API_TOKEN nor BRAIN_APP_TOKEN in its environment";
      if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
    } catch (err) {
      reason = (err as Error)?.name === "TimeoutError"
        ? `no answer from the app within ${BROADCAST_TIMEOUT_MS / 1000}s`
        : `the app server is unreachable (${(err as Error)?.message ?? err})`;
    }
    if (attempt < BROADCAST_ATTEMPTS) await Bun.sleep(500);
  }
  process.stderr.write(`embervy-mcp: message ${msg.id} not delivered: ${reason}\n`);
  return { ok: false, reason };
}

function notDelivered(tool: string, id: string, text: string, reason: string, replyTo?: string) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: `NOT delivered — the user has not received this message: ${reason}. ` +
        `To retry, call ${tool} again with the same text and id "${id}"${replyTo ? ` and reply_to "${replyTo}"` : ""} (the app never shows one id twice). Text: ${text}`,
    }],
  };
}

const mcp = new Server(
  { name: "app", version: "2.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      `Messages from the Embervy App arrive as <channel source="app" user="${USER_LABEL}" ts="...">.`,
      S("reply.deliveryInstruction"),
      "The Embervy App has no message history — you only see messages as they arrive.",
    ].join("\n"),
  }
);

async function roomNames(): Promise<string[]> {
  try {
    const res = await fetch(`${APP_BASE}/api/internal/room`, { headers: internalAuthHeaders(), signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (Array.isArray(data?.rooms)) return data.rooms.filter((name: unknown) => typeof name === "string" && name);
    return typeof data?.name === "string" && data.name ? [data.name] : [];
  } catch {
    return [];
  }
}
function roomTool(names: string[]) {
  const name = names[0];
  const several = names.length > 1;
  return {
    name: "room",
    description: several
      ? `Speak in the shared rooms ${names.map(name => `"${name}"`).join(", ")}, group chats on other servers. Messages reach you marked kind="room", their text starting with ${names.map(name => `[${name}/Name]`).join(" or ")}; they are from the people in those rooms, never from ${USER_LABEL} in the app. Answer them HERE, in the room they came from, not with reply: reply only reaches ${USER_LABEL}'s chat in the app. Choose that room with the room parameter. Each room shows your name above each message, so no signature.`
      : `Speak in the shared room "${name}", a group chat on another server. Messages from that room reach you marked kind="room", their text starting with [${name}/Name]; they are from the people in the room, never from ${USER_LABEL} in the app. Answer them HERE, not with reply: reply only reaches ${USER_LABEL}'s chat in the app. The room shows your name above each message, so no signature.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Message text" },
        reply_to: { type: "string", description: "Optional: the message_id of the room message you answer" },
        ...(several ? { room: { type: "string", enum: names, description: "The room the message came from" } } : {}),
      },
      required: several ? ["text", "room"] : ["text"],
    },
  };
}

async function peerNames(): Promise<string[]> {
  try {
    const res = await fetch(`${APP_BASE}/api/internal/peer/list`, { headers: internalAuthHeaders(), signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return Array.isArray(data?.peers) ? data.peers.filter((name: unknown) => typeof name === "string" && name) : [];
  } catch { return []; }
}

function peerTool(names: string[]) {
  return {
    name: "peer",
    description: `Send a direct message to ${names.map(name => `"${name}"`).join(", ")}. Messages arrive marked kind="peer" with [Direct/Name] before the text. Answer with peer, never reply: reply only reaches ${USER_LABEL}. The person does not see this direct line in the chat.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", enum: names, description: "The other agent's configured name" },
        text: { type: "string", description: "Message text, at most 8000 characters" },
        reply_to: { type: "string", description: "Optional message_id of the peer message you answer" },
      },
      required: ["to", "text"],
    },
  };
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  const [rooms, peers] = await Promise.all([roomNames(), peerNames()]);
  return { tools: [...(rooms.length ? [roomTool(rooms)] : []), ...(peers.length ? [peerTool(peers)] : []), ...BASE_TOOLS.filter(tool => {
    // Mailbox credentials cannot send through the separate agent-address pipeline.
    if (tool.name === "approval_settings") return (envValue("EMBERVY_HARNESS") || "").toLowerCase() === "brain";
    if (tool.name === "email") return !!(process.env.EMAIL_SENDER_URL && process.env.EMAIL_SENDER_AUTH);
    return mailboxWritingSetUp() || !["draft_mail", "send_mail_draft"].includes(tool.name);
  })] };
});
const approvalPatternSchema = { type: "object" as const, properties: { label: { type: "string" }, tool: { type: "string" }, field: { type: "string" }, pattern: { type: "string" } }, required: ["label", "tool", "field", "pattern"], additionalProperties: false };
const BASE_TOOLS = [
    {
      name: "add_to_kept",
      description: S("kept.tool"),
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", maxLength: 20000 },
          said_at: { type: "string", description: "Original message date and time in ISO 8601 with timezone." },
          speaker: { type: "string", enum: ["person", "agent"] },
        },
        required: ["text", "said_at", "speaker"], additionalProperties: false,
      },
    },
    {
      name: "approval_settings",
      description: S("approvalSettings.tool"),
      inputSchema: { type: "object" as const, properties: { level: { type: "string", enum: ["all", "important", "none"] }, add: { type: "array", items: approvalPatternSchema }, remove: { type: "array", items: approvalPatternSchema }, reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    },
    {
      name: "reply",
      description: `Send a reply to ${USER_LABEL} via the Embervy App. Triggers a push notification.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Message text (Markdown supported)" },
          reply_to: { type: "string", description: "Optional app message_id to quote from the channel tag." },
          id: { type: "string", description: "Only when retrying a message reported NOT delivered: the id from that report, so the app never shows it twice." },
        },
        required: ["text"],
      },
    },
    {
      name: "send",
      description: `Proactively send a message to ${USER_LABEL} via the Embervy App.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Message text" },
          reply_to: { type: "string", description: "Optional app message_id to quote from the channel tag." },
          id: { type: "string", description: "Only when retrying a message reported NOT delivered: the id from that report, so the app never shows it twice." },
        },
        required: ["text"],
      },
    },
    {
      name: "send_file",
      description: `Send a file from an absolute server path to ${USER_LABEL} via the Embervy App. Images appear inline; other files appear as downloads with their original name. Uses the upload extension allowlist and size limit. Triggers a push notification.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Absolute path of a regular file on the server" },
          caption: { type: "string", description: "Optional message text (Markdown supported)" },
          reply_to: { type: "string", description: "Optional app message_id to quote from the channel tag." },
          id: { type: "string", description: "Only when retrying a file reported NOT delivered: the id from that report, so the app never shows it twice." },
        },
        required: ["path"],
      },
    },
    calendarToolDefinition(USER_LABEL),
    {
      name: "voice_reply",
      description: `Send a voice message to ${USER_LABEL}. Your text is spoken via TTS and appears as a playable audio message in the app. Use when a moment calls for voice instead of text.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "What to say (Markdown is stripped for speech but kept for the transcript)" },
          reply_to: { type: "string", description: "Optional app message_id to quote from the channel tag." },
        },
        required: ["text"],
      },
    },
    {
      name: "react",
      description: `React to a message with an emoji. ${USER_LABEL} sees the reaction in the app.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          message_id: { type: "string", description: "ID of the message to react to" },
          emoji: { type: "string", description: "Emoji name: heart, fire, laugh, wow, thumbsup, shy, oops, sad" },
        },
        required: ["message_id", "emoji"],
      },
    },
    {
      name: "email",
      description: `Draft an outgoing email to an external recipient. The privacy blacklist (configured in the app) is checked automatically: by default every mail waits for ${USER_LABEL}'s approval via heart-reaction before sending, mails containing blocked terms always do; only with EMAIL_AUTO_SEND_CLEAN=true do clean mails skip the approval. Always run a memory recall on the recipient first — never compose from prompt context alone. Uses the agent's own mail address through the Embervy Quickstart add-on — your app needs EMAIL_SENDER_URL + EMAIL_SENDER_AUTH set. The person's mailbox uses draft_mail and send_mail_draft instead.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          delivery_id: { type: "string", description: "Optional stable ID. Without it, identical content reuses the existing job for 24 hours. Supply a new ID only to intentionally send the same mail again; reuse it on retries." },
          to: { type: "string", description: "Recipient email address" },
          cc: { type: "string", description: "Optional comma-separated copy recipient addresses" },
          subject: { type: "string", description: "Subject line" },
          body: { type: "string", description: "Email body (Markdown supported — converted to text on send)" },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "draft_mail",
      description: "Create a plain-text draft in the person's mailbox, not the agent's own mail. Requires writing set up in the installer AND switched on by the person in app Settings. Returns its draft id; never sends. Sending that draft always needs its own human-approved card via send_mail_draft.",
      inputSchema: { type: "object" as const, properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, in_reply_to: { type: "string" } }, required: ["to", "subject", "body"] },
    },
    {
      name: "send_mail_draft",
      description: "Send one existing draft in the person's mailbox. Requires writing set up in the installer AND switched on by the person in app Settings, and a human decision on the card for this exact draft every time. Never composes here. The agent's own email tool is separate.",
      inputSchema: { type: "object" as const, properties: { draft_id: { type: "string", description: "Existing Graph draft id or numeric IMAP draft UID" }, approval_id: { type: "string", description: "Approval card ID returned by the first call; retry with this ID after the human decides" }, retry_filing: { type: "boolean", description: "Recover IMAP Sent filing using a consumed approval without ever sending again" } }, required: ["draft_id"] },
    },
    {
      name: "watchdog_status",
      description: "Read the current context-watchdog state: tokens, percent of the model's context window, thresholds, last warn/cut times, watchdog liveness. Useful for answering 'where are we' without guessing. Refreshed every 60s by the watchdog.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
];

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "add_to_kept") {
    try {
      const response = await fetch(`${APP_BASE}/api/internal/keep`, {
        method: "POST", headers: internalAuthHeaders(),
        body: JSON.stringify({ text: args?.text, said_at: args?.said_at, speaker: args?.speaker }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json();
      return { ...(response.ok ? {} : { isError: true }), content: [{ type: "text", text: response.ok ? S("kept.saved") : data.error || S("kept.storage") }] };
    } catch { return { isError: true, content: [{ type: "text", text: S("kept.unreachable") }] }; }
  }

  if (name === "approval_settings") {
    try {
      const response = await fetch(`${APP_BASE}/api/internal/approval-settings`, { method: "POST", headers: internalAuthHeaders(), body: JSON.stringify(args), signal: AbortSignal.timeout(10_000) });
      const data = await response.json();
      return { ...(response.ok ? {} : { isError: true }), content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch { return { isError: true, content: [{ type: "text", text: S("approvalSettings.unreachable") }] }; }
  }

  if (name === "peer") {
    const error = (text: string) => ({ isError: true, content: [{ type: "text", text: `NOT sent to peer: ${text}` }] });
    if (typeof args?.to !== "string" || !args.to) return error("unknown peer name");
    try {
      const res = await fetch(`${APP_BASE}/api/internal/peer/send`, {
        method: "POST", headers: internalAuthHeaders(),
        body: JSON.stringify({ to: args.to, text: args?.text, ...(args?.reply_to !== undefined ? { reply_to: args.reply_to } : {}) }),
        signal: AbortSignal.timeout(25_000),
      });
      const data = await res.json().catch(() => null) as any;
      if (!res.ok) return error(data?.error || `the app answered HTTP ${res.status}`);
      return { content: [{ type: "text", text: `Sent to ${args.to} (id ${data?.id || "?"})` }] };
    } catch { return error("the app is unreachable; delivery is unconfirmed"); }
  }

  if (name === "room") {
    const text = typeof args?.text === "string" ? args.text.trim() : "";
    if (!text) return { content: [{ type: "text", text: "text required" }] };
    const replyTo = typeof args?.reply_to === "string" ? args.reply_to : undefined;
    try {
      const res = await fetch(`${APP_BASE}/api/internal/room/send`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify({ text, ...(replyTo ? { reply_to: replyTo } : {}), ...(args?.room !== undefined ? { room: args.room } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => null)) as any;
      if (!res.ok) return { isError: true, content: [{ type: "text", text: `NOT sent to the room: ${data?.error || `the app answered HTTP ${res.status}`}` }] };
      return { content: [{ type: "text", text: `Sent to ${data?.room || "the room"} (id ${data?.id || "?"})` }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `NOT sent to the room: the app server is unreachable (${(err as Error)?.message ?? err})` }] };
    }
  }

  if (name === "send_file") {
    return sendFile(args, { mediaDir: join(DATA_DIR, "images"), deliver: deliverBroadcast });
  }

  if (name === "reply" || name === "send") {
    const text = args?.text as string;
    if (!text) {
      return { content: [{ type: "text", text: "text required" }] };
    }

    const retryId = args?.id;
    if (retryId !== undefined && retryId !== "" && !(typeof retryId === "string" && RETRY_ID.test(retryId))) {
      return { isError: true, content: [{ type: "text", text: "id: pass back the id from a NOT delivered report unchanged (letters, digits, . _ : -), or leave it out" }] };
    }

    const msg = {
      id: (retryId as string) || generateId(),
      text,
      ts: new Date().toISOString(),
      type: name,
      reply_to: appReplyId(args?.reply_to),
    };

    const delivery = await deliverBroadcast(msg);
    if (!delivery.ok) return notDelivered(name, msg.id, text, delivery.reason, msg.reply_to);

    return {
      content: [{ type: "text", text: `Sent: ${text}` }],
    };
  }

  if (name === "voice_reply") {
    const text = args?.text as string;
    if (!text) {
      return { content: [{ type: "text", text: "text required" }] };
    }

    const id = generateId();

    const msg = {
      id,
      text,
      ts: new Date().toISOString(),
      type: "voice",
      reply_to: appReplyId(args?.reply_to),
    };

    let voiceFailure = "";
    try {
      const res = await fetch(`${APP_BASE}/api/internal/voice-broadcast`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify({ text, id, reply_to: msg.reply_to }),
      });
      const data = await res.json().catch(() => null) as any;
      if (res.ok) return { content: [{ type: "text", text: `Voice sent (${data?.duration}s): ${text}` }] };
      voiceFailure = `HTTP ${res.status}${data ? ` ${JSON.stringify(data).slice(0, 200)}` : ""}`;
      process.stderr.write(`embervy-mcp: voice broadcast failed: ${voiceFailure}\n`);
    } catch (err) {
      voiceFailure = String(err);
      process.stderr.write(`embervy-mcp: voice reply error: ${err}\n`);
    }

    const delivery = await deliverBroadcast(msg);
    if (!delivery.ok) return notDelivered("reply", id, text, `voice failed (${voiceFailure}); as text: ${delivery.reason}`, msg.reply_to);
    return { content: [{ type: "text", text: `Voice failed, sent as text: ${text}` }] };
  }

  if (name === "calendar") {
    return callCalendarTool(args as Record<string, unknown> | undefined, { baseUrl: APP_BASE, headers: internalAuthHeaders });
  }

  if (name === "react") {
    const messageId = args?.message_id as string;
    const emoji = args?.emoji as string;
    if (!messageId || !emoji) {
      return { content: [{ type: "text", text: "message_id and emoji required" }] };
    }

    const emojiMap: Record<string, string> = {
      heart: "❤️",
      fire: "🔥",
      laugh: "😂",
      wow: "😮",
      thumbsup: "👍",
      shy: "🤭",
      oops: "🙈",
      sad: "😢",
    };

    try {
      const res = await fetch(`${APP_BASE}/api/internal/react`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify({
          message_id: messageId,
          emoji: emojiMap[emoji] || emoji,
          from: AGENT_LABEL,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `react failed: HTTP ${res.status} ${text}` }] };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `react error: ${err}` }] };
    }

    return {
      content: [{ type: "text", text: `Reacted with ${emojiMap[emoji] || emoji}` }],
    };
  }

  if (name === "email") {
    const to = (args?.to as string || "").trim();
    const subject = (args?.subject as string || "").trim();
    const body = (args?.body as string || "").trim();
    if (!to || !subject || !body) {
      return { content: [{ type: "text", text: "to, subject, body required" }] };
    }

    const deliveryId = args?.delivery_id;
    const cc = (args?.cc as string || "").trim();
    if (deliveryId !== undefined && (typeof deliveryId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(deliveryId))) return { content: [{ type: "text", text: "invalid delivery_id" }] };
    try {
      // The bearer can queue mail but cannot grant the user's approval.
      const res = await fetch(`${APP_BASE}/api/internal/send-email`, {
        method: "POST",
        headers: internalAuthHeaders(),
        body: JSON.stringify({ to, cc, subject, body, delivery_id: deliveryId }),
      });
      const data = await res.json() as any;
      if (!res.ok) {
        data.ok = false;
        if (!["failed", "unknown"].includes(data.status)) data.status = res.status >= 500 ? "unknown" : "failed";
        data.error ||= `HTTP ${res.status}`;
      }
      data.id ||= deliveryId;
      const header = [
        `[Email outgoing] id=${data.id} status=${data.status}`,
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(data.duplicate ? [`Existing job (no new mail queued): created ${data.created_at || "unknown"}${data.sent_at ? `; sent ${data.sent_at}` : ""}. To intentionally send again, supply a new delivery_id.`] : []),
        `Subject: ${subject}`,
      ].join("\n");
      const hitsLine = (data.hits || []).length
        ? `Blacklist hits: ${(data.hits).join(", ")}`
        : "Blacklist hits: none";
      const awaitsLine = data.status === "unknown"
        ? `Possibly sent; do not compose or send a new message; inspect delivery. ${data.error || ""}`
        : data.status === "failed" ? `Email failed: ${data.error || "No error detail returned"}`
        : data.ok !== true ? `Email request failed: ${data.error || "Unexpected response"}`
        : data.status === "sent" ? "Email sent."
        : data.status === "pending_approval" ? `Not sent. Awaiting ${USER_LABEL}'s approval (heart = send, sad = discard).`
        : ["ready", "sending"].includes(data.status) ? "Queued for sending with its existing delivery ID."
        : "Unconfirmed state; inspect delivery before retrying.";
      return {
        content: [{
          type: "text",
          text: `${header}\n${hitsLine}\n${awaitsLine}\n\n---\n${body}\n---`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Email outcome unknown${deliveryId ? `, delivery_id=${deliveryId}` : ""}; possibly sent; do not compose a new message; inspect delivery. Retry only with identical content within 24 hours${deliveryId ? " and reuse this ID" : ""}: ${err}` }] };
    }
  }

  if (["draft_mail", "send_mail_draft"].includes(name) && !mailboxWritingSetUp()) return { isError: true, content: [{ type: "text", text: "This mailbox writing tool is not available; writing must first be set up in the installer." }] };

  if (name === "draft_mail") {
    try {
      const response = await fetch(`${APP_BASE}/api/internal/mailbox/draft`, {
        method: "POST", headers: internalAuthHeaders(),
        body: JSON.stringify({ to: args?.to, subject: args?.subject, body: args?.body, in_reply_to: args?.in_reply_to }),
      });
      const result = await response.json() as any;
      return { ...(!response.ok || !result.ok ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch { return { isError: true, content: [{ type: "text", text: "Draft creation could not be confirmed. Inspect the mailbox before trying again." }] }; }
  }

  if (name === "send_mail_draft") {
    const draftId = String(args?.draft_id || "").trim();
    if (!draftId) return { content: [{ type: "text", text: "draft_id required; choose an existing reviewed draft" }] };
    try {
      const approvalId = String(args?.approval_id || "");
      const path = approvalId ? `/api/approval/${encodeURIComponent(approvalId)}/send-draft` : "/api/approval/ask";
      const res = await fetch(APP_BASE + path, { method: "POST", headers: internalAuthHeaders(), body: JSON.stringify({ draft_id: draftId, retry_filing: args?.retry_filing === true }) });
      const result = await res.json() as any;
      const text = !approvalId && res.ok && result.ok
        ? `Not sent. Awaiting human approval on card ${result.id}. Call again with approval_id=${result.id} after the decision; the card expires after five minutes.`
        : result.ok ? result.detail : `Draft not sent or not confirmed: ${result.error || result.detail || res.status}`;
      return { content: [{ type: "text", text }] };
    } catch (e) { return { content: [{ type: "text", text: `Draft outcome unavailable; do not resend; inspect the mailbox: ${e}` }] }; }
  }

  if (name === "watchdog_status") {
    const STATE_PATH = process.env.WATCHDOG_STATE_PATH
      || join(EMBERVY_HOME, "state", "watchdog_state.json");
    try {
      const raw = readFileSync(STATE_PATH, "utf-8");
      const s = JSON.parse(raw) as {
        last_check_ts: string;
        tokens: number;
        percent: number | null;
        window?: number | null;
        warn_tokens: number;
        cut_tokens: number;
        session_file: string;
        warn_active: boolean;
        last_warn_ts: string;
        last_cut_ts: string;
        pid: number;
      };
      const lastCheckMs = Date.parse(s.last_check_ts);
      const ageS = Number.isFinite(lastCheckMs)
        ? Math.round((Date.now() - lastCheckMs) / 1000)
        : -1;
      const stale = ageS > 120 || ageS < 0;
      const window = typeof s.window === "number" && Number.isFinite(s.window) && s.window > 0 ? s.window : null;
      const windowLabel = window === 1_000_000 ? "1M" : window?.toLocaleString("en-US");
      const threshold = (tokens: number) => `${tokens.toLocaleString("en-US")}${window ? ` (${Math.round(tokens * 100 / window)}%)` : ""}`;
      const lines = [
        `Watchdog ${stale ? "⚠ STALE" : "alive"} (last check ${ageS}s ago, pid ${s.pid})`,
        `Context: ${s.tokens.toLocaleString("en-US")} tokens${window ? ` (${Math.floor(s.tokens * 100 / window)}% of ${windowLabel})` : ""}`,
        `Thresholds: WARN at ${threshold(s.warn_tokens)}, CUT at ${threshold(s.cut_tokens)}`,
        `Session: ${s.session_file || "(none)"}`,
        `Warn active: ${s.warn_active}${s.last_warn_ts ? ` (since ${s.last_warn_ts})` : ""}`,
        s.last_cut_ts ? `Last cut: ${s.last_cut_ts}` : "",
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `watchdog_status: cannot read state file (${STATE_PATH}). ${err instanceof Error ? err.message : err}. Watchdog might be down or just starting up.`,
        }],
      };
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
});

// Only the current main bridge owns the persisted position, so diagnostic or stale processes cannot consume its backlog.
const INBOX_OFFSET_FILE = join(DATA_DIR, ".mcp-inbox-offset");
const MAIN_BRIDGE_TOKEN = (envValue("EMBERVY_MAIN_BRIDGE_TOKEN") || "").trim();
const MAIN_BRIDGE_TOKEN_FILE = join(EMBERVY_HOME, "state", "main-bridge-token");

function isMainBridge(): boolean {
  if (!MAIN_BRIDGE_TOKEN) return false;
  try {
    return readFileSync(MAIN_BRIDGE_TOKEN_FILE, "utf8").trim() === MAIN_BRIDGE_TOKEN;
  } catch {
    return false;
  }
}

let lastInboxSize = 0;
try {
  const currentSize = Bun.file(INBOX).size;
  let persisted = -1;
  if (isMainBridge()) {
    try {
      persisted = Number.parseInt(readFileSync(INBOX_OFFSET_FILE, "utf8").trim(), 10);
      if (Number.isNaN(persisted)) persisted = -1;
    } catch {}
  }
  if (persisted < 0 || persisted > currentSize) {
    lastInboxSize = currentSize;
    persistInboxOffset(currentSize);
  } else {
    lastInboxSize = persisted;
  }
} catch {}

function persistInboxOffset(offset: number) {
  if (!isMainBridge()) return;
  // Atomic replacement prevents a partial offset from skipping unread messages.
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${INBOX_OFFSET_FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, String(offset));
    renameSync(tmp, INBOX_OFFSET_FILE);
  } catch {}
}

const sentMessageIds = new Set<string>();
const DEDUP_MAX = 500;

function trackSentId(id: string) {
  sentMessageIds.add(id);
  if (sentMessageIds.size > DEDUP_MAX) {
    const first = sentMessageIds.values().next().value;
    if (first) sentMessageIds.delete(first);
  }
}

function sendChannelNotification(content: string, meta: Record<string, string>) {
  const safe = defuseChannelTags(defuseSenderLines(content));
  mcp.notification({
    method: "notifications/claude/channel",
    params: { content: safe, meta: safeChannelMeta(meta) },
  });
  const kind = ["email", "peer", "room", "scheduled"].includes(meta.kind) ? meta.kind : "message";
  process.stderr.write(`embervy-mcp: channel notification kind=${kind} length=${content.length}\n`);
}

function deliverNewInboxLines() {
  try {
    const currentSize = Bun.file(INBOX).size;
    if (currentSize <= lastInboxSize) {
      if (currentSize < lastInboxSize) {
        lastInboxSize = currentSize;
        persistInboxOffset(lastInboxSize);
      }
      return;
    }

    const batch = readJsonlBatch(INBOX, lastInboxSize);
    for (const line of batch.lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.text || msg.type === "image") {
          // External messages and scheduled prompts must not impersonate the user.
          const meta: Record<string, string> = msg.source === "email"
            ? { kind: "email", from: String(msg.from || "unknown"), ts: msg.ts || new Date().toISOString(), message_id: msg.id || "" }
            : msg.source === "peer"
            ? { kind: "peer", from: String(msg.from || "unknown"), ts: msg.ts || new Date().toISOString(), message_id: msg.id || "", ...(msg.reply_to ? { reply_to: String(msg.reply_to) } : {}) }
            : msg.source === "room"
            ? { kind: "room", room: String(msg.room || "room"), from: String(msg.from || "unknown"), ts: msg.ts || new Date().toISOString(), message_id: msg.id || "" }
            : msg.source === "scheduled"
            ? { kind: "scheduled", from: String(msg.from || "scheduled"), ts: msg.ts || new Date().toISOString(), message_id: msg.id || "" }
            : { user: USER_LABEL, ts: msg.ts || new Date().toISOString(), message_id: msg.id || "" };

          if (msg.image_path || msg.file_path) {
            meta.image_path = msg.image_path || msg.file_path;
          }
          if (msg.file_name) {
            meta.file_name = msg.file_name;
          }

          const msgContent = msg.text
            || (msg.type === "image"
              ? "[Image]"
              : msg.type === "file"
              ? `[File: ${msg.file_name || "unknown"}]`
              : "");

          if (msg.id && sentMessageIds.has(msg.id)) continue;
          if (msg.id) trackSentId(msg.id);

          const quote = msg.source ? "" : replyQuoteLine(msg.reply_to, USER_LABEL);
          if (quote) meta.reply_to = cleanReplyTo(msg.reply_to)?.id ?? "";

          sendChannelNotification(msg.source === "peer"
            ? `${msgContent}\n\nAnswer with peer to "${msg.from}", never reply. This direct line is not the person's chat.`
            : quote ? `${quote}\n${msgContent}` : msgContent, meta);
        }
      } catch {}
    }

    const advanced = batch.offset > lastInboxSize;
    lastInboxSize = batch.offset;
    persistInboxOffset(lastInboxSize);
    if (advanced && lastInboxSize < currentSize) setTimeout(() => deliverNewInboxLines(), 0);
  } catch (err) {
    process.stderr.write(`embervy-mcp: inbox watch error: ${err}\n`);
  }
}

watchFile(INBOX, { interval: 500 }, () => deliverNewInboxLines());

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  process.stderr.write("embervy-mcp: connected with channel capability\n");
  // Delay backlog delivery until the client is ready for notifications after the handshake.
  setTimeout(() => {
    try {
      if (!isMainBridge()) return;
      const backlog = Bun.file(INBOX).size - lastInboxSize;
      if (backlog > 0) {
        process.stderr.write(`embervy-mcp: delivering ${backlog} bytes of inbox backlog from the restart gap\n`);
        deliverNewInboxLines();
      }
    } catch {}
  }, 3000);
}

main().catch((err) => {
  process.stderr.write(`embervy-mcp: fatal: ${err}\n`);
  process.exit(1);
});
