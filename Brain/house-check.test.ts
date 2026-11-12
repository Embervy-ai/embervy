import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { houseCheckBlock, houseCheckMessage, runStartupDoctor } from "./house-check";

const root = mkdtempSync("/tmp/brain-house-check-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const finding = { id: "memory", label: "Memory is unavailable", detail: "The agent cannot recall earlier conversations.", fix: "Restore the memory service at /opt/house/memory." };

test("doctor collects only warnings and failures and preserves repair steps", async () => {
  const file = join(root, "doctor.json");
  writeFileSync(file, JSON.stringify({ result: "FAIL", summary: { ok: 2, warn: 0, fail: 1, skip: 1 }, checks: [
    { id: "env", group: "Configuration", label: "House env readable", status: "OK", detail: "found" },
    { id: "hear", group: "Ears", label: "Hearing service answers", status: "SKIP", detail: "EMBERVY_HEAR_URL not set" },
    { id: "identity", group: "Identity", label: "Identity file present", status: "OK", detail: "present" },
    { status: "FAIL", group: "Memory", ...finding },
  ] }));
  expect(await runStartupDoctor(`cat '${file}'`)).toEqual([finding]);
});
test("a healthy house reports nothing", async () => {
  expect(await runStartupDoctor(`printf '%s' '{"result":"PASS","checks":[{"id":"env","label":"House env readable","status":"OK","detail":"found"},{"id":"hear","label":"Hearing","status":"SKIP","detail":"off"}]}'`)).toEqual([]);
});
test("a warning without its own fix still reaches the agent with a way forward", async () => {
  const [warning] = await runStartupDoctor(`printf '%s' '{"checks":[{"id":"dream","label":"Nightly dream","status":"WARN","detail":"the nightly run has not happened yet"}]}'`);
  expect(warning).toEqual({ id: "dream", label: "Nightly dream", detail: "the nightly run has not happened yet", fix: "Run the house doctor in a terminal and follow its advice." });
});
test("an unknown status is not read as a pass", async () => {
  expect((await runStartupDoctor(`printf '%s' '{"checks":[{"id":"env","status":"PASS"}]}'`))[0].id).toBe("startup-doctor");
});
test("hanging doctor and its child are cut off", async () => {
  const began = Date.now();
  const findings = await runStartupDoctor("sleep 60 & wait", 60);
  expect(Date.now() - began).toBeLessThan(2000);
  expect(findings[0].id).toBe("startup-doctor");
  expect(findings[0].detail).toContain("longer than 30 seconds");
});
test("unreadable output is not a pass", async () => {
  expect((await runStartupDoctor("printf broken"))[0].fix).toContain("BRAIN_DOCTOR_CMD");
});
test("repair goes to the agent; plain consequences go to the person", () => {
  expect(houseCheckBlock([finding])).toBe("[house check]\n- Memory is unavailable: The agent cannot recall earlier conversations. Fix: Restore the memory service at /opt/house/memory.");
  expect(houseCheckMessage([finding])).toBe("The house check found a problem.\n- Memory is unavailable: The agent cannot recall earlier conversations.\nThe agent has the repair steps.");
});
