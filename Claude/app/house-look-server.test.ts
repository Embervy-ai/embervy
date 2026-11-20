import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HouseLookStore, MAX_PHOTO_BYTES, imageType, readLookBody } from "./house-look";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==", "base64");
const photo = `data:image/png;base64,${png.toString("base64")}`;
const unsafeFonts = [
  "serif; color:red", "serif}", "<serif", "url(font)", "My\\Font", "My\nFont",
  '"My Font', "'My Font", '"My Font\'', "x".repeat(201), "serif{", "serif>",
  "serif)", "My/Font", "My:Font", "My\tFont", "My\u0000Font", "My\u007fFont", "My\u0085Font",
];
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "house-look-")); dirs.push(dir); return dir; };
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("house appearance storage", () => {
  test("JSON commits a separate immutable photo, survives reopening, and leaves no temp files", () => {
    const dir = temp(), store = new HouseLookStore(dir);
    expect(store.read()).toBeNull();
    store.write({ titleText: "Wren", bgMode: "photo", bgPhoto: photo });
    const disk = new HouseLookStore(dir).read()!;
    expect(disk.titleText).toBe("Wren");
    expect(disk.bgPhoto).toMatch(/^house-look-photo-[a-f0-9]{64}$/);
    expect(readFileSync(store.path, "utf8")).not.toContain("data:");
    expect(readFileSync(join(dir, disk.bgPhoto!))).toEqual(png);
    expect(readdirSync(dir).sort()).toEqual([disk.bgPhoto!, "house-look.json"].sort());
    const url = store.publicLook()!.bgPhoto!;
    expect(store.photo(new URL(url, "http://example.test").searchParams.get("v")!)!.type).toBe("image/png");
    expect(store.photo("../house-look.json")).toBeNull();
    store.write({});
    expect(store.read()).toEqual({});
    expect(existsSync(join(dir, disk.bgPhoto!))).toBe(false);
    expect(store.write({ titleText: "Stale phone" }, true)).toEqual({});
  });
  test("a failed JSON commit retains both old metadata and old photo", () => {
    const dir = temp(), store = new HouseLookStore(dir);
    store.write({ titleText: "Old", bgPhoto: photo });
    const old = readFileSync(store.path, "utf8"), name = store.read()!.bgPhoto!;
    const atomic = (store as any).atomic.bind(store);
    (store as any).atomic = (path: string, value: any) => {
      if (path === store.path) throw new Error("injected rename failure");
      atomic(path, value);
    };
    const other = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 1]).toString("base64")}`;
    expect(() => store.write({ titleText: "New", bgPhoto: other })).toThrow();
    expect(readFileSync(store.path, "utf8")).toBe(old);
    expect(readFileSync(join(dir, name))).toEqual(png);
    expect(readdirSync(dir).some(name => /\.tmp$|\.lock$/.test(name))).toBe(false);
  });
  test("signature detection excludes active content and ignores spoofed MIME labels", () => {
    expect(imageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(imageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(imageType(Buffer.from("RIFFxxxxWEBP"))).toBe("image/webp");
    const store = new HouseLookStore(temp());
    store.write({ bgPhoto: photo.replace("image/png", "image/jpeg") });
    expect(store.photo(store.read()!.bgPhoto!.slice("house-look-photo-".length))!.type).toBe("image/png");
  });
  test("a chunked oversized body is bounded before parsing", async () => {
    const body = new ReadableStream({ start(controller) { for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close(); } });
    await expect(readLookBody(new Request("http://example.test", { method: "POST", body }))).rejects.toThrow("body size");
  });
  test("custom title fonts accept safe lists, Unicode letters, and the length boundary", () => {
    const store = new HouseLookStore(temp());
    for (const titleFont of ["", "serif", '"My House Script", cursive', "'Дом 字体', sans-serif", "House_Font-123, serif", "x".repeat(200)]) {
      expect(store.write({ titleFont })).toEqual({ titleFont });
    }
  });
  for (const titleFont of unsafeFonts) test(`unsafe title font is rejected: ${JSON.stringify(titleFont)}`, () => {
    const store = new HouseLookStore(temp());
    expect(() => store.write({ titleFont })).toThrow("Invalid titleFont");
    expect(store.read()).toBeNull();
  });
  test("every font offered in settings is accepted", () => {
    const html = readFileSync(join(import.meta.dir, "public/settings.html"), "utf8");
    const select = html.split('<select id="title-font">')[1].split("</select>")[0];
    const values = [...select.matchAll(/<option value=(?:'([^']*)'|"([^"]*)")/g)].map(m => m[1] ?? m[2]);
    expect(values.length).toBeGreaterThan(0);
    const store = new HouseLookStore(temp());
    for (const titleFont of values) expect(store.write({ titleFont })).toEqual({ titleFont });
  });
});

describe("house appearance HTTP routes in an isolated house", () => {
  let dir: string, base: string, cookie: string, proc: ReturnType<typeof Bun.spawn>;
  const call = (path = "/api/house-look", body?: any, headers: Record<string, string> = { cookie }) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeAll(async () => {
    dir = temp(); mkdirSync(join(dir, "bin"));
    for (const name of ["tmux", "pgrep", "pkill", "setsid"]) {
      const path = join(dir, "bin", name); writeFileSync(path, "#!/bin/sh\nexit 0\n"); chmodSync(path, 0o755);
    }
    const preload = join(dir, "preload.ts");
    writeFileSync(preload, `import { mock } from "bun:test"; mock.module(${JSON.stringify(Bun.resolveSync("web-push", import.meta.dir))}, () => ({ default: { setVapidDetails() {}, async sendNotification() {} } }));`);
    const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = socket.port; socket.stop(true);
    if (port === 3030) throw new Error("refusing production port");
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
      cwd: dir, env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, EMBERVY_HOME: dir,
        EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), EMBERVY_APP_DATA_DIR: join(dir, "data"),
        APP_PASSWORD: "example-password", APP_SESSION_SECRET: "example-secret", INTERNAL_API_TOKEN: "example-agent-token",
        EMBERVY_TRUST_SAME_HOST: "true", EMBERVY_TERMINAL_PANEL: "0", EMBERVY_TIMEZONE: "Pacific/Auckland",
        EMBERVY_STRINGS_LOCAL: join(dir, "absent.json"),
      }, stdout: "ignore", stderr: "pipe",
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + "/health")).ok; } catch {} if (!ready) await Bun.sleep(100); }
    if (!ready) { proc.kill(); throw new Error(await new Response(proc.stderr).text()); }
    const login = await call("/api/auth", { password: "example-password" }, {});
    cookie = (login.headers.get("set-cookie") || "").split(";")[0]; expect(cookie).not.toBe("");
  }, 30_000);
  afterAll(async () => { proc?.kill(); if (proc) await proc.exited; });
  test("all doors require a cookie, reject foreign origins, and never cache even errors", async () => {
    for (const [path, body] of [["/api/house-look", undefined], ["/api/house-look", {}], ["/api/house-look/migrate", {}], ["/api/house-look/photo?v=x", undefined]] as const) {
      for (const headers of [{}, { authorization: "Bearer example-agent-token" }]) {
        const res = await call(path, body, headers);
        expect(res.status).toBe(401); expect(res.headers.get("cache-control")).toBe("private, no-store");
      }
      const res = await call(path, body, { cookie, origin: "https://foreign.example.test" });
      expect(res.status).toBe(403); expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });
  test("first concurrent migration wins; subsequent opening never silently overwrites it", async () => {
    expect(await (await call()).json()).toEqual({ look: null });
    const results = await Promise.all(["First", "Second"].map(titleText => call("/api/house-look/migrate", { titleText })));
    const looks = await Promise.all(results.map(res => res.json()));
    expect(looks[0]).toEqual(looks[1]);
    expect(["First", "Second"]).toContain(looks[0].look.titleText);
    expect(await (await call("/api/house-look/migrate", { titleText: "Third" })).json()).toEqual(looks[0]);
    expect(await (await call()).json()).toEqual(looks[0]);
  });
  test("explicit saves replace shared fields and photo bytes are private", async () => {
    const saved = await call("/api/house-look", { titleText: "Wren", titleFont: '"My House Script", cursive', bgMode: "photo", bgPhoto: photo });
    expect(saved.status).toBe(200); expect(saved.headers.get("cache-control")).toBe("private, no-store");
    const { look } = await saved.json();
    expect(look.titleText).toBe("Wren");
    expect(look.titleFont).toBe('"My House Script", cursive');
    const image = await call(look.bgPhoto);
    expect(image.status).toBe(200); expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(readFileSync(join(dir, "data/house-look.json"), "utf8")).not.toContain("data:");
    for (const bgMode of ["color", "default", "photo"]) expect((await call("/api/house-look", { bgMode, titleText: "", titleFont: "", bgPhoto: "" })).status).toBe(200);
    expect((await call("/api/house-look", {})).status).toBe(200);
    expect(await (await call()).json()).toEqual({ look: {} });
  });
  test("a resized-photo-sized upload can exceed the ordinary JSON body ceiling", async () => {
    const bytes = Buffer.alloc(1200 * 1024); png.copy(bytes);
    const saved = await call("/api/house-look", { bgMode: "photo", bgPhoto: `data:image/png;base64,${bytes.toString("base64")}` });
    expect(saved.status).toBe(200);
    const { look } = await saved.json();
    const image = await call(look.bgPhoto);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
  });
  test("each invalid field, wrong signature, oversized photo and device fields leave state unchanged", async () => {
    await call("/api/house-look", { titleText: "Unchanged" });
    const large = Buffer.alloc(MAX_PHOTO_BYTES + 1); png.copy(large);
    for (const body of [null, [], { titleText: 7 }, { titleText: "x".repeat(25) }, { titleText: "a\nb" }, { titleFont: null }, ...unsafeFonts.map(titleFont => ({ titleFont })), { bgMode: "video" }, { bgMode: 0 }, { bgPhoto: 7 }, { bgPhoto: "https://example.test/a.png" }, { bgPhoto: "data:image/png;base64,PHN2Zz4=" }, { bgPhoto: `data:image/png;base64,${large.toString("base64")}` }, { bgColor: "#123456" }, { features: {} }, { bgPhotoVersion: "a".repeat(64) }]) {
      const res = await call("/api/house-look", body);
      expect(res.status).toBe(400); expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await (await call()).json()).toEqual({ look: { titleText: "Unchanged" } });
    }
  });
  test("startup script supplies house time zone without changing installer feature defaults", async () => {
    const text = await (await call("/feature-defaults.js")).text();
    expect(text).toContain("window.embervyHouseFeatures = ");
    expect(text).toContain('window.embervyHouseTimeZone = "Pacific/Auckland"');
  });
});
