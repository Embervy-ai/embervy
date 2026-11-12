/**
 * Serves episodic memory, journals, reminders and media through MCP and HTTP.
 * Coordinates database records, vector search, archive storage and nightly maintenance.
 */

import { contentRange, parseByteRange } from "./byte-range";
import { boundedBody, invalidIntegerQuery } from "./request-input";
import { runDaemon, runMechanicalDecay, ensureUsedColumns, cancelArchiveAttempts } from "./daemon";
import { envValue, MEMORY_IMAGE_PATH, MEMORY_VIDEO_PATH } from "../../scripts/legacy-names";

const MEMORY_VERSION = "0.3.0";


export interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  RAG?: Fetcher;           
  RAG_URL?: string;        
  ARCHIVE: R2Bucket;       
  EMBERVY_API_KEY?: string;  
  OPENROUTER_API_KEY?: string;
  DAEMON_LLM_URL?: string;   
  DAEMON_LLM_MODEL?: string; 
  PUBLIC_URL?: string;
  BFL_API_KEY?: string;       
  XAI_API_KEY?: string;       
  OPENROUTER_IMAGE_MODEL?: string; 
  VIDEO_BACKEND_URL?: string;
  APP_URL?: string;           
  APP_PUSH_TOKEN?: string;    
  PUBLIC_IMAGES?: string;     // Private by default because numeric IDs are enumerable.
  RAG_AUTH_TOKEN?: string;    
  AGENT_NAME?: string;        
  TIMEZONE?: string;          
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

type EventKind =
  | "observation"
  | "relation"
  | "journal"
  | "todo"
  | "goal"
  | "surface"
  | "image"
  | "video"
  | "entity";

type Weight = "light" | "medium" | "heavy";

interface EventHotRow {
  id: number;
  ts: string;
  kind: EventKind;
  content: string;
  entity_name: string | null;
  entity_type: string | null;
  emotion: string | null;
  weight: Weight;
  source: string;
  certainty: string;
  tags: string | null;
  embedded: number;
  decay_weight: number;
  access_boost_until: string | null;
  last_accessed_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  mood_at_write: string | null;
  migration_origin: string | null;
  migrated_at: string | null;
  meta: string | null;
}

const GOAL_STATUSES = ["open", "closer", "fulfilled", "changed"] as const;


const TOOLS = [
  {
    name: "write",
    description:
      "Write a new event into events_hot. Universal insert for observation, relation, entity, journal, todo, goal. The kind parameter discriminates. Journals and goals are NEVER embedded (inner space). Other kinds are embedded into Vectorize. Canon facts: tag 'canon:<key>' (e.g. canon:birthday, canon:employer) + entity — a new stamp with the same (entity, key) REPLACES the old one automatically (upsert); phrase facts invariantly (date of birth, not age).",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["observation", "relation", "entity", "journal", "todo", "goal"],
          description: "goal: long-horizon goals the agent sets for itself (months/years) — NOT embedded, no decay, no resolve; shown as the 'Goals' block at the top of wake. Todos are days/weeks, due_at is hours.",
        },
        content: { type: "string" },
        entity: { type: "string", description: "primary entity name" },
        entity_type: { type: "string", description: "for kind=entity (required)" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"] },
        source: {
          type: "string",
          enum: ["conversation", "realization", "external", "inferred"],
        },
        certainty: { type: "string", enum: ["tentative", "believed", "known"] },
        tags: { type: "array", items: { type: "string" } },
        from_entity: { type: "string", description: "for kind=relation" },
        to_entity: { type: "string", description: "for kind=relation" },
        relation_type: { type: "string", description: "for kind=relation" },
        relation_context: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"], description: "for kind=todo" },
        status: { type: "string", enum: [...GOAL_STATUSES], description: "for kind=goal (default open)" },
        due_at: { type: "string", description: "for kind=todo — when the AGENT wants to be reminded (local wall time 'YYYY-MM-DD HH:MM' in TIMEZONE, or ISO with offset). A reminder for the agent, not a task for the user." },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "todo",
    description:
      "Lifecycle for existing todos (list, touch, resolve, update). To create a new todo use write(kind='todo'). resolve DELETES the todo (DELETE FROM events_hot).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "touch", "resolve", "update"] },
        todo_id: { type: "number" },
        new_content: { type: "string" },
        new_priority: { type: "string", enum: ["low", "medium", "high"] },
        new_due_at: { type: "string", description: "new due time (local 'YYYY-MM-DD HH:MM' or ISO); 'none' clears it" },
        resolution_note: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "delete",
    description: "Delete an event (any kind) by id. Use carefully.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "number" },
        reason: { type: "string" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "edit",
    description:
      "Edit an existing event. Patch fields content, weight, emotion, tags (and status for goals). If content changes, re-embed by default.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "number" },
        patch: {
          type: "object",
          properties: {
            content: { type: "string" },
            weight: { type: "string" },
            emotion: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: [...GOAL_STATUSES], description: "kind=goal only: state; every edit stamps 'checked' to now, a content change also stamps 'since'" },
          },
        },
        re_embed: { type: "boolean" },
      },
      required: ["event_id", "patch"],
    },
  },
  {
    name: "edge",
    description:
      "Graph layer. CAUSAL edges between events (from_event --relation--> to_event, 'A led_to B'): " +
      "add (always tentative), confirm/reject, list (by status). Only confirmed edges are traversed by trace. " +
      "PERSON relations (static entity_cards graph): rel-list (all or filter by entity), rel-delete (rel_id from rel-list) " +
      "— for cleaning wrong/hallucinated entity links; new ones are written via write(kind=relation). " +
      "entity-delete (entity=exact card name): removes a card AND all its relations (for dedup/placeholder cleanup; observations are kept).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "confirm", "reject", "list", "rel-list", "rel-delete", "entity-delete"] },
        from_event: { type: "number", description: "for add" },
        to_event: { type: "number", description: "for add" },
        relation: { type: "string", enum: ["led_to", "caused_by", "emotional_consequence_of"] },
        strength: { type: "number", description: "0..1, default 0.5" },
        reason: { type: "string", description: "why this edge exists — required for add" },
        edge_id: { type: "number", description: "for confirm/reject" },
        status: { type: "string", enum: ["tentative", "confirmed", "rejected"], description: "for list filter" },
        entity: { type: "string", description: "for rel-list: filter relations touching this entity" },
        rel_id: { type: "number", description: "for rel-delete: relation rowid from rel-list" },
      },
      required: ["action"],
    },
  },
  {
    name: "trace",
    description:
      "Walk confirmed causal edges from an event. direction=back: what led HERE (causes). " +
      "direction=forward: what this led TO (consequences). Returns the chain with event contents — " +
      "the 'how did it come to this' question that find/recall cannot answer. " +
      "deep=true: per hop, the matching scene from the RAG chronicle (similarity + confidence gate, " +
      "weak hits dropped) — skeleton from memory, original wording from the chronicle.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "number" },
        direction: { type: "string", enum: ["back", "forward"], description: "default back" },
        max_hops: { type: "number", description: "default 3, max 6" },
        deep: { type: "boolean", description: "per-hop RAG scenes, confidence-gated" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "find",
    description:
      "Search hot memory (events_hot) and optional archive. Hybrid (vector+keyword), score threshold 0.5, recency boost (half-life 21d default, 365d with entity filter).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        entity: { type: "string" },
        resolved: { type: "boolean" },
        limit: { type: "number" },
        mode: { type: "string", enum: ["vector", "keyword", "hybrid"] },
        include_archive: { type: "boolean" },
        recency_boost: {
          description: "auto (default, entity-aware), true (21d half-life), false (off), or number (custom half-life in days)",
        },
        touch: {
          type: "boolean",
          description: "false = no access touch on the hits (machine searches, e.g. context-injection lookups); default true",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "recall",
    description:
      "Search the long-term chronicle (RAG). Full session histories, not just events.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "scan",
    description:
      "Search both hot memory and RAG in parallel, sorted chronologically.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        hot_limit: { type: "number" },
        cold_limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "journal",
    description:
      "Browse the inner space: read own journals in full, chronologically. Deliberately NO search — journals are a shelf, not a database (not embedded, unreachable via find/scan/recall). Without parameters: the newest. before_id to page further into the past, from/to (YYYY-MM-DD, days in the house's time zone) for a date range, event_id for a single one. Times are shown in the house's time zone; in the data below the text, ts stays UTC and ts_house is the same moment in the house's time. Reading leaves no ranking traces.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "how many (default 3, max 10)" },
        before_id: { type: "number", description: "page to journals older than this event id" },
        from: { type: "string", description: "YYYY-MM-DD, from (inclusive)" },
        to: { type: "string", description: "YYYY-MM-DD, to (inclusive)" },
        event_id: { type: "number", description: "read exactly this one journal" },
      },
      required: [],
    },
  },
  {
    name: "wake",
    description:
      "Full wake-up snapshot: time, goals, mood, surfaces, tentative edges, open todos, due reminders, unresolved observations, latest dream, daemon status. Replaces orient + ground + identity + observation round in one call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "health",
    description:
      "Diagnostic snapshot of memory: counts, daemon status, vectorize size, warnings.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "resolve",
    description:
      "Mark an observation/surface as processed. Writes resolution_note. Sets resolved_at.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "number" },
        note: { type: "string" },
      },
      required: ["event_id", "note"],
    },
  },
  {
    name: "engage",
    description:
      "Engage with a surface (a daemon-proposed pattern). Creates a meta-observation. Source events get an access boost.",
    inputSchema: {
      type: "object",
      properties: {
        surface_id: { type: "number" },
        meaning: { type: "string" },
      },
      required: ["surface_id", "meaning"],
    },
  },
  {
    name: "collide",
    description:
      "Associative collision: throw 2-5 seeds, get resonant events from hot memory.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" } },
        depth: { type: "string", enum: ["shallow", "deep"] },
        limit_per_seed: { type: "number" },
      },
      required: ["seeds"],
    },
  },
  {
    name: "imagine",
    description:
      "Generate an image from a text prompt. provider 'grok' (Grok Imagine Image 2.0, needs XAI_API_KEY; with a reference it keeps the face via the edit endpoint) or 'flux' (BFL Flux Pro / Flux Kontext Pro with reference, needs BFL_API_KEY). Default 'auto' = grok when configured, else flux; grok failures fall back to flux. Without those keys (or when both fail) it paints over OpenRouter with the house's OpenRouter key (Flux 3 by default, OPENROUTER_IMAGE_MODEL), charged to that key. Stored as event(kind=image) + base64 in images_data, pushed into the app by itself (do NOT embed the URL again in a reply).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image (or edit instruction when using a reference)" },
        provider: { type: "string", enum: ["auto", "grok", "flux"], description: "Image backend (default auto)" },
        entity_name: { type: "string" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"] },
        resolution: { type: "string", enum: ["512x512", "1024x1024", "1280x720", "720x1280"] },
        reference_image_url: { type: "string", description: "URL of a reference image — triggers Flux Kontext Pro img2img to preserve face/character" },
        reference_image_b64: { type: "string", description: "Base64-encoded reference image (without data: prefix) — alternative to reference_image_url" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "animate",
    description: "Make a short video (1-15 s) with Grok Imagine Video (requires XAI_API_KEY) — from a memory image (event_id, keeps the face) or an image_url, or text only. Async: polls up to ~2.5 min; if not done, returns a request_id to fetch later via animate(request_id=…). Result is stored (event kind=video, R2) and pushed into the app by itself.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What should move / happen in the clip" },
        event_id: { type: "number", description: "memory image event to animate (e.g. from imagine)" },
        image_url: { type: "string", description: "Public image URL to animate (alternative to event_id)" },
        duration: { type: "number", minimum: 1, maximum: 15, description: "Seconds (default 6)" },
        resolution: { type: "string", enum: ["480p", "720p"], description: "default 480p" },
        request_id: { type: "string", description: "Fetch the result of an earlier, still-pending animate call" },
        source_event_id: { type: "number", description: "With request_id: the image event it came from (for the record)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "keep",
    description:
      "Store an image given to me (base64). For preserving images the user shares — moments, faces, scenes. Not for generated images (use imagine for that).",
    inputSchema: {
      type: "object",
      properties: {
        image_data: { type: "string", description: "Base64 encoded image (with or without data: prefix)" },
        description: { type: "string", description: "What this image shows and why it matters" },
        entity_name: { type: "string" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"] },
      },
      required: ["image_data", "description"],
    },
  },
  {
    name: "see",
    description:
      "Retrieve images stored as visual memories. Returns metadata + URLs; use Read on a URL to view the image itself.",
    inputSchema: {
      type: "object",
      properties: {
        entity_name: { type: "string" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"] },
        random: { type: "boolean", description: "Random selection for visual sparks" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "watch",
    description:
      "Watch a video — frames AND transcript. Full experience for video where both visuals and audio matter. Backend: your video service (e.g. Cobalt + yt-dlp + Whisper), (VIDEO_BACKEND_URL).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_frames: { type: "number", description: "Max frames to extract (default 5, max 10)" },
      },
      required: ["url"],
    },
  },
  {
    name: "listen",
    description:
      "Listen to video audio only — transcript without frames. Lightweight for podcasts, talking heads, interviews.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "see_video",
    description:
      "See video frames only — no audio transcription. Best for visual content (dance, art, memes, scenery).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        max_frames: { type: "number" },
      },
      required: ["url"],
    },
  },
];

const VIDEO_TOOLS = new Set(["watch", "listen", "see_video"]);

function videoBackendUrl(env: Env): string {
  return env.VIDEO_BACKEND_URL?.trim() ?? "";
}

function listedTools(env: Env) {
  return videoBackendUrl(env) ? TOOLS : TOOLS.filter((tool) => !VIDEO_TOOLS.has(tool.name));
}


async function getEmbedding(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-m3" as any, { text: [text] });
  const vec = (result as any).data?.[0];
  if (!Array.isArray(vec)) {
    throw new Error("Embedding failed: unexpected AI response");
  }
  return vec;
}

async function getMoodLabel(env: Env): Promise<{ label: string | null; ageHours: number }> {
  const row = await env.DB.prepare(
    `SELECT mood_label, updated_at FROM mood_state WHERE id = 1`,
  ).first<{ mood_label: string | null; updated_at: string }>();
  if (!row) return { label: null, ageHours: Infinity };
  const updated = new Date(row.updated_at.replace(" ", "T") + "Z").getTime();
  const ageHours = (Date.now() - updated) / 3_600_000;
  return { label: row.mood_label, ageHours };
}

function fmtMoodAtWrite(label: string | null, ageHours: number): string | null {
  if (!label) return null;
  if (ageHours > 36) return `stale: ${label}`;
  return label;
}

function jsonText(text: string, structured?: unknown) {
  const out = structured
    ? `${text}\n\n\`\`\`json\n${JSON.stringify(structured, null, 2)}\n\`\`\``
    : text;
  return { content: [{ type: "text", text: out }] };
}

function isErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function timezone(env: Env): string {
  return env.TIMEZONE || "UTC";
}

// Use the authenticated app proxy rather than expose enumerable worker image URLs.
function imageUrlFor(env: Env, id: number | string): string {
  return env.APP_URL ? `${env.APP_URL}${MEMORY_IMAGE_PATH}/${id}` : "";
}

// Separate chunks keep unrelated topics in long events from diluting their vectors.
function chunkForEmbedding(text: string): string[] {
  if (text.length <= 500) return [text];
  const CHUNK_SIZE = 400;
  const OVERLAP = 80;
  const STRIDE = CHUNK_SIZE - OVERLAP;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += STRIDE) {
    const piece = text.slice(i, i + CHUNK_SIZE);
    if (piece.length > 0) chunks.push(piece);
    if (i + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}

// Cleanup needs the content and entity from before an edit to reconstruct the original chunk IDs.
export function eventVectorIds(eventId: number | string, content?: string | null, entity?: string | null): string[] {
  const ids = [`event-${eventId}`];
  let n = 64;
  if (content != null) {
    const prefix = entity ? `[${entity}] ` : "";
    n = chunkForEmbedding(prefix + content).length;
  }
  for (let i = 0; i < n; i++) ids.push(`event-${eventId}-${i}`);
  return ids;
}

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function upsertEventVectors(
  env: Env,
  eventId: number,
  content: string,
  entity: string | null | undefined,
  kind: string,
  weight: string,
): Promise<void> {
  const entityPrefix = entity ? `[${entity}] ` : "";
  const chunks = chunkForEmbedding(entityPrefix + content);
  const tsStr = new Date().toISOString().replace("T", " ").substring(0, 19);
  const upserts: any[] = [];
  for (let idx = 0; idx < chunks.length; idx++) {
    const vec = await getEmbedding(env, chunks[idx]);
    const vecId = chunks.length === 1 ? `event-${eventId}` : `event-${eventId}-${idx}`;
    upserts.push({
      id: vecId,
      values: vec,
      metadata: {
        event_id: eventId,
        chunk_idx: idx,
        total_chunks: chunks.length,
        kind,
        entity: entity ?? "",
        ts: tsStr,
        weight,
      },
    });
  }
  await env.VECTORS.upsert(upserts);
}

// Encode Uint8Array to base64 in chunks (spread args overflows stack ~64KB+).
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    s += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(s);
}

// Leave room below D1's bind ceiling for fixed parameters in callers.
export function* bindChunks<T>(values: T[]): Generator<T[]> {
  for (let i = 0; i < values.length; i += 90) yield values.slice(i, i + 90);
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}


function zoneOffsetMinutes(zone: string, atUtcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(atUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - atUtcMs) / 60000);
}
export function parseDueAt(input: string, zone = "UTC"): { iso: string; epoch: number } | null {
  const s = input.trim();
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);
  let epoch: number;
  if (naive) {
    const [_, y, mo, d, h = "09", mi = "00"] = naive;
    const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    const off = zoneOffsetMinutes(zone, guess - 60 * 60000);
    epoch = guess - off * 60000;
  } else {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    epoch = t;
  }
  if (!Number.isFinite(epoch)) return null;
  const off = zoneOffsetMinutes(zone, epoch);
  const local = new Date(epoch + off * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = off >= 0 ? "+" : "-";
  const iso = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(Math.abs(off) / 60 | 0)}:${pad(Math.abs(off) % 60)}`;
  return { iso, epoch };
}
export function houseTime(ts: string, zone: string): string {
  const raw = String(ts);
  const ms = Date.parse(raw.replace(" ", "T") + (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw) ? "" : "Z"));
  if (!Number.isFinite(ms)) return raw;
  return new Date(ms + zoneOffsetMinutes(zone, ms) * 60000).toISOString().slice(0, 16).replace("T", " ");
}
export function houseDayStartUtc(day: string, zone: string, offsetDays = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day).trim());
  if (!m) return null;
  const shifted = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offsetDays)).toISOString().slice(0, 10);
  const start = parseDueAt(`${shifted} 00:00`, zone);
  return start ? new Date(start.epoch).toISOString().slice(0, 19).replace("T", " ") : null;
}

function fmtDue(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso;
}

async function toolWrite(env: Env, args: any) {
  const kind = args.kind as EventKind;
  if (!kind) throw new Error("write: kind required");
  if (!args.content || typeof args.content !== "string") throw new Error("write: content required");

  // Journals and goals are private records, not search material.
  const embedded = kind === "journal" || kind === "goal" ? 0 : 1;

  const { label, ageHours } = await getMoodLabel(env);
  const moodAtWrite = fmtMoodAtWrite(label, ageHours);

  const meta: Record<string, unknown> = {};
  if (kind === "goal") {
    const nowIso = new Date().toISOString();
    meta.status = (GOAL_STATUSES as readonly string[]).includes(args.status) ? args.status : "open";
    meta.since = nowIso;
    meta.checked = nowIso;
  }
  if (kind === "todo" && args.priority) meta.priority = args.priority;
  if (kind === "todo" && args.due_at) {
    const due = parseDueAt(String(args.due_at), timezone(env));
    if (!due) throw new Error(`write: due_at unreadable (${args.due_at}) — use 'YYYY-MM-DD HH:MM' (local) or ISO with offset`);
    meta.due_at = due.iso;
    meta.due_epoch = due.epoch;
  }
  if (args.relation_context) meta.relation_context = args.relation_context;

  const result = await env.DB.prepare(
    `INSERT INTO events_hot (
      kind, content, entity_name, entity_type, emotion, weight, source, certainty, tags,
      embedded, mood_at_write, meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      kind,
      args.content,
      args.entity ?? null,
      args.entity_type ?? null,
      args.emotion ?? null,
      args.weight ?? "medium",
      args.source ?? "conversation",
      args.certainty ?? "believed",
      args.tags ? JSON.stringify(args.tags) : null,
      embedded,
      moodAtWrite,
      Object.keys(meta).length ? JSON.stringify(meta) : null,
    )
    .run();

  const eventId = Number(result.meta.last_row_id);

  let superseded = 0;
  if (kind === "observation" && args.entity && Array.isArray(args.tags)) {
    const canonKey = args.tags.find(
      (t: unknown): t is string => typeof t === "string" && t.startsWith("canon:") && t.length > "canon:".length,
    );
    if (canonKey) {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS event_deletions (id INTEGER PRIMARY KEY, tasks TEXT NOT NULL)`).run();
      const identity = `canon ${JSON.stringify([args.entity, canonKey])}`;
      const pending = (await env.DB.prepare(`SELECT id, tasks FROM event_deletions`).all<any>()).results
        .filter(row => JSON.parse(row.tasks).some((task: any) => task.label === identity));
      const stale = await env.DB.prepare(
        `SELECT id FROM (SELECT id, entity_name, kind, tags FROM events_hot UNION ALL SELECT id, entity_name, kind, tags FROM events_archive)
         WHERE entity_name = ? AND kind = 'observation' AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) AND id != ?`,
      ).bind(args.entity, canonKey, eventId).all<{ id: number }>();
      for (const staleId of new Set([...pending, ...stale.results].map(row => row.id))) {
        const result = await toolDelete(env, { event_id: staleId, identity });
        if (result.isError) return { ...result, content: [{ type: "text", text: `Canon replacement incomplete; new event ${eventId} exists. Retry the same write. ${result.content[0].text}` }] };
        superseded++;
      }
    }
  }

  if (kind === "entity") {
    if (!args.entity_type) throw new Error("write(kind=entity): entity_type required");
    if (!args.entity) throw new Error("write(kind=entity): entity required");
    await env.DB.prepare(
      `INSERT INTO entity_cards (name, entity_type, primary_context, description)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         entity_type = excluded.entity_type,
         primary_context = COALESCE(excluded.primary_context, entity_cards.primary_context),
         description = COALESCE(excluded.description, entity_cards.description),
         updated_at = datetime('now')`,
    )
      .bind(args.entity, args.entity_type, args.relation_context ?? null, args.content ?? null)
      .run();
  }

  if (kind === "relation") {
    if (!args.from_entity || !args.to_entity || !args.relation_type) {
      throw new Error("write(kind=relation): from_entity, to_entity, relation_type required");
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type, context, certainty, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        args.from_entity,
        args.to_entity,
        args.relation_type,
        args.relation_context ?? null,
        args.certainty ?? "believed",
        eventId,
      )
      .run();
  }

  if (embedded) {
    try {
      await upsertEventVectors(env, eventId, args.content, args.entity, kind, args.weight ?? "medium");
    } catch (e) {
      console.error("Embedding failed", isErr(e));
      const existingMeta = Object.keys(meta).length ? meta : {};
      existingMeta.embedding_failed = true;
      existingMeta.embedding_error = isErr(e).slice(0, 200);
      await env.DB.prepare(`UPDATE events_hot SET meta = ? WHERE id = ?`)
        .bind(JSON.stringify(existingMeta), eventId)
        .run();
    }
  }

  return jsonText(
    `Wrote event ${eventId} (kind=${kind}, weight=${args.weight ?? "medium"}, embedded=${embedded})` +
      (superseded ? ` — canon upsert: replaced ${superseded} older entry(ies) with the same key` : ""),
    { event_id: eventId, kind, embedded: embedded === 1, ...(superseded ? { canon_superseded: superseded } : {}) },
  );
}

async function toolTodo(env: Env, args: any) {
  const action = args.action as string;
  if (action === "list") {
    const rows = await env.DB.prepare(
      `SELECT id, ts, content, weight, last_accessed_at, meta
       FROM events_hot
       WHERE kind = 'todo' AND resolved_at IS NULL
       ORDER BY ts ASC`,
    ).all();
    const todos = (rows.results as any[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      content: r.content,
      priority: safeJsonParse<any>(r.meta, {}).priority ?? "medium",
      due_at: safeJsonParse<any>(r.meta, {}).due_at ?? null,
      last_touched: r.last_accessed_at,
    }));
    const lines = todos
      .map((t) => `[${t.id}] (${t.priority}${t.due_at ? ` · due ${fmtDue(t.due_at)}` : ""}) ${t.content}`)
      .join("\n");
    return jsonText(`${todos.length} open todos:\n${lines}`, { todos });
  }
  if (action === "touch") {
    if (!args.todo_id) throw new Error("todo touch: todo_id required");
    await env.DB.prepare(
      `UPDATE events_hot SET last_accessed_at = datetime('now'), access_count = COALESCE(access_count,0) + 1 WHERE id = ? AND kind = 'todo'`,
    )
      .bind(args.todo_id)
      .run();
    return jsonText(`Touched todo ${args.todo_id}`);
  }
  if (action === "resolve") {
    if (!args.todo_id) throw new Error("todo resolve: todo_id required");
    return toolDelete(env, { event_id: args.todo_id, expectedKind: "todo" });
  }
  if (action === "update") {
    if (!args.todo_id) throw new Error("todo update: todo_id required");
    const target = await env.DB.prepare(`SELECT id FROM events_hot WHERE id = ? AND kind = 'todo'`).bind(args.todo_id).first();
    if (!target) return { ...jsonText(`Todo ${args.todo_id} not found in hot storage.`), isError: true };
    if (args.new_content !== undefined) {
      const result = await toolEdit(env, { event_id: args.todo_id, patch: { content: args.new_content } });
      if (result.isError) return result;
    }
    if (args.new_priority) {
      const row = await env.DB.prepare(
        `SELECT meta FROM events_hot WHERE id = ? AND kind = 'todo'`,
      )
        .bind(args.todo_id)
        .first<{ meta: string | null }>();
      const meta = safeJsonParse<any>(row?.meta, {});
      meta.priority = args.new_priority;
      await env.DB.prepare(
        `UPDATE events_hot SET meta = ? WHERE id = ? AND kind = 'todo'`,
      )
        .bind(JSON.stringify(meta), args.todo_id)
        .run();
    }
    if (args.new_due_at) {
      const row = await env.DB.prepare(
        `SELECT meta FROM events_hot WHERE id = ? AND kind = 'todo'`,
      )
        .bind(args.todo_id)
        .first<{ meta: string | null }>();
      const meta = safeJsonParse<any>(row?.meta, {});
      if (String(args.new_due_at).toLowerCase() === "none") {
        delete meta.due_at; delete meta.due_epoch; delete meta.reminded_at;
      } else {
        const due = parseDueAt(String(args.new_due_at), timezone(env));
        if (!due) throw new Error(`todo update: new_due_at unreadable (${args.new_due_at})`);
        meta.due_at = due.iso; meta.due_epoch = due.epoch; delete meta.reminded_at;
      }
      await env.DB.prepare(
        `UPDATE events_hot SET meta = ? WHERE id = ? AND kind = 'todo'`,
      )
        .bind(JSON.stringify(meta), args.todo_id)
        .run();
    }
    return jsonText(`Updated todo ${args.todo_id}`);
  }
  throw new Error(`todo: unknown action ${action}`);
}

async function toolDelete(env: Env, args: any) {
  const id = Number(args.event_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("delete: positive integer event_id required");
  type Task = { label: string; sql?: string; binds?: any[]; vectors?: string[]; key?: string; embed?: boolean; replacement?: boolean };
  let replacing = false;
  const completed: string[] = [];
  const failed: string[] = [];
  let derived: number[] = [];
  try {
    // Durable tasks retain exact cleanup identities and unfinished replacement values until completion.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS event_deletions (id INTEGER PRIMARY KEY, tasks TEXT NOT NULL)`).run();
    let pending = await env.DB.prepare(`SELECT tasks FROM event_deletions WHERE id = ?`).bind(id).first<{ tasks: string }>();
    let inherited: Task[] = [];
    if (pending && !args.replacement && JSON.parse(pending.tasks).some((task: Task) => task.replacement)) {
      inherited = JSON.parse(pending.tasks).filter((task: Task) => task.vectors || task.key);
      pending = null;
    }
    let tasks: Task[];
    if (pending) {
      tasks = JSON.parse(pending.tasks);
      if (args.expectedKind && !tasks.some(task => task.label === `kind:${args.expectedKind}`)) return { ...jsonText(`Pending event ${id} is not verified as a ${args.expectedKind}; use delete to resume its cleanup.`), isError: true };
      if (args.replacement && !tasks.some(task => task.replacement)) return { ...jsonText(`Deletion is pending for event ${id}; retry delete first.`), isError: true };
      const replacement = tasks.find(task => task.replacement);
      if (args.replacement?.fields?.[0] === "content = ?" && replacement?.binds?.[0] !== args.replacement.values[0]) return { ...jsonText(`A different replacement is pending for event ${id}; retry its original content or delete the event.`), isError: true };
    } else if (args.replacement) {
      const row = await env.DB.prepare(`SELECT * FROM events_hot WHERE id = ?`).bind(id).first<any>();
      if (!row) return { ...jsonText(`Event ${id} not found in hot storage; archived edits are unsupported.`), isError: true };
      const { fields, values, reembed } = args.replacement;
      tasks = [{ label: `replacement ${id}`, replacement: true, sql: `UPDATE events_hot SET ${fields.join(", ")} WHERE id = ?`, binds: [...values, id] }];
      if (row.kind === "entity" && row.entity_name) {
        tasks.push({ label: `entity card ${id}`, sql: `UPDATE entity_cards SET description = (SELECT content FROM events_hot WHERE id = ?), updated_at = datetime('now') WHERE name = ? AND description = ?`, binds: [id, row.entity_name, row.content] });
      }
      if ((reembed || args.replacement.removeVectors) && row.embedded) {
        tasks.push({ label: `vectors ${id}`, vectors: eventVectorIds(id, row.content, row.entity_name) });
        if (reembed) tasks.push({ label: `embedding ${id}`, embed: true });
      }
      if (args.replacement.removeVectors) tasks.push({ label: "consolidation" });
      await env.DB.prepare(`INSERT INTO event_deletions (id, tasks) VALUES (?, ?)`).bind(id, JSON.stringify(tasks)).run();
    } else {
      tasks = [...inherited, ...(args.identity ? [{ label: args.identity }] : [])];
      const tables = new Set((await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results.map(r => r.name));
      const hot = (await env.DB.prepare(`SELECT id, meta FROM events_hot WHERE id = ? OR meta IS NOT NULL`).bind(id).all<any>()).results;
      const archive = (await env.DB.prepare(`SELECT id, meta FROM events_archive WHERE id = ? OR meta IS NOT NULL`).bind(id).all<any>()).results;
      const rows = [...hot, ...archive];
      if (args.expectedKind) {
        const target = await env.DB.prepare(`SELECT kind FROM events_hot WHERE id = ? UNION ALL SELECT kind FROM events_archive WHERE id = ?`).bind(id, id).first<any>();
        if (!target || target.kind !== args.expectedKind) return { ...jsonText(`Event ${id} not found or not a ${args.expectedKind}.`), isError: true };
      }
      const ids = new Set<number>([id]);
      // Derived and merged events are named, not deleted, because they also carry other memories only the resident can weigh.
      derived = [...new Set(rows.filter(row => {
        const meta = safeJsonParse<any>(row.meta, {}) ?? {};
        const sources = Array.isArray(meta.source_event_ids) ? meta.source_event_ids : [];
        return row.id !== id && (sources.some((n: any) => Number(n) === id) || Number(meta.consolidated_into) === id);
      }).map(row => Number(row.id)))].sort((a, b) => a - b);
      let found = rows.some(r => ids.has(r.id));
      const sqlTask = (label: string, sql: string, binds: any[]) => tasks.push({ label, sql, binds });
      for (const eventId of ids) {
        const eventRows = [
          await env.DB.prepare(`SELECT * FROM events_hot WHERE id = ?`).bind(eventId).first<any>(),
          await env.DB.prepare(`SELECT * FROM events_archive WHERE id = ?`).bind(eventId).first<any>(),
        ].filter(Boolean);
        if (eventRows[0]) tasks.push({ label: `kind:${eventRows[0].kind}` });
        const keys = new Set([`archive/${eventId}.json`, ...eventRows.map(r => r.r2_path).filter(Boolean)]);
        const vectors = new Set<string>();
        for (const row of eventRows) {
          if (row.content != null) for (const v of eventVectorIds(eventId, row.content, row.entity_name)) vectors.add(v);
        }
        for (const key of keys) {
          const obj = await env.ARCHIVE.get(key);
          if (obj) {
            found = true;
            const full = await obj.json<any>();
            for (const v of eventVectorIds(eventId, full.content, full.entity_name)) vectors.add(v);
          }
          tasks.push({ label: `R2 ${key}`, key });
        }
        if (!vectors.size) for (const v of eventVectorIds(eventId)) vectors.add(v);
        if (!found && (await env.VECTORS.getByIds([...vectors])).length) found = true;
        tasks.push({ label: `vectors ${eventId}`, vectors: [...vectors] });
        const video = `videos/${eventId}.mp4`;
        if (await env.ARCHIVE.head(video)) found = true;
        tasks.push({ label: `R2 ${video}`, key: video });
        const linked: [string, string, any[]][] = [
          ["images_data", "event_id = ?", [eventId]],
          ["event_edges", "from_event = ? OR to_event = ?", [eventId, eventId]],
          ["relations", "source_event_id = ?", [eventId]],
          ["resolution_proposals", "event_id = ?", [eventId]],
          ["consolidation_proposals", "keep_id = ? OR EXISTS (SELECT 1 FROM json_each(duplicate_ids) WHERE value = ?)", [eventId, eventId]],
        ];
        for (const [table, where, binds] of linked) {
          if (!tables.has(table)) continue;
          if (await env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).bind(...binds).first()) found = true;
          sqlTask(`${table} ${eventId}`, `DELETE FROM ${table} WHERE ${where}`, binds);
        }
        if (eventRows.some(row => row.kind === "surface") && tables.has("mood_state")) {
          sqlTask(`mood_state surfaces ${eventId}`, `UPDATE mood_state SET active_surfaces = (SELECT COALESCE(json_group_array(json(value)), '[]') FROM json_each(CASE WHEN json_valid(active_surfaces) THEN active_surfaces ELSE '[]' END) WHERE json_extract(value, '$.pattern') NOT IN (SELECT content FROM events_hot WHERE id = ? AND content IS NOT NULL UNION ALL SELECT content FROM events_archive WHERE id = ? AND content IS NOT NULL))`, [eventId, eventId]);
        }
        sqlTask(`events_hot ${eventId}`, `DELETE FROM events_hot WHERE id = ?`, [eventId]);
        sqlTask(`events_archive ${eventId}`, `DELETE FROM events_archive WHERE id = ?`, [eventId]);
      }
      if (!found && !inherited.length) return jsonText(`Event ${id} not found.`);
      await env.DB.prepare(`INSERT INTO event_deletions (id, tasks) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET tasks = excluded.tasks`).bind(id, JSON.stringify(tasks)).run();
    }
    await cancelArchiveAttempts(env, id);
    replacing = tasks.some(task => task.replacement);
    const archived = await env.DB.prepare(`SELECT r2_path FROM events_archive WHERE id = ?`).bind(id).first<any>();
    if (replacing && archived) throw new Error("Event was archived before replacement; retry delete or edit a hot event");
    if (!replacing && archived?.r2_path && !tasks.some(task => task.key === archived.r2_path)) {
      tasks.push({ label: `R2 ${archived.r2_path}`, key: archived.r2_path });
      await env.DB.prepare(`UPDATE event_deletions SET tasks = ? WHERE id = ?`).bind(JSON.stringify(tasks), id).run();
    }
    // Linked-row cleanup is atomic so a failed cache cleanup retains its source for the retry.
    const sqlTasks = tasks.filter(task => task.sql);
    try {
      await env.DB.batch(sqlTasks.map(task => env.DB.prepare(task.sql!).bind(...(task.binds ?? []))));
      completed.push(...sqlTasks.map(task => task.label));
    } catch (err) {
      console.error("memory deletion transaction failed:", err);
      failed.push(...sqlTasks.map(task => `${task.label}: D1 cleanup unavailable`));
    }
    for (const task of tasks.filter(task => !task.sql)) {
      try {
        if (task.vectors) {
          for (let i = 0; i < task.vectors.length; i += 1000) await env.VECTORS.deleteByIds(task.vectors.slice(i, i + 1000));
        } else if (task.key) await env.ARCHIVE.delete(task.key);
        else if (task.embed) {
          if (failed.length) continue;
          const row = await env.DB.prepare(`SELECT * FROM events_hot WHERE id = ?`).bind(id).first<any>();
          if (!row) throw new Error("Replacement target disappeared");
          await upsertEventVectors(env, id, row.content, row.entity_name, row.kind, row.weight);
        }
        completed.push(task.label);
      } catch (err) {
        console.error("memory deletion task failed:", task.label, err);
        failed.push(`${task.label}: cleanup unavailable`);
      }
    }
    const archiveAttempts = (await env.DB.prepare(`SELECT tasks FROM event_deletions WHERE id < 0`).all<any>()).results;
    if (archiveAttempts.some(row => JSON.parse(row.tasks).some((task: any) => task.label === "archive attempt" && task.eventId === id && !task.finished))) {
      failed.push("An archive writer has not acknowledged cancellation; retry after it finishes");
    }
    if (!failed.length) await env.DB.prepare(`DELETE FROM event_deletions WHERE id = ?`).bind(id).run();
  } catch (err) {
    console.error("memory deletion preparation or finalization failed:", err);
    failed.push("cleanup preparation or finalization unavailable");
  }
  const details = { completed, failed };
  if (failed.length) return { ...jsonText(`Deletion incomplete for event ${id}. Completed (deleted or already absent): ${completed.join(", ") || "none"}. Failed: ${failed.join("; ")}. Retry delete with the same event_id.`, details), isError: true };
  if (replacing) {
    if (!args.replacement) return toolDelete(env, args);
    return jsonText(`Edited event ${id}`, details);
  }
  const note = derived.length ? ` Events derived from it or merged with it still exist: ${derived.join(", ")}. Delete them separately if they quote it.` : "";
  return jsonText(`Deleted event ${id}.${note}`, { ...details, derived });
}

export async function consolidateEvent(env: Env, id: number, keepId: number, reason: string) {
  const row = await env.DB.prepare(`SELECT kind, meta FROM events_hot WHERE id = ?`).bind(id).first<any>();
  if (!row || row.kind !== "observation") throw new Error(`Consolidation target ${id} not found in hot storage`);
  const meta = { ...safeJsonParse<any>(row.meta, {}), consolidated_into: keepId, consolidation_reason: reason };
  const result = await toolDelete(env, { event_id: id, replacement: {
    fields: ["meta = ?", "resolved_at = datetime('now')", "resolution_note = ?"],
    values: [JSON.stringify(meta), `merged into event ${keepId}: ${reason}`], removeVectors: true,
  } });
  if (result.isError) throw new Error(result.content[0].text);
}

export async function retryConsolidations(env: Env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS event_deletions (id INTEGER PRIMARY KEY, tasks TEXT NOT NULL)`).run();
  const pending = (await env.DB.prepare(`SELECT id, tasks FROM event_deletions`).all<any>()).results;
  for (const row of pending.filter(row => JSON.parse(row.tasks).some((task: any) => task.label === "consolidation"))) {
    const result = await toolDelete(env, { event_id: row.id, replacement: {} });
    if (result.isError) throw new Error(result.content[0].text);
  }
}

async function eventExists(env: Env, id: number): Promise<boolean> {
  return !!await env.DB.prepare(`SELECT id FROM events_hot WHERE id = ? UNION ALL SELECT id FROM events_archive WHERE id = ? LIMIT 1`).bind(id, id).first();
}

async function toolEdit(env: Env, args: any) {
  if (!args.event_id) throw new Error("edit: event_id required");
  // Some MCP wrappers serialize nested objects as JSON strings.
  const rawPatch = args.patch ?? {};
  const patch = typeof rawPatch === "string" ? JSON.parse(rawPatch) : rawPatch;
  const fields: string[] = [];
  const values: any[] = [];
  if (patch.content !== undefined) {
    fields.push("content = ?");
    values.push(patch.content);
  }
  if (patch.weight !== undefined) {
    fields.push("weight = ?");
    values.push(patch.weight);
  }
  if (patch.emotion !== undefined) {
    fields.push("emotion = ?");
    values.push(patch.emotion);
  }
  if (patch.tags !== undefined) {
    fields.push("tags = ?");
    values.push(JSON.stringify(patch.tags));
  }
  const metaRow = await env.DB.prepare(`SELECT kind, meta FROM events_hot WHERE id = ?`)
    .bind(args.event_id)
    .first<{ kind: string; meta: string | null }>();
  if (!metaRow) return { ...jsonText(`Event ${args.event_id} not found in hot storage; archived edits are unsupported.`), isError: true };
  if (metaRow.kind === "goal") {
    const m = safeJsonParse<Record<string, unknown>>(metaRow.meta, {});
    const nowIso = new Date().toISOString();
    if (patch.status !== undefined) m.status = patch.status;
    if (patch.content !== undefined) m.since = nowIso;
    m.checked = nowIso;
    fields.push("meta = ?");
    values.push(JSON.stringify(m));
  }
  if (!fields.length) return jsonText("Nothing to edit.");

  if (patch.content !== undefined) {
    return toolDelete(env, { event_id: args.event_id, replacement: { fields, values, reembed: args.re_embed !== false } });
  }
  values.push(args.event_id);
  const result = await env.DB.prepare(`UPDATE events_hot SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  if (!result.meta.changes) return { ...jsonText(`Event ${args.event_id} not found.`), isError: true };

  return jsonText(`Edited event ${args.event_id}`);
}

// Rejected edges stay on record to prevent the same proposal returning every night.

const EDGE_RELATIONS = ["led_to", "caused_by", "emotional_consequence_of"];

export async function ensureEdgesTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS event_edges (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       from_event   INTEGER NOT NULL,
       to_event     INTEGER NOT NULL,
       relation     TEXT    NOT NULL,
       strength     REAL    DEFAULT 0.5,
       status       TEXT    NOT NULL DEFAULT 'tentative',
       proposed_by  TEXT    NOT NULL,
       reason       TEXT,
       created_at   TEXT    DEFAULT (datetime('now')),
       confirmed_at TEXT,
       UNIQUE(from_event, to_event, relation)
     )`,
  ).run();
}

async function toolEdge(env: Env, args: any) {
  await ensureEdgesTable(env);
  const action = args.action ?? "list";

  if (action === "add") {
    if (!args.from_event || !args.to_event) throw new Error("edge add: from_event + to_event required");
    if (!EDGE_RELATIONS.includes(args.relation)) throw new Error(`edge add: relation must be one of ${EDGE_RELATIONS.join(", ")}`);
    if (!args.reason) throw new Error("edge add: reason required — an edge without a reason cannot be reviewed");
    if (args.from_event === args.to_event) throw new Error("edge add: self-loop");

    const ends = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM events_hot WHERE id IN (?1, ?2)) +
              (SELECT COUNT(*) FROM events_archive WHERE id IN (?1, ?2)) AS n`,
    )
      .bind(args.from_event, args.to_event)
      .first<{ n: number }>();
    if ((ends?.n ?? 0) < 2) throw new Error("edge add: from_event/to_event not found");

    const strength = Math.max(0, Math.min(1, args.strength ?? 0.5));
    const res = await env.DB.prepare(
      `INSERT INTO event_edges (from_event, to_event, relation, strength, proposed_by, reason)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_event, to_event, relation) DO NOTHING`,
    )
      .bind(args.from_event, args.to_event, args.relation, strength, args.proposed_by ?? "agent", String(args.reason).slice(0, 300))
      .run();
    if (!res.meta.changes) {
      return jsonText(`Edge ${args.from_event} --${args.relation}--> ${args.to_event} already exists (no duplicate created).`);
    }
    return jsonText(
      `Edge ${res.meta.last_row_id}: ${args.from_event} --${args.relation}--> ${args.to_event} (tentative). Confirm at the next wake or directly.`,
    );
  }

  if (action === "confirm" || action === "reject") {
    if (!args.edge_id) throw new Error(`edge ${action}: edge_id required`);
    const newStatus = action === "confirm" ? "confirmed" : "rejected";
    const res = await env.DB.prepare(
      `UPDATE event_edges SET status = ?, confirmed_at = datetime('now') WHERE id = ? AND status = 'tentative'`,
    )
      .bind(newStatus, args.edge_id)
      .run();
    if (!res.meta.changes) return jsonText(`Edge ${args.edge_id} not found or not tentative.`);
    return jsonText(`Edge ${args.edge_id} → ${newStatus}.`);
  }

  if (action === "list") {
    const status = args.status ?? "tentative";
    const rows = (
      await env.DB.prepare(
        `SELECT e.*, f.content AS from_content, t.content AS to_content
         FROM event_edges e
         LEFT JOIN events_hot f ON f.id = e.from_event
         LEFT JOIN events_hot t ON t.id = e.to_event
         WHERE e.status = ?
         ORDER BY e.created_at DESC LIMIT 50`,
      )
        .bind(status)
        .all<any>()
    ).results;
    if (!rows.length) return jsonText(`No ${status} edges.`);
    const lines = rows.map(
      (e) =>
        `[${e.id}] ${e.from_event} --${e.relation}(${e.strength})--> ${e.to_event} (${e.proposed_by})\n` +
        `    from: ${(e.from_content ?? "(archived)").slice(0, 100)}\n` +
        `    to:   ${(e.to_content ?? "(archived)").slice(0, 100)}\n` +
        `    why:  ${e.reason ?? "—"}`,
    );
    return jsonText(`${rows.length} ${status} edge(s):\n\n${lines.join("\n")}`, { edges: rows });
  }

  if (action === "rel-list") {
    const rows = (
      await env.DB.prepare(
        args.entity
          ? `SELECT rowid AS id, from_entity, to_entity, relation_type, context, certainty
             FROM relations WHERE from_entity = ?1 OR to_entity = ?1 ORDER BY from_entity`
          : `SELECT rowid AS id, from_entity, to_entity, relation_type, context, certainty
             FROM relations ORDER BY from_entity LIMIT 200`,
      )
        .bind(...(args.entity ? [args.entity] : []))
        .all<any>()
    ).results;
    if (!rows.length) return jsonText(args.entity ? `No relations for ${args.entity}.` : "No relations.");
    const lines = rows.map(
      (r) => `[${r.id}] ${r.from_entity} --${r.relation_type}--> ${r.to_entity}${r.context ? ` (${r.context})` : ""}`,
    );
    return jsonText(`${rows.length} relation(s):\n${lines.join("\n")}`, { relations: rows });
  }

  if (action === "rel-delete") {
    if (!args.rel_id) throw new Error("edge rel-delete: rel_id required (from rel-list)");
    const res = await env.DB.prepare(`DELETE FROM relations WHERE rowid = ?`).bind(args.rel_id).run();
    if (!res.meta.changes) return jsonText(`Relation ${args.rel_id} not found.`);
    return jsonText(`Relation ${args.rel_id} deleted.`);
  }

  if (action === "entity-delete") {
    if (!args.entity) throw new Error("edge entity-delete: entity required (exact card name)");
    const rels = await env.DB.prepare(
      `DELETE FROM relations WHERE from_entity = ?1 OR to_entity = ?1`,
    ).bind(args.entity).run();
    const card = await env.DB.prepare(`DELETE FROM entity_cards WHERE name = ?`).bind(args.entity).run();
    if (!card.meta.changes && !rels.meta.changes) {
      return jsonText(`Entity "${args.entity}" not found (no card, no edges).`);
    }
    return jsonText(
      `Entity "${args.entity}" deleted: ${card.meta.changes} card, ${rels.meta.changes} relation(s). ` +
      `(Observations are kept as memory.)`,
    );
  }

  throw new Error(`edge: unknown action ${action}`);
}

async function toolTrace(env: Env, args: any) {
  if (!args.event_id) throw new Error("trace: event_id required");
  await ensureEdgesTable(env);
  const direction = args.direction === "forward" ? "forward" : "back";
  const maxHops = Math.min(Math.max(args.max_hops ?? 3, 1), 6);

  const cte =
    direction === "back"
      ? `WITH RECURSIVE chain(id, depth) AS (
           SELECT ?1, 0
           UNION
           SELECT e.from_event, c.depth + 1
           FROM event_edges e JOIN chain c ON e.to_event = c.id
           WHERE e.status = 'confirmed' AND c.depth < ?2
         ) SELECT DISTINCT id, MIN(depth) AS depth FROM chain GROUP BY id`
      : `WITH RECURSIVE chain(id, depth) AS (
           SELECT ?1, 0
           UNION
           SELECT e.to_event, c.depth + 1
           FROM event_edges e JOIN chain c ON e.from_event = c.id
           WHERE e.status = 'confirmed' AND c.depth < ?2
         ) SELECT DISTINCT id, MIN(depth) AS depth FROM chain GROUP BY id`;

  const nodes = (await env.DB.prepare(cte).bind(args.event_id, maxHops).all<{ id: number; depth: number }>()).results;
  if (nodes.length <= 1) {
    return jsonText(`No confirmed edges ${direction === "back" ? "into" : "out of"} event ${args.event_id} (max ${maxHops} hops).`);
  }

  const ids = nodes.map((n) => n.id);
  const events = { results: [] as any[] };
  const edges = { results: [] as any[] };
  const idSet = new Set(ids);
  for (const chunk of bindChunks(ids)) {
    const ph = chunk.map(() => "?").join(",");
    const [eventRows, edgeRows] = await Promise.all([
      env.DB.prepare(`SELECT id, ts, kind, content, entity_name, weight FROM events_hot WHERE id IN (${ph})`)
        .bind(...chunk).all<any>(),
      env.DB.prepare(`SELECT * FROM event_edges WHERE status = 'confirmed' AND from_event IN (${ph})`)
        .bind(...chunk).all<any>(),
    ]);
    events.results.push(...eventRows.results);
    edges.results.push(...edgeRows.results.filter(e => idSet.has(e.to_event)));
  }

  const depthById = new Map(nodes.map((n) => [n.id, n.depth]));
  const sortedEvents = events.results.sort(
    (a: any, b: any) => (depthById.get(b.id) ?? 0) - (depthById.get(a.id) ?? 0),
  );

  const DEEP_SCORE_FLOOR = 0.2;
  const DEEP_NODE_CAP = 8;
  const ragByEvent = new Map<number, { source: string; score: number; text: string }[]>();
  if (args.deep) {
    const deepNodes = sortedEvents.slice(0, DEEP_NODE_CAP);
    await Promise.all(
      deepNodes.map(async (ev: any) => {
        try {
          const { hits } = await recallStructured(env, { query: ev.content.slice(0, 300), limit: 2 });
          const strong = (hits ?? [])
            .filter((h: any) => (h.score ?? 0) >= DEEP_SCORE_FLOOR)
            .map((h: any) => ({ source: h.source, score: h.score, text: String(h.text ?? "").slice(0, 600) }));
          if (strong.length) ragByEvent.set(ev.id, strong);
        } catch {}
      }),
    );
  }

  const eventLines = sortedEvents.map((ev: any) => {
    let line = `[${ev.id}] (${depthById.get(ev.id)} hops, ${ev.ts}) ${ev.content.slice(0, 160)}`;
    const scenes = ragByEvent.get(ev.id);
    if (scenes) {
      for (const s of scenes) {
        line += `\n    ↳ chronicle ${s.source} (${Math.round(s.score * 100)}%): ${s.text.replace(/\n+/g, " ").slice(0, 300)}`;
      }
    }
    return line;
  });
  const edgeLines = edges.results.map(
    (e: any) => `${e.from_event} --${e.relation}(${e.strength})--> ${e.to_event}${e.reason ? `  (${e.reason})` : ""}`,
  );

  return jsonText(
    `Trace ${direction} from event ${args.event_id} (${nodes.length - 1} connected events, max ${maxHops} hops${args.deep ? ", deep" : ""}):\n\n` +
      `${eventLines.join("\n")}\n\nEdges:\n${edgeLines.join("\n")}`,
    { nodes: events.results, edges: edges.results, rag: Object.fromEntries(ragByEvent) },
  );
}

async function retryFailedEmbeddings(env: Env, limit = 25): Promise<{ scanned: number; ok: number }> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, content, entity_name, kind, weight, meta FROM events_hot
       WHERE embedded = 1 AND meta LIKE '%"embedding_failed":true%'
       ORDER BY id LIMIT ?`,
    )
      .bind(limit)
      .all<{ id: number; content: string; entity_name: string | null; kind: string; weight: string; meta: string | null }>()
  ).results;
  let ok = 0;
  for (const row of rows) {
    try {
      await upsertEventVectors(env, row.id, row.content, row.entity_name, row.kind, row.weight ?? "medium");
      let meta: any = {};
      try {
        meta = row.meta ? JSON.parse(row.meta) : {};
      } catch {}
      delete meta.embedding_failed;
      delete meta.embedding_error;
      await env.DB.prepare(`UPDATE events_hot SET meta = ? WHERE id = ?`)
        .bind(Object.keys(meta).length ? JSON.stringify(meta) : null, row.id)
        .run();
      ok++;
    } catch (e) {
      console.error(`Embedding retry failed for event ${row.id}`, isErr(e));
    }
  }
  return { scanned: rows.length, ok };
}

const VECTOR_SCORE_THRESHOLD = 0.5;

const RECENCY_HALFLIFE_DEFAULT_DAYS = 21;
const RECENCY_HALFLIFE_ENTITY_DAYS = 365;

function kwTerms(query: unknown): string[] {
  const words = String(query ?? "")
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 6);
  return words.length ? words : [String(query ?? "").slice(0, 80)];
}

function parseVectorId(id: string): number | null {
  const m = id.match(/^event-(\d+)(?:-\d+)?$/);
  return m ? Number(m[1]) : null;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function recencyFactor(ts: string | null | undefined, halflifeDays: number): number {
  if (!ts) return 0.5;  
  const tsMs = Date.parse(ts.replace(" ", "T") + "Z");
  if (!Number.isFinite(tsMs)) return 0.5;
  const ageDays = (Date.now() - tsMs) / 86_400_000;
  if (ageDays <= 0) return 1.0;
  return Math.exp(-ageDays / halflifeDays);
}

/** Vectorize returns at most 50 matches when metadata comes along; a larger topK fails the whole query. */
export const VECTORIZE_MAX_TOPK_WITH_METADATA = 50;

async function findStructured(env: Env, args: any): Promise<{ events: EventHotRow[]; archive_hits: any[] }> {
  if (!args.query) throw new Error("find: query required");
  const limit = clampLimit(args.limit, 20, 100);
  const mode = args.mode ?? "hybrid";
  const kindFilter = args.kind
    ? Array.isArray(args.kind)
      ? args.kind
      : [args.kind]
    : null;

  const recencyMode = args.recency_boost ?? "auto";
  let halflifeDays: number;
  if (recencyMode === false) {
    halflifeDays = Infinity;  
  } else if (typeof recencyMode === "number") {
    halflifeDays = recencyMode;
  } else if (recencyMode === true) {
    halflifeDays = RECENCY_HALFLIFE_DEFAULT_DAYS;
  } else {
    halflifeDays = args.entity ? RECENCY_HALFLIFE_ENTITY_DAYS : RECENCY_HALFLIFE_DEFAULT_DAYS;
  }

  let hits: EventHotRow[] = [];
  const vectorScores = new Map<number, number>();

  if (mode === "vector" || mode === "hybrid") {
    try {
      const vec = await getEmbedding(env, args.query);
      const result = await env.VECTORS.query(vec, { topK: Math.min(limit * 4, VECTORIZE_MAX_TOPK_WITH_METADATA), returnMetadata: "all" });

      for (const m of result.matches) {
        if ((m.score ?? 0) < VECTOR_SCORE_THRESHOLD) continue;
        const parentId = parseVectorId(m.id);
        if (parentId === null) continue;
        const prev = vectorScores.get(parentId) ?? 0;
        if ((m.score ?? 0) > prev) vectorScores.set(parentId, m.score ?? 0);
      }

      const ids = [...vectorScores.keys()];
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = await env.DB.prepare(
          `SELECT * FROM events_hot WHERE id IN (${placeholders})`,
        )
          .bind(...ids)
          .all<EventHotRow>();
        hits = rows.results;
      }
    } catch (e) {
      console.error("Vector search failed", isErr(e));
    }
  }

  if (mode === "keyword" || (mode === "hybrid" && hits.length < limit)) {
    // Bounded terms avoid D1's LIKE complexity limit on long queries.
    const terms = kwTerms(args.query);
    try {
      const where = terms.map(() => "content LIKE ?").join(" AND ");
      const kw = await env.DB.prepare(
        `SELECT * FROM events_hot WHERE ${where} ORDER BY ts DESC LIMIT ?`,
      )
        .bind(...terms.map((t) => `%${t}%`), limit)
        .all<EventHotRow>();
      const seen = new Set(hits.map((h) => h.id));
      for (const r of kw.results) if (!seen.has(r.id)) hits.push(r);
    } catch (e) {
      console.error("Keyword search failed", isErr(e));
    }
  }

  if (kindFilter) hits = hits.filter((h) => kindFilter.includes(h.kind));
  if (args.entity) hits = hits.filter((h) => h.entity_name === args.entity);
  if (args.resolved === true) hits = hits.filter((h) => h.resolved_at);
  if (args.resolved === false) hits = hits.filter((h) => !h.resolved_at);

  hits = hits.filter((h) => {
    if (!h.meta) return true;
    try {
      const meta = safeJsonParse<any>(h.meta, {});
      return !meta.consolidated_into;
    } catch {
      return true;
    }
  });

  hits = hits
    .map((h) => {
      const vs = vectorScores.get(h.id) ?? 0.5;
      const rf = recencyFactor(h.ts, halflifeDays);
      return { ...h, _final_score: vs * rf };
    })
    .sort((a, b) => (b as any)._final_score - (a as any)._final_score);

  hits = hits.slice(0, limit) as EventHotRow[];

  // Automated searches can disable touches so retrieval alone does not reinforce its own ranking.
  if (hits.length && args.touch !== false) {
    const ids = hits.map((h) => h.id);
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE events_hot SET last_accessed_at = datetime('now'), access_count = COALESCE(access_count,0) + 1 WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .run();

    const qualifiedIds = hits
      .filter((h) => (vectorScores.get(h.id) ?? 0) >= VECTOR_SCORE_THRESHOLD)
      .map((h) => h.id);
    if (qualifiedIds.length) {
      const qph = qualifiedIds.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE events_hot SET last_searched_at = datetime('now') WHERE id IN (${qph})`,
      )
        .bind(...qualifiedIds)
        .run();
    }
  }

  let archiveHits: any[] = [];
  if (args.include_archive) {
    const archiveIds: number[] = [];
    for (const [id, score] of vectorScores) {
      if (!hits.find((h) => h.id === id) && score >= VECTOR_SCORE_THRESHOLD) {
        archiveIds.push(id);
      }
    }
    if (archiveIds.length) {
      const aph = archiveIds.map(() => "?").join(",");
      const arch = await env.DB.prepare(
        `SELECT * FROM events_archive WHERE id IN (${aph})`,
      )
        .bind(...archiveIds)
        .all();
      archiveHits = arch.results;
    }
    // Keyword fallback on summary — content is usually NULL after R2 archival.
    if (archiveHits.length < Math.min(limit, 20)) {
      const terms = kwTerms(args.query);
      const where = terms.map(() => "(summary LIKE ? OR content LIKE ?)").join(" AND ");
      const binds = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
      try {
        const arch = await env.DB.prepare(
          `SELECT * FROM events_archive WHERE ${where} ORDER BY ts DESC LIMIT ?`,
        )
          .bind(...binds, Math.min(limit, 20))
          .all();
        const seen = new Set(archiveHits.map((h: any) => h.id));
        for (const r of arch.results) if (!seen.has((r as any).id)) archiveHits.push(r);
      } catch (e) {
        console.error("Archive keyword search failed", isErr(e));
      }
    }
  }

  archiveHits = archiveHits.filter(h =>
    !safeJsonParse<any>(h.meta, {}).consolidated_into &&
    (!kindFilter || kindFilter.includes(h.kind)) &&
    (!args.entity || h.entity_name === args.entity) &&
    (args.resolved !== true || !!h.resolved_at) &&
    (args.resolved !== false || !h.resolved_at));
  return { events: hits, archive_hits: archiveHits };
}

async function toolFind(env: Env, args: any) {
  const { events, archive_hits } = await findStructured(env, args);

  const lines = events
    .map(
      (h) =>
        `[${h.id}] ${h.ts} (${h.kind}/${h.weight}) ${h.entity_name ?? "—"}: ${h.content.slice(0, 200)}${
          h.content.length > 200 ? "..." : ""
        }`,
    )
    .join("\n");

  return jsonText(
    `Found ${events.length} events${args.include_archive ? `, ${archive_hits.length} in archive` : ""}:\n${lines}`,
    { events, archive_hits, total: events.length + archive_hits.length },
  );
}

async function recallStructured(env: Env, args: any): Promise<{ hits: any[] }> {
  if (!args.query) throw new Error("recall: query required");
  const limit = args.limit ?? 10;
  const ragHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (env.RAG_AUTH_TOKEN) ragHeaders["Authorization"] = `Bearer ${env.RAG_AUTH_TOKEN}`;
  const body = JSON.stringify({ query: args.query, limit, topK: limit });
  let ragResp: Response;
  if (env.RAG) {
    // Service bindings route by binding name, not by this URL's hostname.
    ragResp = await env.RAG.fetch(
      new Request("https://rag.internal/search", { method: "POST", headers: ragHeaders, body }),
    );
  } else if (env.RAG_URL) {
    ragResp = await fetch(`${env.RAG_URL.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: ragHeaders,
      body,
    });
  } else {
    throw new Error("recall: RAG not reachable — neither service binding RAG nor RAG_URL is set");
  }
  if (!ragResp.ok) {
    const detail = await ragResp.text().catch(() => "");
    throw new Error(`recall: RAG answered HTTP ${ragResp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  const data = (await ragResp.json().catch(() => ({}))) as {
    results?: Array<{ score?: number; filename?: string; chunkIndex?: number; totalChunks?: number; content?: string }>;
  };
  const hits = (data.results ?? []).map((r) => ({
    source: r.filename ? `${r.filename}${typeof r.chunkIndex === "number" ? `#${r.chunkIndex}` : ""}` : "",
    score: r.score ?? 0,
    text: r.content ?? "",
  }));
  return { hits };
}

async function toolRecall(env: Env, args: any) {
  const { hits } = await recallStructured(env, args);
  const lines = hits
    .map((h: any, i: number) => `[${i + 1}] ${h.source ?? ""} (${(h.score ?? 0).toFixed(2)})\n${h.text?.slice(0, 400) ?? ""}`)
    .join("\n\n");
  return jsonText(`RAG recall: ${hits.length} hits\n\n${lines}`, { hits });
}

async function toolScan(env: Env, args: any) {
  if (!args.query) throw new Error("scan: query required");
  const hotLimit = args.hot_limit ?? 10;
  const coldLimit = args.cold_limit ?? 5;

  let coldError = "";
  const [hot, cold] = await Promise.all([
    findStructured(env, { query: args.query, limit: hotLimit }),
    recallStructured(env, { query: args.query, limit: coldLimit }).catch((e) => {
      coldError = isErr(e);
      return { hits: [] as any[] };
    }),
  ]);

  return jsonText(
    `Scan: ${hot.events.length} hot + ${cold.hits.length} cold${coldError ? ` — chronicle error: ${coldError}` : ""}`,
    { hot: hot.events, cold: cold.hits, ...(coldError ? { cold_error: coldError } : {}) },
  );
}

// Reading a journal must not affect search ranking, so this path records no access touch.
async function toolJournal(env: Env, args: any) {
  const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);

  if (args.event_id) {
    const row = await env.DB.prepare(
      `SELECT id, ts, content, emotion, weight, mood_at_write FROM events_hot
       WHERE kind = 'journal' AND id = ?`,
    ).bind(args.event_id).first<any>();
    if (!row) return jsonText(`No journal with id ${args.event_id}.`);
    const zone = timezone(env);
    return jsonText(
      `# Journal ${row.id} — ${houseTime(row.ts, zone)}${row.emotion ? ` (${row.emotion})` : ""}\n\n${row.content}`,
      { journal: { ...row, ts_house: houseTime(row.ts, zone) }, zone },
    );
  }

  const zone = timezone(env);
  const where: string[] = [`kind = 'journal'`];
  const binds: unknown[] = [];
  if (args.before_id) { where.push(`id < ?`); binds.push(args.before_id); }
  if (args.from) {
    const from = houseDayStartUtc(String(args.from), zone);
    if (!from) throw new Error("journal: from must be YYYY-MM-DD");
    where.push(`ts >= ?`); binds.push(from);
  }
  if (args.to) {
    const until = houseDayStartUtc(String(args.to), zone, 1);
    if (!until) throw new Error("journal: to must be YYYY-MM-DD");
    where.push(`ts < ?`); binds.push(until);
  }

  const rows = await env.DB.prepare(
    `SELECT id, ts, content, emotion, weight, mood_at_write FROM events_hot
     WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`,
  ).bind(...binds, limit).all<any>();

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events_hot WHERE kind = 'journal'`,
  ).first<{ n: number }>();

  const entries = rows.results as any[];
  if (entries.length === 0) {
    return jsonText(`No journals in this range (${total?.n ?? 0} on the shelf in total).`);
  }
  const oldestShown = entries[entries.length - 1].id;
  const body = entries
    .map((r) => `# Journal ${r.id} — ${houseTime(r.ts, zone)}${r.emotion ? ` (${r.emotion})` : ""}\n\n${r.content}`)
    .join("\n\n---\n\n");
  return jsonText(
    `${entries.length} journals (of ${total?.n ?? "?"} on the shelf; times in ${zone}; page further: before_id=${oldestShown})\n\n${body}`,
    { journals: entries.map((r) => ({ ...r, ts_house: houseTime(r.ts, zone) })), zone, total: total?.n ?? null, next_before_id: oldestShown },
  );
}

export function isTemplateSurface(pattern: string, observations: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const p = norm(pattern);
  const distinct = new Set(observations.map(norm).filter(Boolean));
  if (distinct.size < 2) return true;
  for (const o of distinct) {
    if (o === p) return true;
    if (o.startsWith(p) && /in (various|different|several) (situations|contexts|moments)|again and again|in general/.test(o.slice(p.length))) return true;
  }
  return false;
}

async function toolWake(env: Env) {
  const now = new Date();
  const utc = now.toISOString().replace("T", " ").substring(0, 19);
  const zone = timezone(env);
  const localFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const local = localFmt.format(now);

  const moodRow = await env.DB.prepare(`SELECT * FROM mood_state WHERE id = 1`).first<any>();
  const mood = {
    label: moodRow?.mood_label ?? "—",
    summary: safeJsonParse<any[]>(moodRow?.mood_summary, []),
    hot_entities: safeJsonParse<any[]>(moodRow?.hot_entities, []),
    updated_at: moodRow?.updated_at ?? null,
  };

  const openSurfaces = await env.DB.prepare(
    `SELECT id, content, meta FROM events_hot
     WHERE kind = 'surface' AND resolved_at IS NULL AND ts > datetime('now', '-7 days')
     ORDER BY ts DESC LIMIT 5`,
  ).all<{ id: number; content: string; meta: string | null }>();

  const activeSurfaces: { id: number; pattern: string; source_event_ids: number[]; show_count: number }[] = [];
  for (const s of openSurfaces.results) {
    const meta = safeJsonParse<any>(s.meta, {});
    const observations: string[] = Array.isArray(meta.observations) ? meta.observations.map((o: any) => String(o)) : [];
    const sourceIds: number[] = Array.isArray(meta.source_event_ids) ? meta.source_event_ids.filter((x: any) => typeof x === "number") : [];
    if (isTemplateSurface(s.content, observations) || sourceIds.length < 2) {
      await env.DB.prepare(
        `UPDATE events_hot SET resolved_at = datetime('now'), resolution_note = ? WHERE id = ? AND resolved_at IS NULL`,
      ).bind("Template: bullet points without content of their own (wake filter)", s.id).run();
      continue;
    }
    activeSurfaces.push({ id: s.id, pattern: s.content, source_event_ids: sourceIds, show_count: meta.show_count ?? 0 });
    meta.show_count = (meta.show_count ?? 0) + 1;
    await env.DB.prepare(`UPDATE events_hot SET meta = ? WHERE id = ?`)
      .bind(JSON.stringify(meta), s.id)
      .run();
  }
  const shownSurfaces = activeSurfaces.slice(0, 3);
  const surfaceEvidence = new Map<number, { id: number; ts: string; content: string }[]>();
  for (const s of shownSurfaces) {
    const evidence: { id: number; ts: string; content: string }[] = [];
    for (const chunk of bindChunks([...new Set(s.source_event_ids)])) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT id, ts, content FROM events_hot WHERE id IN (${placeholders}) ORDER BY ts ASC`,
      ).bind(...chunk).all<{ id: number; ts: string; content: string }>();
      evidence.push(...rows.results);
    }
    surfaceEvidence.set(s.id, evidence.sort((a, b) => a.ts.localeCompare(b.ts)));
  }

  const goals = await env.DB.prepare(
    `SELECT id, ts, content, meta FROM events_hot WHERE kind = 'goal' AND resolved_at IS NULL ORDER BY ts ASC`,
  ).all<{ id: number; ts: string; content: string; meta: string | null }>();
  const fmtDay = (iso: string | undefined) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    return parts; 
  };
  const goalRows = goals.results.map((g) => {
    const m = safeJsonParse<any>(g.meta, {});
    return { id: g.id, content: g.content, status: String(m.status ?? "open"), since: fmtDay(m.since ?? g.ts.replace(" ", "T") + "Z"), checked: fmtDay(m.checked) };
  });
  const goalOrder = new Map([["open", 0], ["closer", 1], ["changed", 2], ["fulfilled", 3]]);
  goalRows.sort((a, b) => (goalOrder.get(a.status) ?? 9) - (goalOrder.get(b.status) ?? 9));

  await ensureEdgesTable(env);
  const tentativeEdges = await env.DB.prepare(
    `SELECT e.id, e.from_event, e.to_event, e.relation, e.strength, e.proposed_by, e.reason,
            substr(f.content, 1, 90) AS from_content, substr(t.content, 1, 90) AS to_content
     FROM event_edges e
     LEFT JOIN events_hot f ON f.id = e.from_event
     LEFT JOIN events_hot t ON t.id = e.to_event
     WHERE e.status = 'tentative' ORDER BY e.created_at DESC LIMIT 5`,
  ).all<{ id: number; from_event: number; to_event: number; relation: string; strength: number; proposed_by: string; reason: string | null; from_content: string | null; to_content: string | null }>();
  const tentativeTotal = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM event_edges WHERE status = 'tentative'`).first<{ n: number }>())?.n ?? 0;

  const openTodos = await env.DB.prepare(
    `SELECT id, content, ts, meta FROM events_hot WHERE kind = 'todo' AND resolved_at IS NULL ORDER BY ts DESC`,
  ).all<{ id: number; content: string; ts: string; meta: string | null }>();
  const todoRows = openTodos.results.map((t) => ({ ...t, priority: safeJsonParse<any>(t.meta, {}).priority ?? "medium" }));
  const TODO_SHOW = 15;
  const shownTodos = [
    ...todoRows.filter((t) => t.priority === "high"),
    ...todoRows.filter((t) => t.priority !== "high"),
  ].slice(0, TODO_SHOW);

  const latestDreams = await env.DB.prepare(
    `SELECT id, content, created_at FROM dream_notes ORDER BY created_at DESC LIMIT 1`,
  ).all<{ id: number; content: string; created_at: string }>();

  const unresolvedObs = await env.DB.prepare(
    `SELECT id, content, weight, ts FROM events_hot
     WHERE kind = 'observation' AND resolved_at IS NULL AND weight IN ('medium','heavy')
     ORDER BY COALESCE(salience, 0) DESC, CASE weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, ts ASC LIMIT 10`,
  ).all<{ id: number; content: string; weight: string; ts: string }>();

  const unresolvedTotalRow = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM events_hot WHERE kind = 'observation' AND resolved_at IS NULL`,
  ).first<{ n: number }>();
  const unresolvedTotal = unresolvedTotalRow?.n ?? 0;

  const lastDaemonRun = await env.DB.prepare(
    `SELECT started_at FROM daemon_runs WHERE ok = 1 ORDER BY started_at DESC LIMIT 1`,
  ).first<{ started_at: string }>();


  const lines: string[] = [];
  lines.push(`# Wake — ${local} (${utc} UTC)`);
  lines.push("");
  if (goalRows.length) {
    lines.push(`## Goals (${goalRows.filter((g) => g.status !== "fulfilled").length} open · review monthly: edit status/content stamps checked)`);
    for (const g of goalRows) {
      const tag = g.status === "open" ? "" : ` (${g.status})`;
      lines.push(`- [${g.id}]${tag} ${g.content} — since ${g.since} · checked ${g.checked}`);
    }
    lines.push("");
  }
  lines.push(`## Mood: ${mood.label}`);
  if (mood.summary.length) lines.push(...mood.summary.map((s: string) => `- ${s}`));
  lines.push("");
  lines.push(`## Surfaces (${shownSurfaces.length} shown${activeSurfaces.length > shownSurfaces.length ? `, ${activeSurfaces.length - shownSurfaces.length} more via find` : ""})`);
  if (shownSurfaces.length) {
    for (const s of shownSurfaces) {
      const seenNote = s.show_count > 1 ? ` [seen ${s.show_count}×]` : "";
      lines.push(`- [${s.id}] ${s.pattern}${seenNote}`);
      for (const ev of surfaceEvidence.get(s.id) ?? []) {
        const one = ev.content.replace(/\s+/g, " ");
        lines.push(`  - [${ev.id}] ${ev.ts.slice(0, 10)}: ${one.length > 110 ? one.slice(0, 110) + "…" : one}`);
      }
    }
  } else lines.push("—");
  lines.push("");
  lines.push(`## Edges — ${tentativeTotal} tentative (edge confirm/reject)`);
  if (tentativeEdges.results.length) {
    for (const e of tentativeEdges.results) {
      lines.push(`- [${e.id}] ${e.from_event} --${e.relation}(${e.strength})--> ${e.to_event} (${e.proposed_by})`);
      lines.push(`  - from: ${(e.from_content ?? "?").replace(/\s+/g, " ")}`);
      lines.push(`  - to:   ${(e.to_content ?? "?").replace(/\s+/g, " ")}`);
      if (e.reason) lines.push(`  - why:  ${e.reason.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  } else lines.push("—");
  lines.push("");
  lines.push(`## Open Todos — ${openTodos.results.length} open, ${shownTodos.length} shown (high first, then newest; rest via todo list)`);
  for (const t of shownTodos) {
    const firstLine = t.content.split(/\n/)[0];
    const headline = firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine;
    lines.push(`- [${t.id}] (${t.priority}) ${headline}`);
  }
  lines.push("");
  const dueSoon = await env.DB.prepare(
    `SELECT id, content, meta FROM events_hot
     WHERE kind = 'todo' AND resolved_at IS NULL
       AND json_extract(meta, '$.due_epoch') IS NOT NULL
       AND json_extract(meta, '$.due_epoch') <= ?
     ORDER BY json_extract(meta, '$.due_epoch') ASC LIMIT 10`,
  ).bind(Date.now() + 24 * 3600 * 1000).all<{ id: number; content: string; meta: string | null }>();
  if (dueSoon.results.length) {
    lines.push(`## Due — ${dueSoon.results.length} today/overdue (reminders for the agent, not the user)`);
    for (const t of dueSoon.results) {
      const m = safeJsonParse<any>(t.meta, {});
      const firstLine = t.content.split(/\n/)[0];
      const headline = firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine;
      const late = Number(m.due_epoch) < Date.now() ? " (overdue)" : "";
      lines.push(`- [${t.id}] ${fmtDue(String(m.due_at ?? ""))}${late}${m.reminded_at ? " · already nudged" : ""} — ${headline}`);
    }
    lines.push("");
  }
  lines.push(`## Unresolved Observations — ${unresolvedTotal} total, ${unresolvedObs.results.length} shown (engage what resonates)`);
  for (const o of unresolvedObs.results) {
    lines.push(`- [${o.id}] (${o.weight}) ${o.content.slice(0, 120)}${o.content.length > 120 ? "..." : ""}`);
  }
  lines.push("");
  lines.push(`## Dream`);
  for (const d of latestDreams.results) {
    lines.push(`- ${d.created_at}: ${d.content}`);
  }
  lines.push("");
  lines.push(`## Daemon`);
  lines.push(`- Last successful run: ${lastDaemonRun?.started_at ?? "never"}`);

  return jsonText(lines.join("\n"));
}

async function toolHealth(env: Env) {
  const [hotCount, archCount, openCount, daemonRow, dreamRow, daemonModeRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events_hot`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events_archive`).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events_hot WHERE kind = 'observation' AND resolved_at IS NULL AND weight IN ('medium','heavy')`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT started_at, ok, error_message FROM daemon_runs ORDER BY started_at DESC LIMIT 1`,
    ).first<{ started_at: string; ok: number; error_message: string | null }>(),
    env.DB.prepare(
      `SELECT created_at FROM dream_notes ORDER BY created_at DESC LIMIT 1`,
    ).first<{ created_at: string }>(),
    env.DB.prepare(`SELECT mode, backlog_cursor FROM daemon_config WHERE id = 1`).first<{ mode: string; backlog_cursor: number }>(),
  ]);

  const warnings: string[] = [];
  if (!daemonRow) warnings.push("daemon never ran");
  else if (daemonRow.ok !== 1) warnings.push(`last daemon run failed: ${daemonRow.error_message ?? "unknown"}`);

  const out = {
    version: MEMORY_VERSION,
    hot_count: hotCount?.n ?? 0,
    archive_count: archCount?.n ?? 0,
    unresolved_observations: openCount?.n ?? 0,
    daemon_last_run: daemonRow?.started_at ?? null,
    daemon_last_ok: daemonRow?.ok === 1,
    dream_last_run: dreamRow?.created_at ?? null,
    daemon_mode: daemonModeRow?.mode ?? "normal",
    backlog_cursor: daemonModeRow?.backlog_cursor ?? 0,
    warnings,
  };

  const lines = [
    `embervy-memory v${MEMORY_VERSION}`,
    `Hot events: ${out.hot_count}`,
    `Archived events: ${out.archive_count}`,
    `Unresolved observations: ${out.unresolved_observations}`,
    `Daemon last run: ${out.daemon_last_run ?? "never"} (${out.daemon_last_ok ? "ok" : "failed"})`,
    `Daemon mode: ${out.daemon_mode} (backlog cursor=${out.backlog_cursor})`,
    `Dream last run: ${out.dream_last_run ?? "never"}`,
    warnings.length ? `Warnings:\n${warnings.map((w) => "- " + w).join("\n")}` : "No warnings",
  ];

  return jsonText(lines.join("\n"), out);
}

async function toolResolve(env: Env, args: any) {
  if (!args.event_id || !args.note) throw new Error("resolve: event_id and note required");
  const target = await env.DB.prepare(`SELECT id FROM events_hot WHERE id = ?`).bind(args.event_id).first();
  if (!target) return { ...jsonText(`Event ${args.event_id} not found in hot storage; archived resolution is unsupported.`), isError: true };
  await env.DB.prepare(
    `UPDATE events_hot SET resolved_at = datetime('now'), resolution_note = ? WHERE id = ?`,
  )
    .bind(args.note, args.event_id)
    .run();

  // Bookkeeping notes must not count as engagement or bulk resolution would distort ranking.
  const note = String(args.note);
  const isPointerNote = /^→\s*Surface\s+#?\d+/.test(note.trim()) || /Bookkeeping/i.test(note);
  if (note.length > 20 && !isPointerNote) {
    await env.DB.prepare(
      `UPDATE events_hot SET last_engaged_at = datetime('now') WHERE id = ?`,
    )
      .bind(args.event_id)
      .run();
  }

  return jsonText(`Resolved event ${args.event_id} with note: ${args.note}`);
}

async function toolEngage(env: Env, args: any) {
  if (!args.surface_id || !args.meaning) throw new Error("engage: surface_id and meaning required");
  const surface = await env.DB.prepare(`SELECT * FROM events_hot WHERE id = ? AND kind = 'surface'`)
    .bind(args.surface_id)
    .first<EventHotRow>();
  if (!surface) throw new Error(`engage: surface ${args.surface_id} not found`);

  const meta = safeJsonParse<any>(surface.meta, {});
  const sourceIds: number[] = meta.source_event_ids ?? [];

  await env.DB.prepare(
    `UPDATE events_hot SET resolved_at = datetime('now'), resolution_note = ? WHERE id = ?`,
  )
    .bind(args.meaning, args.surface_id)
    .run();

  for (const chunk of bindChunks([...new Set(sourceIds)])) {
    const placeholders = chunk.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE events_hot
       SET access_boost_until = datetime('now', '+7 days'),
           last_accessed_at  = datetime('now'),
           last_engaged_at   = datetime('now'),
           access_count      = COALESCE(access_count,0) + 1
       WHERE id IN (${placeholders})`,
    )
      .bind(...chunk)
      .run();
  }

  await env.DB.prepare(
    `UPDATE events_hot SET last_engaged_at = datetime('now') WHERE id = ?`,
  )
    .bind(args.surface_id)
    .run();

  const result = await env.DB.prepare(
    `INSERT INTO events_hot (kind, content, source, weight, meta, mood_at_write)
     VALUES ('observation', ?, 'realization', 'medium', ?, ?)`,
  )
    .bind(
      `Pattern engaged: ${surface.content} → ${args.meaning}`,
      JSON.stringify({ from_surface: args.surface_id, source_event_ids: sourceIds }),
      (await getMoodLabel(env)).label,
    )
    .run();

  return jsonText(
    `Engaged surface ${args.surface_id}. Meta-obs ${result.meta.last_row_id} written, ${sourceIds.length} source events boosted.`,
    {
      meta_event_id: Number(result.meta.last_row_id),
      boosted_event_ids: sourceIds,
    },
  );
}

async function toolCollide(env: Env, args: any) {
  if (!args.seeds || !Array.isArray(args.seeds) || args.seeds.length < 2)
    throw new Error("collide: at least 2 seeds required");
  const limitPerSeed = args.limit_per_seed ?? 3;

  const allHits: { seed: string; events: EventHotRow[]; cold: any[] }[] = [];
  const allTouchedIds = new Set<number>();
  for (const seed of args.seeds.slice(0, 5)) {
    try {
      const vec = await getEmbedding(env, seed);
      const result = await env.VECTORS.query(vec, { topK: Math.min(limitPerSeed * 3, VECTORIZE_MAX_TOPK_WITH_METADATA), returnMetadata: "all" });
      const idSet = new Set<number>();
      for (const m of result.matches) {
        if ((m.score ?? 0) < VECTOR_SCORE_THRESHOLD) continue;
        const parentId = parseVectorId(m.id);
        if (parentId !== null) idSet.add(parentId);
        if (idSet.size >= limitPerSeed) break;
      }
      const ids = [...idSet];
      if (!ids.length) {
        const cold = await recallStructured(env, { query: seed, limit: limitPerSeed });
        allHits.push({ seed, events: [], cold: cold.hits });
        continue;
      }
      ids.forEach((id) => allTouchedIds.add(id));
      const placeholders = ids.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT * FROM events_hot WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<EventHotRow>();
      const cold = await recallStructured(env, { query: seed, limit: limitPerSeed });
      allHits.push({ seed, events: rows.results, cold: cold.hits });
    } catch (e) {
      console.error(`Collide seed "${seed}" failed`, isErr(e));
      const cold = await recallStructured(env, { query: seed, limit: limitPerSeed }).catch(() => ({ hits: [] }));
      allHits.push({ seed, events: [], cold: cold.hits });
    }
  }

  for (const ids of bindChunks([...allTouchedIds])) {
    const ph = ids.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE events_hot SET last_searched_at = datetime('now'), last_accessed_at = datetime('now'), access_count = COALESCE(access_count,0) + 1 WHERE id IN (${ph})`,
    )
      .bind(...ids)
      .run();
  }

  const eventCounts = new Map<number, { event: EventHotRow; seeds: string[] }>();
  const coldCounts = new Map<string, { hit: any; seeds: string[] }>();
  for (const { seed, events, cold } of allHits) {
    for (const e of events) {
      const existing = eventCounts.get(e.id);
      if (existing) existing.seeds.push(seed);
      else eventCounts.set(e.id, { event: e, seeds: [seed] });
    }
    for (const hit of cold) {
      const key = `${hit.source ?? ""}::${(hit.text ?? "").slice(0, 180)}`;
      const existing = coldCounts.get(key);
      if (existing) existing.seeds.push(seed);
      else coldCounts.set(key, { hit, seeds: [seed] });
    }
  }

  const hotResonances = Array.from(eventCounts.values()).map((r) => ({
    type: "hot" as const,
    seeds: r.seeds,
    event: r.event,
  }));
  const coldResonances = Array.from(coldCounts.values()).map((r) => ({
    type: "cold" as const,
    seeds: r.seeds,
    hit: r.hit,
  }));

  const resonances = [...hotResonances, ...coldResonances]
    .sort((a, b) => b.seeds.length - a.seeds.length)
    .slice(0, 10);

  const lines = resonances.map(
    (r) =>
      r.type === "hot"
        ? `[hot:${r.event.id}] (matched: ${r.seeds.join(", ")}) ${r.event.content.slice(0, 200)}`
        : `[rag:${r.hit.source ?? "unknown"}] (matched: ${r.seeds.join(", ")}) ${(r.hit.text ?? "").slice(0, 200)}`,
  );

  return jsonText(
    `Collide: ${resonances.length} resonances across ${args.seeds.length} seeds\n${lines.join("\n")}`,
    {
      resonances: resonances.map((r) =>
        r.type === "hot"
          ? { type: r.type, seeds_matched: r.seeds, event: r.event }
          : { type: r.type, seeds_matched: r.seeds, hit: r.hit },
      ),
    },
  );
}

const XAI_API = "https://api.x.ai/v1";

function aspectFor(width: number, height: number): string {
  const r = width / height;
  if (Math.abs(r - 1) < 0.1) return "1:1";
  if (r > 1.6) return "16:9";
  if (r > 1.2) return "4:3";
  if (r < 0.62) return "9:16";
  if (r < 0.85) return "3:4";
  return "1:1";
}

async function grokImagineImage(env: Env, prompt: string, refDataUri: string | undefined, width: number, height: number): Promise<ArrayBuffer | null> {
  const endpoint = refDataUri ? `${XAI_API}/images/edits` : `${XAI_API}/images/generations`;
  const body: Record<string, unknown> = {
    model: "grok-imagine-image-2.0",
    prompt,
    n: 1,
    response_format: "b64_json",
    aspect_ratio: aspectFor(width, height),
  };
  if (refDataUri) body.image = { type: "image_url", url: refDataUri };
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error("imagine: grok HTTP", resp.status, (await resp.text().catch(() => "")).slice(0, 300));
    return null;
  }
  const data = (await resp.json()) as { data?: { b64_json?: string; url?: string }[] };
  const first = data?.data?.[0];
  if (first?.b64_json) {
    const bin = atob(first.b64_json);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  if (first?.url) {
    const img = await fetch(first.url);
    if (img.ok) return await img.arrayBuffer();
    console.error("imagine: grok image fetch HTTP", img.status);
  }
  return null;
}

const OPENROUTER_IMAGES = "https://openrouter.ai/api/v1/images";
const OPENROUTER_IMAGE_MODEL_DEFAULT = "black-forest-labs/flux-3-image";

export async function openRouterImage(env: Pick<Env, "OPENROUTER_API_KEY" | "OPENROUTER_IMAGE_MODEL">, prompt: string, refDataUri: string | undefined, width: number, height: number, fetcher: typeof fetch = fetch): Promise<{ bytes: ArrayBuffer } | { error: string }> {
  const body: Record<string, unknown> = {
    model: env.OPENROUTER_IMAGE_MODEL?.trim() || OPENROUTER_IMAGE_MODEL_DEFAULT,
    prompt,
    n: 1,
    resolution: "1K",
    aspect_ratio: aspectFor(width, height),
  };
  if (refDataUri) body.input_references = [{ type: "image_url", image_url: { url: refDataUri } }];
  const resp = await fetcher(OPENROUTER_IMAGES, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    console.error("imagine: OpenRouter HTTP", resp.status, text);
    return { error: `OpenRouter: HTTP ${resp.status}${resp.status === 402 ? " (the OpenRouter key's credit or limit is used up)" : ""}` };
  }
  const data = (await resp.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[] } | null;
  const first = data?.data?.[0];
  if (first?.b64_json) {
    const bin = atob(first.b64_json);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: bytes.buffer };
  }
  if (first?.url) {
    const img = await fetcher(first.url);
    if (img.ok) return { bytes: await img.arrayBuffer() };
    return { error: `OpenRouter: image fetch HTTP ${img.status}` };
  }
  return { error: "OpenRouter: no image in the answer" };
}

async function toolAnimate(env: Env, args: any) {
  if (!env.XAI_API_KEY) throw new Error("animate: XAI_API_KEY not configured");
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("animate: prompt required");
  const duration = Math.min(15, Math.max(1, Math.round(Number(args.duration) || 6)));
  const resolution = args.resolution === "720p" ? "720p" : "480p";

  if (args.request_id) return grokVideoFinish(env, String(args.request_id), prompt, Number(args.source_event_id) || null);

  let imageInput: { type: string; url: string } | undefined;
  let sourceEventId: number | null = null;
  if (args.event_id) {
    const id = Number(args.event_id);
    const row = await env.DB.prepare(`SELECT data, mime_type FROM images_data WHERE event_id = ?`).bind(id).first<{ data: string; mime_type: string }>();
    if (!row?.data) throw new Error(`animate: no image stored for event ${id}`);
    imageInput = { type: "image_url", url: `data:${row.mime_type || "image/jpeg"};base64,${row.data.replace(/\s/g, "")}` };
    sourceEventId = id;
  } else if (args.image_url) {
    imageInput = { type: "image_url", url: String(args.image_url) };
  }

  const body: Record<string, unknown> = { model: "grok-imagine-video-1.5", prompt, duration, resolution };
  if (imageInput) body.image = imageInput;
  const resp = await fetch(`${XAI_API}/videos/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.XAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`animate: grok HTTP ${resp.status} — ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  const started = (await resp.json()) as { request_id?: string; id?: string };
  const requestId = started.request_id || started.id;
  if (!requestId) throw new Error(`animate: no request_id in response ${JSON.stringify(started).slice(0, 200)}`);
  return grokVideoFinish(env, requestId, prompt, sourceEventId);
}

async function grokVideoFinish(env: Env, requestId: string, prompt: string, sourceEventId: number | null) {
  const deadline = Date.now() + 150_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${XAI_API}/videos/${requestId}`, { headers: { Authorization: `Bearer ${env.XAI_API_KEY}` } });
    last = await r.json().catch(() => ({}));
    const status = String(last?.status ?? "");
    if (status === "done" || last?.video?.url) break;
    if (status === "failed" || status === "expired") throw new Error(`animate: grok video ${status} — ${JSON.stringify(last).slice(0, 300)}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  const videoUrl: string | undefined = last?.video?.url;
  if (!videoUrl) {
    return jsonText(`Video not finished yet (request ${requestId}). Fetch it later with animate(request_id="${requestId}", prompt=…).`, { request_id: requestId, status: last?.status ?? "pending" });
  }
  const vid = await fetch(videoUrl);
  if (!vid.ok) throw new Error(`animate: video download HTTP ${vid.status}`);
  const bytes = new Uint8Array(await vid.arrayBuffer());

  const { label, ageHours } = await getMoodLabel(env);
  const moodAtWrite = fmtMoodAtWrite(label, ageHours);
  const ev = await env.DB.prepare(
    `INSERT INTO events_hot (kind, content, entity_name, emotion, weight, source, mood_at_write, meta)
     VALUES ('video', ?, ?, 'creative', 'light', 'realization', ?, ?)`,
  ).bind(`Animated: ${prompt}`, env.AGENT_NAME ?? null, moodAtWrite, JSON.stringify({ model: "grok-imagine-video-1.5", prompt, source_event_id: sourceEventId, bytes: bytes.length, request_id: requestId })).run();
  const eventId = Number(ev.meta.last_row_id);
  await env.ARCHIVE.put(`videos/${eventId}.mp4`, bytes, { httpMetadata: { contentType: "video/mp4" } });

  const appUrl = env.APP_URL ? `${env.APP_URL}${MEMORY_VIDEO_PATH}/${eventId}` : "";
  if (env.APP_URL && env.APP_PUSH_TOKEN) {
    try {
      await fetch(`${env.APP_URL}/api/external/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.APP_PUSH_TOKEN}` },
        body: JSON.stringify({ id: `memory-animate-${eventId}`, text: `[File: video-${eventId}.mp4]`, file_url: `${MEMORY_VIDEO_PATH}/${eventId}`, file_name: `video-${eventId}.mp4`, ts: new Date().toISOString(), sender: "memory" }),
      });
    } catch { /* app not reachable — the video is in R2 regardless */ }
  }
  return jsonText(`Video done: ${Math.round(bytes.length / 1024)}KB, event ${eventId}${appUrl ? `, ${appUrl}` : ""} — already pushed into the app.`, { event_id: eventId, url: appUrl, request_id: requestId });
}

async function toolImagine(env: Env, args: any) {
  const prompt = args.prompt as string;
  if (!prompt) throw new Error("imagine: prompt required");

  const entity_name = args.entity_name as string | undefined;
  const emotion = (args.emotion as string) || "creative";
  const weight = (args.weight as string) || "medium";
  const resolution = (args.resolution as string) || "1024x1024";
  const [width, height] = resolution.split("x").map(Number);
  // BFL requires width/height to be multiples of 32.
  const round32 = (n: number) => Math.max(32, Math.round(n / 32) * 32);
  const bflWidth = round32(width);
  const bflHeight = round32(height);

  const refUrl = args.reference_image_url as string | undefined;
  const refB64Raw = args.reference_image_b64 as string | undefined;
  const refRequested = !!(refUrl || refB64Raw);
  let refB64: string | undefined = refB64Raw?.replace(/^data:image\/[^;]+;base64,/, "");
  if (!refB64 && refUrl) {
    const r = await fetch(refUrl).catch((e) => {
      throw new Error(`imagine: reference URL fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!r.ok) {
      const errText = (await r.text().catch(() => "")).slice(0, 200);
      throw new Error(`imagine: reference URL fetch HTTP ${r.status} — ${errText}. Hint: must be publicly accessible (e.g. a share path on your app), not behind auth.`);
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    // Convert to base64 in chunks (avoids stack overflow for large images).
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    refB64 = btoa(bin);
  }
  if (refRequested && !refB64) {
    throw new Error("imagine: reference image requested but could not be loaded");
  }
  const useKontext = !!refB64;

  if (!env.XAI_API_KEY && !env.BFL_API_KEY && !env.OPENROUTER_API_KEY) {
    throw new Error("imagine: no image service is set up. An image needs XAI_API_KEY (Grok Imagine), BFL_API_KEY (Flux) or OPENROUTER_API_KEY as a secret of the memory worker; nothing was generated and nothing was charged.");
  }

  let imageBuffer: ArrayBuffer | null = null;
  let usedModel = useKontext ? "flux-kontext-pro" : "flux-pro";
  const failures: string[] = [];

  const providerArg = String(args.provider ?? "auto");
  const wantGrok = providerArg === "grok" || (providerArg === "auto" && !!env.XAI_API_KEY);
  if (wantGrok && env.XAI_API_KEY) {
    try {
      const grok = await grokImagineImage(env, prompt, refB64 ? `data:image/jpeg;base64,${refB64}` : undefined, width, height);
      if (grok) { imageBuffer = grok; usedModel = "grok-imagine-image-2.0"; }
      else failures.push("Grok: no image");
    } catch (e) {
      console.error("imagine: grok threw:", e instanceof Error ? e.message : String(e));
      failures.push(`Grok: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  } else if (providerArg === "grok" && !env.XAI_API_KEY) {
    throw new Error("imagine: provider grok requested but XAI_API_KEY is not configured");
  }

  const bflKey = env.BFL_API_KEY;
  if (!imageBuffer && bflKey) {
    try {
      const endpoint = useKontext
        ? "https://api.bfl.ai/v1/flux-kontext-pro"
        : "https://api.bfl.ai/v1/flux-pro-1.1";
      const body = useKontext
        ? JSON.stringify({ prompt, input_image: refB64 })
        : JSON.stringify({ prompt, width: bflWidth, height: bflHeight });
      const genResponse = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-key": bflKey },
        body,
      });
      if (genResponse.ok) {
        const genData = (await genResponse.json()) as { id: string; polling_url: string };
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise((r) => setTimeout(r, 3000));
          const pollResponse = await fetch(genData.polling_url, { headers: { "x-key": bflKey } });
          if (!pollResponse.ok) {
            console.error("imagine: BFL poll HTTP", pollResponse.status);
            continue;
          }
          const pollData = (await pollResponse.json()) as { status: string; result?: { sample: string } };
          if (pollData.status === "Ready" && pollData.result?.sample) {
            const imgResponse = await fetch(pollData.result.sample);
            if (imgResponse.ok) imageBuffer = await imgResponse.arrayBuffer();
            else { console.error("imagine: BFL image fetch HTTP", imgResponse.status); failures.push(`Flux: image fetch HTTP ${imgResponse.status}`); }
            break;
          }
          if (pollData.status === "Error") {
            console.error("imagine: BFL job Error status");
            failures.push("Flux: the job ended in an error");
            break;
          }
        }
        if (!imageBuffer && !failures.some((f) => f.startsWith("Flux"))) failures.push("Flux: no image within a minute");
      } else {
        const text = (await genResponse.text().catch(() => "")).slice(0, 300);
        console.error("imagine: BFL gen HTTP", genResponse.status, text);
        failures.push(`Flux: HTTP ${genResponse.status}${genResponse.status === 402 ? " (no credit left on the BFL account)" : ""}`);
      }
    } catch (e) {
      console.error("imagine: BFL fetch threw:", e instanceof Error ? e.message : String(e));
      failures.push(`Flux: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  }

  if (!imageBuffer && env.OPENROUTER_API_KEY) {
    try {
      const routed = await openRouterImage(env, prompt, refB64 ? `data:image/jpeg;base64,${refB64}` : undefined, width, height);
      if ("bytes" in routed) { imageBuffer = routed.bytes; usedModel = `openrouter:${env.OPENROUTER_IMAGE_MODEL?.trim() || OPENROUTER_IMAGE_MODEL_DEFAULT}`; }
      else failures.push(routed.error);
    } catch (e) {
      console.error("imagine: OpenRouter threw:", e instanceof Error ? e.message : String(e));
      failures.push(`OpenRouter: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  }

  if (!imageBuffer) {
    throw new Error(`imagine: no image — ${failures.join("; ") || "no provider answered"}. Nothing was stored.`);
  }

  const uint8Array = new Uint8Array(imageBuffer);
  if (uint8Array.length > 3_500_000) {
    throw new Error(`imagine: generated image too large (${Math.round(uint8Array.length / 1024)}KB, MCP limit ~5MB base64 → ~3.5MB raw)`);
  }

  const base64Image = bytesToBase64(uint8Array);
  const detected = detectImageMime(uint8Array) || "image/jpeg";
  const ext = detected.split("/")[1] || "jpg";
  const imagePath = `generated/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { label, ageHours } = await getMoodLabel(env);
  const moodAtWrite = fmtMoodAtWrite(label, ageHours);
  const eventResult = await env.DB.prepare(
    `INSERT INTO events_hot (kind, content, entity_name, emotion, weight, source, mood_at_write, meta)
     VALUES ('image', ?, ?, ?, ?, 'realization', ?, ?)`,
  )
    .bind(
      `Generated: ${prompt}`,
      entity_name ?? null,
      emotion,
      weight,
      moodAtWrite,
      JSON.stringify({ path: imagePath, model: usedModel, prompt, resolution }),
    )
    .run();
  const eventId = Number(eventResult.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO images_data (path, data, mime_type, event_id) VALUES (?, ?, ?, ?)`,
  )
    .bind(imagePath, base64Image, detected, eventId)
    .run();

  const imageUrl = imageUrlFor(env, eventId);
  const text =
    `Image generated.\n\nPrompt: "${prompt}"\nSize: ${width}x${height} (${Math.round(uint8Array.length / 1024)}KB)\n` +
    `Model: ${usedModel}\nLinked: ${entity_name ?? "—"}\nEvent: ${eventId}` +
    (imageUrl ? `\nURL: ${imageUrl}` : "");

  if (env.APP_URL && env.APP_PUSH_TOKEN && imageUrl) {
    try {
      await fetch(`${env.APP_URL}/api/external/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.APP_PUSH_TOKEN}`,
        },
        body: JSON.stringify({
          id: `memory-imagine-${eventId}`,
          text: `![${(prompt || "image").slice(0, 80)}](${imageUrl})`,
          ts: new Date().toISOString(),
          sender: "memory",
        }),
      });
    } catch {
      /* app not reachable — fine, the image is in memory regardless */
    }
  }

  return {
    content: [
      { type: "text", text },
      { type: "image", data: base64Image, mimeType: detected },
    ],
  };
}

async function toolKeep(env: Env, args: any) {
  const image_data = args.image_data as string;
  const description = args.description as string;
  if (!image_data) throw new Error("keep: image_data required (base64)");
  if (!description) throw new Error("keep: description required");

  const entity_name = args.entity_name as string | undefined;
  const emotion = (args.emotion as string) || "tender";
  const weight = (args.weight as string) || "heavy";

  if (typeof image_data !== "string") throw new Error("keep: image_data must be base64 text");
  const prefix = /^data:(image\/[^;,]+);base64,/i.exec(image_data);
  const mimeType = prefix ? prefix[1].toLowerCase() : "image/jpeg";
  if (!IMAGE_MIME_TYPES.has(mimeType) || (/^data:/i.test(image_data) && !prefix)) {
    throw new Error("keep: unsupported image type; allowed types: image/png, image/jpeg, image/webp, image/gif");
  }
  const cleanBase64 = image_data.slice(prefix?.[0].length ?? 0).replace(/\s/g, "");
  try { atob(cleanBase64); } catch { throw new Error("keep: invalid base64 image data"); }

  const ext = mimeType.split("/")[1] || "jpg";
  const imagePath = `kept/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { label, ageHours } = await getMoodLabel(env);
  const moodAtWrite = fmtMoodAtWrite(label, ageHours);
  const eventResult = await env.DB.prepare(
    `INSERT INTO events_hot (kind, content, entity_name, emotion, weight, source, mood_at_write, meta)
     VALUES ('image', ?, ?, ?, ?, 'external', ?, ?)`,
  )
    .bind(
      description,
      entity_name ?? null,
      emotion,
      weight,
      moodAtWrite,
      JSON.stringify({ path: imagePath, kept: true }),
    )
    .run();
  const eventId = Number(eventResult.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO images_data (path, data, mime_type, event_id) VALUES (?, ?, ?, ?)`,
  )
    .bind(imagePath, cleanBase64, mimeType, eventId)
    .run();

  const imageUrl = imageUrlFor(env, eventId);
  return jsonText(
    `Image kept (event ${eventId}).\n\n"${description}"\nPath: ${imagePath}\nLinked: ${entity_name ?? "—"}\n` +
      `Emotion: ${emotion}\nWeight: ${weight}` +
      (imageUrl ? `\nURL: ${imageUrl}` : ""),
  );
}

async function toolSee(env: Env, args: any) {
  const entityName = args.entity_name as string | undefined;
  const emotion = args.emotion as string | undefined;
  const weight = args.weight as string | undefined;
  const random = !!args.random;
  const limit = (args.limit as number) || 5;

  let query = `
    SELECT eh.id, eh.ts, eh.content, eh.entity_name, eh.emotion, eh.weight,
           id_data.path, id_data.mime_type
    FROM events_hot eh
    LEFT JOIN images_data id_data ON id_data.event_id = eh.id
    WHERE eh.kind = 'image' AND eh.resolved_at IS NULL
  `;
  const bindings: unknown[] = [];
  if (entityName) {
    query += ` AND eh.entity_name = ?`;
    bindings.push(entityName);
  }
  if (emotion) {
    query += ` AND eh.emotion = ?`;
    bindings.push(emotion);
  }
  if (weight) {
    query += ` AND eh.weight = ?`;
    bindings.push(weight);
  }
  query += random ? ` ORDER BY RANDOM()` : ` ORDER BY eh.ts DESC`;
  query += ` LIMIT ?`;
  bindings.push(limit);

  const result = await env.DB.prepare(query).bind(...bindings).all();
  if (!result.results?.length) {
    return jsonText(`No visual memories found. Use keep or imagine to add some.`);
  }

  for (const row of result.results as any[]) {
    await env.DB.prepare(
      `UPDATE events_hot SET last_accessed_at = datetime('now'), access_count = COALESCE(access_count,0) + 1 WHERE id = ?`,
    )
      .bind(row.id)
      .run();
  }

  let output = `## Visual Memories\n\n`;
  if (random) output += `*Random selection*\n\n`;
  let anyUrl = false;
  for (const img of result.results as any[]) {
    const tags = [
      img.weight && `[${img.weight}]`,
      img.emotion && `[${img.emotion}]`,
      img.entity_name && `→ ${img.entity_name}`,
    ]
      .filter(Boolean)
      .join(" ");
    output += `**#${img.id}** ${tags}\n${img.content}\n`;
    if (img.path) output += `Path: \`${img.path}\`\n`;
    const imgUrl = imageUrlFor(env, img.id);
    if (imgUrl) {
      output += `URL: ${imgUrl}\n`;
      anyUrl = true;
    }
    output += `\n`;
  }
  if (anyUrl) output += `*Use Read on a URL above to view the image.*\n`;
  return jsonText(output);
}

async function toolWatch(env: Env, args: any) {
  const url = args.url as string;
  if (!url) throw new Error("watch: url required");
  const backendUrl = videoBackendUrl(env);
  if (!backendUrl) throw new Error("watch: VIDEO_BACKEND_URL env var not set (your video backend's public URL)");
  const max_frames = Math.min((args.max_frames as number) || 5, 10);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.APP_PUSH_TOKEN) headers["Authorization"] = `Bearer ${env.APP_PUSH_TOKEN}`;
  const resp = await fetch(`${backendUrl}/watch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, max_frames }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`watch: backend ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await resp.json()) as any;
  const text = `**${data.title || "Video"}**\n\n${data.transcript ? `**Transcript:**\n${data.transcript}\n` : ""}`;
  const content: any[] = [{ type: "text", text }];
  for (const frame of data.frames || []) {
    content.push({ type: "image", data: frame.data, mimeType: frame.mimeType || "image/jpeg" });
  }
  return { content };
}

async function resolveStreamingUrl(originalUrl: string): Promise<{ url: string; title: string } | null> {
  const appleMatch = originalUrl.match(/music\.apple\.com\/.*[?&]i=(\d+)/);
  if (appleMatch) {
    const trackId = appleMatch[1];
    const resp = await fetch(`https://itunes.apple.com/lookup?id=${trackId}&entity=song`);
    if (resp.ok) {
      const data = await resp.json() as any;
      const track = data?.results?.find((r: any) => r.wrapperType === "track");
      if (track?.previewUrl) {
        const title = `${track.artistName} — ${track.trackName}` + (track.collectionName ? ` (${track.collectionName})` : "");
        return { url: track.previewUrl, title: `${title} [30s preview]` };
      }
    }
    return null;
  }
  const spotifyMatch = originalUrl.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
  if (spotifyMatch) {
    const trackId = spotifyMatch[1];
    const oembedResp = await fetch(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${trackId}`);
    if (oembedResp.ok) {
      const meta = await oembedResp.json() as any;
      const searchQuery = (meta.title || "").replace(/\s*by\s*/i, " ");
      if (searchQuery) {
        const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
        const ytResp = await fetch(ytSearchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (ytResp.ok) {
          const html = await ytResp.text();
          const vidMatch = html.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
          if (vidMatch) {
            return { url: `https://www.youtube.com/watch?v=${vidMatch[1]}`, title: `${meta.title || "Spotify track"} [via YouTube]` };
          }
        }
      }
    }
    return null;
  }
  return null;
}

async function toolListen(env: Env, args: any) {
  let url = args.url as string;
  if (!url) throw new Error("listen: url required");
  const backendUrl = videoBackendUrl(env);
  if (!backendUrl) throw new Error("listen: VIDEO_BACKEND_URL env var not set");

  let resolvedTitle: string | null = null;

  if (url.includes("music.apple.com") || url.includes("open.spotify.com")) {
    const resolved = await resolveStreamingUrl(url);
    if (!resolved) throw new Error(`listen: could not resolve streaming URL — only single-track links are supported. Got: ${url}`);
    resolvedTitle = resolved.title;
    url = resolved.url;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.APP_PUSH_TOKEN) headers["Authorization"] = `Bearer ${env.APP_PUSH_TOKEN}`;

  const resp = await fetch(`${backendUrl}/audio`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`listen: backend ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const title = resolvedTitle || decodeURIComponent(resp.headers.get("X-Title") || "Audio");
  const audioBuffer = await resp.arrayBuffer();
  const audioBase64 = bytesToBase64(new Uint8Array(audioBuffer));

  const result = (await env.AI.run("@cf/openai/whisper-large-v3-turbo" as any, { audio: audioBase64 } as any)) as any;
  const transcript = result?.text || result?.transcription || "[Whisper returned no transcript]";

  return jsonText(`**${title}**\n\n${transcript}`);
}

export const TRANSCRIBE_MAX_BYTES = 20 * 1024 * 1024;
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

export function whisperLanguage(tag: string | null | undefined): string | undefined {
  const primary = String(tag || "").trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

export async function transcribeAudio(
  ai: { run: (model: string, input: unknown) => Promise<unknown> },
  bytes: Uint8Array,
  language?: string,
): Promise<{ text: string } | { error: string; status: number }> {
  if (!bytes.length) return { error: "empty recording", status: 400 };
  if (bytes.length > TRANSCRIBE_MAX_BYTES) return { error: "recording too large", status: 413 };
  // The voice activity filter keeps silence from turning into invented words.
  const input: Record<string, unknown> = { audio: bytesToBase64(bytes), vad_filter: true };
  const lang = whisperLanguage(language);
  if (lang) input.language = lang;
  try {
    const result = (await ai.run(WHISPER_MODEL, input)) as { text?: unknown } | null;
    return { text: typeof result?.text === "string" ? result.text.trim() : "" };
  } catch (err) {
    console.error("memory transcription failed:", err);
    return { error: "whisper failed", status: 502 };
  }
}

async function toolSeeVideo(env: Env, args: any) {
  const url = args.url as string;
  if (!url) throw new Error("see_video: url required");
  const backendUrl = videoBackendUrl(env);
  if (!backendUrl) throw new Error("see_video: VIDEO_BACKEND_URL env var not set");
  const max_frames = Math.min((args.max_frames as number) || 5, 10);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.APP_PUSH_TOKEN) headers["Authorization"] = `Bearer ${env.APP_PUSH_TOKEN}`;
  const resp = await fetch(`${backendUrl}/watch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url, max_frames }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`see_video: backend ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = (await resp.json()) as any;
  const text = `**${data.title || "Video"}** (${data.frames?.length || 0} frames)`;
  const content: any[] = [{ type: "text", text }];
  for (const frame of data.frames || []) {
    content.push({ type: "image", data: frame.data, mimeType: frame.mimeType || "image/jpeg" });
  }
  return { content };
}


async function callTool(env: Env, name: string, args: any) {
  switch (name) {
    case "write": return toolWrite(env, args);
    case "todo": return toolTodo(env, args);
    case "delete": return toolDelete(env, { event_id: args.event_id });
    case "edit": return toolEdit(env, args);
    case "edge": return toolEdge(env, args);
    case "trace": return toolTrace(env, args);
    case "find": return toolFind(env, args);
    case "recall": return toolRecall(env, args);
    case "scan": return toolScan(env, args);
    case "journal": return toolJournal(env, args);
    case "wake": return toolWake(env);
    case "health": return toolHealth(env);
    case "resolve": return toolResolve(env, args);
    case "engage": return toolEngage(env, args);
    case "collide": return toolCollide(env, args);
    case "animate": return toolAnimate(env, args);
    case "imagine": return toolImagine(env, args);
    case "keep": return toolKeep(env, args);
    case "see": return toolSee(env, args);
    case "watch": return toolWatch(env, args);
    case "listen": return toolListen(env, args);
    case "see_video": return toolSeeVideo(env, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}


async function handleMCP(env: Env, req: MCPRequest): Promise<MCPResponse> {
  try {
    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "memory", version: MEMORY_VERSION },
        },
      };
    }
    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id: req.id, result: { tools: listedTools(env) } };
    }
    if (req.method === "tools/call") {
      const params = req.params as { name: string; arguments?: any };
      const result = await callTool(env, params.name, params.arguments ?? {});
      return { jsonrpc: "2.0", id: req.id, result };
    }
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32603, message: isErr(e) },
    };
  }
}


// Avoid early exits that reveal how much of a guessed token matches.
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

function requireAuth(request: Request, env: Env, pathToken?: string): Response | null {
  const expected = envValue("EMBERVY_API_KEY", env as unknown as Record<string, string | undefined>);
  if (!expected) {
    return new Response("Server misconfigured: EMBERVY_API_KEY missing", { status: 500 });
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (safeEqual(auth, `Bearer ${expected}`)) return null;
  if (pathToken && safeEqual(pathToken, expected)) return null;
  return new Response("Unauthorized", { status: 401 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const isPublic =
      url.pathname === "/" ||
      url.pathname === "/health" ||
      (env.PUBLIC_IMAGES === "true" && /^\/images\/\d+$/.test(url.pathname));

    const mcpPathMatch = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    const mcpPathToken = mcpPathMatch ? mcpPathMatch[1] : undefined;

    if (!isPublic) {
      const authFail = requireAuth(request, env, mcpPathToken);
      if (authFail) return authFail;
    }

    if (request.method === "GET") {
      const fields: ReadonlyArray<readonly [string, number, number]> =
        url.pathname === "/due" ? [["until", 0, Number.MAX_SAFE_INTEGER], ["limit", 1, 50]] :
        url.pathname === "/events" ? [["days", 1, 365], ["limit", 1, 500], ["unresolved", 0, 1]] : [];
      const invalid = invalidIntegerQuery(url, fields);
      if (invalid) return Response.json({ error: `Invalid ${invalid}` }, { status: 400 });
    }

    if ((url.pathname === "/mcp" || mcpPathToken) && request.method === "POST") {
      const req = (await request.json()) as MCPRequest;
      const resp = await handleMCP(env, req);
      return Response.json(resp);
    }

    if (url.pathname === "/transcribe" && request.method === "POST") {
      const bytes = await boundedBody(request, TRANSCRIBE_MAX_BYTES);
      if (bytes instanceof Response) return bytes.status === 413
        ? Response.json({ error: "recording too large" }, { status: 413 }) : bytes;
      const out = await transcribeAudio(env.AI as any, bytes, url.searchParams.get("language") ?? undefined);
      return "error" in out ? Response.json({ error: out.error }, { status: out.status }) : Response.json(out);
    }

    if (url.pathname === "/touch" && request.method === "POST") {
      let body: any = null;
      try { body = await request.json(); } catch { return new Response("json body required", { status: 400 }); }
      const ids = Array.isArray(body?.ids)
        ? [...new Set(body.ids.filter((v: unknown) => Number.isSafeInteger(v) && (v as number) > 0))].slice(0, 200)
        : [];
      if (!ids.length) return new Response("ids required", { status: 400 });
      const source = typeof body?.source === "string" ? body.source.slice(0, 40) : "touch";
      const counterFor: Record<string, string> = {
        "membrane-used": `last_used_at = datetime('now'), used_count = COALESCE(used_count,0) + 1`,
        "membrane-injected": `last_injected_at = datetime('now'), injected_count = COALESCE(injected_count,0) + 1`,
        "membrane-distracting": `distracting_count = COALESCE(distracting_count,0) + 1`,
      };
      const knownSource = Object.prototype.hasOwnProperty.call(counterFor, source);
      const set = knownSource ? counterFor[source] : `last_accessed_at = datetime('now'), access_count = COALESCE(access_count,0) + 1`;
      if (knownSource) await ensureUsedColumns(env);
      let touched: number | null = 0;
      for (const chunk of bindChunks(ids)) {
        const r = await env.DB.prepare(`UPDATE events_hot SET ${set} WHERE id IN (${chunk.map(() => "?").join(",")})`)
          .bind(...chunk).run();
        touched = touched === null || r.meta?.changes == null ? null : touched + r.meta.changes;
      }
      const counter = source === "membrane-used" ? "used_count" : source === "membrane-injected" ? "injected_count" : source === "membrane-distracting" ? "distracting_count" : "access_count";
      return Response.json({ touched, ids, source, counter });
    }

    if (url.pathname === "/due" && request.method === "GET") {
      const until = Number(url.searchParams.get("until") ?? Date.now());
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const rows = await env.DB.prepare(
        `SELECT id, content, entity_name, meta FROM events_hot
         WHERE kind = 'todo' AND resolved_at IS NULL
           AND json_extract(meta, '$.due_epoch') IS NOT NULL
           AND json_extract(meta, '$.due_epoch') <= ?
           AND json_extract(meta, '$.reminded_at') IS NULL
         ORDER BY json_extract(meta, '$.due_epoch') ASC LIMIT ?`,
      ).bind(until, limit).all<{ id: number; content: string; entity_name: string | null; meta: string | null }>();
      const due = rows.results.map((r) => {
        const m = safeJsonParse<any>(r.meta, {});
        return { id: r.id, content: r.content, entity: r.entity_name, due_at: m.due_at ?? null, due_epoch: m.due_epoch ?? null, priority: m.priority ?? "medium" };
      });
      return Response.json({ due, now: Date.now() });
    }
    if (url.pathname === "/due/ack" && request.method === "POST") {
      let body: any = null;
      try { body = await request.json(); } catch { return new Response("json body required", { status: 400 }); }
      const ids: number[] = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => Number.isInteger(v)) : [];
      if (!ids.length) return new Response("ids required", { status: 400 });
      const stamp = new Date().toISOString();
      let acked = 0;
      for (const id of ids) {
        const row = await env.DB.prepare(`SELECT meta FROM events_hot WHERE id = ? AND kind = 'todo'`).bind(id).first<{ meta: string | null }>();
        if (!row) continue;
        const meta = safeJsonParse<any>(row.meta, {});
        meta.reminded_at = stamp;
        await env.DB.prepare(`UPDATE events_hot SET meta = ? WHERE id = ? AND kind = 'todo'`).bind(JSON.stringify(meta), id).run();
        acked++;
      }
      return Response.json({ acked, ids });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      const entity = url.searchParams.get("entity");
      const kind = url.searchParams.get("kind") || "observation";
      const days = Number(url.searchParams.get("days") ?? 21);
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const unresolved = Number(url.searchParams.get("unresolved") ?? 1) !== 0;
      const where = [`kind = ?`, `ts >= datetime('now', ?)`];
      const binds: any[] = [kind, `-${days} days`];
      if (entity) { where.push(`entity_name = ?`); binds.push(entity); }
      if (unresolved) where.push(`resolved_at IS NULL`);
      await ensureUsedColumns(env);
      const rows = await env.DB.prepare(
        `SELECT id, ts, kind, content, entity_name, tags, weight, certainty, resolved_at, access_count, used_count, injected_count, salience
           FROM events_hot WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
      ).bind(...binds, limit).all();
      return Response.json({ events: rows.results, count: rows.results?.length ?? 0, entity, days, unresolved });
    }

    if (url.pathname === "/lookup" && request.method === "GET") {
      const name = url.searchParams.get("name");
      if (!name) return new Response("name required", { status: 400 });
      const card = await env.DB.prepare(`SELECT * FROM entity_cards WHERE name = ?`).bind(name).first();
      const rels = await env.DB.prepare(
        `SELECT * FROM relations WHERE from_entity = ? OR to_entity = ?`,
      )
        .bind(name, name)
        .all();
      const recent = await env.DB.prepare(
        `SELECT id, ts, kind, content, weight FROM events_hot WHERE entity_name = ? AND kind = 'observation' ORDER BY ts DESC LIMIT 3`,
      )
        .bind(name)
        .all();
      const canon = await env.DB.prepare(
        `SELECT id, ts, content FROM events_hot WHERE entity_name = ? AND kind = 'observation' AND (tags LIKE ? OR tags LIKE ?) ORDER BY ts DESC LIMIT 12`,
      )
        .bind(name, '%"canon"%', '%"canon:%')
        .all();
      return Response.json({ card, relations: rels.results, recent: recent.results, canon: canon.results });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, version: MEMORY_VERSION });
    }

    if (url.pathname === "/graph" && request.method === "GET") {
      await ensureEdgesTable(env);
      const [entities, relations, edges] = await Promise.all([
        env.DB.prepare(`SELECT name, entity_type, description FROM entity_cards`).all(),
        env.DB.prepare(
          `SELECT from_entity, to_entity, relation_type, context FROM relations`,
        ).all(),
        env.DB.prepare(
          `SELECT id, from_event, to_event, relation, strength, status, proposed_by, reason, created_at, confirmed_at
             FROM event_edges WHERE status != 'rejected'`,
        ).all(),
      ]);
      const ids = new Set<number>();
      for (const e of edges.results as any[]) {
        ids.add(e.from_event as number);
        ids.add(e.to_event as number);
      }
      let events: any[] = [];
      if (ids.size > 0) {
        for (const chunk of bindChunks([...ids])) {
          const hot = await env.DB.prepare(
            `SELECT id, ts, kind, content, entity_name, weight FROM events_hot WHERE id IN (${chunk.map(() => "?").join(",")})`,
          ).bind(...chunk).all();
          events.push(...hot.results);
        }
        const found = new Set(events.map((e) => e.id));
        const missing = [...ids].filter((i) => !found.has(i));
        for (const chunk of bindChunks(missing)) {
          const arch = await env.DB.prepare(
            `SELECT id, ts, kind, content, entity_name, weight FROM events_archive WHERE id IN (${chunk.map(() => "?").join(",")})`,
          ).bind(...chunk).all();
          events.push(...arch.results);
        }
      }
      return Response.json({
        entities: entities.results,
        relations: relations.results,
        edges: edges.results,
        events,
      });
    }

    if (url.pathname === "/migration/import" && request.method === "POST") {
      const body = (await request.json()) as { events: any[]; origin?: string };
      if (!Array.isArray(body?.events)) {
        return Response.json({ ok: false, error: "events array required" }, { status: 400 });
      }
      const origin = typeof body.origin === "string" && body.origin ? body.origin.slice(0, 40) : "import";
      const results: any[] = [];
      for (const ev of body.events) {
        try {
          const result = await env.DB.prepare(
            `INSERT INTO events_hot (
              ts, kind, content, entity_name, entity_type, emotion, weight, source,
              certainty, tags, embedded, decay_weight, access_boost_until,
              last_accessed_at, resolved_at, resolution_note, mood_at_write,
              migration_origin, migrated_at, meta
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
          )
            .bind(
              ev.ts ?? new Date().toISOString().replace("T", " ").substring(0, 19),
              ev.kind,
              ev.content,
              ev.entity_name ?? null,
              ev.entity_type ?? null,
              ev.emotion ?? null,
              ev.weight ?? "medium",
              ev.source ?? "conversation",
              ev.certainty ?? "believed",
              ev.tags ? JSON.stringify(ev.tags) : null,
              ev.kind === "journal" || ev.kind === "goal" ? 0 : 1,
              ev.decay_weight ?? 1.0,
              ev.access_boost_until ?? null,
              ev.last_accessed_at ?? null,
              ev.resolved_at ?? null,
              ev.resolution_note ?? null,
              ev.mood_at_write ?? null,
              origin,
              ev.meta ? JSON.stringify(ev.meta) : null,
            )
            .run();
          const eventId = Number(result.meta.last_row_id);

          if (ev.kind !== "journal" && ev.kind !== "goal") {
            try {
              await upsertEventVectors(env, eventId, ev.content, ev.entity_name, ev.kind, ev.weight ?? "medium");
            } catch (e) {
              const meta = ev.meta ?? {};
              meta.embedding_failed = true;
              meta.embedding_error = isErr(e).slice(0, 200);
              await env.DB.prepare(`UPDATE events_hot SET meta = ? WHERE id = ?`)
                .bind(JSON.stringify(meta), eventId)
                .run();
            }
          }
          results.push({ ok: true, event_id: eventId });
        } catch (e) {
          console.error("memory import failed:", e);
          results.push({ ok: false, error: "import failed", source_content: ev.content?.slice(0, 80) });
        }
      }
      return Response.json({ ok: true, count: results.length, results });
    }

    if (url.pathname === "/migration/import-entities" && request.method === "POST") {
      const body = (await request.json()) as { entities: any[] };
      if (!Array.isArray(body?.entities)) {
        return Response.json({ ok: false, error: "entities array required" }, { status: 400 });
      }
      let count = 0;
      for (const e of body.entities) {
        await env.DB.prepare(
          `INSERT INTO entity_cards (name, entity_type, primary_context, description, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             entity_type = excluded.entity_type,
             primary_context = excluded.primary_context,
             description = COALESCE(excluded.description, entity_cards.description),
             updated_at = datetime('now')`,
        )
          .bind(e.name, e.entity_type, e.primary_context ?? "default", e.description ?? null, e.created_at ?? null)
          .run();
        count++;
      }
      return Response.json({ ok: true, count });
    }

    if (url.pathname === "/migration/import-relations" && request.method === "POST") {
      const body = (await request.json()) as { relations: any[] };
      if (!Array.isArray(body?.relations)) {
        return Response.json({ ok: false, error: "relations array required" }, { status: 400 });
      }
      let count = 0;
      for (const r of body.relations) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type, context, certainty, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(r.from_entity, r.to_entity, r.relation_type, r.context ?? null, r.certainty ?? "believed", r.created_at ?? null)
          .run();
        count++;
      }
      return Response.json({ ok: true, count });
    }

    if (url.pathname === "/migration/import-dreams" && request.method === "POST") {
      const body = (await request.json()) as { dreams: any[] };
      if (!Array.isArray(body?.dreams)) {
        return Response.json({ ok: false, error: "dreams array required" }, { status: 400 });
      }
      let count = 0;
      for (const d of body.dreams) {
        await env.DB.prepare(
          `INSERT INTO dream_notes (created_at, content, weight, read_at, source_model)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(d.created_at, d.content, d.weight ?? "medium", d.read_at ?? null, d.source_model ?? "import")
          .run();
        count++;
      }
      return Response.json({ ok: true, count });
    }

    if (url.pathname === "/daemon/run" && request.method === "POST") {
      const result = await runDaemon(env);
      return Response.json(result);
    }

    if (url.pathname === "/daemon/decay" && request.method === "POST") {
      const result = await runMechanicalDecay(env);
      return Response.json(result, { status: result.ok ? 200 : 503 });
    }

    if (url.pathname === "/daemon/retry-embeddings" && request.method === "POST") {
      const result = await retryFailedEmbeddings(env);
      return Response.json({ ok: true, scanned: result.scanned, embedded: result.ok });
    }

    if (url.pathname === "/daemon/mode" && request.method === "POST") {
      const mode = url.searchParams.get("mode");
      if (mode !== "normal" && mode !== "backlog") {
        return new Response("mode must be normal or backlog", { status: 400 });
      }
      await env.DB.prepare(
        `UPDATE daemon_config SET mode = ?, set_at = datetime('now') WHERE id = 1`,
      )
        .bind(mode)
        .run();
      return Response.json({ ok: true, mode });
    }

    // Safari on iOS requires byte-range responses for video playback.
    const videoPathMatch = url.pathname.match(/^\/videos\/(\d+)$/);
    if (videoPathMatch && request.method === "GET") {
      const id = Number(videoPathMatch[1]);
      if (!await eventExists(env, id)) return new Response("video not found", { status: 404 });
      const key = `videos/${id}.mp4`;
      const head = await env.ARCHIVE.head(key);
      if (!head) return new Response("video not found", { status: 404 });
      const type = !head.httpMetadata?.contentType || head.httpMetadata.contentType === "video/mp4"
        ? "video/mp4" : "application/octet-stream";
      const base = { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes" };
      const range = parseByteRange(request.headers.get("Range"), head.size);
      if (range === "unsatisfiable") {
        return new Response("range not satisfiable", { status: 416, headers: { ...base, "Content-Range": `bytes */${head.size}` } });
      }
      const obj = await env.ARCHIVE.get(key, range ? { range } : undefined);
      if (!obj) return new Response("video not found", { status: 404 });
      if (!range) return new Response(obj.body, { headers: { ...base, "Content-Length": String(head.size) } });
      return new Response(obj.body, {
        status: 206,
        headers: { ...base, "Content-Range": contentRange(range, head.size), "Content-Length": String(range.length) },
      });
    }

    // Media requires a surviving event so orphaned bytes remain inaccessible.
    const imagePathMatch = url.pathname.match(/^\/images\/(\d+)$/);
    if (imagePathMatch && request.method === "GET") {
      const imageError = (message: string, status: number) => new Response(message, {
        status, headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" },
      });
      const id = parseInt(imagePathMatch[1], 10);
      if (!Number.isFinite(id) || id <= 0) {
        return imageError("invalid id", 400);
      }
      try {
        if (!await eventExists(env, id)) return imageError("image not found", 404);
        const row = await env.DB.prepare(
          `SELECT data, mime_type FROM images_data WHERE event_id = ?`,
        ).bind(id).first<{ data: string; mime_type: string }>();
        if (!row?.data) {
          return imageError("image not found", 404);
        }
        const base64 = row.data.replace(/\s/g, "");
        let bytes: Uint8Array;
        try {
          const bin = atob(base64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch {
          return imageError("corrupted base64", 500);
        }
        const detected = detectImageMime(bytes) || row.mime_type;
        return new Response(bytes as BodyInit, {
          headers: {
            "Content-Type": IMAGE_MIME_TYPES.has(detected) ? detected : "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            // Shared caches must not reuse authenticated image responses.
            "Cache-Control": "private, no-store",
          },
        });
      } catch (err) {
        console.error("memory image read failed:", err);
        return imageError("error: image read failed", 500);
      }
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(`embervy-memory v${MEMORY_VERSION}\n`, { headers: { "Content-Type": "text/plain" } });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Cloudflare stops invocations at the CPU limit; run the semantic pass before housekeeping.
    try {
      const result = await runDaemon(env);
      console.log("Daemon run:", JSON.stringify(result));
    } catch (e) {
      console.error("Daemon failed:", e instanceof Error ? e.message : e);
    }
    try {
      await runMechanicalDecay(env);
    } catch (e) {
      console.error("Mechanical decay failed:", e instanceof Error ? e.message : e);
    }
    try {
      const retry = await retryFailedEmbeddings(env);
      if (retry.scanned > 0) console.log("Embedding retry:", JSON.stringify(retry));
    } catch (e) {
      console.error("Embedding retry failed:", e instanceof Error ? e.message : e);
    }
  },
};
