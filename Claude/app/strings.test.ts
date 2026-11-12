import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_FILES, checkReport, clientFilesFingerprint, clientScript, interpolate, loadStrings, mergeStrings, normalizeLanguage, pageVersion, t } from "./strings";


const APP = import.meta.dir;
const REPO = join(APP, "..", "..");
const read = (path: string) => readFileSync(path, "utf8");
const enOf = (appDir: string) => JSON.parse(read(join(appDir, "strings", "en.json")));
const EN = enOf(APP);

const scratch = mkdtempSync(join(tmpdir(), "embervy-strings-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let fileNo = 0;
function writeScratch(content: string): string {
  const path = join(scratch, `f${++fileNo}.json`);
  writeFileSync(path, content);
  return path;
}

const I18N_SOURCE = read(join(APP, "public", "i18n.js"));
type FakeEl = { tag: string; attrs: Record<string, string>; textContent: string; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void };
function fakeEl(tag: string, attrs: Record<string, string>, text: string): FakeEl {
  return {
    tag, attrs, textContent: text,
    getAttribute(n) { return own(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = v; },
  };
}
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function runInBrowser(script: string, elements: FakeEl[]) {
  const document = {
    documentElement: { lang: "en" },
    querySelectorAll(selector: string) {
      const attr = selector.match(/^\[([\w-]+)\]$/)?.[1];
      return attr ? elements.filter((e) => own(e.attrs, attr)) : [];
    },
  };
  const window: any = { document };
  new Function("window", "document", "module", script + "\n" + I18N_SOURCE)(window, document, undefined);
  return { window, document };
}

const ATTRS = ["title", "aria-label", "placeholder", "data-placeholder", "data-new-label"];
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
async function markedElements(htmlPath: string): Promise<FakeEl[]> {
  const found: FakeEl[] = [];
  let open: FakeEl | null = null;
  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        const attrs: Record<string, string> = {};
        for (const [name, value] of el.attributes) attrs[name] = decode(value);
        if (!Object.keys(attrs).some((a) => a === "data-i18n" || a.startsWith("data-i18n-"))) return;
        const entry = fakeEl(el.tagName, attrs, "");
        found.push(entry);
        if (own(attrs, "data-i18n")) {
          open = entry;
          el.onEndTag(() => { open = null; });
        }
      },
    })
    .on("[data-i18n]", {
      // data-i18n elements hold plain text and are never nested.
      text(chunk) {
        if (open) open.textContent += decode(chunk.text);
      },
    });
  await rewriter.transform(new Response(read(htmlPath))).text();
  for (const e of found) e.textContent = e.textContent.replace(/\s+/g, " ").trim();
  return found;
}
function keysInMarkup(elements: FakeEl[]): string[] {
  const keys: string[] = [];
  for (const e of elements) {
    if (own(e.attrs, "data-i18n")) keys.push(e.attrs["data-i18n"]);
    for (const a of ATTRS) if (own(e.attrs, `data-i18n-${a}`)) keys.push(e.attrs[`data-i18n-${a}`]);
  }
  return keys;
}
function keysInCode(paths: string[]): string[] {
  const keys: string[] = [];
  for (const p of paths) {
    const src = read(p);
    for (const m of src.matchAll(/\b(?:t|S|L)\("([\w.]+)"/g)) keys.push(m[1]);
    for (const m of src.matchAll(/nameKey: "([\w.]+)"/g)) keys.push(m[1]);
  }
  return keys;
}
const textKeys = (en: Record<string, unknown>) => Object.keys(en).filter((k) => k !== "language" && !k.startsWith("_"));

describe("merging en.json with strings.local.json", () => {
  test("no local file: English, language en, nothing to report", () => {
    const s = mergeStrings(EN, undefined);
    expect(s.language).toBe("en");
    expect(s.strings["chat.send"]).toBe("Send");
    expect(s.overridden).toEqual([]);
    expect(s.warnings).toEqual([]);
  });

  test("partial local file overrides only the keys it names; the rest falls back to English", () => {
    const s = mergeStrings(EN, { language: "fr", "chat.send": "Envoyer", "push.allow": "Oui" });
    expect(s.language).toBe("fr");
    expect(s.strings["chat.send"]).toBe("Envoyer");
    expect(s.strings["push.allow"]).toBe("Oui");
    expect(s.strings["push.prompt"]).toBe("Enable push notifications?");
    expect(s.overridden.sort()).toEqual(["chat.send", "push.allow"]);
    expect(s.warnings).toEqual([]);
  });

  test("language tags are validated and canonicalised", () => {
    expect(normalizeLanguage("EN-gb")).toBe("en-GB");
    expect(normalizeLanguage("pt-br")).toBe("pt-BR");
    expect(normalizeLanguage("de")).toBe("de");
    expect(normalizeLanguage("not a language!")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage(42)).toBeNull();
    const bad = mergeStrings(EN, { language: "french please" });
    expect(bad.language).toBe("en");
    expect(bad.warnings.join("\n")).toContain("not a valid language tag");
  });

  test("unknown keys, non-string values and non-objects are skipped with a warning, never thrown", () => {
    const s = mergeStrings(EN, { "chat.sned": "Envoyer", "chat.send": 5, "_note": "translated by the agent", "push.allow": "Oui" });
    expect(s.strings["chat.send"]).toBe("Send");
    expect(s.strings["push.allow"]).toBe("Oui");
    expect(own(s.strings, "chat.sned")).toBe(false);
    expect(own(s.strings, "_note")).toBe(false);
    expect(s.warnings).toHaveLength(2);
    expect(s.warnings.join("\n")).toContain('unknown key "chat.sned"');
    expect(s.warnings.join("\n")).toContain('"chat.send" must be a string');
    for (const local of [["x"], "fr", 7]) {
      const r = mergeStrings(EN, local);
      expect(r.strings).toEqual(mergeStrings(EN, undefined).strings);
      expect(r.warnings.join("\n")).toContain("must be a JSON object");
    }
  });

  test("a translation that drops a placeholder is kept but reported", () => {
    const s = mergeStrings(EN, { "chat.uploadFailed": "Échec de l'envoi" });
    expect(s.strings["chat.uploadFailed"]).toBe("Échec de l'envoi");
    expect(s.warnings.join("\n")).toContain("{name}");
  });

  test("the sections for Brain and the time channel are accepted without a warning and never become app texts", () => {
    const s = mergeStrings(EN, {
      language: "es", "chat.send": "Enviar",
      brain: { "cache ping": "ping de caché" },
      timeWords: { yesterday: ["ayer"], weekdays: { martes: 2 } },
    });
    expect(s.warnings).toEqual([]);
    expect(s.sections).toEqual(["brain", "timeWords"]);
    expect(s.overridden).toEqual(["chat.send"]);
    expect(own(s.strings, "brain")).toBe(false);
    expect(own(s.strings, "timeWords")).toBe(false);
    const bad = mergeStrings(EN, { brain: "ping de caché", timeWords: ["ayer"] });
    expect(bad.sections).toEqual([]);
    expect(bad.warnings).toHaveLength(2);
    expect(bad.warnings.join("\n")).toContain('"brain" must be an object');
    expect(bad.warnings.join("\n")).toContain('"timeWords" must be an object');
    const report = checkReport(join(APP, "strings", "en.json"), writeScratch(JSON.stringify({ language: "es", brain: {}, timeWords: {} })));
    expect(report.ok).toBe(true);
    expect(report.text).toContain('sections for other readers: "brain" — ');
    expect(report.text).toContain('"timeWords" — the time channel');
  });
});

describe("t / interpolate", () => {
  test("fills placeholders once, leaves unknown ones visible, shows a missing key as itself", () => {
    const table = { greet: "Hello {name}, {missing}" };
    expect(t(table, "greet", { name: "{missing}" })).toBe("Hello {missing}, {missing}");
    expect(t(table, "nope")).toBe("nope");
    expect(interpolate("{a}{b}", { a: 1, b: "x" })).toBe("1x");
    expect(interpolate("keep {x}")).toBe("keep {x}");
  });
});

describe("loading from disk", () => {
  test("missing local file and broken local JSON both mean English, no throw", () => {
    const missing = loadStrings(join(APP, "strings", "en.json"), join(scratch, "absent.json"), false);
    expect(missing.language).toBe("en");
    expect(missing.warnings).toEqual([]);
    const broken = loadStrings(join(APP, "strings", "en.json"), writeScratch("{ \"language\": \"fr\", "), false);
    expect(broken.language).toBe("en");
    expect(broken.strings["chat.send"]).toBe("Send");
    expect(broken.warnings.join("\n")).toContain("not valid JSON");
  });

  test("a changed local file is picked up without a restart", () => {
    const local = writeScratch(JSON.stringify({ language: "fr", "chat.send": "Envoyer" }));
    const en = join(APP, "strings", "en.json");
    expect(loadStrings(en, local, false).strings["chat.send"]).toBe("Envoyer");
    writeFileSync(local, JSON.stringify({ language: "es", "chat.send": "Enviar", "push.allow": "Sí" }));
    const after = loadStrings(en, local, false);
    expect(after.language).toBe("es");
    expect(after.strings["chat.send"]).toBe("Enviar");
    expect(after.strings["push.allow"]).toBe("Sí");
  });

  test("--check lists what is still English and what was skipped", () => {
    const local = writeScratch(JSON.stringify({ language: "fr", "chat.send": "Envoyer", "chat.sned": "x" }));
    const report = checkReport(join(APP, "strings", "en.json"), local);
    expect(report.ok).toBe(false);
    expect(report.text).toContain("language: fr");
    expect(report.text).toContain(`overridden: 1 of ${textKeys(EN).length}`);
    expect(report.text).toContain('push.allow = "Yes"');
    expect(report.text).toContain('unknown key "chat.sned"');
    expect(checkReport(join(APP, "strings", "en.json"), join(scratch, "absent.json")).ok).toBe(true);
  });
});

describe("browser side (public/i18n.js)", () => {
  const at1405 = new Date(2026, 8, 30, 14, 5).toISOString();

  test("time and numbers follow the language setting; English by default", () => {
    const create = (language: string) => runInBrowser(clientScript(mergeStrings(EN, { language })), []).window.embervyI18n;
    expect(create("en").formatTime(at1405)).toMatch(/^02:05\sPM$/u);
    expect(create("de").formatTime(at1405)).toBe("14:05");
    expect(create("en-GB").formatTime(at1405)).toBe("14:05");
    expect(create("fr").formatTime(at1405)).toBe("14:05");
    expect(create("en").formatNumber(1234567)).toBe("1,234,567");
    expect(create("de").formatNumber(1234567)).toBe("1.234.567");
  });

  test("/strings.js sets <html lang> and the table; i18n.js applies it with English fallback", async () => {
    const elements = await markedElements(join(APP, "public", "index.html"));
    const merged = mergeStrings(EN, {
      language: "fr",
      "chat.input.placeholder": "Écrire un message…",
      "chat.send": "Envoyer",
      "notes.saved": "Enregistré",
      "chat.newMessage": "Nouveau message",
    });
    const { window, document } = runInBrowser(clientScript(merged), elements);
    expect(document.documentElement.lang).toBe("fr");
    expect(window.embervyI18n.language).toBe("fr");
    const byId = (id: string) => elements.find((e) => e.attrs.id === id)!;
    expect(byId("input").attrs.placeholder).toBe("Écrire un message…");
    expect(byId("send-btn").attrs["aria-label"]).toBe("Envoyer");
    expect(byId("notes-saved-indicator").textContent).toBe("Enregistré");
    expect(byId("scroll-bottom-btn").attrs["data-new-label"]).toBe("Nouveau message");
    expect(byId("mic-btn").attrs.title).toBe("Voice input");
    expect(byId("terminal-live-btn").textContent).toBe("● Live");
    expect(window.embervyI18n.t("chat.uploadFailed", { name: "a.pdf" })).toBe("[Upload failed: a.pdf]");
  });

  test("terminal text submission is Send while the standalone key remains Enter", async () => {
    const elements = await markedElements(join(APP, "public", "index.html"));
    const send = elements.find(e => e.attrs.id === "terminal-input-send")!;
    const enter = elements.find(e => e.attrs["data-terminal-key"] === "Enter")!;
    expect(send.textContent).toBe("Send");
    expect(send.attrs["aria-label"]).toBe("Send terminal input");
    expect(send.attrs["data-i18n"]).toBe("terminal.input.sendText");
    expect(enter.textContent).toBe("Enter");
    expect(enter.attrs["data-i18n"]).toBe("terminal.key.enter");
    expect(EN["terminal.input.sendText"]).toBe("Send");
    expect(EN["terminal.key.enter"]).toBe("Enter");
    runInBrowser(clientScript(mergeStrings(EN, {
      language: "fr",
      "terminal.input.sendText": "Envoyer",
      "terminal.input.send": "Envoyer la saisie au terminal",
      "terminal.key.enter": "Entrée",
    })), elements);
    expect(send.textContent).toBe("Envoyer");
    expect(send.attrs["aria-label"]).toBe("Envoyer la saisie au terminal");
    expect(enter.textContent).toBe("Entrée");
  });

  test("without /strings.js the page keeps its inline English", async () => {
    const elements = await markedElements(join(APP, "public", "index.html"));
    const before = JSON.stringify(elements.map((e) => [e.attrs, e.textContent]));
    runInBrowser("", elements);
    expect(JSON.stringify(elements.map((e) => [e.attrs, e.textContent]))).toBe(before);
  });
});

for (const [name, appDir, pages, code] of [
  ["Claude/app", APP, ["index.html", "settings.html"], ["public/app.js", "public/settings.js", "server.ts", "mcp.ts", "file-viewer.ts"]],
] as const) {
  describe(`${name}: en.json is complete and matches the UI`, () => {
    const en = enOf(appDir);

    test("en.json is flat, all strings, language en, no duplicate keys", () => {
      expect(en.language).toBe("en");
      for (const k of textKeys(en)) expect(typeof en[k]).toBe("string");
      const raw = read(join(appDir, "strings", "en.json"));
      const declared = [...raw.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]);
      expect(declared.length).toBe(new Set(declared).size);
      expect(mergeStrings(en, undefined).warnings).toEqual([]);
    });

    test("every marked element's English equals en.json (the English UI is unchanged)", async () => {
      for (const page of pages) {
        for (const el of await markedElements(join(appDir, "public", page))) {
          if (own(el.attrs, "data-i18n")) {
            const key = el.attrs["data-i18n"];
            expect([page, key, en[key]]).toEqual([page, key, el.textContent]);
          }
          for (const a of ATTRS) {
            if (!own(el.attrs, `data-i18n-${a}`)) continue;
            const key = el.attrs[`data-i18n-${a}`];
            expect([page, key, en[key]]).toEqual([page, key, el.attrs[a]]);
          }
        }
      }
    });

    test("every key the code or markup uses exists, and every key in en.json is used", async () => {
      const used = new Set(keysInCode(code.map((c) => join(appDir, c))));
      for (const page of pages) for (const k of keysInMarkup(await markedElements(join(appDir, "public", page)))) used.add(k);
      expect([...used].filter((k) => !own(en, k))).toEqual([]);
      expect(textKeys(en).filter((k) => !used.has(k))).toEqual([]);
    });

    test("the email-approval text names the reactions server.ts acts on — and no others", () => {
      const src = read(join(appDir, "server.ts"));
      const list = (name: string) => {
        const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
        expect(m).not.toBeNull();
        return [...m![1].matchAll(/"([^"]*)"/g)].map((x) => JSON.parse(`"${x[1]}"`) as string);
      };
      const sends = list("heartLike");
      const discards = list("discardLike");
      expect(sends.length).toBeGreaterThan(0);
      expect(discards.length).toBeGreaterThan(0);
      const card = en["email.approvalMessage"];
      for (const emoji of [...sends, ...discards]) expect([emoji, card.includes(emoji)]).toEqual([emoji, true]);
      for (const wrong of ["✅", "❌"]) expect([wrong, card.includes(wrong)]).toEqual([wrong, false]);
      const toSend = card.indexOf("to send");
      const toDiscard = card.indexOf("to discard");
      expect(card.indexOf("React with")).toBeGreaterThanOrEqual(0);
      expect(toSend).toBeGreaterThan(card.indexOf("React with"));
      expect(toDiscard).toBeGreaterThan(toSend);
      const sendSide = card.slice(card.indexOf("React with"), toSend);
      const discardSide = card.slice(toSend, toDiscard);
      for (const emoji of sends) expect([emoji, sendSide.includes(emoji), discardSide.includes(emoji)]).toEqual([emoji, true, false]);
      for (const emoji of discards) expect([emoji, sendSide.includes(emoji), discardSide.includes(emoji)]).toEqual([emoji, false, true]);
    });

    test("pages load /strings.js in <head> and i18n.js before the page script", () => {
      for (const page of pages) {
        const html = read(join(appDir, "public", page));
        expect(html).toContain('<html lang="en">');
        expect(html.indexOf('<script src="/strings.js"></script>')).toBeLessThan(html.indexOf("</head>"));
        const i18n = html.indexOf('<script src="/i18n.js');
        const pageScript = html.search(/<script src="\/(app|settings)\.js/);
        expect(i18n).toBeGreaterThan(html.indexOf("</head>"));
        expect(i18n).toBeLessThan(pageScript);
      }
    });

    test("no German leftovers in the visible layer", () => {
      const files = [...pages.map((p) => `public/${p}`), ...code, "public/style.css"].map((f) => read(join(appDir, f)));
      for (const bad of ['lang="de"', "de-DE"]) {
        expect(files.filter((f) => f.includes(bad)).length).toBe(0);
      }
      expect(files.filter((f) => /[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/.test(f)).length).toBe(0);
    });
  });
}

describe("the version the open app compares", () => {
  // A phone restores the app from memory; it reloads once when this version
  // moves, so it must move with the app's code and style, not only its texts.
  test("a changed app.js or style.css moves it; the texts alone still do", () => {
    const dir = mkdtempSync(join(tmpdir(), "client-files-"));
    try {
      for (const f of CLIENT_FILES) writeFileSync(join(dir, f), `${f} one`);
      const s = mergeStrings(EN, {});
      const first = pageVersion(s, dir);
      expect(first).toMatch(/^[0-9a-f]{12}$/);
      expect(pageVersion(s, dir)).toBe(first);
      writeFileSync(join(dir, "app.js"), "app.js two");
      const second = pageVersion(s, dir);
      expect(second).not.toBe(first);
      writeFileSync(join(dir, "style.css"), "style.css two, a little longer");
      expect(pageVersion(s, dir)).not.toBe(second);
      expect(pageVersion(mergeStrings(EN, { language: "fr" }), dir)).not.toBe(pageVersion(s, dir));
      expect(clientFilesFingerprint(dir)).toMatch(/^[0-9a-f]{64}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("every client file it hashes is one the app ships", () => {
    for (const f of CLIENT_FILES) expect(existsSync(join(import.meta.dir, "public", f))).toBe(true);
  });
});

describe("updates leave strings.local.json alone", () => {
  test("strings.local.json is gitignored where the app lives; en.json is not", () => {
    const rules = read(join(REPO, ".gitignore"));
    expect(rules.split("\n").map((l) => l.trim())).toContain("strings.local.json");
    // A detached worktree can point outside the test sandbox; test the shipped rules in isolation.
    const dir = mkdtempSync(join(tmpdir(), "strings-ignore-"));
    try {
      writeFileSync(join(dir, ".gitignore"), rules);
      const init = Bun.spawnSync(["git", "-C", dir, "init", "--quiet"]);
      expect(init.exitCode, init.stderr.toString()).toBe(0);
      const ignored = (p: string) => Bun.spawnSync(["git", "-C", dir, "check-ignore", "-q", "--no-index", p]).exitCode;
      expect(ignored("Claude/app/strings.local.json")).toBe(0);
      expect(ignored("Claude/app/strings/en.json")).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const HAVE_DEPS = existsSync(join(APP, "node_modules", "hono")) && existsSync(join(APP, "node_modules", "web-push"));
describe("server", () => {
  test.skipIf(!HAVE_DEPS)("login page and /strings.js pick up strings.local.json live; broken JSON falls back to English", async () => {
    const local = join(scratch, "server.strings.local.json");
    const port = 40000 + Math.floor(Math.random() * 9000);
    const base = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn(["bun", join(APP, "server.ts")], {
      cwd: scratch, // no .env of a real house gets loaded
      env: {
        ...process.env,
        APP_PASSWORD: "test-password",
        APP_SESSION_SECRET: "test-secret-test-secret-test-secret",
        EMBERVY_APP_PORT: String(port),
        EMBERVY_APP_HOST: "127.0.0.1",
        EMBERVY_APP_DATA_DIR: join(scratch, "data"),
        EMBERVY_STRINGS_LOCAL: local,
        EMBERVY_TERMINAL_PANEL: "0",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let login = "";
      for (let i = 0; i < 50 && !login; i++) {
        login = await fetch(`${base}/`).then((r) => r.text()).catch(() => "");
        if (!login) await Bun.sleep(100);
      }
      expect(login).toContain('<html lang="en">');
      expect(login).toContain(">Wrong password<");
      expect(login).toContain('placeholder="Password"');

      writeFileSync(local, JSON.stringify({ language: "fr", "login.password": "Mot de passe", "login.enter": "Entrer" }));
      login = await fetch(`${base}/`).then((r) => r.text());
      expect(login).toContain('<html lang="fr">');
      expect(login).toContain('placeholder="Mot de passe"');
      expect(login).toContain(">Entrer</button>");
      expect(login).toContain(">Wrong password<");

      const auth = await fetch(`${base}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
      const cookie = (auth.headers.get("set-cookie") || "").split(";")[0];
      expect(cookie).toStartWith("embervy_session=");
      const script = async () => {
        const r = await fetch(`${base}/strings.js`, { headers: { cookie } });
        expect(r.headers.get("content-type")).toContain("javascript");
        expect(r.headers.get("cache-control")).toContain("no-cache");
        return runInBrowser(await r.text(), []).window;
      };
      let w = await script();
      expect(w.document.documentElement.lang).toBe("fr");
      expect(w.embervyI18n.t("login.enter")).toBe("Entrer");
      expect(w.embervyI18n.t("chat.send")).toBe("Send");

      const stamped = async () => {
        const version = (await (await fetch(`${base}/api/strings/version`, { headers: { cookie } })).json()).version;
        expect(version).toMatch(/^[0-9a-f]{12}$/);
        for (const page of ["/", "/settings.html"]) {
          const r = await fetch(`${base}${page}`, { headers: { cookie } });
          expect(r.headers.get("cache-control")).toContain("no-cache");
          const html = await r.text();
          expect(html).toContain(`<script src="/strings.js?v=${version}"></script>`);
          expect(html).not.toContain('<script src="/strings.js"></script>');
        }
        return version;
      };
      const frVersion = await stamped();
      expect(w.embervyI18n.version).toBe(frVersion);
      const named = await fetch(`${base}/strings.js?v=0123456789ab`, { headers: { cookie } }).then((r) => r.text());
      expect(runInBrowser(named, []).window.embervyI18n.version).toBe("0123456789ab");
      const bogus = await fetch(`${base}/strings.js?v=%3Cscript%3E`, { headers: { cookie } }).then((r) => r.text());
      expect(runInBrowser(bogus, []).window.embervyI18n.version).toBe(frVersion);
      expect(await fetch(`${base}/`, { headers: { cookie } }).then((r) => r.text())).toContain('<html lang="fr">');
      expect((await fetch(`${base}/api/strings/version`)).status).toBe(401);

      writeFileSync(local, "{ this is not json");
      w = await script();
      expect(w.document.documentElement.lang).toBe("en");
      expect(w.embervyI18n.t("login.enter")).toBe("Enter");
      const enVersion = await stamped();
      expect(enVersion).not.toBe(frVersion);
      expect(w.embervyI18n.version).toBe(enVersion);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 20_000);
});
