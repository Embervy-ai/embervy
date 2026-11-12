import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function menuCommands(confirm = true) {
  const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
  const start = source.indexOf("  async function bmSend(body)");
  const end = source.indexOf("  function openBrainMenu()", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const requests: Array<{ path: string; init: RequestInit; resolve: (response: Response) => void }> = [];
  const messages: unknown[][] = [];
  let closes = 0;
  const controls = new Function("fetch", "addMessage", "window", "closeBrainMenu", `
    let brainMenuBusy = false;
    let brainMenuMsg = null;
    let brainMenuData = { current: {} };
    let bmSel = { effort: "high" };
    const t = key => key;
    const bmDepthText = () => "40 turns";
    const renderBrainMenu = () => {};
    const bmResetSelection = () => {};
    const bmReloadSoon = () => {};
    ${source.slice(start, end)}
    return { bmRestart, bmPickModel, bmSetEffort, busy: () => brainMenuBusy, message: () => brainMenuMsg };
  `)(
    (path: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ path, init, resolve })),
    (...args: unknown[]) => messages.push(args),
    { confirm: () => confirm },
    () => { closes++; },
  );
  return { controls, requests, messages, closes: () => closes };
}

describe("Brain menu commands without user bubbles", () => {
  test("restart posts once while pending and never adds a user message from the command response", async () => {
    const ui = menuCommands();
    const pending = ui.controls.bmRestart();
    expect(ui.controls.busy()).toBe(true);
    await ui.controls.bmRestart();
    expect(ui.requests).toHaveLength(1);
    const request = ui.requests[0]!;
    expect(request.path).toBe("/api/brain/command");
    expect(request.init).toMatchObject({ method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(request.init.body as string)).toEqual({ action: "restart" });
    expect(ui.messages).toEqual([]);
    request.resolve(Response.json({ ok: true, id: "restart-command", command: "/respawn", ts: "2026-01-01T00:00:00Z" }));
    await pending;
    expect(ui.messages).toEqual([]);
    expect(ui.controls.busy()).toBe(false);
    expect(ui.closes()).toBe(1);
  });

  test.each([
    ["head", { action: "switch", head: "gpt", model: "gpt-model", move: true, effort: "high" }, "/move gpt gpt-model effort=high"],
    ["model", { action: "switch", head: "gpt", model: "gpt-model", move: false }, "/head gpt gpt-model"],
    ["effort", { action: "effort", level: "low" }, "/effort low"],
    ["default effort", { action: "effort", level: "default" }, "/effort default"],
  ])("%s changes post one command without a user bubble", async (kind, body, command) => {
    const ui = menuCommands();
    const pending = body.action === "effort"
      ? ui.controls.bmSetEffort(body.level)
      : ui.controls.bmPickModel({ name: "gpt", label: "ChatGPT" }, { id: "gpt-model", version: "Model", kind: kind === "head" ? "head" : "model" });
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0]!.path).toBe("/api/brain/command");
    expect(JSON.parse(ui.requests[0]!.init.body as string)).toEqual(body);
    ui.requests[0]!.resolve(Response.json({ ok: true, command, id: "menu-command" }));
    await pending;
    expect(ui.messages).toEqual([]);
    expect(ui.controls.message().error).toBeUndefined();
    expect(ui.controls.busy()).toBe(false);
  });

  test("cancelled restart sends nothing", async () => {
    const ui = menuCommands(false);
    await ui.controls.bmRestart();
    expect(ui.requests).toEqual([]);
    expect(ui.messages).toEqual([]);
    expect(ui.closes()).toBe(0);
  });

  test("failed restart keeps the error in the menu and does not retry or add a bubble", async () => {
    const ui = menuCommands();
    const pending = ui.controls.bmRestart();
    ui.requests[0]!.resolve(Response.json({ error: "Not sent" }, { status: 500 }));
    await pending;
    expect(ui.requests).toHaveLength(1);
    expect(ui.messages).toEqual([]);
    expect(ui.controls.message()).toMatchObject({ error: true });
    expect(ui.controls.busy()).toBe(false);
    expect(ui.closes()).toBe(0);
  });

  test("Claude Code cut acknowledgement still closes the menu without a local chat echo", async () => {
    const ui = menuCommands();
    const pending = ui.controls.bmRestart();
    ui.requests[0]!.resolve(Response.json({ ok: true, mode: "respawn", message: "Cut requested." }, { status: 202 }));
    await pending;
    expect(ui.requests).toHaveLength(1);
    expect(ui.messages).toEqual([]);
    expect(ui.closes()).toBe(1);
  });
});
