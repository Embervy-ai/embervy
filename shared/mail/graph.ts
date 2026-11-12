// Reads mail and manages drafts through Microsoft Graph.
// Outlook requires OAuth rather than IMAP basic authentication.

import { refreshStoredCredential, withCredentialLock, writePrivateJson } from "../scripts/credential-store";

export interface GraphAccount {
  clientId: string;
  tokenCachePath: string;
}

export interface MailMessage {
  id: string;
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

const TENANT = "common"; // Includes personal and organizational accounts.
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "Mail.Read Mail.ReadWrite Mail.Send offline_access";
export function graphScopes(allowSend = false): string {
  // Reading alone needs neither draft creation nor permission to send.
  return allowSend === true ? SCOPES : "Mail.Read offline_access";
}


export interface DeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

export async function startDeviceCode(clientId: string, allowSend = false): Promise<DeviceCodeStart> {
  const res = await fetch(`${AUTH_BASE}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: graphScopes(allowSend) }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`startDeviceCode failed: HTTP ${res.status} ${body}`);
  }
  const json = await res.json();
  return json as DeviceCodeStart;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
}

const PENDING_ERRORS = new Set(["authorization_pending", "slow_down"]);

export async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  timeoutMs = 15 * 60_000, // 15 minutes
  requestedScope = graphScopes(),
): Promise<TokenSet> {
  const deadline = Date.now() + timeoutMs;
  let interval = Math.max(intervalSeconds, 5); 

  while (Date.now() < deadline) {
    await Bun.sleep(interval * 1000);

    const res = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCode,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      const json = (await res.json()) as TokenResponse;
      return toTokenSet(json, requestedScope);
    }

    const errBody = await res.json().catch(() => ({} as any));
    const err = errBody?.error;
    if (err === "slow_down") {
      interval += 5; // Microsoft requires this backoff.
      continue;
    }
    if (err === "authorization_pending") {
      continue;
    }
    throw new Error(`pollForToken failed: ${err || res.status} ${errBody?.error_description || ""}`);
  }
  throw new Error("pollForToken timed out waiting for user to authenticate");
}

export type DeviceCodePollResult =
  | { status: "pending"; slow_down?: boolean }
  | { status: "completed"; tokens: TokenSet }
  | { status: "expired"; detail: string }
  | { status: "denied"; detail: string }
  | { status: "error"; detail: string };

// One attempt avoids holding a browser request open throughout sign-in.
export async function pollDeviceCodeOnce(clientId: string, deviceCode: string, requestedScope = graphScopes()): Promise<DeviceCodePollResult> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCode,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    // Network failures remain retryable; the caller must enforce the expiry deadline.
    return { status: "pending" };
  }
  if (res.ok) {
    const json = (await res.json()) as TokenResponse;
    return { status: "completed", tokens: toTokenSet(json, requestedScope) };
  }
  const errBody: any = await res.json().catch(() => ({}));
  const err = errBody?.error;
  const detail = String(errBody?.error_description || err || `HTTP ${res.status}`).slice(0, 300);
  if (err === "authorization_pending") return { status: "pending" };
  if (err === "slow_down") return { status: "pending", slow_down: true };
  if (err === "expired_token") return { status: "expired", detail };
  if (err === "authorization_declined") return { status: "denied", detail };
  return { status: "error", detail };
}

function toTokenSet(t: TokenResponse, requestedScope: string): TokenSet {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
    // OAuth may omit scope when it is unchanged from the request.
    scope: t.scope ?? requestedScope,
  };
}


export async function loadTokenCache(path: string): Promise<TokenSet | null> {
  try {
    const text = await Bun.file(path).text();
    return JSON.parse(text) as TokenSet;
  } catch {
    return null;
  }
}

// Atomic replacement prevents a partial cache; owner-only access protects the refresh token.
export async function saveTokenCache(path: string, tokens: TokenSet): Promise<void> {
  await withCredentialLock(path, () => writePrivateJson(path, tokens));
}

// Microsoft can rotate refresh tokens on use, so the new token must be saved immediately.
export async function refreshToken(clientId: string, cachePath: string, current: TokenSet): Promise<TokenSet> {
  return refreshStoredCredential(cachePath, async () => {
    const stored = await loadTokenCache(cachePath);
    if (stored && (stored.access_token !== current.access_token || stored.refresh_token !== current.refresh_token || stored.expires_at !== current.expires_at)) return stored;
    current = stored ?? current;
    const res = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: current.refresh_token,
        // A cache without scope metadata represents a full-scope consent grant, not a read-only grant.
        scope: current.scope ?? SCOPES,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`refreshToken failed: HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as TokenResponse;
    const next = toTokenSet(json, current.scope ?? SCOPES);
    await writePrivateJson(cachePath, next);
    return next;
  });
}

async function ensureFreshToken(clientId: string, cachePath: string, tokens: TokenSet): Promise<TokenSet> {
  const skewMs = 60_000; // Refresh early to avoid expiry during a request.
  if (Date.now() < tokens.expires_at - skewMs) return tokens;
  return refreshToken(clientId, cachePath, tokens);
}


// Graph pagination links already contain the full URL and query string.
async function authorizedFetch(account: GraphAccount, pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  let tokens = await loadTokenCache(account.tokenCachePath);
  if (!tokens) {
    throw new Error(
      "graph: no token cache found — run the device-code flow first (startDeviceCode/pollForToken) and saveTokenCache the result",
    );
  }
  tokens = await ensureFreshToken(account.clientId, account.tokenCachePath, tokens);

  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${tokens.access_token}`,
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  return res;
}

export async function probe(account: GraphAccount): Promise<ProbeResult> {
  try {
    const res = await authorizedFetch(account, "/me/mailFolders?$top=1");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status} ${body}` };
    }
    return { ok: true, detail: "mailbox reachable" };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}


export interface GraphCursor {
  since: string;
  /** Seen IDs suppress duplicates while the inclusive filter preserves late arrivals at the boundary. */
  seenIdsAtSince: string[];
  nextLink?: string;
}

export interface GraphFetchResult {
  messages: MailMessage[];
  cursor: GraphCursor;
}

interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
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

export async function fetchSinceCursor(
  account: GraphAccount,
  cursor: GraphCursor | null,
  maxBodyChars = 2000,
): Promise<GraphFetchResult> {
  const sinceIso = cursor?.since ?? new Date().toISOString();
  const seenAtSince = new Set(cursor?.seenIdsAtSince ?? []);

  const filter = `receivedDateTime ge ${sinceIso}`;
  const select = "id,subject,receivedDateTime,from,bodyPreview,body";
  let path = cursor?.nextLink || `/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$select=${select}&$top=50`;

  const out: MailMessage[] = [];
  let newestIso = sinceIso;
  let newestIds: string[] = [...(cursor?.seenIdsAtSince ?? [])];

  let guard = 0;
  while (path && guard < 20) {
    guard++;
    const res = await authorizedFetch(account, path);
    if (!res.ok) throw new Error(`fetchSinceCursor failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const json: any = await res.json();

    const items = (json.value ?? []) as GraphMessage[];
    for (const m of items) {
      const receivedIso = m.receivedDateTime ?? sinceIso;
      if (receivedIso === sinceIso && seenAtSince.has(m.id)) continue;

      const from = m.from?.emailAddress?.address || m.from?.emailAddress?.name || "unknown";
      const subject = m.subject || "(no subject)";
      let text = "";
      try {
        text = m.bodyPreview || "";
        if (m.body?.content) text = m.body.contentType === "html" ? htmlToText(m.body.content) : m.body.content;
        text = text.slice(0, maxBodyChars);
      } catch {
        text = "";
      }
      out.push({
        id: m.id,
        uid: 0, // Graph has no numeric UID.
        from,
        subject,
        date: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
        text: text.slice(0, maxBodyChars),
      });

      if (receivedIso > newestIso) {
        newestIso = receivedIso;
        newestIds = [m.id];
      } else if (receivedIso === newestIso) {
        newestIds.push(m.id);
      }
    }

    path = json["@odata.nextLink"] || "";
  }

  return {
    messages: out,
    cursor: { since: newestIso, seenIdsAtSince: [...new Set(newestIds)], ...(path ? { nextLink: path } : {}) },
  };
}


// Reject header-like line breaks even though Graph transports these fields as JSON.
function stripHeaderInjection(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function sanitizeAddress(value: string): string {
  const clean = stripHeaderInjection(value);
  if (/[:\n\r]/.test(clean)) throw new Error(`invalid address/header value: ${JSON.stringify(value)}`);
  return clean;
}

export async function readDraft(account: GraphAccount, draftId: string) {
  if (!draftId || /[\r\n/]/.test(draftId)) throw new Error("invalid draft id");
  const path = `/me/messages/${encodeURIComponent(draftId)}`;
  const res = await authorizedFetch(account, path);
  if (!res.ok) throw new Error(`read draft failed: HTTP ${res.status}`);
  const message = await res.json() as any;
  if (!message.isDraft) throw new Error("message is not a draft");
  const mime = await authorizedFetch(account, path + "/$value");
  if (!mime.ok) throw new Error(`read draft content failed: HTTP ${mime.status}`);
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(message)).update(await mime.arrayBuffer()).digest("hex");
  const recipients = [...(message.toRecipients || []), ...(message.ccRecipients || []), ...(message.bccRecipients || [])].map(r => r.emailAddress.address);
  const body = message.body?.content || "";
  const preview = message.body?.contentType?.toLowerCase() === "html" ? htmlToText(body) : body;
  return { hash, etag: message["@odata.etag"], detail: `To: ${recipients.join(", ")}\nSubject: ${message.subject || ""}\n\n${preview.slice(0, 800)}` };
}

// Callers must require explicit send permission and a user command.
export async function sendDraft(account: GraphAccount, draftId: string, expectedHash?: string): Promise<ProbeResult> {
  if (!draftId || /[\r\n/]/.test(draftId)) return { ok: false, detail: "invalid draft id" };
  try {
    const snapshot = expectedHash ? await readDraft(account, draftId) : undefined;
    if (snapshot && snapshot.hash !== expectedHash) return { ok: false, detail: "draft changed since approval; not sent" };
    const res = await authorizedFetch(account, `/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST", headers: snapshot?.etag ? { "If-Match": snapshot.etag } : {} });
    if (!res.ok) return { ok: false, detail: `sendDraft failed: HTTP ${res.status} ${await res.text().catch(() => "")}` };
    return { ok: true, detail: "existing Graph draft sent" };
  } catch (e: any) {
    return { ok: false, detail: e?.message || String(e) };
  }
}

export async function appendDraft(
  account: GraphAccount,
  opts: { to: string; subject: string; body: string; inReplyTo?: string },
): Promise<ProbeResult & { id: string | null }> {
  try {
    const to = sanitizeAddress(opts.to);
    const subject = stripHeaderInjection(opts.subject);
    const inReplyTo = opts.inReplyTo ? sanitizeAddress(opts.inReplyTo) : undefined;

    const payload: Record<string, unknown> = {
      subject,
      body: { contentType: "Text", content: opts.body },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    // A new Graph draft has no In-Reply-To field; the body preserves the reference without promising threading.
    if (inReplyTo) {
      payload.body = { contentType: "Text", content: `${opts.body}\n\n[In-Reply-To: ${inReplyTo}]` };
    }

    const res = await authorizedFetch(account, "/me/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, id: null, detail: `HTTP ${res.status} ${detail}` };
    }
    const draft = await res.json() as { id?: unknown };
    const id = typeof draft.id === "string" && draft.id ? draft.id : null;
    return { ok: true, id, detail: id ? "draft created via Graph /me/messages" : "draft created without an id; inspect the mailbox; do not create another draft" };
  } catch (e: any) {
    return { ok: false, id: null, detail: e?.message || String(e) };
  }
}
