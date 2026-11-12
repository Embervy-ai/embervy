import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeEnv, sessionFile, TOKEN } from "../../shared/rag/test/fake-env.ts";

// The inlet worker's time channel, offline: a local fake rag server (or the
// real rag worker module on fake bindings), no classifier, no external
// network. A fixed clock in Europe/Berlin makes relative dates deterministic. All session
// texts are invented. The language file is a path that does not exist (English
// only) unless a test names one.

const WORKER = resolve(import.meta.dir, "inlet-worker.ts");
const languageDirs: string[] = [];
afterEach(() => {
  for (const dir of languageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = "2026-10-02T14:00:00+02:00";

type Call = { path: string; query: Record<string, string>; body: any };
type Handler = (call: Call) => Response | Promise<Response | undefined> | undefined;

const hit = (filename: string, chunkIndex: number, content: string, score: number, date: string | null, sources = ["bm25", "rerank"]) =>
  ({ filename, chunkIndex, content, score, sources, date, session: Number(filename.match(/_(\d+)/)?.[1] ?? 0), totalChunks: 4 });

// Meaning search (no dateFrom): five hits.
const SEMANTIC = [
  hit("Session_1.md", 0, "Semantic one", 0.8, "2026-08-01"),
  hit("Session_2.md", 0, "Semantic two", 0.7, "2026-08-02"),
  hit("Session_3.md", 0, "Semantic three", 0.6, "2026-08-03"),
  hit("Session_4.md", 0, "Semantic four", 0.5, "2026-08-04"),
  hit("Session_5.md", 0, "Semantic five", 0.45, "2026-08-05"),
];
// Window search (dateFrom/dateTo): chunks around the day before the fixed clock.
const WINDOW = [
  hit("Session_40.md", 2, "Window one", 0.7, "2026-10-01"),
  hit("Session_39.md", 1, "Adjacent day", 0.6, "2026-09-30"),
  hit("Session_41.md", 0, "Window two", 0.55, "2026-10-01"),
  hit("Session_41.md", 3, "Too weak", 0.05, "2026-10-01"),
];
const ROW = (filename: string, session: number, date: string, themes: string | null, summary: string | null, part = 1) =>
  ({ filename, prefix: "Session", session, part, date, total_chunks: 4, themes, summary, key_moments: null });
const DAY_ROWS: Record<string, any[]> = {
  "2026-09-30": [ROW("Session_39.md", 39, "2026-09-30", "Bookshelf", "Shelf assembled.")],
  "2026-10-01": [
    ROW("Session_40.md", 40, "2026-10-01", "Garden plans", "Raised beds measured."),
    ROW("Session_41_part01.md", 41, "2026-10-01", "Tool shed", "Roof options compared."),
    ROW("Session_41_part02.md", 41, "2026-10-01", "Tool shed", "Roof options compared.", 2),
  ],
  "2026-10-02": [ROW("Session_42.md", 42, "2026-10-02", "Morning walk", "Short walk before work.")],
};

function rowsBetween(from: string, to: string, order: string) {
  const days = Object.keys(DAY_ROWS).filter((d) => d >= from && d <= to).sort();
  if (order === "desc") days.reverse();
  return days.flatMap((d) => (order === "desc" ? [...DAY_ROWS[d]].reverse() : DAY_ROWS[d]));
}

// A rag worker that knows the time channel.
const newWorker: Handler = ({ path, query, body }) => {
  if (path === "/files") return Response.json({ from: query.from, to: query.to, files: rowsBetween(query.from, query.to, query.order), truncated: false });
  if (path === "/search") {
    if (body.dateFrom) {
      const results = WINDOW.filter((r) => r.date! >= body.dateFrom && r.date! <= body.dateTo);
      return Response.json({ results, date_filter: { from: body.dateFrom, to: body.dateTo } });
    }
    return Response.json({ results: SEMANTIC, date_filter: null });
  }
  if (path === "/expand") return Response.json({ results: [], vetoes: [] });
};

// A rag worker from before the channel: no /files, dateFrom ignored.
const oldWorker: Handler = ({ path }) => {
  if (path === "/search") return Response.json({ results: SEMANTIC });
  if (path === "/expand") return Response.json({ results: [], vetoes: [] });
  return new Response("Not found", { status: 404 });
};

async function run(prompt: string, handler: Handler, env: Record<string, string> = {}, fetchImpl?: (req: Request) => Promise<Response>) {
  const calls: Call[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      if (fetchImpl) {
        const u = new URL(req.url);
        const clone = req.clone();
        calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: req.method === "POST" ? await clone.json().catch(() => null) : null });
        return fetchImpl(req);
      }
      const u = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      const call = { path: u.pathname, query: Object.fromEntries(u.searchParams), body };
      calls.push(call);
      return (await handler(call)) ?? new Response("Unexpected request", { status: 500 });
    },
  });
  const proc = Bun.spawn([process.execPath, WORKER, prompt], {
    cwd: "/tmp",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      RAG_URL: server.url.origin, RAG_AUTH_TOKEN: TOKEN,
      OPENROUTER_API_KEY: "",
      EMBERVY_TIMEZONE: "Europe/Berlin",
      INLET_NOW: NOW,
      EMBERVY_STRINGS_LOCAL: join(tmpdir(), "no-such-dir-7f3a", "strings.local.json"),
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 8_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(code).toBe(0);
    return { stdout, stderr, calls };
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

const PLAIN = [
  "## Chronicle (RAG)",
  "[Session_1.md] (80% [bm25+rerank])\nSemantic one",
  "[Session_2.md] (70% [bm25+rerank])\nSemantic two",
  "[Session_3.md] (60% [bm25+rerank])\nSemantic three",
  "[Session_4.md] (50% [bm25+rerank])\nSemantic four",
  "[Session_5.md] (45% [bm25+rerank])\nSemantic five",
];
const PLAIN_OUT = `${PLAIN[0]}\n${PLAIN.slice(1).join("\n\n---\n\n")}\n`;
const timeCalls = (calls: Call[]) => calls.filter((c) => c.path === "/files" || (c.path === "/search" && c.body?.dateFrom !== undefined));

describe("no time reference: byte-identical to the meaning search alone", () => {
  for (const prompt of [
    "deployment decision",
    "Tomorrow I have to see the doctor",
    "Next Tuesday is the appointment",
    "How's it going today?",
    "Good morning",
    "[gateway:silent] What happened yesterday?",
    "Do you have time on Wednesday?",
  ]) {
    test(JSON.stringify(prompt), async () => {
      const on = await run(prompt, newWorker);
      const off = await run(prompt, newWorker, { INLET_TEMPORAL: "0" });
      expect(on.stdout).toBe(off.stdout);
      expect(on.stdout).toBe(PLAIN_OUT);
      expect(timeCalls(on.calls)).toHaveLength(0);
      expect(on.calls.filter((c) => c.path === "/search").map((c) => Object.keys(c.body).sort()))
        .toEqual([["mode", "query", "topK"]]);
    });
  }
});

describe("time questions against a worker that knows the channel", () => {
  test("pure time question: day card, the best chunk of the window, four meaning slots", async () => {
    const r = await run("What happened yesterday?", newWorker);
    expect(r.stdout).toBe([
      "## Time window (RAG)",
      'Time window Thu 2026-10-01 ("yesterday"):',
      "- Session_40 (Thu 2026-10-01): Garden plans — Raised beds measured.",
      "- Session_41 (Thu 2026-10-01): Tool shed — Roof options compared.",
      "",
      "[Session_40.md] (70% [bm25+rerank], 2026-10-01)",
      "Window one",
      "",
      `${PLAIN[0]}\n${PLAIN.slice(1, 5).join("\n\n---\n\n")}`,
      "",
    ].join("\n"));
    const files = r.calls.filter((c) => c.path === "/files");
    expect(files.map((c) => c.query)).toEqual([{ from: "2026-10-01", to: "2026-10-01", order: "asc", facts: "6" }]);
    const windowSearch = r.calls.filter((c) => c.path === "/search" && c.body.dateFrom);
    // ±1 day around the window; a pure question ranks by the whole prompt.
    expect(windowSearch.map((c) => c.body)).toEqual([{ query: "What happened yesterday?", topK: 5, mode: "hybrid", dateFrom: "2026-09-30", dateTo: "2026-10-02" }]);
  });

  test("a topic in the window: two window chunks, three meaning chunks, no chunk twice", async () => {
    const dupe = (h: Handler): Handler => (call) => {
      if (call.path === "/search" && !call.body.dateFrom) {
        return Response.json({ results: [hit("Session_40.md", 2, "Window one", 0.9, "2026-10-01"), ...SEMANTIC] });
      }
      return h(call);
    };
    const r = await run("What did we say about the tool shed yesterday?", dupe(newWorker));
    const window = r.stdout.split("## Chronicle (RAG)")[0];
    const chronicle = r.stdout.split("## Chronicle (RAG)")[1];
    expect(window).toContain("[Session_40.md] (70% [bm25+rerank], 2026-10-01)\nWindow one");
    // In-window day ranks ahead of the adjacent day (0.55 × 1.25 > 0.6); the 0.05 chunk is under the floor.
    expect(window).toContain("[Session_41.md] (55% [bm25+rerank], 2026-10-01)\nWindow two");
    expect(window).not.toContain("Adjacent day");
    expect(window).not.toContain("Too weak");
    expect(chronicle).not.toContain("Window one");
    expect(chronicle.match(/^\[Session_/gm)).toHaveLength(3);
    expect(r.stdout.match(/^\[Session_/gm)).toHaveLength(5);
    const windowSearch = r.calls.find((c) => c.path === "/search" && c.body.dateFrom)!;
    expect(windowSearch.body.query).toBe("What did we say about the tool shed?");
  });

  test("yesterday evening: the end of yesterday, then the start of today", async () => {
    const r = await run("What happened yesterday evening?", newWorker);
    expect(r.calls.filter((c) => c.path === "/files").map((c) => c.query).sort((a, b) => a.from.localeCompare(b.from))).toEqual([
      { from: "2026-10-01", to: "2026-10-01", order: "desc", facts: "6" },
      { from: "2026-10-02", to: "2026-10-02", order: "asc", facts: "6" },
    ]);
    expect(r.stdout).toContain([
      'Time window Thu 2026-10-01 – Fri 2026-10-02 ("yesterday evening"):',
      "- Session_41 (Thu 2026-10-01): Tool shed — Roof options compared.",
      "- Session_40 (Thu 2026-10-01): Garden plans — Raised beds measured.",
      "- Session_42 (Fri 2026-10-02): Morning walk — Short walk before work.",
    ].join("\n"));
  });

  test("an empty window says so honestly and shows the adjacent days", async () => {
    const r = await run("What happened on September 29?", newWorker);
    expect(r.stdout).toContain([
      "## Time window (RAG)",
      'Time window Tue 2026-09-29 ("on September 29"): no archived session.',
      "Adjacent days:",
      "- Session_39 (Wed 2026-09-30): Bookshelf — Shelf assembled.",
    ].join("\n"));
    expect(r.calls.filter((c) => c.path === "/files").map((c) => c.query)).toEqual([
      { from: "2026-09-29", to: "2026-09-29", order: "asc", facts: "6" },
      { from: "2026-09-28", to: "2026-09-30", order: "asc", facts: "4" },
    ]);
    expect(r.stdout).toContain("[Session_39.md] (60% [bm25+rerank], 2026-09-30)\nAdjacent day");
  });

  test("today only, nothing archived yet: nothing added", async () => {
    const empty: Handler = (call) => (call.path === "/files" ? Response.json({ files: [] }) : newWorker(call));
    const r = await run("What did we say this morning?", empty);
    const off = await run("What did we say this morning?", empty, { INLET_TEMPORAL: "0" });
    expect(r.stdout).toBe(off.stdout);
    expect(r.calls.filter((c) => c.path === "/search" && c.body.dateFrom)).toHaveLength(0);
  });

  test("a month only boosts meaning hits dated inside it; no window search", async () => {
    const monthHits: Handler = (call) => {
      if (call.path === "/search") {
        return Response.json({ results: [hit("Session_7.md", 0, "August thing", 0.6, "2026-08-20"), hit("Session_9.md", 0, "September thing", 0.5, "2026-09-10")] });
      }
      return newWorker(call);
    };
    const on = await run("What happened in September?", monthHits);
    const off = await run("What happened in September?", monthHits, { INLET_TEMPORAL: "0" });
    expect(timeCalls(on.calls)).toHaveLength(0);
    expect(on.stdout.indexOf("September thing")).toBeLessThan(on.stdout.indexOf("August thing"));
    expect(off.stdout.indexOf("August thing")).toBeLessThan(off.stdout.indexOf("September thing"));
    // Scores shown are the real ones.
    expect(on.stdout).toContain("[Session_9.md] (50% [bm25+rerank])");
  });

  test("INLET_TEMPORAL=0 switches the channel off completely", async () => {
    for (const value of ["0", "off", "false"]) {
      const r = await run("What happened yesterday?", newWorker, { INLET_TEMPORAL: value });
      expect(timeCalls(r.calls)).toHaveLength(0);
      expect(r.stdout).toBe(PLAIN_OUT);
    }
  });
});

describe("the time words of the language file (strings.local.json) reach the worker", () => {
  const languageFile = (timeWords: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "inlet-time-words-"));
    languageDirs.push(dir);
    const file = join(dir, "strings.local.json");
    writeFileSync(file, JSON.stringify({ language: "es", "chat.send": "Enviar", timeWords }));
    return file;
  };
  const SPANISH = { yesterday: ["ayer"], lastWeekday: ["[el] {weekday} pasado"], weekdays: { martes: 2 }, past: ["pasó"], filler: ["qué", "pasó"] };

  test("with Spanish words a Spanish question opens the window; without the file it is English only", async () => {
    const r = await run("¿Qué pasó ayer?", newWorker, { EMBERVY_STRINGS_LOCAL: languageFile(SPANISH) });
    expect(r.stdout).toContain('## Time window (RAG)\nTime window Thu 2026-10-01 ("ayer"):\n- Session_40');
    expect(r.calls.filter((c) => c.path === "/files").map((c) => c.query)).toEqual([{ from: "2026-10-01", to: "2026-10-01", order: "asc", facts: "6" }]);
    expect(r.stderr).not.toContain("[inlet/time]");
    const without = await run("¿Qué pasó ayer?", newWorker);
    expect(without.stdout).toBe(PLAIN_OUT);
    expect(timeCalls(without.calls)).toHaveLength(0);
  });

  test("a broken entry is logged and skipped; the rest of the file still works", async () => {
    const r = await run("¿Qué pasó el martes pasado?", newWorker, { EMBERVY_STRINGS_LOCAL: languageFile({ ...SPANISH, yesterday: ["ayer", "{nope}"] }) });
    expect(r.stderr).toContain('[inlet/time] timeWords.yesterday: "{nope}" has an unknown slot {nope} — skipped');
    expect(r.stdout).toContain('Time window Tue 2026-09-29 ("el martes pasado")');
  });
});

describe("fail-open: a worker without the channel changes nothing", () => {
  test("old worker (no /files, dateFrom ignored): byte-identical, one probe, no window search", async () => {
    for (const prompt of ["What happened yesterday?", "What did we say about the fence last Tuesday?", "What happened last night?"]) {
      const r = await run(prompt, oldWorker);
      const off = await run(prompt, oldWorker, { INLET_TEMPORAL: "0" });
      expect(r.stdout).toBe(off.stdout);
      expect(r.stdout).toBe(PLAIN_OUT);
      expect(r.calls.filter((c) => c.path === "/search" && c.body.dateFrom)).toHaveLength(0);
      expect(r.calls.filter((c) => c.path === "/files").length).toBeGreaterThan(0);
    }
  });

  for (const [label, files] of [
    ["500", () => new Response("boom", { status: 500 })],
    ["invalid JSON", () => new Response("not json")],
    ["no files field", () => Response.json({ rows: [] })],
    ["rows of another shape", () => Response.json({ files: [{ name: "Session_40.md" }] })],
  ] as const) {
    test(`/files answers ${label}: byte-identical`, async () => {
      const h: Handler = (call) => (call.path === "/files" ? files() : newWorker(call));
      const r = await run("What happened yesterday?", h);
      expect(r.stdout).toBe(PLAIN_OUT);
      expect(r.calls.filter((c) => c.path === "/search" && c.body.dateFrom)).toHaveLength(0);
    });
  }

  test("a worker with /files but a /search that ignores the range: day card, no window chunks", async () => {
    const half: Handler = (call) => (call.path === "/search" ? Response.json({ results: [...WINDOW, ...SEMANTIC] }) : newWorker(call));
    const r = await run("What happened yesterday?", half);
    expect(r.stdout).toContain('Time window Thu 2026-10-01 ("yesterday"):\n- Session_40');
    expect(r.stdout.split("## Chronicle (RAG)")[0]).not.toContain("[Session_");
  });

  test("window chunks dated outside the asked range are dropped", async () => {
    const wrong: Handler = (call) => (call.path === "/search" && call.body.dateFrom
      ? Response.json({ results: [hit("Session_2.md", 1, "Old chunk", 0.9, "2026-08-02")], date_filter: { from: call.body.dateFrom, to: call.body.dateTo } })
      : newWorker(call));
    const r = await run("What happened yesterday?", wrong);
    expect(r.stdout).not.toContain("Old chunk");
    expect(r.stdout).toContain("Time window Thu 2026-10-01");
  });

  test("a hanging /files is cut off at the deadline", async () => {
    const slow: Handler = async (call) => {
      if (call.path === "/files") { await Bun.sleep(3_000); return Response.json({ files: [] }); }
      return newWorker(call);
    };
    const started = Date.now();
    const r = await run("What happened yesterday?", slow, { INLET_TEMPORAL_TIMEOUT_MS: "300" });
    expect(r.stdout).toBe(PLAIN_OUT);
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});

describe("end to end with the real rag worker on fake bindings", () => {
  test("the window holds yesterday's sessions; the meaning search is untouched", async () => {
    const worker = (await import("../../shared/rag/src/index.ts")).default;
    const env = fakeEnv();
    const up = async (name: string, content: string) => {
      const form = new FormData();
      form.append("file", new File([content], name));
      const res = await worker.fetch(new Request("https://rag.test/upload", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form }), env as any);
      expect(res.status).toBe(200);
    };
    await up("Session_50.md", sessionFile("Session_50", "2026-09-20", { themes: "Kitchen shelf" }, "**User**\n\nThe kitchen shelf and the garden hose.\n"));
    await up("Session_51.md", sessionFile("Session_51", "2026-10-01", { themes: "Garden hose", summary: "Picked a longer hose." }, "**User**\n\nWe need a longer garden hose for the beds.\n"));
    await up("Session_52.md", sessionFile("Session_52", "2026-10-02", { themes: "Breakfast" }, "**User**\n\nPancakes this morning.\n"));

    const r = await run("What did we say about the garden hose yesterday?", () => undefined, {}, (req) => worker.fetch(req, env as any));
    expect(r.stdout).toContain('Time window Thu 2026-10-01 ("yesterday"):\n- Session_51 (Thu 2026-10-01): Garden hose — Picked a longer hose.');
    const window = r.stdout.split("## Chronicle (RAG)")[0];
    expect(window).toContain("[Session_51.md] (");
    expect(window).not.toContain("[Session_50.md]");
    // The meaning search still sees every day.
    expect(r.stdout.split("## Chronicle (RAG)")[1] ?? "").toContain("[Session_50.md]");
  });
});
