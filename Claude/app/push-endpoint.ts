// A house may run its own push relay (for example a proxy that forwards web push to a
// native shell). Such a host is accepted only when the house names it explicitly in
// EMBERVY_PUSH_RELAY_HOSTS (comma-separated, exact host names). Entries that are not
// plain DNS names with a dot (IP addresses, localhost, wildcards, ports, paths) are ignored.
export function pushRelayHosts(value: string | undefined = process.env.EMBERVY_PUSH_RELAY_HOSTS): string[] {
  return (value || "").split(",").map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(entry));
}

export function acceptedPushEndpoint(url: string, relayHosts: string[] = pushRelayHosts()): boolean {
  if (typeof url !== "string") return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;

    // A plain authority avoids userinfo and host encodings that URL parsers may interpret differently.
    if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:[/?#]|$)/i.test(url)) return false;

    const host = parsed.hostname;
    return host === "fcm.googleapis.com"
      || host === "updates.push.services.mozilla.com"
      || host === "web.push.apple.com"
      || host === "android.googleapis.com"
      || /^(?:[a-z0-9-]+\.)+(?:notify\.windows\.com|push\.apple\.com)$/.test(host)
      || relayHosts.includes(host);
  } catch {
    return false;
  }
}
