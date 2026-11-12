import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WebSocket liveness after an app switch on iOS. Coming back from another
// app, the header kept showing "Live" while the connection was dead, and the
// client never reconnected: iOS keeps reporting a socket it cut in the
// background as OPEN, and a close() on it often produces no close event.
// This test slices the real connection code and the foreground listeners out
// of public/app.js (markers, as in app-fields.test.ts) and drives them
// against a fake WebSocket and a fake clock. A "dead" socket here is one that
// stays OPEN, delivers nothing and sends no close event after close().
//
// Run against another version of the file:
//   WS_APP_JS=path/to/app.js bun test ws-liveness

const SOURCE = readFileSync(process.env.WS_APP_JS ?? join(import.meta.dir, "public", "app.js"), "utf8");
const EN = JSON.parse(readFileSync(join(import.meta.dir, "strings", "en.json"), "utf8")) as Record<string, string>;

function slice(start: string, end: string): string {
  const a = SOURCE.indexOf(start);
  const b = a < 0 ? -1 : SOURCE.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`marker not found in app.js: ${a < 0 ? start : end}`);
  return SOURCE.slice(a, b);
}

const WS_PART = slice("  let wsHeartbeat = null;", "  async function loadHistory() {");
const LIFECYCLE_PART = slice("  document.addEventListener(\"visibilitychange\", () => {\n    if (document.visibilityState === \"visible\") {\n      checkStringsVersion();", "  async function catchUpMessages() {");

type Timer = { at: number; fn: () => void; every?: number };

class Clock {
  now = 1_000_000;
  private seq = 0;
  private timers = new Map<number, Timer>();
  setTimeout = (fn: () => void, ms = 0) => { const id = ++this.seq; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = (id: number | null) => { if (id != null) this.timers.delete(id); };
  setInterval = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { at: this.now + ms, fn, every: ms }); return id; };
  clearInterval = (id: number | null) => { if (id != null) this.timers.delete(id); };
  /** Time passes and timers fire (app in the foreground). Overdue timers fire once, right away. */
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let next: [number, Timer] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, t] = next;
      this.now = Math.max(this.now, t.at);
      if (t.every) t.at = this.now + t.every; else this.timers.delete(id);
      t.fn();
    }
    this.now = end;
  }
  /** Time passes and nothing fires (iOS froze the app). */
  freeze(ms: number) { this.now += ms; }
}

function harness(opts: { terminalOpen?: boolean; random?: () => number } = {}) {
  const clock = new Clock();
  const sockets: FakeWs[] = [];
  const created: number[] = [];
  class FakeWs {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    sent: any[] = [];
    closeCalls = 0;
    onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
    constructor(public url: string) { sockets.push(this); created.push(clock.now); }
    send(data: string) {
      if (this.readyState === 0) throw new Error("InvalidStateError");
      if (this.readyState === 1) this.sent.push(JSON.parse(data));
    }
    // Dead socket: close() never reaches the server and no close event follows.
    close() { this.closeCalls++; if (this.readyState < 2) this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    deliver(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
    fireClose() { this.readyState = 3; this.onclose?.(); }
    pings() { return this.sent.filter((m) => m.type === "ping").length; }
  }

  const statusClasses = new Set<string>();
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const on = (type: string, fn: (e: any) => void) => { (listeners[type] ??= []).push(fn); };
  const document = {
    visibilityState: "visible",
    getElementById: (id: string) => id === "status"
      ? { classList: { add: (c: string) => statusClasses.add(c), remove: (c: string) => statusClasses.delete(c) } }
      : null,
    addEventListener: on,
  };
  const window = { addEventListener: on };
  const calls = { catchUp: 0, subscribe: 0, strings: 0, inputVisible: [] as boolean[] };
  const terminalFreshness = { textContent: EN["terminal.live"] };
  const noop = () => {};
  const math = Object.create(Math) as Math;
  if (opts.random) math.random = opts.random;
  const env = {
    terminalOpen: opts.terminalOpen ?? false,
    terminalFreshness,
    t: (key: string) => {
      if (!(key in EN)) throw new Error(`unknown string key: ${key}`);
      return EN[key];
    },
    fns: {
      catchUpMessages: () => { calls.catchUp++; },
      checkStringsVersion: () => { calls.strings++; },
      syncModel: noop,
      terminalPanelEnabled: () => true,
      sendTerminalSubscription: (on: boolean) => { if (on) calls.subscribe++; },
      renderTerminalInputVisibility: (v: boolean) => { calls.inputVisible.push(v); },
      settleTerminalInput: noop,
      startPing: noop,
      startBackgroundPing: noop,
      showTyping: noop,
      addMessage: noop,
      setDoctorBadge: noop,
      renderTerminalFrame: noop,
      closeTerminal: noop,
      addReactionToMessage: noop,
    },
  };

  // Everything the sliced code reads from the rest of app.js is declared here;
  // what the slices declare themselves (reconnectAttempt, timers, ...) is not.
  const body = `"use strict";
    let ws = null, reconnectTimer = null;
    let terminalOpen = env.terminalOpen, terminalSubscribed = false, terminalInputRequest = null;
    const terminalFreshness = env.terminalFreshness, t = env.t;
    const { catchUpMessages, checkStringsVersion, syncModel, terminalPanelEnabled, sendTerminalSubscription,
      renderTerminalInputVisibility, settleTerminalInput, startPing, startBackgroundPing, showTyping,
      addMessage, setDoctorBadge, renderTerminalFrame, closeTerminal, addReactionToMessage } = env.fns;
    ${WS_PART}
    ${LIFECYCLE_PART}
    return { connectWs, current: () => ws };`;
  const app = new Function(
    "env", "WebSocket", "location", "document", "window",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "Math", "console",
    body,
  )(
    env, FakeWs, { protocol: "https:", host: "app.test" }, document, window,
    clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval,
    { now: () => clock.now }, math, { log: noop, warn: noop },
  ) as { connectWs: () => void; current: () => FakeWs | null };

  const fire = (type: string, e: any = {}) => { for (const fn of listeners[type] ?? []) fn(e); };
  const live = () => !statusClasses.has("disconnected");
  /** Connect and let the server answer. */
  const connect = () => { app.connectWs(); const s = sockets.at(-1)!; s.open(); return s; };
  /** App goes away (frozen), time passes, app comes back. */
  const backgroundFor = (ms: number) => {
    document.visibilityState = "hidden"; fire("visibilitychange");
    clock.freeze(ms);
    document.visibilityState = "visible"; fire("visibilitychange");
  };
  return { app, clock, sockets, created, fire, live, connect, backgroundFor, calls, terminalFreshness };
}

describe("WebSocket liveness after an app switch", () => {
  test("a silent connection that still reports OPEN is detected on return and replaced at once", () => {
    const h = harness({ terminalOpen: true });
    const first = h.connect();
    h.backgroundFor(9 * 60_000);
    // The return asks the server instead of trusting readyState.
    expect(first.pings()).toBeGreaterThan(0);
    h.clock.advance(4_500); // no answer within the probe window
    expect(h.sockets.length).toBe(2);
    expect(h.app.current()).toBe(h.sockets[1]);
    expect(first.onclose).toBeNull();
    // Honest until the new connection is up.
    expect(h.live()).toBe(false);
    expect(h.terminalFreshness.textContent).toBe(EN["terminal.connecting"]);
    // New connection up: catch-up and terminal resubscribe through the existing paths.
    const catchUpBefore = h.calls.catchUp;
    const subBefore = h.calls.subscribe;
    h.sockets[1].open();
    expect(h.live()).toBe(true);
    expect(h.calls.catchUp).toBeGreaterThan(catchUpBefore);
    expect(h.calls.subscribe).toBe(subBefore + 1);
  });

  test("if the server answers the probe, the connection stays", () => {
    const h = harness();
    const first = h.connect();
    h.backgroundFor(5 * 60_000);
    h.clock.advance(300);
    first.deliver({ type: "pong" });
    h.clock.advance(10_000);
    expect(h.sockets.length).toBe(1);
    expect(h.app.current()).toBe(first);
    expect(h.live()).toBe(true);
  });

  test("a heartbeat timeout replaces the connection even if the close event never comes", () => {
    const h = harness({ terminalOpen: true });
    const first = h.connect();
    // The server goes quiet in the foreground (socket stays OPEN, close() does nothing).
    h.clock.advance(15_000);
    expect(h.live()).toBe(false);
    expect(h.terminalFreshness.textContent).toBe(EN["terminal.connecting"]);
    h.clock.advance(3_100); // backoff step 0: at most 3 s
    expect(h.sockets.length).toBe(2);
    expect(first.onclose).toBeNull();
  });

  test("a late close from the replaced connection does not touch the new one", () => {
    const h = harness({ terminalOpen: true });
    const first = h.connect();
    h.fire("online"); // network change: forced reconnect
    const second = h.sockets[1];
    expect(second).toBeDefined();
    second.open();
    const pingsBefore = second.pings();
    // Now the old one finally reports in.
    first.fireClose();
    first.onerror?.();
    expect(h.live()).toBe(true);
    expect(h.app.current()).toBe(second);
    expect(second.closeCalls).toBe(0);
    // The new connection's heartbeat keeps running.
    second.deliver({ type: "pong" });
    h.clock.advance(5_100);
    expect(second.pings()).toBeGreaterThan(pingsBefore);
  });

  test("a hanging handshake is given up after the timeout and retried with backoff", () => {
    const h = harness();
    h.app.connectWs(); // no open, no close
    h.clock.advance(10_100);
    expect(h.live()).toBe(false);
    h.clock.advance(3_100);
    expect(h.sockets.length).toBe(2);
  });

  test("returning without an open connection reconnects at once, without waiting for the backoff", () => {
    const h = harness();
    const first = h.connect();
    first.fireClose(); // clean close: backoff timer running
    h.backgroundFor(0);
    expect(h.sockets.length).toBe(2);
  });

  test("pageshow from the back-forward cache checks the connection like a return", () => {
    const h = harness();
    h.connect();
    h.clock.freeze(60_000);
    h.fire("pageshow", { persisted: true });
    h.clock.advance(4_500);
    expect(h.sockets.length).toBe(2);
  });

  test("a resume event checks the connection like a return", () => {
    const h = harness();
    h.connect();
    h.clock.freeze(60_000);
    h.fire("resume");
    h.clock.advance(4_500);
    expect(h.sockets.length).toBe(2);
  });

  test("every return asks whether the texts changed while the page slept", () => {
    const h = harness();
    h.connect();
    h.backgroundFor(1_000);
    h.fire("pageshow", { persisted: true });
    h.fire("resume");
    expect(h.calls.strings).toBe(3);
  });

  /** Close the newest socket now and return how long it takes until the next one is created. */
  function gapAfterClose(h: ReturnType<typeof harness>): number {
    const before = h.sockets.length;
    const closedAt = h.clock.now;
    h.sockets.at(-1)!.fireClose(); // refused or dropped right away
    // Small steps, so the new socket's own connect timeout cannot fire first.
    for (let waited = 0; h.sockets.length === before && waited < 40_000; waited += 100) h.clock.advance(100);
    expect(h.sockets.length).toBe(before + 1);
    return h.created.at(-1)! - closedAt;
  }

  test("reconnects back off (2 s x 1.5^n, capped at 30 s) and reset once a connection opens", () => {
    const h = harness({ random: () => 0 }); // no jitter: exact delays
    h.connect();
    const gaps: number[] = [];
    for (let i = 0; i < 9; i++) gaps.push(gapAfterClose(h));
    expect(gaps).toEqual([2000, 3000, 4500, 6750, 10125, 15187.5, 22781.25, 30000, 30000]);
    // An open connection resets the ladder.
    h.sockets.at(-1)!.open();
    expect(gapAfterClose(h)).toBe(2000);
  });

  test("jitter stays below one second on top of the backoff", () => {
    const h = harness({ random: () => 0.999 });
    h.connect();
    const gap = gapAfterClose(h);
    expect(gap).toBeGreaterThanOrEqual(2000);
    expect(gap).toBeLessThan(3000);
  });
});
