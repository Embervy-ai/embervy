import { expect, test } from "bun:test";
import { doctor } from "./embervy-doctor.test";

const marker = "PRIVATE-provider-text-key-https://secret.invalid/?token=secret";
function daemonFailure(value: string) {
  return { daemon_last_ok: false, warnings: [`last daemon run failed: ${value}`, marker, `last dream attempt failed: ${marker}`] };
}
for (const status of [400, 404]) {
  test(`doctor gives model setting guidance for daemon and dream HTTP ${status}`, () => {
    for (const value of [`provider_http ${status}`, `OpenRouter ${status}: {"user_id":"${marker}","request":"${marker}"}`,
      `details withheld (recorded before 1.0.3) (HTTP ${status})`]) {
      const report = doctor(daemonFailure(value));
      expect(report.check.status).toBe("WARN");
      expect(report.check.detail).toContain("model may no longer exist at the provider");
      expect(report.check.detail).toContain("DAEMON_LLM_MODEL");
      expect(report.check.detail).toContain('shared/memory/README.md, section "Changing the night model"');
      expect(doctor(daemonFailure(value), { text: true }).stdout).not.toContain(marker);
    }
    const report = doctor({ dream_last_attempt: new Date(Date.now() - 1000).toISOString(), dream_last_result: "failed",
      dream_last_error: { class: "provider_http", status, message: marker } });
    expect(report.check.detail).toContain("model may no longer exist at the provider");
    expect(report.check.detail).toContain("DREAM_LLM_MODEL");
    expect(report.check.detail).toContain("Changing the night model");
  });
}

test("doctor timeout guidance names budget and timeout, with no remote free text", () => {
  const report = doctor(daemonFailure("provider_timeout"));
  expect(report.check.detail).toContain("DAEMON_TIMEOUT_MS");
  expect(report.check.detail).toContain("DAEMON_MAX_TOKENS");
});

for (const value of [marker, `provider_http 400 ${marker}`, `OpenRouter 4000: ${marker}`, `unexpected\n${marker}`]) {
  test(`doctor rejects unbounded stored failure: ${value.slice(0, 30)}`, () => {
    const report = doctor(daemonFailure(value));
    expect(report.check.detail).toContain("last daemon run failed: details withheld (recorded before 1.0.3)");
    expect(report.check.detail).not.toContain("DAEMON_LLM_MODEL");
    expect(doctor(daemonFailure(value), { text: true }).stdout).not.toContain(marker);
  });
}

test("doctor explains unusable model output without exposing raw_response", () => {
  const trace = { ...daemonFailure("provider_response 200"), raw_response: marker };
  const report = doctor(trace);
  expect(report.check.detail).toContain("empty or not valid JSON");
  expect(report.check.detail).toContain("thinks before answering");
  expect(report.check.detail).toContain("DAEMON_MAX_TOKENS may be too small");
  expect(report.check.detail).toContain('shared/memory/README.md, section "Changing the night model"');
  expect(doctor(trace, { text: true }).stdout).not.toContain(marker);
});

for (const [healthFailure, cause] of [
  ["http", "HTTP 401"], ["network", "unreachable"], ["timeout", "timeout"],
  ["json", "invalid response"], ["fenced", "invalid response"], ["shape", "invalid response"], ["text", "invalid response"],
] as const) {
  test(`doctor gives a fixed health failure cause: ${healthFailure}`, () => {
    const detail = `not checked — cannot read memory health: ${cause}`;
    expect(doctor({}, { healthFailure }).check).toMatchObject({ status: "WARN", detail });
    expect(doctor({}, { healthFailure, text: true }).stdout).toContain(detail);
  });
}

test("doctor reports a failed dream newer than a recent successful note", () => {
  const report = doctor({ dream_last_run: new Date(Date.now() - 60000).toISOString(),
    dream_last_attempt: new Date(Date.now() - 1000).toISOString(), dream_last_result: "failed",
    dream_last_error: { class: "provider_http", status: 404 } });
  expect(report.check.status).toBe("WARN");
  expect(report.check.detail).toContain("DREAM_LLM_MODEL");
});
