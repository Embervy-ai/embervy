import { appAddress } from "../../shared/scripts/app-address";

function httpOrigin(address: string | null): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

// A browser page may open the socket only from the app's own address: the configured
// public one, or the address this very request was sent to (tunnel forwarding included),
// so the app stays usable through an SSH tunnel while a public address is configured.
export function websocketOriginAllowed(req: Request, publicUrl?: string): boolean {
  const origin = req.headers.get("origin");
  // Native clients and local tooling authenticate without a browser Origin.
  if (origin === null) return true;
  let supplied: URL;
  try { supplied = new URL(origin); } catch { return false; }
  if (!["http:", "https:"].includes(supplied.protocol) || supplied.username || supplied.password
      || supplied.pathname !== "/" || supplied.search || supplied.hash) return false;
  const own = [httpOrigin(appAddress(publicUrl, req, true)), httpOrigin(appAddress(undefined, req, true))];
  return own.includes(supplied.origin);
}
