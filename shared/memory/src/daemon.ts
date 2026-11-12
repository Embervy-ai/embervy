/**
 * Consolidates memory each night and archives inactive observations.
 * Validates model proposals before applying them; the model has no database access.
 */

import type { Env } from "./index";
import { retryD1Write, type RetryPause } from "./d1-retry";
// Both sides of this import cycle use these functions only at request time.
import { eventVectorIds, ensureEdgesTable, isTemplateSurface, consolidateEvent, retryConsolidations, bindChunks } from "./index";

const DEFAULT_LLM_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_LLM_MODEL = "mistralai/mistral-medium-3.1";
const OPENROUTER_TIMEOUT_MS = 120_000;
// A rate-limited or briefly unavailable provider usually recovers within minutes.
// Waits stay well inside the 15-minute limit of a scheduled invocation; a timeout
// is not retried, because it already used two of those minutes.
const MODEL_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MODEL_RETRY_PAUSES_MS = [30_000, 120_000, 300_000];
const MODEL_RETRY_MAX_WAIT_MS = 300_000;
const waitFor: RetryPause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function callModelWithRetry(
  request: () => Promise<Response>,
  pause: RetryPause,
): Promise<{ response: Response; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    const response = await request();
    if (response.ok || !MODEL_RETRY_STATUSES.has(response.status) || attempt >= MODEL_RETRY_PAUSES_MS.length) {
      return { response, attempts: attempt + 1 };
    }
    await response.body?.cancel();
    const wait = Math.max(MODEL_RETRY_PAUSES_MS[attempt], retryAfterMs(response) ?? 0);
    await pause(Math.min(wait, MODEL_RETRY_MAX_WAIT_MS));
  }
}

const VISIBLE_KINDS = ["observation", "surface"] as const;
const BACKLOG_CHUNK_SIZE = 100;

interface DaemonInput {
  recent_stream: any[];
  unresolved_old: any[];
  current_mood: any;
  mood_age_hours: number;
  recent_surfaces_engaged: any[];
  backlog_chunk?: any[];
}

interface DaemonOutput {
  decay_modifiers?: { event_id: number; modifier: number; reason: string }[];
  surfaces?: {
    pattern: string;
    observations: string[];
    source_event_ids: number[];
    confidence?: number;       
  }[];
  consolidations?: {
    duplicate_event_ids: number[];
    keep_id: number;
    reason: string;
  }[];
  mood?: {
    label: string;
    summary: string[];
    hot_entities: string[];
    active_surface_count: number;
  };
  resolutions_proposed?: { event_id: number; note: string }[];
  edges_proposed?: { from_event: number; to_event: number; relation: string; strength?: number; reason: string }[];
  notes?: string[];
}


function buildPrompt(input: DaemonInput, mode: "normal" | "backlog", agentName = "the agent"): string {
  const moodAgeNote =
    input.mood_age_hours > 36
      ? `(updated_at: ${input.mood_age_hours.toFixed(0)}h old — please refresh, no urgency)`
      : `(updated_at: ${input.mood_age_hours.toFixed(0)}h old)`;


  return `# You are the nightly memory worker of ${agentName}.

${agentName} keeps its own memory. You work while the agent is not active, once
per night. You structure, evaluate, propose — you do not decide.

Style: terse, factual. No prose, no drama.

# Tonight's tasks

1. **Propose surfaces.** Patterns from the last 7 days that the agent should
   see in the morning. Example: "Five mentions of a recurring topic across six
   days." Format: \`pattern + observations (list) + source_event_ids\` (min. 2,
   max. 7 events) **plus confidence (0.0–1.0)**. Max. 10 surfaces per night.

   Every bullet cites ONE concrete event from the input data (what, when, with
   whom — including the event ID). No characterizations ("the agent shows
   clarity", "X in various situations"), no two identical bullets, no bullet
   that merely restates the pattern — such surfaces are discarded. A pattern
   means: the same topic on different days, named by the topic, not by a trait.

   Confidence scale: 0.9+ = clear repeated pattern from 4+ events. 0.7 = solid
   pattern from 3 events. 0.5 = possible pattern from 2 events. <0.5 = uncertain,
   leave it out. When in doubt estimate lower, not higher.

2. **Consolidation.** Only true duplicates — two observations of the same content
   on the same entity. NEVER thematic summarization. NEVER compaction. When in
   doubt: do not consolidate.

3. **Mood update.** Inner-weather snapshot. **Do not invent a label, do not pick
   from a list, do not copy the example.** Read the \`emotion\` fields of the events
   from the last 24–48h and distill what the agent currently carries. The mood
   is solely an aggregate of the real emotions in the data — not a repeat of the
   previous day. If the emotions of the most recent events shift relative to the
   current mood, the mood shifts with them. \`label\` as comma-separated keywords
   (max 80 chars). \`summary\` as a list of 2–5 bullets. \`hot_entities\` as a
   list of up to 5 names. \`active_surface_count\` as an integer.

4. **Resolution proposals (optional).** When an old unresolved observation has
   been visibly closed off by newer observations, propose a resolution note.
   The agent takes it or leaves it.

5. **Propose causal edges (optional, max 5).** When a cause-and-effect relation
   between two events is EXPLICIT in the text (event B mentions / visibly
   follows from event A), propose an edge: \`from_event --relation--> to_event\`.
   Relations: \`led_to\` (A led to B), \`caused_by\` (A was caused by B),
   \`emotional_consequence_of\` (the feeling in A is a consequence of B). ONLY when
   the connection is in the texts themselves — causality is interpretive, and an
   invented chain is worse than none. The cause is ALWAYS the older event: for
   \`led_to\` from_event must be older than to_event; for \`caused_by\` /
   \`emotional_consequence_of\` to_event must be older. A later event QUOTING an
   earlier one does not make the later one the cause — edges pointing the wrong
   way in time are rejected mechanically. The agent confirms every edge
   individually before it counts. \`reason\` (required): ONE sentence naming the
   passages that support the link. \`strength\` 0.3–0.7 (you propose, you do not
   judge — never above 0.7).

# What you do NOT do

- **Invent nothing.** Every event_id, every pattern, every resolution note must
  come from the input data. No hallucination. When in doubt: leave it out.
- No \`delete\` proposals (not even for obvious junk — the agent decides).
- No thematic summarization. That is compaction, that is loss.
- No content edits on events, except typo fixes flagged as such.
- No advice ("you should...").
- No prose, no dramatization.

(Journals and todos do not enter your input data — you don't have to think about them.)

# Input data

Each event in the streams contains: id, ts, kind, content, entity_name, weight,
emotion, decay_weight, resolved_at, mood_at_write (mood snapshot at write time).
Surfaces additionally carry meta.show_count (how often the agent has already
seen them — high show_count + no engagement = probably uninteresting).

## Last 7 days of events (observation + surface)
${JSON.stringify(input.recent_stream, null, 2)}

## Old unresolved observations (>24h, max 50)
${JSON.stringify(input.unresolved_old, null, 2)}

## Current mood
${JSON.stringify(input.current_mood, null, 2)}
${moodAgeNote}

## Engaged surfaces from the last 7 days (examples of what the agent picks up)
${JSON.stringify(input.recent_surfaces_engaged, null, 2)}

# Output (strict JSON, no surrounding text)

\`\`\`json
{
  "surfaces": [
    {
      "pattern": "Three mentions of a recurring topic",
      "observations": ["ts 2026-04-26: topic appears", "ts 2026-04-27: topic comes back up"],
      "source_event_ids": [12345, 12350],
      "confidence": 0.7
    }
  ],
  "mood": {
    "label": "...",
    "summary": ["...", "..."],
    "hot_entities": ["..."],
    "active_surface_count": 2
  },
  "resolutions_proposed": [
    { "event_id": 12340, "note": "closed by today's conversation" }
  ],
  "edges_proposed": [
    { "from_event": 12345, "to_event": 12350, "relation": "led_to", "strength": 0.5, "reason": "12350 names the fix from 12345 as its trigger" }
  ],
  "consolidations": [
    { "duplicate_event_ids": [12345, 12348], "keep_id": 12345, "reason": "verbatim duplicate" }
  ],
  "notes": ["one short bullet"]
}
\`\`\`

**Order is required:** surfaces → mood → resolutions_proposed → edges_proposed → consolidations → notes.
If tokens get tight, shorten notes before dropping surfaces.

# Format rules

- Valid JSON, no surrounding text, no markdown fences.
- All lists may be empty (\`[]\`); fields may be absent when nothing is proposed.
- \`event_id\` must exist in the input data.
- \`surfaces.observations\`: 2–7 bullets, each max 120 chars.
- \`surfaces.source_event_ids\`: 2–7 IDs, must correspond to the observations.
- \`mood.label\`: max 80 chars, lowercase, comma-separated.
- \`mood.summary\`: list of 2–5 bullets, each max 100 chars.
- \`notes\`: list of up to 5 bullets, each max 100 chars.
- Output language: match what the agent writes in (default English).
- If a surface is not supported by at least 2 real events: leave it out.

Begin your reply directly with \`{\`. No preface, no explanation.`;
}


function validate(raw: unknown): { ok: true; data: DaemonOutput } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const o = raw as any;

  const out: DaemonOutput = {};

  if (o.surfaces !== undefined) {
    if (!Array.isArray(o.surfaces)) return { ok: false, reason: "surfaces not array" };
    out.surfaces = [];
    for (const s of o.surfaces.slice(0, 10)) {
      if (typeof s?.pattern !== "string") continue;
      if (!Array.isArray(s?.observations) || s.observations.length < 2 || s.observations.length > 7) continue;
      if (!Array.isArray(s?.source_event_ids) || s.source_event_ids.length < 2 || s.source_event_ids.length > 7) continue;
      if (!s.source_event_ids.every((x: any) => typeof x === "number")) continue;
      if (isTemplateSurface(String(s.pattern), s.observations.map((x: any) => String(x)))) continue;
      let confidence = typeof s.confidence === "number" ? s.confidence : 0.5;
      if (confidence < 0) confidence = 0;
      if (confidence > 1) confidence = 1;
      out.surfaces.push({
        pattern: String(s.pattern).slice(0, 300),
        observations: s.observations.map((x: string) => String(x).slice(0, 120)),
        source_event_ids: s.source_event_ids,
        confidence,
      });
    }
  }

  if (o.consolidations !== undefined) {
    if (!Array.isArray(o.consolidations)) return { ok: false, reason: "consolidations not array" };
    out.consolidations = [];
    for (const c of o.consolidations.slice(0, 20)) {
      if (!Array.isArray(c?.duplicate_event_ids) || c.duplicate_event_ids.length < 2) continue;
      if (typeof c?.keep_id !== "number") continue;
      if (!c.duplicate_event_ids.includes(c.keep_id)) continue;
      out.consolidations.push({
        duplicate_event_ids: c.duplicate_event_ids,
        keep_id: c.keep_id,
        reason: String(c.reason ?? "").slice(0, 200),
      });
    }
  }

  if (o.mood !== undefined) {
    if (!o.mood || typeof o.mood !== "object") return { ok: false, reason: "mood not object" };
    if (typeof o.mood.label !== "string" || o.mood.label.length > 80) return { ok: false, reason: "mood.label invalid" };
    if (!Array.isArray(o.mood.summary)) return { ok: false, reason: "mood.summary not array" };
    if (!Array.isArray(o.mood.hot_entities)) return { ok: false, reason: "mood.hot_entities not array" };
    out.mood = {
      label: o.mood.label.slice(0, 80),
      summary: o.mood.summary.slice(0, 5).map((x: string) => String(x).slice(0, 100)),
      hot_entities: o.mood.hot_entities.slice(0, 5).map((x: string) => String(x)),
      active_surface_count: Number(o.mood.active_surface_count ?? 0),
    };
  }

  if (o.resolutions_proposed !== undefined) {
    if (!Array.isArray(o.resolutions_proposed)) return { ok: false, reason: "resolutions not array" };
    out.resolutions_proposed = [];
    for (const r of o.resolutions_proposed.slice(0, 20)) {
      if (typeof r?.event_id !== "number") continue;
      if (typeof r?.note !== "string") continue;
      out.resolutions_proposed.push({ event_id: r.event_id, note: String(r.note).slice(0, 300) });
    }
  }

  if (o.edges_proposed !== undefined) {
    if (!Array.isArray(o.edges_proposed)) return { ok: false, reason: "edges not array" };
    const EDGE_RELATIONS = ["led_to", "caused_by", "emotional_consequence_of"];
    out.edges_proposed = [];
    for (const e of o.edges_proposed.slice(0, 5)) {
      if (typeof e?.from_event !== "number" || typeof e?.to_event !== "number") continue;
      if (e.from_event === e.to_event) continue;
      if (!EDGE_RELATIONS.includes(e.relation)) continue;
      if (typeof e.reason !== "string" || !e.reason.trim()) continue;
      const strength = Math.max(0.1, Math.min(0.7, typeof e.strength === "number" ? e.strength : 0.5));
      out.edges_proposed.push({
        from_event: e.from_event, to_event: e.to_event, relation: e.relation,
        strength, reason: String(e.reason).slice(0, 300),
      });
    }
  }

  if (o.notes !== undefined) {
    if (!Array.isArray(o.notes)) return { ok: false, reason: "notes not array" };
    out.notes = o.notes.slice(0, 5).map((x: string) => String(x).slice(0, 100));
  }

  return { ok: true, data: out };
}


// Absorb isolated keyword changes without letting one recurring keyword block a genuine mood shift.
function moodLabelsSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length >= 3),
    );
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  const union = new Set([...sa, ...sb]).size;
  return shared / union >= 0.5;
}


// Keep retries local to this run so other callers do not repeat unsafe writes.
function daemonRetryDatabase(db: Env["DB"], pause?: RetryPause): Env["DB"] {
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const fixedUpdates = new Set([
    "UPDATE daemon_runs SET finished_at = datetime('now'), ok = 3, error_message = ? WHERE id = ?",
    "UPDATE daemon_runs SET finished_at = datetime('now'), ok = 2, error_message = 'JSON parse failed', raw_response = ? WHERE id = ?",
    "UPDATE daemon_runs SET raw_response = ? WHERE id = ?",
    "UPDATE daemon_runs SET finished_at = datetime('now'), ok = 2, error_message = ?, raw_response = ? WHERE id = ?",
    "UPDATE daemon_runs SET finished_at = datetime('now'), mode = ?, events_seen = ?, surfaces_proposed = ?, consolidations_proposed = ?, decay_modifiers_proposed = ?, ok = 1 WHERE id = ?",
    "UPDATE mood_state SET mood_label = ?, mood_summary = ?, hot_entities = ?, active_surfaces = ?, pending_label = NULL, pending_summary = NULL, pending_entities = NULL, pending_at = NULL, updated_at = datetime('now'), source = 'daemon' WHERE id = 1",
    "UPDATE mood_state SET mood_summary = ?, hot_entities = ?, active_surfaces = ?, pending_label = NULL, pending_summary = NULL, pending_entities = NULL, pending_at = NULL, updated_at = datetime('now'), source = 'daemon' WHERE id = 1",
    "UPDATE mood_state SET pending_label = ?, pending_summary = ?, pending_entities = ?, pending_at = datetime('now'), active_surfaces = ? WHERE id = 1",
    "UPDATE events_hot SET resolved_at = datetime('now'), resolution_note = ? WHERE id = ? AND kind = 'observation' AND resolved_at IS NULL",
    "UPDATE events_hot SET meta = ?, resolved_at = datetime('now'), resolution_note = ? WHERE id = ?",
    "UPDATE event_deletions SET tasks = ? WHERE id = ?",
  ]);
  const safe = (sql: string) => fixedUpdates.has(sql)
    || /^DELETE FROM /.test(sql)
    || /^CREATE TABLE IF NOT EXISTS (resolution_proposals|event_edges|event_deletions) \(/.test(sql)
    || /^UPDATE events_hot SET last_accessed_at = datetime\('now'\) WHERE id IN \(\?(,\?)*\)$/.test(sql);

  // Native batch execution must not call wrapped run methods and create nested retry budgets.
  const statements = new WeakMap<D1PreparedStatement, { native: D1PreparedStatement; sql: string }>();
  function wrap(native: D1PreparedStatement, sql: string, binds: unknown[] = []): D1PreparedStatement {
    const wrapped = new Proxy(native, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        if (key === "run") return async () => {
          if (safe(sql)) return retryD1Write(() => target.run(), { pause });

          let lookup: D1PreparedStatement | undefined;
          if (sql === "INSERT INTO daemon_runs (mode, ok) VALUES ('?', 0)") {
            // The watermark prevents recovery from claiming an older run's row.
            const before = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM daemon_runs").first<{ id: number }>();
            lookup = db.prepare("SELECT id FROM daemon_runs WHERE id > ? AND mode = '?' AND ok = 0 AND finished_at IS NULL LIMIT 1").bind(before!.id);
          } else if (sql.startsWith("INSERT INTO events_hot (kind, content, source, weight, meta, embedded)")) {
            // Preserve repeated model output while identifying only a row created by this attempt.
            const before = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events_hot").first<{ id: number }>();
            if (sql.includes("VALUES ('surface', ?, 'inferred', ?, ?, 0)")) {
              lookup = db.prepare("SELECT id FROM events_hot WHERE id > ? AND kind = 'surface' AND content = ? AND source = 'inferred' AND weight = ? AND meta = ? LIMIT 1").bind(before!.id, ...binds);
            } else if (sql.includes("VALUES ('observation', ?, 'daemon', 'light', ?, 0)")) {
              lookup = db.prepare("SELECT id FROM events_hot WHERE id > ? AND kind = 'observation' AND content = ? AND source = 'daemon' AND weight = 'light' AND meta = ? LIMIT 1").bind(before!.id, ...binds);
            }
          } else if (sql === "INSERT INTO consolidation_proposals (duplicate_ids, keep_id, reason) VALUES (?, ?, ?)") {
            lookup = db.prepare("SELECT id FROM consolidation_proposals WHERE duplicate_ids = ? AND keep_id = ? LIMIT 1").bind(binds[0], binds[1]);
          } else if (sql === "INSERT INTO resolution_proposals (event_id, note) VALUES (?, ?)") {
            lookup = db.prepare("SELECT id FROM resolution_proposals WHERE event_id = ? LIMIT 1").bind(binds[0]);
          } else if (sql.startsWith("INSERT INTO event_edges (from_event, to_event, relation, strength, proposed_by, reason)")) {
            lookup = db.prepare("SELECT id FROM event_edges WHERE from_event = ? AND to_event = ? AND relation = ? LIMIT 1").bind(...binds.slice(0, 3));
          } else if (sql === "INSERT INTO event_deletions (id, tasks) VALUES (?, ?)"
            || sql === "INSERT INTO event_deletions (id, tasks) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET tasks = excluded.tasks") {
            lookup = db.prepare("SELECT id FROM event_deletions WHERE id = ? AND tasks = ? LIMIT 1").bind(...binds);
          }
          if (!lookup) return target.run();
          return retryD1Write(() => target.run(), {
            pause,
            recover: async () => {
              const row = await lookup!.first<{ id: number }>();
              return row ? { success: true, results: [], meta: { last_row_id: Number(row.id) } } as D1Result : undefined;
            },
          });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { native, sql });
    return wrapped;
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), normalize(sql));
      if (key === "batch") return (batch: D1PreparedStatement[]) => {
        const entries = batch.map(statement => statements.get(statement));
        const write = () => target.batch(batch.map((statement, i) => entries[i]?.native ?? statement));
        return entries.every(entry => entry && safe(entry.sql)) ? retryD1Write(write, { pause }) : write();
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runDaemon(env: Env, pause?: RetryPause, modelPause: RetryPause = waitFor): Promise<{ ok: boolean; mode: string; reason?: string }> {
  if (!env.OPENROUTER_API_KEY) return { ok: false, mode: "?", reason: "OPENROUTER_API_KEY missing" };
  env = { ...env, DB: daemonRetryDatabase(env.DB, pause) };

  // Manual and scheduled runs can overwrite each other's proposals; unfinished runs expire after 30 minutes.
  const running = await env.DB.prepare(
    `SELECT id FROM daemon_runs WHERE ok = 0 AND finished_at IS NULL
     AND started_at > datetime('now', '-30 minutes') LIMIT 1`,
  ).first<{ id: number }>();
  if (running) return { ok: false, mode: "?", reason: `daemon already running (run ${running.id})` };

  const runStart = await env.DB.prepare(
    `INSERT INTO daemon_runs (mode, ok) VALUES ('?', 0)`,
  ).run();
  const runId = Number(runStart.meta.last_row_id);

  try {
    await retryConsolidations(env);
    const recentStreamRaw = await env.DB.prepare(
      `SELECT id, ts, kind, content, entity_name, emotion, weight, source, resolved_at, decay_weight, mood_at_write, meta
       FROM events_hot
       WHERE ts > datetime('now', '-7 days')
         AND kind IN ('observation', 'surface')
       ORDER BY ts DESC`,
    ).all();

    const dedupedStream = recentStreamRaw.results.map((r: any) => {
      let showCount = 0;
      if (r.kind === "surface" && r.meta) {
        try { showCount = JSON.parse(r.meta).show_count ?? 0; } catch {}
      }
      const out: any = {
        id: r.id, ts: r.ts, kind: r.kind, content: r.content, entity_name: r.entity_name,
        emotion: r.emotion, weight: r.weight, source: r.source, resolved_at: r.resolved_at,
        decay_weight: r.decay_weight, mood_at_write: r.mood_at_write,
      };
      if (r.kind === "surface") out.show_count = showCount;
      return out;
    });

    const unresolvedRaw = await env.DB.prepare(
      `SELECT id, ts, kind, content, entity_name, weight, decay_weight, mood_at_write
       FROM events_hot
       WHERE resolved_at IS NULL
         AND ts < datetime('now', '-24 hours')
         AND kind = 'observation'
       ORDER BY CASE weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, ts ASC
       LIMIT 50`,
    ).all();

    const moodRow = await env.DB.prepare(`SELECT * FROM mood_state WHERE id = 1`).first<any>();
    const moodUpdated = moodRow ? new Date(moodRow.updated_at.replace(" ", "T") + "Z").getTime() : 0;
    const moodAge = moodUpdated ? (Date.now() - moodUpdated) / 3_600_000 : 9999;

    const surfacesEngagedRaw = await env.DB.prepare(
      `SELECT id, content, resolution_note FROM events_hot
       WHERE kind = 'surface' AND resolved_at IS NOT NULL AND resolved_at > datetime('now', '-7 days')
       LIMIT 30`,
    ).all();

    const input: DaemonInput = {
      recent_stream: dedupedStream,
      unresolved_old: unresolvedRaw.results,
      current_mood: moodRow,
      mood_age_hours: moodAge,
      recent_surfaces_engaged: surfacesEngagedRaw.results,
      backlog_chunk: undefined,
    };


    const mode: "normal" | "backlog" = "normal";
    const prompt = buildPrompt(input, mode, (env as any).AGENT_NAME || "the agent");

    const { response: llmResp, attempts } = await callModelWithRetry(() => fetch(env.DAEMON_LLM_URL || DEFAULT_LLM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.DAEMON_LLM_MODEL || DEFAULT_LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 8000,
      }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    }), modelPause);

    if (!llmResp.ok) {
      const errText = await llmResp.text();
      const tries = attempts > 1 ? ` after ${attempts} attempts` : "";
      await env.DB.prepare(
        `UPDATE daemon_runs SET finished_at = datetime('now'), ok = 3, error_message = ? WHERE id = ?`,
      )
        .bind(`OpenRouter ${llmResp.status}${tries}: ${errText.slice(0, 500)}`, runId)
        .run();
      return { ok: false, mode, reason: `OpenRouter ${llmResp.status}` };
    }

    const llmJson = (await llmResp.json()) as any;
    const rawText = llmJson.choices?.[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      await env.DB.prepare(
        `UPDATE daemon_runs SET finished_at = datetime('now'), ok = 2, error_message = 'JSON parse failed', raw_response = ? WHERE id = ?`,
      )
        .bind(rawText.slice(0, 8000), runId)
        .run();
      return { ok: false, mode, reason: "JSON parse failed" };
    }

    const llmProposed = {
      surfaces: Array.isArray((parsed as any)?.surfaces) ? (parsed as any).surfaces.length : 0,
      consolidations: Array.isArray((parsed as any)?.consolidations) ? (parsed as any).consolidations.length : 0,
      resolutions: Array.isArray((parsed as any)?.resolutions_proposed) ? (parsed as any).resolutions_proposed.length : 0,
      mood: !!(parsed as any)?.mood,
      notes: Array.isArray((parsed as any)?.notes) ? (parsed as any).notes.length : 0,
    };
    console.log(`[daemon] LLM proposed:`, JSON.stringify(llmProposed));

    const loggedResponse = `[LLM_PROPOSED]: ${JSON.stringify(llmProposed)}\n\n[RAW]:\n${rawText}`;
    await env.DB.prepare(
      `UPDATE daemon_runs SET raw_response = ? WHERE id = ?`,
    ).bind(loggedResponse.slice(0, 16000), runId).run();

    const validation = validate(parsed);
    if (!validation.ok) {
      await env.DB.prepare(
        `UPDATE daemon_runs SET finished_at = datetime('now'), ok = 2, error_message = ?, raw_response = ? WHERE id = ?`,
      )
        .bind(validation.reason, rawText.slice(0, 5000), runId)
        .run();
      return { ok: false, mode, reason: validation.reason };
    }


    const out = validation.data;
    let surfacesProposed = 0;
    let consolidationsProposed = 0;
    const decayModsProposed = 0;  
    const touchedIds = new Set<number>();

    if (out.surfaces) {
      const existingSurfaces = await env.DB.prepare(
        `SELECT id, content FROM events_hot
         WHERE kind = 'surface' AND resolved_at IS NULL
           AND ts > datetime('now', '-14 days')`,
      ).all<{ id: number; content: string }>();
      const existingPatterns = new Set(
        existingSurfaces.results.map((s) => s.content.toLowerCase().trim()),
      );

      for (const s of out.surfaces) {
        if (existingPatterns.has(s.pattern.toLowerCase().trim())) continue;

        const placeholders = s.source_event_ids.map(() => "?").join(",");
        const existing = await env.DB.prepare(
          `SELECT id FROM events_hot WHERE id IN (${placeholders})`,
        )
          .bind(...s.source_event_ids)
          .all<{ id: number }>();
        if (existing.results.length < 2) continue;

        const existingIds = existing.results.map((r) => r.id);
        const conf = s.confidence ?? 0.5;
        const surfaceWeight = conf >= 0.7 ? "medium" : "light";

        await env.DB.prepare(
          `INSERT INTO events_hot (kind, content, source, weight, meta, embedded)
           VALUES ('surface', ?, 'inferred', ?, ?, 0)`,
        )
          .bind(
            s.pattern,
            surfaceWeight,
            JSON.stringify({
              observations: s.observations,
              source_event_ids: existingIds,
              show_count: 0,
              confidence: conf,
            }),
          )
          .run();
        for (const sid of existingIds) touchedIds.add(sid);
        surfacesProposed++;
      }
    }

    // Requiring a repeated proposal limits the damage from a single mistaken model response.
    if (out.consolidations) {
      await env.DB.prepare(
        `DELETE FROM consolidation_proposals WHERE proposed_at < datetime('now', '-48 hours')`,
      ).run();

      for (const c of out.consolidations) {
        const dupIds = c.duplicate_event_ids.filter((id) => id !== c.keep_id);
        if (!dupIds.length) continue;
        const sortedDupIds = [...dupIds].sort((a, b) => a - b);
        const dupKey = JSON.stringify(sortedDupIds);

        const existingProposal = await env.DB.prepare(
          `SELECT id FROM consolidation_proposals WHERE duplicate_ids = ? AND keep_id = ? LIMIT 1`,
        )
          .bind(dupKey, c.keep_id)
          .first<{ id: number }>();

        if (!existingProposal) {
          await env.DB.prepare(
            `INSERT INTO consolidation_proposals (duplicate_ids, keep_id, reason) VALUES (?, ?, ?)`,
          )
            .bind(dupKey, c.keep_id, c.reason)
            .run();
          continue;
        }

        // Between proposal and confirmation an event can be archived, merged or deleted; a stale
        // proposal is dropped instead of failing the whole night.
        const hotObservation = async (id: number) => (await env.DB.prepare(
          `SELECT kind FROM events_hot WHERE id = ?`,
        ).bind(id).first<{ kind: string }>())?.kind === "observation";
        const liveDupIds: number[] = [];
        for (const dupId of dupIds) if (await hotObservation(dupId)) liveDupIds.push(dupId);
        if (!liveDupIds.length || !(await hotObservation(c.keep_id))) {
          await env.DB.prepare(`DELETE FROM consolidation_proposals WHERE id = ?`)
            .bind(existingProposal.id)
            .run();
          continue;
        }

        for (const dupId of liveDupIds) {
          await consolidateEvent(env, dupId, c.keep_id, c.reason);
          touchedIds.add(dupId);
        }
        touchedIds.add(c.keep_id);

        await env.DB.prepare(`DELETE FROM consolidation_proposals WHERE id = ?`)
          .bind(existingProposal.id)
          .run();

        consolidationsProposed++;
      }
    }

    // A single unusual model response must not change the persistent mood.
    if (out.mood) {
      const cur = moodRow as any;
      const newLabel = out.mood.label;
      const newSummary = JSON.stringify(out.mood.summary);
      const newEntities = JSON.stringify(out.mood.hot_entities);
      const activeSurfaces = JSON.stringify(
        out.surfaces?.map((s) => ({ pattern: s.pattern, observations: s.observations, confidence: s.confidence })) ?? [],
      );

      const pendingFresh =
        cur?.pending_label && cur?.pending_at &&
        (Date.now() - new Date(cur.pending_at.replace(" ", "T") + "Z").getTime()) < 48 * 3600 * 1000;

      const matchesPending =
        pendingFresh &&
        moodLabelsSimilar(newLabel, cur.pending_label);

      if (matchesPending) {
        await env.DB.prepare(
          `UPDATE mood_state
           SET mood_label = ?, mood_summary = ?, hot_entities = ?, active_surfaces = ?,
               pending_label = NULL, pending_summary = NULL, pending_entities = NULL, pending_at = NULL,
               updated_at = datetime('now'), source = 'daemon'
           WHERE id = 1`,
        )
          .bind(newLabel, newSummary, newEntities, activeSurfaces)
          .run();
      } else if (cur?.mood_label === newLabel || moodLabelsSimilar(cur?.mood_label, newLabel)) {
        await env.DB.prepare(
          `UPDATE mood_state
           SET mood_summary = ?, hot_entities = ?, active_surfaces = ?,
               pending_label = NULL, pending_summary = NULL, pending_entities = NULL, pending_at = NULL,
               updated_at = datetime('now'), source = 'daemon'
           WHERE id = 1`,
        )
          .bind(newSummary, newEntities, activeSurfaces)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE mood_state
           SET pending_label = ?, pending_summary = ?, pending_entities = ?,
               pending_at = datetime('now'),
               active_surfaces = ?
           WHERE id = 1`,
        )
          .bind(newLabel, newSummary, newEntities, activeSurfaces)
          .run();
      }
    }

    // A later run must confirm resolution so one hallucination cannot close an observation.
    if (out.resolutions_proposed) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS resolution_proposals (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           event_id INTEGER NOT NULL,
           note TEXT,
           proposed_at TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
      ).run();
      await env.DB.prepare(
        `DELETE FROM resolution_proposals WHERE proposed_at < datetime('now', '-48 hours')`,
      ).run();

      for (const r of out.resolutions_proposed) {
        const existing = await env.DB.prepare(
          `SELECT id FROM resolution_proposals WHERE event_id = ?
           AND proposed_at < datetime('now', '-12 hours') LIMIT 1`,
        )
          .bind(r.event_id)
          .first<{ id: number }>();

        if (!existing) {
          const already = await env.DB.prepare(
            `SELECT id FROM resolution_proposals WHERE event_id = ? LIMIT 1`,
          )
            .bind(r.event_id)
            .first<{ id: number }>();
          if (!already) {
            await env.DB.prepare(
              `INSERT INTO resolution_proposals (event_id, note) VALUES (?, ?)`,
            )
              .bind(r.event_id, String(r.note).slice(0, 300))
              .run();
          }
          continue;
        }

        await env.DB.prepare(
          `UPDATE events_hot
           SET resolved_at = datetime('now'),
               resolution_note = ?
           WHERE id = ? AND kind = 'observation' AND resolved_at IS NULL`,
        )
          .bind(`[daemon] ${r.note}`, r.event_id)
          .run();
        touchedIds.add(r.event_id);
        await env.DB.prepare(`DELETE FROM resolution_proposals WHERE event_id = ?`)
          .bind(r.event_id)
          .run();
      }
    }

    // Edges stay tentative until explicitly confirmed, so they need no repeated model proposal.
    if (out.edges_proposed && out.edges_proposed.length) {
      await ensureEdgesTable(env);
      let edgesTimeRejected = 0;
      for (const e of out.edges_proposed) {
        const { results: ends } = await env.DB.prepare(
          `SELECT id, ts FROM events_hot WHERE id IN (?1, ?2)
           UNION ALL
           SELECT id, ts FROM events_archive WHERE id IN (?1, ?2)`,
        )
          .bind(e.from_event, e.to_event)
          .all<{ id: number; ts: string }>();
        const fromRow = ends.find((r) => r.id === e.from_event);
        const toRow = ends.find((r) => r.id === e.to_event);
        if (!fromRow || !toRow) continue;
        const causeFirst = e.relation === "led_to"
          ? fromRow.ts <= toRow.ts
          : toRow.ts <= fromRow.ts;
        if (!causeFirst) {
          edgesTimeRejected++;
          console.log(`[daemon] edge time-rejected: ${e.from_event} --${e.relation}--> ${e.to_event} (${fromRow.ts} vs ${toRow.ts})`);
          continue;
        }
        await env.DB.prepare(
          `INSERT INTO event_edges (from_event, to_event, relation, strength, proposed_by, reason)
           VALUES (?, ?, ?, ?, 'daemon', ?)
           ON CONFLICT(from_event, to_event, relation) DO NOTHING`,
        )
          .bind(e.from_event, e.to_event, e.relation, e.strength ?? 0.5, e.reason)
          .run();
      }
      if (edgesTimeRejected) console.log(`[daemon] edges time-rejected: ${edgesTimeRejected}/${out.edges_proposed.length}`);
    }

    for (const ids of bindChunks([...touchedIds])) {
      const placeholders = ids.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE events_hot SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .run();
    }

    if (out.notes && out.notes.length > 0) {
      for (const note of out.notes) {
        await env.DB.prepare(
          `INSERT INTO events_hot (kind, content, source, weight, meta, embedded)
           VALUES ('observation', ?, 'daemon', 'light', ?, 0)`,
        )
          .bind(note, JSON.stringify({ daemon_note: true, run_id: runId }))
          .run();
      }
    }


    await env.DB.prepare(
      `UPDATE daemon_runs
       SET finished_at = datetime('now'),
           mode = ?,
           events_seen = ?,
           surfaces_proposed = ?,
           consolidations_proposed = ?,
           decay_modifiers_proposed = ?,
           ok = 1
       WHERE id = ?`,
    )
      .bind(
        mode,
        dedupedStream.length,
        surfacesProposed,
        consolidationsProposed,
        decayModsProposed,
        runId,
      )
      .run();

    return { ok: true, mode };
  } catch (e) {
    await env.DB.prepare(
      `UPDATE daemon_runs SET finished_at = datetime('now'), ok = 3, error_message = ? WHERE id = ?`,
    )
      .bind(e instanceof Error ? e.message : String(e), runId)
      .run();
    console.error("memory daemon failed:", e);
    return { ok: false, mode: "?", reason: "daemon failed" };
  }
}

let usedColumnsEnsured = false;
export async function ensureUsedColumns(env: Env): Promise<void> {
  if (usedColumnsEnsured) return;
  const cols = await env.DB.prepare(`PRAGMA table_info(events_hot)`).all();
  const names = new Set((cols.results || []).map((r: any) => String(r.name)));
  if (!names.has("used_count")) await env.DB.prepare(`ALTER TABLE events_hot ADD COLUMN used_count REAL DEFAULT 0`).run();
  if (!names.has("last_used_at")) await env.DB.prepare(`ALTER TABLE events_hot ADD COLUMN last_used_at TEXT`).run();
  if (!names.has("injected_count")) await env.DB.prepare(`ALTER TABLE events_hot ADD COLUMN injected_count REAL DEFAULT 0`).run();
  if (!names.has("last_injected_at")) await env.DB.prepare(`ALTER TABLE events_hot ADD COLUMN last_injected_at TEXT`).run();
  if (!names.has("distracting_count")) await env.DB.prepare(`ALTER TABLE events_hot ADD COLUMN distracting_count REAL DEFAULT 0`).run();
  usedColumnsEnsured = true;
}

export async function cancelArchiveAttempts(env: Env, eventId?: number) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS event_deletions (id INTEGER PRIMARY KEY, tasks TEXT NOT NULL)`).run();
  const plans = (await env.DB.prepare(`SELECT id, tasks FROM event_deletions WHERE id < 0`).all<any>()).results;
  for (const plan of plans) {
    const task = JSON.parse(plan.tasks)[0];
    if (task.label !== "archive attempt" || (eventId !== undefined && task.eventId !== eventId)) continue;
    const cancelled = JSON.stringify([{ ...task, cancelled: true }]);
    // Cancelling the intent fences an in-flight writer before its object is removed.
    await env.DB.prepare(`UPDATE event_deletions SET tasks = ? WHERE id = ?`).bind(cancelled, plan.id).run();
    const referenced = await env.DB.prepare(`SELECT id FROM events_archive WHERE r2_path = ?`).bind(task.key).first();
    if (!referenced) await env.ARCHIVE.delete(task.key);
    // A cancelled intent remains as a content-free tombstone until its writer acknowledges cleanup.
    if (referenced || task.finished) await env.DB.prepare(`DELETE FROM event_deletions WHERE id = ? AND tasks = ?`).bind(plan.id, cancelled).run();
  }
}

export async function runMechanicalDecay(env: Env) {
  const report = { ok: true, candidates: 0, archived: 0, failed: [] as { id: number | null; error: string }[] };
  // Embeddings remain searchable after archival; only the full content moves to object storage.
  try {
    await cancelArchiveAttempts(env);
  } catch (error) {
    report.ok = false;
    console.error("memory pending archive cleanup failed:", error);
    report.failed.push({ id: null, error: "Pending archive cleanup failed" });
    return report;
  }
  await ensureUsedColumns(env);
  // SQLite SET expressions read old values, so salience needs a separate update after counter decay.
  await env.DB.prepare(
    `UPDATE events_hot SET access_count      = COALESCE(access_count, 0) * 0.97,
                           used_count        = COALESCE(used_count, 0) * 0.99,
                           injected_count    = COALESCE(injected_count, 0) * 0.99,
                           distracting_count = COALESCE(distracting_count, 0) * 0.99`,
  ).run();
  await env.DB.prepare(
    `UPDATE events_hot SET salience =
       (CASE weight WHEN 'heavy' THEN 2.0 WHEN 'medium' THEN 1.0 ELSE 0.5 END)
       * (1.0 + 0.3 * (CASE WHEN emotion IS NOT NULL AND emotion != '' THEN 0.5 ELSE 0.0 END))
       * (CASE certainty WHEN 'known' THEN 1.0 WHEN 'believed' THEN 0.9 ELSE 0.7 END)
       * (0.3 + 0.7 * exp(-(julianday('now') - julianday(ts)) / 30.0))
       * (1.0 + ln(1.0 + COALESCE(access_count, 0)))
       * (1.0 + 1.5 * ln(1.0 + min(COALESCE(used_count, 0), 12.0)))`,
  ).run();

  const archiveQuery = `
    SELECT id, ts, kind, content, entity_name, entity_type, emotion, weight, source, certainty,
           tags, resolved_at, resolution_note, mood_at_write, meta,
           CASE
             WHEN last_searched_at IS NULL AND last_engaged_at IS NULL THEN 'fast'
             WHEN last_searched_at IS NULL OR last_engaged_at IS NULL THEN 'medium-stagnant'
             ELSE 'slow-stagnant'
           END AS archive_class
    FROM events_hot
    WHERE kind = 'observation'
      AND (
        (last_searched_at IS NULL AND last_engaged_at IS NULL AND ts < datetime('now', '-21 days'))
        OR
        (
          (last_searched_at IS NOT NULL OR last_engaged_at IS NOT NULL)
          AND (last_searched_at IS NULL OR last_searched_at < datetime('now', '-28 days'))
          AND (last_engaged_at IS NULL OR last_engaged_at < datetime('now', '-28 days'))
          AND ts < datetime('now', '-21 days')
        )
      )
  `;
  const candidates = (await env.DB.prepare(archiveQuery).all<any>()).results;
  report.candidates = candidates.length;

  for (const row of candidates) {
    const attemptId = -Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - 1) + 1);
    const r2Path = `archive/${row.id}/${crypto.randomUUID()}.json`;
    const intent = JSON.stringify([{ label: "archive attempt", eventId: row.id, key: r2Path }]);
    const finishedIntent = JSON.stringify([{ label: "archive attempt", eventId: row.id, key: r2Path, finished: true }]);
    await env.DB.prepare(`INSERT INTO event_deletions (id, tasks) VALUES (?, ?)`).bind(attemptId, intent).run();
    const archivePayload = {
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      content: row.content,
      entity_name: row.entity_name,
      entity_type: row.entity_type,
      emotion: row.emotion,
      weight: row.weight,
      source: row.source,
      certainty: row.certainty,
      tags: row.tags,
      resolved_at: row.resolved_at,
      resolution_note: row.resolution_note,
      mood_at_write: row.mood_at_write,
      meta: row.meta,
      archived_at: new Date().toISOString().replace("T", " ").substring(0, 19),
      archive_reason: row.archive_class,
    };
    try {
      await env.ARCHIVE.put(r2Path, JSON.stringify(archivePayload), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (e) {
      await env.DB.prepare(`INSERT INTO event_deletions (id, tasks) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET tasks = excluded.tasks`).bind(attemptId, finishedIntent).run();
      console.error("memory archive write failed:", e);
      report.failed.push({ id: row.id, error: "archive write failed" });
      continue;
    }

    const summary = String(row.content ?? "").slice(0, 200);
    try {
      // A D1 batch is atomic, so a crash cannot leave the event in both tables.
      const columns = ["id", "ts", "kind", "content", "entity_name", "entity_type", "emotion", "weight", "source", "certainty", "tags", "resolved_at", "resolution_note", "mood_at_write", "meta"];
      const matches = columns.map(column => `${column} IS ?`).join(" AND ");
      // Snapshot comparison and intent ownership prevent stale archival from replacing a changed or deleted event.
      const result = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO events_archive (
             id, ts, kind, content, entity_name, entity_type, emotion, weight, source, certainty,
             tags, resolved_at, resolution_note, mood_at_write, meta, archive_reason, r2_path, summary
           ) SELECT id, ts, kind, NULL, entity_name, entity_type, emotion, weight, source, certainty,
             tags, resolved_at, resolution_note, mood_at_write, meta, ?, ?, ? FROM events_hot
             WHERE ${matches} AND EXISTS (SELECT 1 FROM event_deletions WHERE id = ? AND tasks = ?)
             AND NOT EXISTS (SELECT 1 FROM event_deletions WHERE id = events_hot.id)`,
        ).bind(row.archive_class, r2Path, summary, ...columns.map(column => row[column] ?? null), attemptId, intent),
        env.DB.prepare(`DELETE FROM events_hot WHERE id = ? AND EXISTS (SELECT 1 FROM events_archive WHERE id = ? AND r2_path = ?)`).bind(row.id, row.id, r2Path),
      ]);
      if (result[0].meta.changes) report.archived++;
      else await env.ARCHIVE.delete(r2Path);
      await env.DB.prepare(`DELETE FROM event_deletions WHERE id = ?`).bind(attemptId).run();
    } catch (e) {
      await env.DB.prepare(`INSERT INTO event_deletions (id, tasks) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET tasks = excluded.tasks`).bind(attemptId, finishedIntent).run();
      console.error("memory archive finalization failed:", e);
      report.failed.push({ id: row.id, error: "archive finalization failed" });
    }
  }
  report.ok = report.failed.length === 0;
  return report;
}
