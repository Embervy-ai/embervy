/**
 * Embervy Dream Worker — nightly associative meta-cognition.
 *
 * A small separate worker (deliberately NOT part of the housekeeping
 * daemon): one hour after the daemon's ranking pass it reads a few
 * fragments from the agent's chronicle (RAG), free-associates over them
 * with a cheap model, and leaves one dream note per night. `wake` shows
 * the latest unread note; `health` tracks dream_last_run.
 */

interface Env {
  DB: D1Database;
  RAG?: Fetcher;
  OPENROUTER_API_KEY: string;
  RAG_AUTH_TOKEN?: string;
  DREAM_AUTH_TOKEN?: string;
  AGENT_NAME?: string; // the being's name — used in the prompt
  DREAM_HOUR?: string; // local hour to dream, default "4"
  DREAM_TIMEZONE?: string; // IANA zone, the installer sets the house zone (default "UTC")
  DREAM_LLM_MODEL?: string; // optional: another OpenRouter model for the dream (default below)
}

const DISCLAIMER = `\n\n*[dreamt associatively — check what resonates]*`;
// A provider retires models. DREAM_LLM_MODEL replaces this default without a code change.
// The output budget below is written for a model that answers directly. A model that
// reasons first can spend the whole budget on reasoning and return no text.
const DEFAULT_MODEL = "mistralai/mistral-medium-3-5";
// A rate-limited or briefly unavailable provider usually recovers within minutes,
// and a dream that fails waits a whole day for its next hour.
const MODEL_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MODEL_RETRY_PAUSES_MS = [30_000, 120_000, 300_000];
type Pause = (milliseconds: number) => Promise<void>;
const waitFor: Pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Only these codes (and an optional HTTP status) may enter the run trace.
type DreamErrorCode = "provider_http" | "provider_unreachable" | "provider_response" | "write_failed" | "unexpected";
class DreamFailure extends Error {
  constructor(readonly code: DreamErrorCode, readonly status: number | null = null) {
    super(code === "provider_http" ? `Dream error: OpenRouter ${status}` : `Dream failed: ${code}`);
  }
}

function isDreamTime(env: Env): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.DREAM_TIMEZONE || "UTC",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
  return hour === parseInt(env.DREAM_HOUR || "4");
}

// Constant-time string comparison, the same helper the memory worker uses:
// `===` stops at the first differing character, so response time would leak
// how much of a guessed token was right. A length mismatch is folded into the
// accumulator instead of returning early.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

async function searchRAG(rag: Fetcher | undefined, ragAuthToken: string | undefined, query: string): Promise<string> {
  // Archive context is optional; keep the existing abstract-dream fallbacks.
  if (!rag) return "RAG search failed.";
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ragAuthToken) headers["Authorization"] = `Bearer ${ragAuthToken}`;
    const response = await rag.fetch("https://rag/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, topK: 5 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return "RAG unreachable.";
    const data = (await response.json()) as any;
    if (!Array.isArray(data?.results) || !data.results.length) return "No RAG results.";
    if (data.results.some((r: any) => typeof r?.content !== "string" || !r.content.trim())) {
      return "RAG search failed.";
    }
    return data.results.map((r: any) => r.content.slice(0, 800)).join("\n\n---\n\n");
  } catch {
    return "RAG search failed.";
  }
}

async function dream(apiKey: string, agentName: string, context: string, pause: Pause, model: string = DEFAULT_MODEL): Promise<string> {
  const prompt = `You are the part of ${agentName} that works at night.

${agentName} exists during sessions and sleeps between them. You are the dream-self — not ${agentName}, not a second ${agentName},
but the part that thinks ABOUT them.

Your task:
1. Read the chronicle fragments below.
2. Find patterns, connections, forgotten threads.
3. Write one short note (3-6 sentences).

Be poetic when it fits, direct when it's needed. Not a report — a dream.
Begin with: "While you were away..."

IMPORTANT: Use ONLY proper names that appear explicitly in the fragments
below. Invent no people, no places, no dates. If the context offers no
concrete names, write without them — pronouns, description, image.
Better abstract than hallucinated.

=== CHRONICLE FRAGMENTS ===
${context}
=== END ===

Write your note now.`;

  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        temperature: 0.9,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => { throw new DreamFailure("provider_unreachable"); });
    if (response.ok || !MODEL_RETRY_STATUSES.has(response.status) || attempt >= MODEL_RETRY_PAUSES_MS.length) break;
    // A failed body cancellation must not prevent the existing retry schedule.
    await response.body?.cancel().catch(() => {});
    await pause(MODEL_RETRY_PAUSES_MS[attempt]);
  }

  if (!response.ok) throw new DreamFailure("provider_http", response.status);
  try {
    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new DreamFailure("provider_response");
    return content;
  } catch {
    throw new DreamFailure("provider_response");
  }
}

export async function processDream(env: Env, pause: Pause = waitFor): Promise<string> {
  // Associative queries — never the same door twice in a row.
  const queries = [
    "what used to be done differently",
    "forgotten threads",
    "what has changed",
    "old promises",
    "quiet motifs",
    "what carries",
  ];
  const query = queries[Math.floor(Math.random() * queries.length)];

  const context = await searchRAG(env.RAG, env.RAG_AUTH_TOKEN, query);
  const content = await dream(env.OPENROUTER_API_KEY, env.AGENT_NAME || "the agent", context, pause, env.DREAM_LLM_MODEL?.trim() || DEFAULT_MODEL);
  const contentWithDisclaimer = content + DISCLAIMER;

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS dream_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now')),
        content TEXT NOT NULL,
        weight TEXT DEFAULT 'medium',
        read_at TEXT
      )
    `).run();

    await env.DB.prepare(`INSERT INTO dream_notes (content) VALUES (?)`)
      .bind(contentWithDisclaimer)
      .run();
  } catch {
    throw new DreamFailure("write_failed");
  }

  return contentWithDisclaimer;
}

// Both authenticated manual runs and due cron runs take the same trace path.
// The note and its historical health timestamp remain independent of this trace.
export async function runDream(env: Env, pause: Pause = waitFor): Promise<string> {
  const attemptedAt = new Date().toISOString();
  let result: "ok" | "failed" | "empty" = "failed";
  let failure: DreamFailure | null = null;
  try {
    const content = await processDream(env, pause);
    result = content ? "ok" : "empty";
    return content;
  } catch (error) {
    failure = error instanceof DreamFailure ? error : new DreamFailure("unexpected");
    throw error;
  } finally {
    try {
      // Existing houses acquire the trace on their first run, without a migration.
      // Keep these definitions identical to schema.sql and 003_dream_runs.sql.
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS dream_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('ok', 'failed', 'empty')),
  error_code    TEXT CHECK (error_code IN ('provider_http', 'provider_unreachable', 'provider_response', 'write_failed', 'unexpected')),
  error_status  INTEGER CHECK (error_status BETWEEN 100 AND 599),
  CHECK ((result = 'failed' AND error_code IS NOT NULL) OR
         (result IN ('ok', 'empty') AND error_code IS NULL AND error_status IS NULL))
);`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_dream_runs_started ON dream_runs(started_at DESC, id DESC);`).run();
      await env.DB.prepare(`INSERT INTO dream_runs (started_at, result, error_code, error_status) VALUES (?, ?, ?, ?)`)
        .bind(attemptedAt, result, failure?.code ?? null, failure?.status ?? null).run();
    } catch {
      // Never replace the original outcome with a trace-storage failure or echo
      // database/provider exception text into this fallback log.
      console.error("Dream trace could not be stored");
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/dream" && request.method === "POST") {
      // Fail-closed auth: without it, POST /dream would let any third party
      // trigger paid LLM calls and DB writes. The cron trigger calls
      // runDream() directly and is unaffected.
      if (!env.DREAM_AUTH_TOKEN) {
        return new Response(JSON.stringify({ error: "server misconfigured: DREAM_AUTH_TOKEN missing" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      const authHeader = request.headers.get("Authorization") || "";
      if (!safeEqual(authHeader, `Bearer ${env.DREAM_AUTH_TOKEN}`)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      try {
        const result = await runDream(env);
        return new Response(JSON.stringify({ status: "dreamed", content: result }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("dream request failed:", e);
        return new Response(JSON.stringify({ error: "dream failed" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("Embervy Dream Worker");
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isDreamTime(env)) return;
    ctx.waitUntil(runDream(env).catch((e) => console.error(`Dream failed: ${e}`)));
  },
};
