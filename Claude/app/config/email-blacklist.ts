// Flags private terms in outgoing mail for user approval.

// Store warning terms here, never actual secrets.
const CORE_PRIVACY: string[] = [



  "CLOUDFLARE_API_TOKEN",
  "OPENROUTER_API_KEY",
  "ELEVENLABS",
  "VAPID",
  "AUTH_CLIENT_SECRET",

];

const SCENE_NAMES: string[] = [
];

const INFRA_URLS: string[] = [
];

// Trusted recipients may know names and infrastructure, but core privacy still applies.
const RECIPIENT_WHITELIST: string[] = [
];

export const EMAIL_BLACKLIST: string[] = [
  ...CORE_PRIVACY,
  ...SCENE_NAMES,
  ...INFRA_URLS,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matches(text: string, term: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
  return pattern.test(text);
}

export function checkEmailBlacklist(subject: string, body: string, to?: string): string[] {
  const text = subject + " " + body;
  const toLower = (to || "").toLowerCase().trim();
  const isWhitelisted = RECIPIENT_WHITELIST.some((r) => toLower === r.toLowerCase());

  const list = isWhitelisted
    ? CORE_PRIVACY
    : [...CORE_PRIVACY, ...SCENE_NAMES, ...INFRA_URLS];

  const hits: string[] = [];
  for (const term of list) {
    if (matches(text, term)) {
      hits.push(term);
    }
  }
  return hits;
}

export function isRecipientWhitelisted(to: string): boolean {
  const toLower = to.toLowerCase().trim();
  return RECIPIENT_WHITELIST.some((r) => toLower === r.toLowerCase());
}
