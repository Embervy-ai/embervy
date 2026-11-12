// The configured address wins; tunnel forwarding supplies the public address otherwise.
export function appAddress(publicUrl: string | undefined, req?: Request, allowLocal = false): string | null {
  if (publicUrl?.trim()) return publicUrl.trim().replace(/\/+$/, "");
  if (!req) return null;
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || (allowLocal ? url.host : "");
  const proto = req.headers.get("x-forwarded-proto") || (req.headers.get("cf-ray") ? "https" : allowLocal ? url.protocol.slice(0, -1) : "");
  if (!host || !proto || (!allowLocal && /^(127\.|localhost|\[::1\])/.test(host))) return null;
  return `${proto}://${host}`;
}
