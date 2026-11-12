export function acceptedPushEndpoint(url: string): boolean {
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
      || /^(?:[a-z0-9-]+\.)+(?:notify\.windows\.com|push\.apple\.com)$/.test(host);
  } catch {
    return false;
  }
}
