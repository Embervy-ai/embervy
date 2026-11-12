import { Hono } from "hono";
import { isSafeMessageId, defuseSenderLines } from "./message-fields";

export type PeerConfig = { name: string; base: string; token: string };
export type PeerEntry = { id: string; source: "peer"; from: string; text: string; ts: string; reply_to?: string };
export const PEER_TEXT_MAX = 8000;

export function peerConfigsFromEnv(env: Record<string, string | undefined>, warn: (line: string) => void = line => process.stderr.write(line + "\n")): PeerConfig[] {
  if (!env.EMBERVY_PEERS?.trim()) return [];
  let list: unknown;
  try { list = JSON.parse(env.EMBERVY_PEERS); } catch {
    warn("embervy-app: EMBERVY_PEERS skipped: invalid JSON list");
    return [];
  }
  if (!Array.isArray(list)) {
    warn("embervy-app: EMBERVY_PEERS skipped: expected a JSON list");
    return [];
  }
  const peers: PeerConfig[] = [];
  list.forEach((value, index) => {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a peer object");
      const { name, url: rawUrl, token } = value;
      if (typeof name !== "string" || !name.trim() || [...name].length > 40 || /[^\p{L}\p{N} _-]/u.test(name)) throw new Error("name: letters, digits, spaces, _ and - only, at most 40 characters");
      if (typeof token !== "string" || !token || /[^\x21-\x7e]/.test(token)) throw new Error("token: non-empty printable ASCII without spaces");
      let url: URL;
      try { url = new URL(rawUrl); } catch { throw new Error("invalid URL"); }
      const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
      if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("URL must use https or loopback http");
      if (url.username || url.password || url.search || url.hash) throw new Error("URL must not contain credentials, query or hash");
      if (peers.some(peer => peer.name === name)) throw new Error("duplicate name");
      if (peers.some(peer => peer.token === token)) throw new Error("duplicate token: each pair needs its own secret");
      peers.push({ name, base: url.origin + url.pathname.replace(/\/+$/, ""), token });
    } catch (err) {
      // Indexes identify even malformed entries without echoing secret-bearing input.
      warn(`embervy-app: EMBERVY_PEERS[${index}] skipped: ${(err as Error).message}`);
    }
  });
  return peers;
}

function peerMessageId(value: unknown): value is string {
  return typeof value === "string" && isSafeMessageId(value) && !/[^A-Za-z0-9._:-]/.test(value);
}

export function peerMessageError(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "a JSON object is required";
  if (typeof body.text !== "string" || !body.text.trim()) return "text required";
  if (body.text.trim().length > PEER_TEXT_MAX) return `text must be at most ${PEER_TEXT_MAX} characters`;
  if (body.reply_to !== undefined && !peerMessageId(body.reply_to)) return "reply_to must be a message id, at most 64 characters";
  return null;
}

export async function sendToPeer(peer: PeerConfig, body: { text: string; reply_to?: string }, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(`${peer.base}/api/peer/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${peer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    // A remote error body or exception may contain credentials; never forward either.
    if (!res.ok) { await res.body?.cancel(); return { ok: false, reason: `peer said HTTP ${res.status}` }; }
    const data = await res.json().catch(() => null) as any;
    if (data?.ok !== true || !peerMessageId(data.id)) return { ok: false, reason: "peer returned an invalid acknowledgement" };
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, reason: "peer unreachable or did not answer within 20s; delivery is unconfirmed" };
  }
}

export function registerPeerRoutes(app: Hono, peers: PeerConfig[], options: {
  internalToken: string;
  bearerMatches: (header: string, token: string) => boolean;
  append: (entry: PeerEntry) => void;
}) {
  if (!peers.length) return;
  const buckets = new Map<string, { tokens: number; at: number }>();
  app.post("/api/peer/message", async c => {
    const header = c.req.header("authorization") || "";
    const peer = peers.find(peer => options.bearerMatches(header, peer.token));
    if (!peer) return c.json({ error: "unauthorized" }, 401);
    const now = performance.now();
    const bucket = buckets.get(peer.token) || { tokens: 30, at: now };
    bucket.tokens = Math.min(30, bucket.tokens + (now - bucket.at) / 2000);
    bucket.at = now;
    buckets.set(peer.token, bucket);
    if (bucket.tokens < 1) return c.json({ error: "peer rate limit exceeded" }, 429, { "Retry-After": String(Math.ceil((1 - bucket.tokens) * 2)) });
    bucket.tokens--;
    const body = await c.req.json().catch(() => null);
    const error = peerMessageError(body);
    if (error) return c.json({ error }, 400);
    const entry: PeerEntry = {
      id: `peer-${crypto.randomUUID()}`, source: "peer", from: peer.name,
      text: `[Direct/${peer.name}] ${defuseSenderLines(body.text.trim())}`, ts: new Date().toISOString(),
      ...(body.reply_to !== undefined ? { reply_to: body.reply_to } : {}),
    };
    try { options.append(entry); } catch { return c.json({ error: "could not store peer message" }, 500); }
    return c.json({ ok: true, id: entry.id });
  });
  app.use("/api/internal/peer/*", async (c, next) => {
    if (!options.internalToken || !options.bearerMatches(c.req.header("authorization") || "", options.internalToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.get("/api/internal/peer/list", c => c.json({ peers: peers.map(peer => peer.name) }));
  app.post("/api/internal/peer/send", async c => {
    const body = await c.req.json().catch(() => null);
    const peer = peers.find(peer => peer.name === body?.to);
    if (!peer) return c.json({ error: "unknown peer name" }, 400);
    const error = peerMessageError(body);
    if (error) return c.json({ error }, 400);
    const sent = await sendToPeer(peer, { text: body.text.trim(), ...(body.reply_to !== undefined ? { reply_to: body.reply_to } : {}) });
    if (!sent.ok) return c.json({ error: sent.reason }, 502);
    return c.json({ ok: true, id: sent.id, to: peer.name });
  });
}
