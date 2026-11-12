import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstTurnItem, gatewayPlan, gatewayRoomReply, isRoomTurn, isScheduledTurn, migrateReplyGateway, pipeTurnSpeech, replyGatewayOffPath, settleTurnSpeech } from "./brain";
import { ALIASES } from "./aliases";
import { CLI_NO_OUTPUT_PROMPT, isCliNoOutputPrompt, PipeVisibleContext, TurnAccumulator } from "./claude-pipe";

function temporary(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gateway-switch-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const roomPrompt = '<channel source="app" kind="room" room="work">\nQuestion\n</channel>';
const prose = { replied: false, prose: "Answer", missing: ["Missing reply"] };

describe("live reply gateway", () => {
  test("the same process disables both paths and enables them again after removal", () => temporary((dir) => {
    const file = join(dir, "reply-gateway-off");
    const plan = () => gatewayPlan("app", prose, "Question", file);
    expect(plan()).toEqual({ forward: "⚡ Answer", owed: "⚡ Missing reply" });
    writeFileSync(file, "");
    expect(plan()).toEqual({ forward: null, owed: null });
    unlinkSync(file);
    expect(plan()).toEqual({ forward: "⚡ Answer", owed: "⚡ Missing reply" });
    expect(gatewayPlan("internal", prose, "", file)).toEqual({ forward: null, owed: null });
  }));

  test("path defaults share the house hook even with a separate Brain state directory", () => {
    expect(replyGatewayOffPath({ EMBERVY_HOME: "/house", BRAIN_STATE_DIR: "/brain/state" })).toBe("/house/state/reply-gateway-off");
    expect(replyGatewayOffPath({ BRAIN_STATE_DIR: "/house/state" })).toBe("/house/state/reply-gateway-off");
    expect(replyGatewayOffPath({ BRAIN_REPLY_GATEWAY_OFF_FILE: "/custom/off", EMBERVY_HOME: "/house" })).toBe("/custom/off");
    expect(replyGatewayOffPath({})).toEndWith("/state/reply-gateway-off");
  });

  test("legacy off creates and logs once without replacing an existing marker", () => temporary((dir) => {
    const env = { EMBERVY_HOME: dir, BRAIN_REPLY_GATEWAY: "off" };
    const file = replyGatewayOffPath(env);
    const events: unknown[] = [];
    migrateReplyGateway(env, (event) => events.push(event));
    expect(existsSync(file)).toBe(true);
    expect(events).toEqual([{ type: "reply_gateway_migrated", file }]);
    writeFileSync(file, "preserve");
    migrateReplyGateway(env, (event) => events.push(event));
    expect(readFileSync(file, "utf8")).toBe("preserve");
    expect(events.length).toBe(1);
    unlinkSync(file);
    expect(gatewayPlan("app", prose, "", file).forward).toBe("⚡ Answer");
    migrateReplyGateway(env, (event) => events.push(event));
    expect(existsSync(file)).toBe(false);
  }));

  test("only an explicit on keeps the gateway on; unset keeps the old default off", () => temporary((dir) => {
    const on = { EMBERVY_HOME: join(dir, "on"), BRAIN_REPLY_GATEWAY: "on" };
    migrateReplyGateway(on, () => {});
    expect(existsSync(replyGatewayOffPath(on))).toBe(false);
    const unset = { EMBERVY_HOME: join(dir, "unset") };
    migrateReplyGateway(unset, () => {});
    expect(existsSync(replyGatewayOffPath(unset))).toBe(true);
  }));

  test("delivered pipe room replies answer only room-origin turns", () => temporary((dir) => {
    const file = join(dir, "off");
    const result = { appReplyTexts: [], assistantText: "Terminal prose", finalContent: "Terminal prose", roomTexts: ["[Room work] Answer"] };
    const speech = pipeTurnSpeech(result, isRoomTurn(roomPrompt));
    expect(speech.replied).toBe(true);
    expect(speech.answer).toContain("[Room work] Answer");
    expect(gatewayPlan("app", speech, roomPrompt, file).forward).toBeNull();
    expect(pipeTurnSpeech(result, false).replied).toBe(false);
    expect(pipeTurnSpeech({ ...result, roomTexts: [] }, true).replied).toBe(false);
  }));

  test("API room calls answer room-origin turns across namespaces", () => temporary((dir) => {
    for (const name of ["room", "mcp__app__room"]) {
      const replied = gatewayRoomReply(isRoomTurn(roomPrompt), name);
      expect(replied).toBe(true);
      const speech = settleTurnSpeech(replied, [], [], "Terminal prose");
      expect(gatewayPlan("app", speech, roomPrompt, join(dir, "off")).forward).toBeNull();
      expect(gatewayRoomReply(false, name)).toBe(false);
    }
    expect(gatewayRoomReply(true, "roomish")).toBe(false);
  }));

  test("CLI repair user events and replay events suppress prose and retries", () => temporary((dir) => {
    for (const replay of [false, true]) {
      for (const content of [CLI_NO_OUTPUT_PROMPT, [{ type: "text", text: CLI_NO_OUTPUT_PROMPT }]]) {
        const acc = new TurnAccumulator({} as any, null, new PipeVisibleContext(), null);
        acc.observe({ type: "user", isReplay: replay, message: { content } });
        const { result } = acc.finish({ result: "Repair answer" });
        const speech = pipeTurnSpeech(result);
        expect(speech.silent).toBe(true);
        expect(gatewayPlan("app", { ...speech, missing: ["Retry"] }, "", join(dir, "off"))).toEqual({ forward: null, owed: null });
      }
    }
    expect(gatewayPlan("app", prose, CLI_NO_OUTPUT_PROMPT, join(dir, "off"))).toEqual({ forward: null, owed: null });
    expect(isCliNoOutputPrompt(`Quoted: ${CLI_NO_OUTPUT_PROMPT}`)).toBe(false);
    const fresh = new TurnAccumulator({} as any, null, new PipeVisibleContext(), null);
    expect(fresh.finish({ result: "Normal" }).result.gatewaySilent).toBe(false);
  }));
});

describe("startup reply fallback", () => {
  const greeting = { kind: "internal", source: "internal", text: "Greet the person.", replyExpected: true } as const;
  const speech = { replied: false, prose: "Hello, I am here.", missing: [] };

  test("a greeting without the reply tool forwards its prose with lightning", () => temporary((dir) => {
    expect(gatewayPlan(greeting.source, speech, greeting.text, join(dir, "off"), greeting.replyExpected))
      .toEqual({ forward: "⚡ Hello, I am here.", owed: null });
  }));

  test("a greeting marked still stays private", () => temporary((dir) => {
    expect(gatewayPlan(greeting.source, { ...speech, prose: "[still] Hello." }, greeting.text, join(dir, "off"), greeting.replyExpected))
      .toEqual({ forward: null, owed: null });
  }));

  test("greetings share the quiet-tag, empty, dot and status-only exclusions", () => temporary((dir) => {
    for (const prose of ["", " \n ", ".", " *checking*\n\n *ready* ", ...ALIASES.quietTags.map((tag) => `${tag} Hello.`)]) {
      expect(gatewayPlan(greeting.source, { ...speech, prose }, greeting.text, join(dir, "off"), greeting.replyExpected))
        .toEqual({ forward: null, owed: null });
    }
  }));

  test("a greeting delivered through the reply tool is not forwarded twice", () => temporary((dir) => {
    const replied = pipeTurnSpeech({ appReplyTexts: [speech.prose], assistantText: speech.prose, finalContent: speech.prose, roomTexts: [] });
    expect(replied.replied).toBe(true);
    expect(gatewayPlan(greeting.source, replied, greeting.text, join(dir, "off"), greeting.replyExpected))
      .toEqual({ forward: null, owed: null });
  }));

  test("a first turn carries the mark and forwards without the reply tool", () => temporary((dir) => {
    const file = join(dir, "first-turn.md");
    writeFileSync(file, "Introduce yourself.");
    const item = firstTurnItem(file, dir)!;
    expect(item).toMatchObject({ kind: "internal", source: "internal", replyExpected: true });
    expect(gatewayPlan(item.source, speech, item.text, join(dir, "off"), item.replyExpected))
      .toEqual({ forward: "⚡ Hello, I am here.", owed: null });
  }));

  test("an unmarked internal turn keeps the same prose private", () => temporary((dir) => {
    expect(gatewayPlan("internal", speech, greeting.text, join(dir, "off")))
      .toEqual({ forward: null, owed: null });
  }));

  test("scheduled prose stays private even with the startup mark", () => temporary((dir) => {
    const prompt = '<channel source="app" kind="scheduled" from="moments">A moment.</channel>';
    for (const source of ["app", "internal"]) {
      for (const replyExpected of [false, true]) {
        expect(gatewayPlan(source, speech, prompt, join(dir, "off"), replyExpected))
          .toEqual({ forward: null, owed: null });
      }
    }
  }));

  test("an unmarked terminal turn keeps its prose private", () => temporary((dir) => {
    expect(gatewayPlan("terminal", speech, "Hello", join(dir, "off")))
      .toEqual({ forward: null, owed: null });
  }));

  test("the live off file suppresses marked greetings and their owed replies", () => temporary((dir) => {
    const file = join(dir, "off");
    writeFileSync(file, "");
    expect(gatewayPlan(greeting.source, prose, greeting.text, file, greeting.replyExpected))
      .toEqual({ forward: null, owed: null });
    unlinkSync(file);
    expect(gatewayPlan(greeting.source, speech, greeting.text, file, greeting.replyExpected).forward)
      .toBe("⚡ Hello, I am here.");
  }));

  test("silent greetings suppress both prose and owed replies", () => temporary((dir) => {
    expect(gatewayPlan(greeting.source, { ...prose, silent: true }, greeting.text, join(dir, "off"), greeting.replyExpected))
      .toEqual({ forward: null, owed: null });
  }));

  test("the CLI no-output prompt stays silent even with the startup mark", () => temporary((dir) => {
    expect(gatewayPlan(greeting.source, prose, CLI_NO_OUTPUT_PROMPT, join(dir, "off"), greeting.replyExpected))
      .toEqual({ forward: null, owed: null });
  }));

  test("app turns keep the same forwarding and exclusion rules", () => temporary((dir) => {
    const file = join(dir, "off");
    expect(gatewayPlan("app", speech, "Question", file)).toEqual({ forward: "⚡ Hello, I am here.", owed: null });
    for (const prose of ["[still] Hello.", ".", "*checking*", ...ALIASES.quietTags.map((tag) => `${tag} Hello.`)]) {
      expect(gatewayPlan("app", { ...speech, prose }, "Question", file)).toEqual({ forward: null, owed: null });
    }
    expect(gatewayPlan("app", { ...speech, replied: true }, "Question", file)).toEqual({ forward: null, owed: null });
  }));

  test("a marked greeting retries an undelivered reply without duplicating delivered prose", () => temporary((dir) => {
    expect(gatewayPlan(greeting.source, { ...prose, replied: true }, greeting.text, join(dir, "off"), greeting.replyExpected))
      .toEqual({ forward: null, owed: "⚡ Missing reply" });
  }));
});

test("a scheduled prompt's prose stays with the agent; a failed reply is still owed", () => temporary((dir) => {
  const file = join(dir, "off");
  const prompt = '<channel source="app" kind="scheduled" from="moments" ts="x">[gateway:silent] A moment.</channel>';
  expect(isScheduledTurn(prompt)).toBe(true);
  expect(isScheduledTurn('<channel source="app" user="Sam" ts="x">hi</channel>')).toBe(false);
  const quiet = pipeTurnSpeech({ appReplyTexts: [], assistantText: "Just thinking.", finalContent: "Just thinking.", roomTexts: [] }, false);
  expect(gatewayPlan("app", quiet, prompt, file).forward).toBeNull();
  const normal = gatewayPlan("app", quiet, '<channel source="app" user="Sam" ts="x">hi</channel>', file);
  expect(normal.forward).not.toBeNull();
}));
