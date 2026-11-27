import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));

const browser = "https://fcm.googleapis.com/send/invented-browser-secret";
const relay = "https://relay.example.org/push/invented-relay-secret";
const subscriptions = JSON.stringify([{ endpoint: browser }, { endpoint: relay }]);
const relaySetting = "EMBERVY_PUSH_RELAY_HOSTS=relay.example.org\n";

type Options = {
  root?: string;
  app?: string;
  override?: string;
  file?: string | null;
  unreadable?: boolean;
  absent?: boolean;
  storedAt?: string;
  text?: boolean;
};

function doctor(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "doctor-push-"));
  homes.push(home);
  const appDir = join(home, "Claude/app");
  mkdirSync(join(home, "bin"));
  const expand = (value: string) => value.replaceAll("@HOME@", home);
  writeFileSync(join(home, ".env"), `RAG_AUTH_TOKEN=test-token\nDOCTOR_STATUS_FILE=${home}/status.json\n${expand(options.root || "")}`);
  if (!options.absent) {
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "server.ts"), "// Installed app marker.\n");
    if (options.app !== undefined) writeFileSync(join(appDir, ".env"), expand(options.app));
    const dataDir = resolve(appDir, expand(options.storedAt || "data"));
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, "push-subscriptions.json");
    if (options.unreadable) mkdirSync(file); // Deterministic read failure, even under root.
    else if (options.file !== null) writeFileSync(file, options.file ?? subscriptions);
  }
  if (options.override !== undefined) writeFileSync(join(home, "custom.env"), expand(options.override));
  writeFileSync(join(home, "bin/systemctl"), '#!/bin/sh\nprintf "LoadState=not-found\\nActiveState=inactive\\n"\n', { mode: 0o755 });
  const runner = join(home, "runner.ts");
  // Isolate unrelated health probes; configuration and subscription reads use real files.
  writeFileSync(runner, `globalThis.fetch = async () => { throw new Error("offline fixture"); };\nawait import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});\n`);
  const child = Bun.spawnSync([process.execPath, runner, "--offline", "--verbose", ...(options.text ? [] : ["--json"])], {
    cwd: home,
    env: { HOME: home, EMBERVY_HOME: home, PATH: join(home, "bin"),
      EMBERVY_HARNESS: "brain", EMBERVY_SUBSTRATE: "brain",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs"),
      ...(options.override !== undefined ? { APP_ENV_FILE: join(home, "custom.env") } : {}) },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.stderr.toString()).toBe("");
  const status = readFileSync(join(home, "status.json"), "utf8");
  const report = JSON.parse(options.text ? status : child.stdout.toString());
  const check = report.checks.find((c: any) => c.id === "health.push_subscriptions");
  expect(check).toBeDefined();
  const output = child.stdout.toString() + child.stderr.toString() + status;
  for (const secret of [browser, relay, "relay.example.org", "fcm.googleapis.com", "invented-browser-secret", "invented-relay-secret"]) {
    expect(output).not.toContain(secret);
  }
  return check;
}

test("warns with counts and a repair when a stored relay subscription would be skipped", () => {
  const check = doctor();
  expect(check.status).toBe("WARN");
  expect(check.detail).toBe("1 of 2 stored push subscriptions are skipped: their host is not a browser push service and not named in EMBERVY_PUSH_RELAY_HOSTS");
  expect(check.fix).toContain("EMBERVY_PUSH_RELAY_HOSTS");
  expect(check.fix).toContain("restart the app");
  expect(check.fix).toContain("remove");
});

test("accepts a relay configured only in the house .env", () => {
  const check = doctor({ root: relaySetting });
  expect(check.status).toBe("OK");
  expect(check.detail).toBe("2 stored push subscriptions; 0 skipped");
});

test("accepts a relay configured only in Claude/app/.env", () => {
  expect(doctor({ app: relaySetting }).status).toBe("OK");
});

test("app-local relay assignments override the house file, including empty values", () => {
  expect(doctor({ root: "EMBERVY_PUSH_RELAY_HOSTS=\n", app: relaySetting }).status).toBe("OK");
  expect(doctor({ root: relaySetting, app: "EMBERVY_PUSH_RELAY_HOSTS=\n" }).status).toBe("WARN");
});

test("APP_ENV_FILE replaces the default app settings file", () => {
  expect(doctor({ app: "EMBERVY_PUSH_RELAY_HOSTS=\n", override: relaySetting }).status).toBe("OK");
  expect(doctor({ app: relaySetting, override: "EMBERVY_PUSH_RELAY_HOSTS=\n" }).status).toBe("WARN");
});

test("uses the configured absolute data directory from the house file", () => {
  const check = doctor({ root: "EMBERVY_APP_DATA_DIR=@HOME@/push-data\n", storedAt: "@HOME@/push-data" });
  expect(check.status).toBe("WARN");
  expect(check.detail).toContain("1 of 2");
});

test("app-local data directory overrides the house path and resolves relative to the app", () => {
  const check = doctor({ root: "EMBERVY_APP_DATA_DIR=@HOME@/unused\n",
    app: "EMBERVY_APP_DATA_DIR=relative-data\n", storedAt: "relative-data" });
  expect(check.status).toBe("WARN");
  expect(check.detail).toContain("1 of 2");
});

test("warns on broken JSON without disclosing parser context", () => {
  const check = doctor({ file: subscriptions.slice(0, -1) });
  expect(check.status).toBe("WARN");
  expect(check.detail).toBe("Push subscription file is not valid JSON");
});

test("warns when the file is not a JSON array", () => {
  for (const file of ["null", JSON.stringify({ endpoint: relay }), "42"]) {
    const check = doctor({ file });
    expect(check.status).toBe("WARN");
    expect(check.detail).toBe("Push subscription file is not a JSON array");
  }
});

test("warns when the subscription file cannot be read", () => {
  const check = doctor({ unreadable: true });
  expect(check.status).toBe("WARN");
  expect(check.detail).toBe("Push subscription file is unreadable");
});

test("missing files and empty arrays report zero subscriptions", () => {
  for (const file of [null, "[]"]) {
    const check = doctor({ file });
    expect(check.status).toBe("OK");
    expect(check.detail).toContain("0 stored push subscriptions");
  }
});

test("browser-only subscriptions pass without relay configuration", () => {
  const check = doctor({ file: JSON.stringify([{ endpoint: browser }]) });
  expect(check.status).toBe("OK");
  expect(check.detail).toBe("1 stored push subscriptions; 0 skipped");
});

test("malformed array entries are counted as skipped just as in the app", () => {
  const check = doctor({ file: JSON.stringify([null, {}, { endpoint: 42 }, { endpoint: browser }]) });
  expect(check.status).toBe("WARN");
  expect(check.detail).toContain("3 of 4");
});

test("houses without an installed or running app skip the check", () => {
  expect(doctor({ absent: true }).status).toBe("SKIP");
});

test("text output also keeps subscription addresses and hosts private", () => {
  expect(doctor({ text: true }).status).toBe("WARN");
  expect(doctor({ text: true, app: relaySetting }).status).toBe("OK");
  expect(doctor({ text: true, file: subscriptions.slice(0, -1) }).status).toBe("WARN");
});
