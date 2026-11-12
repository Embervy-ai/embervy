import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(`${import.meta.dir}/public/app.js`, "utf8");
function harness(platform = "Win32", touches = 0, shareError = "", status = 200, downloadError = false) {
  const shared: File[] = [], downloaded: any[] = [], notices: string[] = [];
  const navigator = { platform, maxTouchPoints: touches, canShare: () => true, share: async ({ files }: any) => {
    if (shareError) throw Object.assign(new Error("share failed"), { name: shareError });
    shared.push(...files);
  } };
  const document = { createElement: () => ({ click() { if (downloadError) throw new Error("download failed"); downloaded.push(this); }, remove() {} }), body: { appendChild() {} } };
  const window = { alert: (text: string) => notices.push(text) };
  const URL = { createObjectURL: () => "blob:file", revokeObjectURL() {} };
  const fetch = async () => { if (status === 0) throw new Error("offline"); return new Response("bytes", { status }); };
  const t = (key: string) => key;
  const files = source.slice(source.indexOf("  const FILE_TYPES = {"), source.indexOf('  messagesEl.addEventListener("click"', source.indexOf("  const FILE_TYPES = {")));
  const image = source.slice(source.indexOf("  async function downloadImage("), source.indexOf("  function openLightbox("));
  const api = new Function("navigator", "document", "window", "URL", "fetch", "t", "setTimeout", `${files}\n${image}\nreturn { shareFile, downloadImage };`)(navigator, document, window, URL, fetch, t, () => {});
  const editor = { innerText: "note", innerHTML: "note" };
  let stored: string | null = "note";
  const notes = source.slice(source.indexOf("    async function doSave()"), source.indexOf('    saveBtn.addEventListener("click", doSave)'));
  const doSave = new Function("navigator", "document", "window", "URL", "t", "editor", "localStorage", "autosave", "flashSaved", "setTimeout", `let saveTimer; const STORAGE_KEY = 'notes'; ${notes}; return doSave;`)(navigator, document, window, URL, t, editor, { removeItem() { stored = null; } }, () => { stored = editor.innerHTML; }, () => {}, () => {});
  return { ...api, doSave, shared, downloaded, notices, editor, stored: () => stored };
}

for (const platform of ["Win32", "MacIntel", "Linux x86_64"]) {
  for (const kind of ["txt", "md", "image", "note"]) test(`${platform} downloads ${kind} even when sharing is available`, async () => {
    const h = harness(platform);
    if (kind === "note") await h.doSave();
    else if (kind === "image") await h.downloadImage("/api/images/photo.png");
    else await h.shareFile(`/api/images/file.${kind}`, `file.${kind}`);
    expect(h.shared).toEqual([]);
    expect(h.downloaded).toHaveLength(1);
    expect(h.notices).toEqual([]);
    if (kind === "note") expect(h.stored()).toBe("note");
  });
}
for (const [platform, touches] of [["iPhone", 0], ["iPad", 0], ["MacIntel", 5]] as const) {
  for (const kind of ["file", "image", "note"]) test(`${platform} with ${touches} touch points shares ${kind}`, async () => {
    const h = harness(platform, touches);
    if (kind === "note") await h.doSave();
    else if (kind === "image") await h.downloadImage("/api/images/photo.png");
    else await h.shareFile("/api/images/file.md", "file.md");
    expect(h.shared).toHaveLength(1);
    expect(h.downloaded).toEqual([]);
    if (kind === "note") expect(h.stored()).toBe(null);
  });
}
for (const kind of ["file", "image", "note"]) {
  for (const error of ["AbortError", "NotAllowedError"]) test(`${kind} ${error} ${error === "AbortError" ? "keeps the draft without a download" : "falls back to download"}`, async () => {
    const h = harness("iPhone", 0, error);
    if (kind === "note") await h.doSave();
    else if (kind === "image") await h.downloadImage("/api/images/photo.png");
    else await h.shareFile("/api/images/file.txt", "file.txt");
    expect(h.downloaded).toHaveLength(error === "AbortError" ? 0 : 1);
    expect(h.notices).toEqual([]);
    if (kind === "note") expect(h.stored()).toBe("note");
  });
  test(`${kind} download failure is visible`, async () => {
    const h = harness("Win32", 0, "", 200, true);
    if (kind === "note") await h.doSave();
    else if (kind === "image") await h.downloadImage("/api/images/photo.png");
    else await h.shareFile("/api/images/file.txt", "file.txt");
    expect(h.notices).toEqual(["files.saveFailed"]);
    if (kind === "note") expect(h.stored()).toBe("note");
  });
}
for (const status of [0, 401, 404, 503]) for (const kind of ["file", "image"]) test(`${kind} fetch failure ${status} never saves an error page`, async () => {
  const h = harness("Win32", 0, "", status);
  if (kind === "image") await h.downloadImage("/api/images/photo.png");
  else await h.shareFile("/api/images/file.txt", "file.txt");
  expect(h.downloaded).toEqual([]);
  expect(h.shared).toEqual([]);
  expect(h.notices).toEqual(["files.saveFailed"]);
});
