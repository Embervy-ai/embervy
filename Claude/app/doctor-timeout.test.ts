import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  if (doctorBtn) {", source.indexOf("  loadDoctorStatus();")), source.indexOf("  function renderDoctorReport(data)"));

for (const timeout of [true, false]) {
  test(`doctor click ${timeout ? "times out" : "finishes"} and releases the button`, async () => {
    let click: () => Promise<void>;
    let timer: () => void;
    let cleared = false;
    let signal: AbortSignal;
    const classes = new Set<string>();
    const button = { disabled: false, classList: { add: (s: string) => classes.add(s), remove: (s: string) => classes.delete(s) },
      addEventListener: (_: string, fn: () => Promise<void>) => { click = fn; } };
    const reports: any[] = [];
    const badges: any[] = [];
    const fetch = (_: string, options: any) => {
      signal = options.signal;
      if (!timeout) return Promise.resolve({ json: async () => ({ report: { summary: { pass: 1 } } }) });
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    new Function("doctorBtn", "fetch", "AbortController", "setTimeout", "clearTimeout", "renderDoctorReport", "setDoctorBadge", handler)(
      button, fetch, AbortController, (fn: () => void, ms: number) => { expect(ms).toBe(60_000); timer = fn; return 1; },
      () => { cleared = true; }, (data: any) => reports.push(data), (...args: any[]) => badges.push(args));
    const done = click!();
    expect(button.disabled).toBe(true);
    if (timeout) timer!();
    await done;
    expect(button.disabled).toBe(false);
    expect(classes.has("running")).toBe(false);
    expect(cleared).toBe(true);
    expect(signal!.aborted).toBe(timeout);
    if (timeout) { expect(reports).toEqual([{ timeout: true }]); expect(badges).toEqual([]); }
    else expect(reports[0].report.summary.pass).toBe(1);
  });
}
