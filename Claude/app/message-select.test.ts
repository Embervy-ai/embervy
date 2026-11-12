import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// These tests check message selection and the app's picker.
// Native iOS text selection would cover the picker with its own menu.

const css = readFileSync(join(import.meta.dir, "public", "style.css"), "utf8");
const app = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");

test("fine primary pointers allow native selection after the base message rule", () => {
  const media = css.match(/@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{\s*\.message\s*\{([^}]*)\}\s*\}/);
  expect(media).not.toBeNull();
  expect(media!.index!).toBeGreaterThan(css.indexOf("\n.message {"));
  expect(media![1]).toMatch(/-webkit-user-select:\s*text/);
  expect(media![1]).toMatch(/(^|[^-])user-select:\s*text/);
});

for (const [builder, next] of [["addMessage", "addVoiceMessage"], ["addVoiceMessage", "formatDuration"]]) {
  test(`${builder} opens the existing picker on right click and retains long press`, () => {
    const body = app.slice(app.indexOf(`  function ${builder}(`), app.indexOf(`  function ${next}(`));
    expect(body).toMatch(/div\.addEventListener\("contextmenu",\s*\(e\)\s*=>\s*\{\s*e\.preventDefault\(\);\s*showEmojiPicker\(div, msgId\);\s*\}\)/);
    expect(body).toMatch(/addEventListener\("touchstart"[\s\S]*?setTimeout\(\(\) => showEmojiPicker\(div, msgId\), 500\)/);
    expect(body).toContain('addEventListener("touchend", () => clearTimeout(pressTimer))');
    expect(body).toContain('addEventListener("touchmove", () => clearTimeout(pressTimer))');
  });
}
const rule = (selector: RegExp) => css.match(selector)?.[1] ?? "";

test("messages keep the phone's text selection and callout off", () => {
  const message = rule(/\n\.message\s*\{([^}]*)\}/);
  expect(message).toMatch(/-webkit-touch-callout:\s*none/);
  expect(message).toMatch(/-webkit-user-select:\s*none/);
  expect(message).toMatch(/(^|[^-])user-select:\s*none/);
});

test("the one message chosen with Aa becomes selectable again", () => {
  const selectable = rule(/\.message\.selectable\s*\{([^}]*)\}/);
  expect(selectable).toMatch(/-webkit-touch-callout:\s*default/);
  expect(selectable).toMatch(/-webkit-user-select:\s*text/);
  expect(selectable).toMatch(/(^|[^-])user-select:\s*text/);
});
