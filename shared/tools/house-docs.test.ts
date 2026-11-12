import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocumentClaims, collectFacts, compareFacts, factsRecord, handbookVars, HANDBOOK_TEMPLATE_TEXT, renderHandbook, renderInfrastructure, renderCapabilities, rescueLinePresent } from "./house-docs";

import * as houseDocs from "./house-docs";

test("forwarding scripts can change without losing settings source inference", () => {
  const home = loopFixture("--setting-sources project,local");
  for (const script of ["loop-wrapper.sh", "start-claude-loop.sh"]) {
    writeFileSync(join(home, "Claude/scripts", script), '#!/bin/bash\nexec next "$@"\n');
  }
  expect(run(home).stdout.toString()).toContain("The configured loop passes `--setting-sources project,local`");
});

test("either script mentioning settings sources requires verification", () => {
  for (const script of ["loop-wrapper.sh", "start-claude-loop.sh"]) {
    const home = loopFixture("--setting-sources project,local");
    writeFileSync(join(home, "Claude/scripts", script), '#!/bin/bash\nexec next --setting-sources user "$@"\n');
    const text = run(home).stdout.toString();
    expect(text).toContain("Check the loop service's ExecStart");
    expect(text).not.toContain("The configured loop passes");
  }
});

const temp = mkdtempSync(join(tmpdir(), "house-docs-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const cli = join(import.meta.dir, "house-docs.ts");

test("inlet instructions use the current session and guard the diagnostic log", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const inlet = guide.split("## 6b. Brain\n")[1].split("### Inlet\n")[1].split("### Memory and chronicle")[0];
  expect(inlet.includes('session_id=$(jq -r .session_id')).toBe(true);
  expect(inlet.includes('"$EMBERVY_HOME/Brain/logs/session-$session_id.jsonl"')).toBe(true);
  expect(inlet.includes('if test -f "$EMBERVY_HOME/Brain/logs/inlet-worker.log"; then\n  tail -n 30')).toBe(true);
  expect(inlet.includes("A missing worker log only means the worker wrote nothing to stderr.")).toBe(true);
});
test("inlet instructions distinguish deduplication from fresh injection", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  expect(guide.includes('inlet_(injected|worker_empty|worker_failed|dedupe_suppressed)')).toBe(true);
  expect(guide.includes("That event is a healthy non-injection, never proof of a fresh injection.")).toBe(true);
  expect(guide.match(/genuinely different archived\s+fact/g)?.length).toBe(2);
  expect(guide.includes("Never lower thresholds or clear caches to force a fresh\nautomatic injection.")).toBe(true);
});

test("restart instructions correlate recovery with the previous session", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const loop = guide.split("## 6b. Brain\n")[1].split("### Loop service\n")[1].split("### Cut and watchdog")[0];
  expect(loop.includes("The long stop timeout leaves room for archival")).toBe(false);
  expect(loop.includes("signals the whole control\ngroup")).toBe(true);
  expect(loop.indexOf("old_session_id=$(jq")).toBeLessThan(loop.indexOf("systemctl restart embervy-brain &&"));
  expect(loop.includes('.type == "catch_up_archived" and .session == $old and .uploaded == true')).toBe(true);
  expect(loop.includes("use the `upload_retry` receipt described in Memory")).toBe(true);
  expect(loop.includes('"$EMBERVY_HOME/Brain/logs/session-$session_id.jsonl"')).toBe(true);
  expect(guide.includes("set `old_session_id` in this new\nshell to the ID saved before reboot")).toBe(true);
});

test("cut and memory instructions locate decimal recovery receipts", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8").split("## 6b. Brain\n")[1];
  const sections = [
    guide.split("### Cut and watchdog\n")[1].split("### App channel")[0],
    guide.split("### Memory and chronicle\n")[1].split("### First start")[0],
  ];
  for (const section of sections) {
    expect(section.includes("Session_1.1.md")).toBe(true);
    expect(section.includes("Session_1.2.md")).toBe(true);
    expect(section.includes("`catch_up_archived`")).toBe(true);
    expect(/new\s+session's/.test(section)).toBe(true);
    expect(section.includes("`upload_pending` alone is neither success nor failure")).toBe(true);
  }
});

function fixture(harness = "brain") {
  const home = mkdtempSync(join(temp, "house-"));
  mkdirSync(join(home, "Claude/app"), { recursive: true });
  mkdirSync(join(home, "Brain"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\nEMBERVY_APP_PORT=4130\nEMBERVY_URL=https://user:URL_SECRET@memory.example/path?token=QUERY_SECRET#FRAGMENT_SECRET\nRAG_URL=https://rag.example\nEMBERVY_API_KEY=MEMORY_SECRET\nRAG_AUTH_TOKEN=RAG_SECRET\nOPENROUTER_API_KEY=ROUTER_SECRET\nCALENDAR_ICS_URLS=https://private.example/ICS_SECRET\nUSER_LABEL=Sam\nEMBERVY_APP_SERVICE=own-app.service\nEMBERVY_LOOP_SERVICE=own-loop\nWATCHDOG_WARN_TOKENS=700000\nWATCHDOG_CUT_TOKENS=850000\n`);
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_APP_PORT=4230\nINTERNAL_API_TOKEN=APP_SECRET\nAPP_PASSWORD=PASSWORD_SECRET\nAPP_SESSION_SECRET=SESSION_SECRET\n");
  writeFileSync(join(home, "Brain/brain.env"), `BRAIN_HEAD=gpt\nBRAIN_GPT_MODEL=gpt-test\nGPT_ADAPTER_PORT=4242\nBRAIN_CONTROL_PORT=4290\nBRAIN_TMUX_SOCKET=own-brain\nBRAIN_GPT_WATCHDOG_WARN=210000\nBRAIN_GPT_WATCHDOG_CUT=230000\nBRAIN_HEADER_ENRICH_CMD=${home}/Claude/scripts/enrich-header.sh\nBRAIN_CONTROL_TOKEN=CONTROL_SECRET\nBRAIN_API_KEY=MODEL_SECRET\n`);
  writeFileSync(join(home, "bin/systemctl"), `#!/bin/bash
printf '%s\\n' "$@" >> "${home}/unit-queries"
printf 'ActiveState=active\\nUnitFileState=enabled\\n'
`, { mode: 0o755 });
  return home;
}
function run(home: string, ...flags: string[]) {
  return Bun.spawnSync([process.execPath, cli, "--home", home, ...flags], {
    cwd: home, env: { PATH: `${home}/bin:${process.env.PATH}`, HOME: join(temp, "unrelated-home"),
      // Bun's large-file transpiler cache otherwise creates HOME before the CLI runs.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      EMBERVY_HOME: "/another-house", EMBERVY_API_KEY: "INHERITED_SECRET", EMBERVY_APP_PORT: "9999" },
    stdout: "pipe", stderr: "pipe",
  });
}

for (const harness of ["brain", "claude-code"]) test(`renders both documents for ${harness}, with no markers or credentials`, () => {
  const home = fixture(harness);
  const result = run(home);
  expect(result.exitCode).toBe(0);
  const text = result.stdout.toString();
  expect(text).not.toContain("{{");
  expect(text).not.toContain("<!--");
  expect(text).toContain(harness === "brain" ? "You run inside Brain" : "You run inside Claude Code");
  expect(text).not.toContain(harness === "brain" ? "You run inside Claude Code" : "You run inside Brain");
  expect(text).toContain("4230");
  expect(text).toContain("https://memory.example");
  expect(text).toContain(harness === "brain" ? "230,000" : "850,000");
  for (const secret of ["URL_SECRET", "QUERY_SECRET", "FRAGMENT_SECRET", "MEMORY_SECRET", "RAG_SECRET", "ROUTER_SECRET", "ICS_SECRET", "APP_SECRET", "PASSWORD_SECRET", "SESSION_SECRET", "CONTROL_SECRET", "MODEL_SECRET", "INHERITED_SECRET"]) expect(text).not.toContain(secret);
  expect(text).not.toContain("/another-house");
  expect(existsSync(join(home, "HANDBOOK.md"))).toBe(false);
  const queries = readFileSync(join(home, "unit-queries"), "utf8");
  expect(queries.match(/own-app.service/g)?.length).toBe(1);
  expect(queries.match(/own-loop.service/g)?.length).toBe(1);
  expect(queries).not.toContain("embervy-app");
});

for (const name of ["INFRASTRUCTURE.md", "HANDBOOK.md"]) test(`${name} keeps ungenerated sections verbatim and checks recognised facts without quoting their text`, () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  const original = readFileSync(join(home, name), "utf8");
  const generatedHeading = original.match(/^## .+$/m)![0];
  const resources = "## Resource inventory\r\n\r\n| Kind | ID |\r\n|---|---|\r\n| D1 | database-id |\r\n| Vectorize | index-id |\r\n| R2 | bucket-id |\r\n\r\n";
  const emergency = "## Emergency procedures\n\nPhone: open the SSH client.\nComputer: ssh root@192.0.2.1\nIf stuck: systemctl status own-app\nApp port: 9999\n\n```sh\n## Reachability\nprintf 'example'\n```\n";
  writeFileSync(join(home, name), `# Previous document\n\n${resources}${generatedHeading}\nSTALE_GENERATED_TEXT\n\n${emergency}`);
  const marker = "<!-- kept from the previous " + name + ": house-docs does not generate these sections -->";
  for (let pass = 0; pass < 2; pass++) {
    const checked = run(home, "--check");
    expect(checked.exitCode).toBe(1);
    const output = checked.stdout.toString();
    expect(output).toContain(`${name}: kept section Emergency procedures: app port: contradicts house configuration`);
    for (const heading of ["Resource inventory", "Emergency procedures"]) {
      expect(output.split(`${name}: kept section: ${heading}`).length - 1).toBe(1);
    }
    for (const content of ["database-id", "Phone:", "9999", "printf"]) expect(output).not.toContain(content);
    const preview = run(home).stdout.toString();
    expect(preview).toContain(marker + "\n\n" + resources + emergency);
    expect(run(home, "--write").exitCode).toBe(0);
    const written = readFileSync(join(home, name), "utf8");
    expect(written).toBe(original + "\n" + marker + "\n\n" + resources + emergency);
    expect(written).not.toContain("STALE_GENERATED_TEXT");
    expect(written.split(marker).length - 1).toBe(1);
  }
});

test("kept sections containing configured credentials refuse writes without partial changes", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  const name = "INFRASTRUCTURE.md";
  const text = readFileSync(join(home, name), "utf8") + "\n## Private notes\nMEMORY_SECRET\n";
  writeFileSync(join(home, name), text);
  const handbook = readFileSync(join(home, "HANDBOOK.md"), "utf8");
  expect(run(home).stdout.toString()).not.toContain("MEMORY_SECRET");
  const result = run(home, "--write");
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).not.toContain("MEMORY_SECRET");
  expect(readFileSync(join(home, name), "utf8")).toBe(text);
  expect(readFileSync(join(home, "HANDBOOK.md"), "utf8")).toBe(handbook);
});

for (const harness of ["brain", "claude-code"]) {
  for (const rule of [undefined, "own", "together"]) test(`${harness} renders the ${rule ?? "default"} identity rule`, () => {
    const home = fixture(harness);
    if (rule !== undefined) writeFileSync(join(home, "Claude/app/.env"), `EMBERVY_IDENTITY_RULE=${rule}\nEMBERVY_APP_PORT=4230\n`);
    const facts = collectFacts(home, { queryUnits: false }).facts;
    const vars = { ...handbookVars(facts), USER: undefined };
    const text = renderHandbook(vars, facts.harness);
    const section1 = text.split("## 1.")[1].split("## 2.")[0];
    const section5 = text.split("## 5.")[1].split("## 6.")[0];
    if (rule === "together") {
      expect(section1).toContain("Your identity file is written together with your user and changed only with your user's okay.");
      expect(section1).not.toContain("Your identity file is yours.");
      expect(section5.split("You need your user's okay for:\n")[1].split("### Changing the app")[0]).toContain("- changes to your identity file.");
    } else {
      expect(section1).toContain("Who you are is not in this handbook. Your identity file is yours. When you change it, show your user the difference: what stood there before and what stands now, not a summary. This house only explains the house.");
      expect(section5).not.toContain("changes to your identity file");
      const explicit = renderHandbook({ ...vars, IDENTITY_RULE: "own" }, facts.harness);
      expect(text).toBe(explicit);
    }
    expect(section1).toContain("what stood there before and what stands now, not a summary");
    const infrastructure = renderInfrastructure(facts).split("## Where things live")[1].split("## Ground layer")[0];
    expect(infrastructure).toContain(`EMBERVY_IDENTITY_RULE=${rule ?? "own"}`);
    expect(renderCapabilities(facts)).not.toContain("EMBERVY_IDENTITY_RULE");
    expect(run(home, "--write").exitCode).toBe(0);
    expect(run(home, "--check").exitCode).toBe(0);
  });

  test(`${harness} reads identity rules with house environment precedence`, () => {
    const home = fixture(harness);
    const root = readFileSync(join(home, ".env"), "utf8");
    writeFileSync(join(home, ".env"), root + "EMBERVY_IDENTITY_RULE=together\n");
    const rendered = () => {
      const { facts } = collectFacts(home, { queryUnits: false });
      return renderHandbook(handbookVars(facts), facts.harness);
    };
    expect(rendered()).toContain("identity file is written together");
    writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_IDENTITY_RULE=own\n");
    expect(rendered()).toContain("Your identity file is yours.");
    writeFileSync(join(home, "Brain/brain.env"), "EMBERVY_IDENTITY_RULE=together\n");
    expect(rendered()).toContain(harness === "brain" ? "identity file is written together" : "Your identity file is yours.");
  });

  for (const value of ["unsupported-choice", "", "Bearer " + "x".repeat(48)]) test(`${harness} rejects an unknown identity rule without quoting it (${value.length})`, () => {
    const home = fixture(harness);
    writeFileSync(join(home, "Claude/app/.env"), `EMBERVY_IDENTITY_RULE="${value}"\n`);
    expect(run(home, "--write").exitCode).toBe(0);
    const checked = run(home, "--check");
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout.toString()).toContain("EMBERVY_IDENTITY_RULE: unrecognised setting; using own");
    expect(readFileSync(join(home, "HANDBOOK.md"), "utf8")).toContain("Your identity file is yours.");
    if (value) {
      const output = checked.stdout.toString() + checked.stderr.toString() + run(home).stdout.toString();
      expect(output.includes(value)).toBe(false);
      expect(readFileSync(join(home, "state/house-docs-facts.json"), "utf8").includes(value)).toBe(false);
    }
  });

  for (const rule of ["own", "together"] as const) test(`${harness} checks the opposite handbook identity rule against current facts (${rule})`, () => {
    const home = fixture(harness);
    writeFileSync(join(home, "Claude/app/.env"), `EMBERVY_IDENTITY_RULE=${rule}\n`);
    expect(run(home, "--write").exitCode).toBe(0);
    const { facts } = collectFacts(home, { queryUnits: false });
    const other = rule === "own" ? "together" : "own";
    const opposite = renderHandbook({ ...handbookVars(facts), IDENTITY_RULE: other }, facts.harness);
    writeFileSync(join(home, "HANDBOOK.md"), opposite);
    for (const recorded of [true, false]) {
      if (!recorded) rmSync(join(home, "state/house-docs-facts.json"));
      const checked = run(home, "--check");
      expect(checked.exitCode).toBe(1);
      expect(checked.stdout.toString()).toMatch(new RegExp(`HANDBOOK\\.md:\\d+: EMBERVY_IDENTITY_RULE: document says ${other}, now ${rule}`));
      expect(readFileSync(join(home, "HANDBOOK.md"), "utf8")).toBe(opposite);
    }
  });
}

test("identity claims ignore examples and recognise the approval list independently", () => {
  const record = factsRecord(collectFacts(fixture(), { queryUnits: false }).facts);
  const together = "Your identity file is written together with your user and changed only with your user's okay.";
  expect(checkDocumentClaims([
    `If requested: ${together}`, `Example: ${together}`, `Would ${together}`,
    "```text", together, "```", "<!--", together, "-->",
    "## Notes", "- changes to your identity file;",
  ].join("\n"), record)).toEqual([]);
  expect(checkDocumentClaims("## 5. What needs your user\nYou need your user's okay for:\n- changes to your identity file;", record)).toEqual([
    "3: EMBERVY_IDENTITY_RULE: document says together, now own",
  ]);
  expect(checkDocumentClaims("Identity rule: EMBERVY_IDENTITY_RULE=together", record)).toEqual([
    "1: EMBERVY_IDENTITY_RULE: document says together, now own",
  ]);
});

test("older fact records default to own and identity rule changes are recorded", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  const path = join(home, "state/house-docs-facts.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  delete record.identityRule;
  writeFileSync(path, JSON.stringify(record));
  expect(run(home, "--check").exitCode).toBe(0);
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_APP_PORT=4230\nEMBERVY_IDENTITY_RULE=together\n");
  expect(run(home, "--check").stdout.toString()).toContain("EMBERVY_IDENTITY_RULE: own → together");
});

test("Brain adapter documents follow the configured head", () => {
  for (const head of ["claude", "api", "gpt"]) {
    const home = fixture();
    const profile = readFileSync(join(home, "Brain/brain.env"), "utf8").replace("BRAIN_HEAD=gpt", `BRAIN_HEAD=${head}`);
    writeFileSync(join(home, "Brain/brain.env"), profile);
    const { facts } = collectFacts(home, { queryUnits: false });
    expect(facts.ports.adapter).toBe(head === "gpt" ? 4242 : undefined);
    const infrastructure = renderInfrastructure(facts);
    const handbook = renderHandbook(handbookVars(facts), "brain");
    expect(infrastructure.includes("Subscription adapter port:")).toBe(head === "gpt");
    expect(handbook.includes("The subscription adapter uses port")).toBe(head === "gpt");
    expect(infrastructure).toContain("Brain control port: 4290");
    expect(handbook).toContain("The control endpoint uses port 4290.");
    if (head === "gpt") {
      expect(infrastructure).toContain("Subscription adapter port: 4242");
      expect(handbook).toContain("The subscription adapter uses port 4242.");
      const before = factsRecord(facts);
      const changed = structuredClone(before);
      changed.ports.adapter = 4342;
      expect(compareFacts(before, changed)).toEqual(["adapter port: 4242 → 4342"]);
    }
    expect(run(home, "--write").exitCode).toBe(0);
    expect(run(home, "--check").exitCode).toBe(0);
  }
});

test("Claude Code adapter documents follow the configured backend", () => {
  for (const head of ["claude", "gpt"]) {
    const home = fixture("claude-code");
    writeFileSync(join(home, "Claude/app/.env"), `EMBERVY_BACKEND=${head}\n`);
    const { facts } = collectFacts(home, { queryUnits: false });
    expect(facts.ports.adapter).toBe(head === "gpt" ? 3041 : undefined);
    expect(renderInfrastructure(facts).includes("Subscription adapter port:")).toBe(head === "gpt");
    expect(renderHandbook(handbookVars(facts), "claude-code").includes("The subscription adapter uses port 3041.")).toBe(head === "gpt");
    expect(run(home, "--write").exitCode).toBe(0);
    expect(run(home, "--check").exitCode).toBe(0);
  }
});

test("saved Brain heads select adapter documentation for either GPT transport", () => {
  for (const [head, transport] of [["claude", "pipe"], ["gpt", "api"], ["gpt", "pipe"]]) {
    const home = fixture();
    writeFileSync(join(home, "Brain/brain.env"), `BRAIN_HEAD=${head === "gpt" ? "claude" : "gpt"}\n`);
    mkdirSync(join(home, "Brain/state"));
    writeFileSync(join(home, "Brain/state/brain-head.json"), JSON.stringify({ version: 1, head, model: "test", window: 1000000, transport }));
    const { facts } = collectFacts(home, { queryUnits: false });
    expect(facts.head).toBe(head);
    expect(facts.ports.adapter).toBe(head === "gpt" ? 3042 : undefined);
    const handbook = renderHandbook(handbookVars(facts), "brain");
    expect(handbook.includes("The subscription adapter uses port 3042.")).toBe(head === "gpt");
    expect(handbook).toContain("The control endpoint uses port 3910.");
  }
});

test("Claude Brain checks ignore dormant adapter facts but reject adapter claims", () => {
  const home = fixture();
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=claude\nGPT_ADAPTER_PORT=4242\n");
  expect(run(home, "--write").exitCode).toBe(0);
  const path = join(home, "state/house-docs-facts.json");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.ports.adapter = 4242;
  writeFileSync(path, JSON.stringify(record));
  expect(run(home, "--check").exitCode).toBe(0);
  const infrastructure = join(home, "INFRASTRUCTURE.md");
  writeFileSync(infrastructure, readFileSync(infrastructure, "utf8") + "\nSubscription adapter port: 4242\n");
  const checked = run(home, "--check");
  expect(checked.exitCode).toBe(1);
  expect(checked.stdout.toString()).toContain("adapter port: document says 4242, now not configured");
});

for (const harness of ["brain", "claude-code"]) {
  for (const [label, config, scheduled] of [
    ["missing", undefined, undefined],
    ["empty", "[triggers]\ncrons = [\n]\n", false],
    ["configured", '[triggers]\ncrons = ["15 6 * * 1"]\n', true],
    ["malformed", "[triggers]\ncrons = [\n", undefined],
  ] as const) test(`${harness} handbook describes ${label} worker schedules without a nightly promise`, () => {
    const home = fixture(harness);
    if (config !== undefined) {
      mkdirSync(join(home, "shared/memory/dream-worker"), { recursive: true });
      for (const file of ["shared/memory/wrangler.toml", "shared/memory/dream-worker/wrangler.toml"]) {
        writeFileSync(join(home, file), config);
      }
    }
    const { facts } = collectFacts(home, { queryUnits: false });
    expect(facts.schedules?.memory).toBe(scheduled);
    expect(facts.schedules?.dream).toBe(scheduled);
    const handbook = renderHandbook(handbookVars(facts), facts.harness);
    expect(handbook.includes("runs nightly")).toBe(false);
    expect(handbook.includes("nightly work on your Lore")).toBe(false);
    for (const subject of ["The memory daemon", "The dream worker"]) {
      expect(handbook.includes(scheduled === false ? `${subject} has no scheduled runs`
        : scheduled === true ? `${subject} follows the non-empty cron schedule`
        : `${subject} runs on`)).toBe(true);
    }
    if (scheduled === undefined) expect(handbook).toContain("which may be empty; check the worker's configuration");
    else for (const file of ["shared/memory/wrangler.toml", "shared/memory/dream-worker/wrangler.toml"]) {
      expect(handbook).toContain(join(home, file));
    }
    expect(handbook).toContain("Local configuration does not verify the deployed schedule or successful execution.");
    expect(run(home, "--write").exitCode).toBe(0);
    expect(run(home, "--check").exitCode).toBe(0);
  });
}

test("memory and dream schedules are read independently", () => {
  const home = fixture();
  mkdirSync(join(home, "shared/memory/dream-worker"), { recursive: true });
  writeFileSync(join(home, "shared/memory/wrangler.toml"), "[triggers]\ncrons = []\n");
  writeFileSync(join(home, "shared/memory/dream-worker/wrangler.toml"), '[triggers]\ncrons = ["0 * * * *"]\n');
  const { facts } = collectFacts(home, { queryUnits: false });
  expect(facts.schedules).toEqual({ memory: false, dream: true });
  const handbook = renderHandbook(handbookVars(facts), facts.harness);
  expect(handbook).toContain("The memory daemon has no scheduled runs");
  expect(handbook).toContain("The dream worker follows the non-empty cron schedule");
});

for (const file of ["shared/memory/wrangler.toml", "shared/memory/dream-worker/wrangler.toml"]) test(`worker schedules refuse an escaping configuration link at ${file}`, () => {
  const home = fixture();
  const neighbour = fixture();
  const outside = join(neighbour, "worker.toml");
  writeFileSync(outside, "[triggers]\ncrons = []\n");
  mkdirSync(join(home, file, ".."), { recursive: true });
  symlinkSync(outside, join(home, file));
  expect(() => collectFacts(home, { queryUnits: false })).toThrow("symlink outside --home");
  expect(existsSync(join(home, "HANDBOOK.md"))).toBe(false);
});

test("handbook contract preserves unnamed prose and rejects missing values and markers", () => {
  const { facts } = collectFacts(fixture());
  const vars = handbookVars(facts);
  delete vars.USER;
  expect(renderHandbook(vars, "brain")).toContain("your user");
  expect(() => renderHandbook(vars, "brain", "{{MISSING}}" )).toThrow("HANDBOOK.md: no value for {{MISSING}}");
  expect(() => renderHandbook(vars, "brain", "{{malformed" )).toThrow("leftover marker");
  expect(() => renderHandbook(vars, "brain", "<!-- unexpected -->")).toThrow("leftover marker");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("Your Lore is one tool call away");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("<!-- harness:brain -->");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("<!-- harness:claude-code -->");
});

test("write is private, check reports changed port without overwriting agent edits", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  for (const name of ["HANDBOOK.md", "INFRASTRUCTURE.md"]) expect(statSync(join(home, name)).mode & 0o777).toBe(0o600);
  expect(run(home, "--check").exitCode).toBe(0);
  const original = readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8");
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_APP_PORT=4330\n");
  const result = run(home, "--write", "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("app port: 4230 → 4330");
  expect(result.stdout.toString()).toMatch(/INFRASTRUCTURE\.md:\d+: app port: document says 4230, now 4330/);
  expect(readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8")).toBe(original);
  writeFileSync(join(home, "INFRASTRUCTURE.md"), original + "AGENT_PRIVATE_SECRET\n");
  expect(run(home, "--check").stdout.toString()).not.toContain("AGENT_PRIVATE_SECRET");
  chmodSync(join(home, "HANDBOOK.md"), 0o644);
  expect(run(home, "--write").exitCode).toBe(0);
  expect(statSync(join(home, "HANDBOOK.md")).mode & 0o777).toBe(0o600);
});

test("public facts render optional installer fields only when supplied", () => {
  const { facts } = collectFacts(fixture());
  expect(renderInfrastructure(facts)).not.toContain("ssh -i");
  expect(renderInfrastructure(facts)).not.toContain("Installer state:");
  facts.installer = { provider: "Example VPS", ssh: { keyPath: "keys/rescue", host: "192.0.2.1" }, statePath: "laptop/state.json", resources: [{ kind: "D1", name: "own-db", id: "db-id" }] };
  facts.overflow = { reserve: `${facts.home}/state/disk-reserve`, present: true };
  const text = renderInfrastructure(facts);
  expect(text).toContain('ssh -i "keys/rescue" root@192.0.2.1');
  expect(text).toContain("laptop/state.json");
  expect(text).toContain("own-db");
  expect(text).toContain("fallocate -l 2G");
});

for (const target of [".env", "Claude/app", "Brain/brain.env", "HANDBOOK.md", "INFRASTRUCTURE.md", "state", "state/house-docs-facts.json"]) test(`refuses an escaping symlink at ${target}`, () => {
  const home = fixture();
  const outside = mkdtempSync(join(temp, "neighbour-"));
  writeFileSync(join(outside, "sentinel"), "NEIGHBOUR_SECRET");
  const destination = join(home, target);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(join(destination, ".."), { recursive: true });
  symlinkSync(["Claude/app", "state"].includes(target) ? outside : join(outside, "sentinel"), destination);
  const result = run(home, "--write");
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).not.toContain("NEIGHBOUR_SECRET");
  expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("NEIGHBOUR_SECRET");
  expect(readdirSync(outside)).toEqual(["sentinel"]);
});

test("does not follow imported env paths or inherited house settings, and redacts duplicate secret values", () => {
  const home = fixture();
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=api\nBRAIN_MODEL=DUPLICATE_SECRET\nBRAIN_API_KEY=DUPLICATE_SECRET\nBRAIN_IMPORT_ENV_FILE=/must-not-read\nBRAIN_EXTRA_ENV_FILE=/must-not-read\nBRAIN_CONTEXT_WINDOW=262144\n");
  const result = run(home, "--write");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8")).not.toContain("DUPLICATE_SECRET");
  expect(readFileSync(join(home, "state/house-docs-facts.json"), "utf8")).not.toContain("DUPLICATE_SECRET");
  expect(readFileSync(join(home, "HANDBOOK.md"), "utf8")).toContain("235,929");
  expect(existsSync(join(temp, "unrelated-home"))).toBe(false);
});

for (const harness of ["brain", "claude-code"]) test(`services discover only the ${harness} house's exact unit names and states`, () => {
  const home = fixture(harness);
  const prefix = harness === "brain" ? "embervy" : "embervy-secondary";
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\nEMBERVY_APP_SERVICE=${prefix}-app\n`);
  const parts = ["app.service", "brain.service", "brain-watchdog.service", "tunnel.service", "ears.service", "moments.timer", "loop.service", "watchdog.service"];
  writeFileSync(join(home, "bin/systemctl"), `#!/bin/bash
printf '%s\\n' "$@" >> "${home}/unit-queries"
case "\${@: -1}" in
${parts.map(part => `${prefix}-${part}`).join("|")})
  printf 'LoadState=loaded\\nActiveState=active\\nUnitFileState=enabled\\n'
  ;;
*) printf 'LoadState=not-found\\nActiveState=inactive\\nUnitFileState=\\n';;
esac
`, { mode: 0o755 });
  const result = run(home, "--write");
  expect(result.exitCode).toBe(0);
  const text = readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8");
  for (const part of parts) expect(text).toMatch(new RegExp(`${prefix}-${part.replaceAll(".", "\\.")}\x60 — .*active: active; enabled: enabled`));
  expect(text).not.toContain(`${prefix}-mail-poll.service\x60`);
  const queried = readFileSync(join(home, "unit-queries"), "utf8").split("\n").filter(line => /\.(service|timer)$/.test(line));
  expect(new Set(queried).size).toBe(queried.length);
  expect(queried.every(name => new RegExp(`^${prefix}-(app|brain|brain-watchdog|tunnel|ears|moments|loop|watchdog|mail-poll|calendar-poll)\\.(service|timer)$`).test(name))).toBe(true);
  expect(queried).not.toContain(harness === "brain" ? "embervy-secondary-app.service" : "embervy-app.service");
});

for (const harness of ["brain", "claude-code"]) test(`header enrichment describes the ${harness} invocation without borrowing the other harness settings`, () => {
  const home = fixture(harness);
  mkdirSync(join(home, "Claude/scripts"), { recursive: true });
  writeFileSync(join(home, "Claude/scripts/enrich-header.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const text = run(home).stdout.toString();
  const line = text.split("\n").find(line => line.startsWith("- Header enrichment:"))!;
  expect(line).toContain("enabled");
  if (harness === "brain") {
    expect(line).not.toContain("project,local");
    expect(line).not.toContain("auto-rag-header definition");
    expect(line).toContain("BRAIN_HEADER_ENRICH_CMD");
    expect(line).toContain("temporary archive file");
  } else expect(line).toContain("project,local");
});

for (const harness of ["brain", "claude-code"]) test(`ground-layer weather and cache ping identify the ${harness} harness`, () => {
  const home = fixture(harness);
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\nEMBERVY_HOOK_WEATHER=0\nEMBERVY_CACHE_PING=0\n`);
  mkdirSync(join(home, "Brain/state"));
  writeFileSync(join(home, "Brain/state/brain-head.json"), JSON.stringify({ version: 1, head: "claude", model: "test", window: 1000000, transport: "pipe" }));
  for (const enabled of [true, false]) {
    writeFileSync(join(home, "Brain/brain.env"), `BRAIN_HEAD=api\nBRAIN_SENSE=${enabled ? "on" : "off"}\nBRAIN_WEATHER_URL=https://weather.invalid\nBRAIN_CACHE_PING=${enabled ? "auto" : "off"}\n`);
    expect(run(home, "--write").exitCode).toBe(0);
    const text = readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8");
    const state = harness === "brain" && enabled ? "on" : "off";
    for (const [key, capability] of [["weather", "Weather"], ["cachePing", "Cache ping"]]) {
      expect(text).toContain(`- ${harness === "brain" ? "Brain " : "Claude Code "}${key}: ${state}`);
      expect(text).not.toContain(`- ${key}:`);
      const facts = collectFacts(home, { queryUnits: false }).facts;
      expect(renderCapabilities(facts)).toContain(`- ${capability} | ${capability === "Weather" ? "Sense local weather conditions" : "Keep prompt cache warm"} | ${state}`);
      expect(checkDocumentClaims(text, factsRecord(facts))).toEqual([]);
      const changed = text.replace(`Code ${key}: ${state}`, `Code ${key}: ${state === "on" ? "off" : "on"}`)
        .replace(`Brain ${key}: ${state}`, `Brain ${key}: ${state === "on" ? "off" : "on"}`);
      expect(checkDocumentClaims(changed, factsRecord(facts)).length).toBe(1);
    }
  }
});

for (const harness of ["brain", "claude-code"]) {
  test(`handbook distinguishes the new-house approval default from ${harness} house settings`, () => {
    const home = fixture(harness);
    writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=claude\nBRAIN_APPROVAL_SETTINGS=approval.json\nBRAIN_APP_URL=http://127.0.0.1:4230\nBRAIN_APP_TOKEN=APP_SECRET\nBRAIN_CONTROL_TOKEN=CONTROL_SECRET\n");
    writeFileSync(join(home, "approval.json"), '{"level":"none","extra":[]}');
    expect(run(home, "--write").exitCode).toBe(0);
    const text = readFileSync(join(home, "HANDBOOK.md"), "utf8");
    expect(text).not.toContain("Approval cards start at **important**");
    if (harness === "brain") {
      expect(text).toContain("For a new house, approval cards default to **important**");
      expect(text).toContain("The current level is in the app's **Approvals** settings");
      expect(text).toContain("`CAPABILITIES.md` records whether cards are enabled");
      expect(readFileSync(join(home, "CAPABILITIES.md"), "utf8")).toContain("Approval cards | Ask before important actions | off");
    } else expect(text).not.toContain("approval cards default");
  });

  test(`handbook tells a house about the key the installer created, and only then, for ${harness}`, () => {
    const home = fixture(harness);
    const base = `EMBERVY_HARNESS=${harness}\nCLOUDFLARE_ACCOUNT_ID=account\nCLOUDFLARE_API_TOKEN=HOUSE_KEY_SECRET\n`;
    writeFileSync(join(home, ".env"), base);
    expect(run(home, "--write").exitCode).toBe(0);
    const handbook = () => readFileSync(join(home, "HANDBOOK.md"), "utf8");
    expect(handbook()).not.toContain("**Cloudflare access.**");
    writeFileSync(join(home, ".env"), base + "EMBERVY_CF_HOUSE_KEY=embervy-home-workers\n");
    expect(run(home, "--write").exitCode).toBe(0);
    expect(handbook()).toContain("**Cloudflare access.** The installer created a Cloudflare key for this house (current validity not checked), limited to Workers scripts, D1, Vectorize and R2.");
    expect(handbook()).toContain("To revoke a key the installer created");
    expect(handbook()).not.toContain("To revoke the house sign-in");
    expect(handbook()).not.toContain("wrangler stores and refreshes");
    expect(handbook()).toContain("deploying your workers with that access");
    expect(run(home).stdout.toString()).not.toContain("HOUSE_KEY_SECRET");
  });

  test(`handbook includes Cloudflare sign-in only with house-owned OAuth evidence for ${harness}`, () => {
    const home = fixture(harness);
    const base = `EMBERVY_HARNESS=${harness}\nCLOUDFLARE_ACCOUNT_ID=account\nCLOUDFLARE_API_TOKEN=EARS_ONLY_SECRET\n`;
    writeFileSync(join(home, ".env"), base);
    expect(run(home, "--write").exitCode).toBe(0);
    const handbook = () => readFileSync(join(home, "HANDBOOK.md"), "utf8");
    expect(handbook()).not.toContain("**Cloudflare access.**");
    expect(handbook()).not.toContain("To revoke the house sign-in");
    expect(handbook()).not.toContain("deploying your workers with that access");
    writeFileSync(join(home, ".env"), base + `XDG_CONFIG_HOME=${home}/state/xdg\nWRANGLER_CLIENT_ID=house-client\n`);
    const auth = join(home, "state/xdg/.wrangler/config/default.toml");
    mkdirSync(join(auth, ".."), { recursive: true });
    for (const content of ["", 'oauth_token = "EAR_TOKEN"\nscopes = ["ai.read"]\n']) {
      writeFileSync(auth, content);
      expect(run(home, "--write").exitCode).toBe(0);
      expect(handbook()).not.toContain("**Cloudflare access.**");
    }
    writeFileSync(auth, 'oauth_token = "HOUSE_OAUTH_SECRET"\nrefresh_token = "HOUSE_REFRESH_SECRET"\nscopes = ["workers-scripts.write", "d1.write", "vectorize.write", "workers-r2.write"]\n');
    expect(run(home, "--write").exitCode).toBe(0);
    expect(handbook()).toContain("**Cloudflare access.**");
    expect(handbook()).toContain("To revoke the house sign-in");
    expect(handbook()).toContain("stored house sign-in");
    for (const secret of ["EARS_ONLY_SECRET", "HOUSE_OAUTH_SECRET", "HOUSE_REFRESH_SECRET"]) expect(run(home).stdout.toString()).not.toContain(secret);
    writeFileSync(join(home, ".env"), base + `XDG_CONFIG_HOME=${temp}/other-house\nWRANGLER_CLIENT_ID=house-client\n`);
    expect(run(home, "--write").exitCode).toBe(0);
    expect(handbook()).not.toContain("**Cloudflare access.**");
    expect(existsSync(join(temp, "other-house"))).toBe(false);
  });
}

for (const harness of ["brain", "claude-code"]) for (const mode of ["root-only", "app-only", "both"]) test(`fresh ${harness} capabilities name only existing settings files: ${mode}`, () => {
  const home = fixture(harness);
  const settings = `EMBERVY_HARNESS=${harness}\nEMBERVY_APP_SERVICE=embervy-secondary-app\nEMBERVY_BROWSER=1\n`;
  writeFileSync(join(home, ".env"), settings);
  writeFileSync(join(home, "Claude/app/.env"), settings);
  if (mode === "root-only") rmSync(join(home, "Claude/app/.env"));
  if (mode === "app-only") rmSync(join(home, ".env"));
  expect(run(home, "--write").exitCode).toBe(0);
  const file = join(home, "CAPABILITIES.md");
  const text = readFileSync(file, "utf8");
  const browser = text.split("\n").find(line => line.startsWith("- Browser |"))!;
  expect(browser).toContain(mode === "app-only" ? "in Claude/app/.env" : "in .env");
  if (mode === "both") expect(browser).toContain(".env / Claude/app/.env");
  if (mode === "root-only") expect(text).not.toContain("Claude/app/.env");
  if (mode === "app-only") expect(text).not.toMatch(/in \.env(?:\s|;|$)/m);
  expect(text).not.toContain("config/features.json");
  expect(text).not.toContain("Brain/state/brain-head.json");
  const infra = readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8").split("\n").find(line => line.startsWith("- House env files"))!;
  if (mode === "root-only") expect(infra).not.toContain("Claude/app/.env");
  if (mode === "app-only") expect(infra).not.toContain(`\x60${home}/.env\x60`);
  const kept = text + "\nAgent-owned annotation\n";
  writeFileSync(file, kept);
  writeFileSync(join(home, "Claude/app/.env"), settings);
  writeFileSync(join(home, ".env"), settings);
  expect(run(home, "--write").exitCode).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(kept);
});

for (const harness of ["brain", "claude-code"]) test(`Cloudflare document evidence stays private and refuses escaping config links for ${harness}`, () => {
  const home = fixture(harness);
  const neighbour = fixture(harness);
  const root = `EMBERVY_HARNESS=${harness}\nXDG_CONFIG_HOME=${home}/state/xdg\nWRANGLER_CLIENT_ID=house-client\nCLOUDFLARE_ACCOUNT_ID=account\nUSER_LABEL=REFRESH_SENTINEL\n`;
  writeFileSync(join(home, ".env"), root);
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=api\nBRAIN_USER_NAME=REFRESH_SENTINEL\n");
  const config = join(home, "state/xdg/.wrangler/config");
  mkdirSync(config, { recursive: true });
  const auth = join(config, "default.toml");
  const valid = 'oauth_token = "ACCESS_SENTINEL"\nrefresh_token = "REFRESH_SENTINEL"\nscopes = ["workers-scripts.write", "d1.write", "vectorize.write", "workers-r2.write"]\n';
  writeFileSync(auth, valid);
  const preview = run(home);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout.toString()).toContain("stored house sign-in");
  expect(preview.stdout.toString()).not.toContain("REFRESH_SENTINEL");
  expect(preview.stdout.toString()).not.toContain("ACCESS_SENTINEL");
  writeFileSync(auth, valid.replace('"workers-r2.write"]', '"workers-r2.write", "dns.write"]'));
  expect(run(home).stdout.toString()).not.toContain("**Cloudflare access.**");
  rmSync(auth);
  const outside = join(neighbour, "wrangler.toml");
  writeFileSync(outside, valid);
  symlinkSync(outside, auth);
  const refused = run(home, "--write");
  expect(refused.exitCode).toBe(2);
  expect(refused.stderr.toString()).not.toContain("SENTINEL");
  expect(readFileSync(outside, "utf8")).toBe(valid);
  expect(existsSync(join(home, "HANDBOOK.md"))).toBe(false);
});

for (const harness of ["brain", "claude-code"]) test(`existing optional settings files are named in ${harness} capabilities`, () => {
  const home = fixture(harness);
  mkdirSync(join(home, "config"));
  writeFileSync(join(home, "config/features.json"), '{"weather":true}');
  mkdirSync(join(home, "Brain/state"));
  writeFileSync(join(home, "Brain/state/brain-head.json"), JSON.stringify({ version: 1, head: "claude", model: "test", window: 1000000, transport: "pipe" }));
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=claude\nBRAIN_APPROVAL_SETTINGS=approval.json\n");
  writeFileSync(join(home, "approval.json"), '{"level":"none","extra":[]}');
  const text = run(home, "--capabilities").stdout.toString();
  if (harness === "brain") {
    expect(text).toContain("saved head in Brain/state/brain-head.json");
    expect(text).toContain("level in approval.json");
  } else expect(text).toContain("weather in config/features.json");
});

function placeholderSweep(home: string) {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const section = guide.slice(guide.indexOf("Before signing off, sweep the finished house"));
  const block = section.match(/python3 - <<'PY'\n([\s\S]*?)\nPY/);
  expect(block).not.toBeNull();
  mkdirSync(join(home, "Brain"), { recursive: true });
  writeFileSync(join(home, "Brain/brain.env.example"), readFileSync(join(import.meta.dir, "../../Brain/brain.env.example")));
  return Bun.spawnSync(["python3", "-c", block![1]], {
    env: { PATH: process.env.PATH, EMBERVY_HOME: home, HOUSE_UNITS: "" },
    stdout: "pipe", stderr: "pipe",
  });
}

test("finished house accepts generated documents and empty identity markers", () => {
  const home = fixture("claude-code");
  const env = join(home, ".env");
  writeFileSync(env, readFileSync(env, "utf8").replaceAll(".example", ".test"));
  expect(run(home, "--write").exitCode).toBe(0);
  writeFileSync(join(home, "CLAUDE.md"), "# Identity\n<!-- identity -->\n<!-- /identity -->\n");
  const handbook = join(home, "HANDBOOK.md");
  writeFileSync(handbook, readFileSync(handbook, "utf8") + "\n## Personal notes\nKeep this section.\n");
  expect(run(home, "--write").exitCode).toBe(0);
  expect(readFileSync(handbook, "utf8")).toContain("<!-- kept from the previous");
  expect(existsSync(join(home, "CAPABILITIES.md"))).toBe(true);
  const clean = placeholderSweep(home);
  expect(clean.stderr.toString()).toBe("");
  expect(clean.stdout.toString()).toBe("placeholder sweep: clean\n");
  expect(clean.exitCode).toBe(0);
  writeFileSync(join(home, ".env"), "# Configuration\nBRAIN_MODEL=<model-id>\n");
  writeFileSync(join(home, "CLAUDE.md"), "# Identity\nHome: {path}.\n");
  const incomplete = placeholderSweep(home);
  expect(incomplete.exitCode).toBe(1);
  expect(incomplete.stdout.toString()).toContain(`${home}/.env:2: review template marker`);
  expect(incomplete.stdout.toString()).toContain(`${home}/CLAUDE.md:2: review template marker`);
  expect(incomplete.stdout.toString()).not.toContain("model-id");
});

test("finished house recognizes shipped placeholder forms without treating notation as a marker", () => {
  const home = fixture("claude-code");
  const brain = readFileSync(join(import.meta.dir, "../../Brain/brain.env.example"), "utf8");
  const markers = [...new Set(brain.split("\n").filter(line => !line.startsWith("#")).flatMap(line => line.match(/<[^>\n]+>/g) || [])),
    "YOUR-ACCOUNT", "YOUR_TOKEN", "CHANGE_ME", "REPLACE_WITH_A_MEMBER_KEY_AT_LEAST_32_CHARS", "https://provider.example.invalid", "https://example.com", "https://work.example", "<classifier-api-key>", "/path/to/config", "{path}", "{host}", "{date}", "{EMBERVY_URL}", "{RAG_URL}", "{{HOME}}"];
  writeFileSync(join(home, ".env"), markers.map(marker => `VALUE=${marker}`).join("\n"));
  const result = placeholderSweep(home);
  expect(result.exitCode).toBe(1);
  for (let i = 0; i < markers.length; i++) expect(result.stdout.toString()).toContain(`${home}/.env:${i + 1}: review template marker`);
  writeFileSync(join(home, ".env"), "# VALUE=<model-id>\n; VALUE=YOUR_TOKEN\n");
  writeFileSync(join(home, "CLAUDE.md"), "<!-- identity -->\n<!-- /identity -->\n<!-- kept from the previous document -->\nmcp__lore__<name> <Prefix>_<N>.md <path>.embervy-merged journalctl -u <service> WATCHDOG_WARN_TOKENS_<ENGINE>\n");
  expect(placeholderSweep(home).exitCode).toBe(0);
});

function loopFixture(args: string) {
  const home = fixture("claude-code");
  mkdirSync(join(home, "Claude/scripts"), { recursive: true });
  for (const script of ["loop-wrapper.sh", "start-claude-loop.sh"]) writeFileSync(join(home, "Claude/scripts", script), readFileSync(join(import.meta.dir, "../../Claude/scripts", script)));
  writeFileSync(join(home, "bin/systemctl"), `#!/bin/bash
printf 'ActiveState=active\\nUnitFileState=enabled\\n'
if [ "\${@: -1}" = own-loop.service ]; then
  printf '%s\\n' 'ExecStart={ path=/bin/bash ; argv[]=/bin/bash ${home}/Claude/scripts/loop-wrapper.sh ${args} ; ignore_errors=no ; }'
fi
`, { mode: 0o755 });
  return home;
}

test("Claude Code omits settings source instructions when the loop passes no flag", () => {
  const home = loopFixture("");
  const result = run(home);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain("--setting-sources");
  expect(result.stdout.toString()).not.toContain("start with");
});

for (const args of ["--setting-sources project,local", "--setting-sources=local"]) test(`Claude Code describes the loop argument ${args}`, () => {
  const home = loopFixture(args);
  const result = run(home, "--write");
  expect(result.exitCode).toBe(0);
  const text = readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8");
  expect(text).toContain(`The configured loop passes \`--setting-sources ${args.endsWith("=local") ? "local" : "project,local"}\``);
  expect(text).not.toContain("start with");
});

test("quoted private settings and continuation preserve the loop settings source argument", () => {
  const home = loopFixture('--continue --settings "/private/settings file.json" --setting-sources project,local');
  const text = run(home).stdout.toString();
  expect(text).toContain("The configured loop passes `--setting-sources project,local`");
  expect(text).not.toContain("/private/settings file.json");
});

for (const args of ["--settings --setting-sources project,local", "--setting-sources local --setting-sources project", "--unknown-option --setting-sources project,local"]) test(`ambiguous loop arguments require verification: ${args}`, () => {
  const text = run(loopFixture(args)).stdout.toString();
  expect(text).toContain("Check the loop service's ExecStart");
  expect(text).not.toContain("The configured loop passes");
});

test("unknown or missing loop configuration asks for verification instead of asserting flags", () => {
  for (const home of [fixture("claude-code"), loopFixture("--setting-sources project,local")]) {
    mkdirSync(join(home, "Claude/scripts"), { recursive: true });
    rmSync(join(home, "Claude/scripts/start-claude-loop.sh"), { force: true });
    const text = run(home).stdout.toString();
    expect(text).toContain("Check the loop service's ExecStart");
    expect(text).not.toContain("--setting-sources");
  }
});

for (const suffix of ["embervy", "embervy-secondary"]) test(`installer reserve for ${suffix} supplies the disk recovery path`, () => {
  const path = `/var/lib/${suffix}/reserve.img`;
  const checked: string[] = [];
  const overflow = houseDocs.reserveFacts(`/opt/${suffix}`, undefined, candidate => {
    checked.push(candidate);
    return candidate === path;
  });
  expect(overflow).toEqual({ reserve: path, present: true });
  expect(checked).toEqual([path]);
  const facts = collectFacts(fixture(), { queryUnits: false }).facts;
  facts.overflow = overflow;
  expect(renderInfrastructure(facts)).toContain(`Disk full: remove the reserve \`${path}\` first`);
});

for (const harness of ["brain", "claude-code"]) test(`first-house reserve uses the current layout for ${harness}`, () => {
  const facts = collectFacts(fixture(harness), { queryUnits: false }).facts;
  const checked: string[] = [];
  const present = (path: string) => { checked.push(path); return path === "/var/lib/embervy/reserve.img"; };
  facts.overflow = houseDocs.reserveFacts("/opt/embervy", undefined, present);
  expect(facts.overflow).toEqual({ reserve: "/var/lib/embervy/reserve.img", present: true });
  expect(renderInfrastructure(facts)).toContain("fallocate -l 2G /var/lib/embervy/reserve.img");
  expect(houseDocs.reserveFacts("/opt/embervy", "/var/lib/embervy/reserve.img", present)).toEqual(facts.overflow);
  expect(checked).toEqual(["/var/lib/embervy/reserve.img", "/var/lib/embervy/reserve.img"]);
  expect(houseDocs.reserveFacts("/opt/embervy-secondary", undefined, path => path === "/var/lib/embervy/reserve.img")).toBeUndefined();
  expect(() => houseDocs.reserveFacts("/opt/embervy-secondary", "/var/lib/embervy/reserve.img", () => true)).toThrow("outside --home");
});

test("reserve discovery does not claim another house or guess ownership for custom homes", () => {
  const checked: string[] = [];
  const probe = (path: string) => { checked.push(path); return path === "/var/lib/embervy/reserve.img"; };
  expect(houseDocs.reserveFacts("/opt/embervy-secondary", undefined, probe)).toBeUndefined();
  expect(houseDocs.reserveFacts("/srv/custom", undefined, probe)).toBeUndefined();
  expect(checked).toEqual(["/var/lib/embervy-secondary/reserve.img"]);
  expect(() => houseDocs.reserveFacts("/opt/embervy-secondary", "/var/lib/embervy/reserve.img", probe)).toThrow("outside --home");
});

test("missing installer reserves retain the existing no reserve sentence", () => {
  const facts = collectFacts(fixture(), { queryUnits: false }).facts;
  facts.overflow = houseDocs.reserveFacts("/opt/embervy-secondary", undefined, () => false);
  expect(renderInfrastructure(facts)).toContain("No house-local disk reserve configured or checked. Ask the server owner about any shared reserve before deleting it.");
});

test("an explicit installer reserve is accepted only for the matching house", () => {
  const path = "/var/lib/embervy-secondary/reserve.img";
  expect(houseDocs.reserveFacts("/opt/embervy-secondary", path, candidate => candidate === path)).toEqual({ reserve: path, present: true });
  expect(() => houseDocs.reserveFacts("/opt/embervy", path, () => true)).toThrow("outside --home");
});

test("an existing explicit reserve wins and a missing one falls back only to its own installer reserve", () => {
  const home = "/opt/embervy-secondary";
  const explicit = `${home}/reserve`;
  const installer = "/var/lib/embervy-secondary/reserve.img";
  expect(houseDocs.reserveFacts(home, explicit, path => [explicit, installer].includes(path))).toEqual({ reserve: explicit, present: true });
  expect(houseDocs.reserveFacts(home, explicit, path => path === installer)).toEqual({ reserve: installer, present: true });
  expect(houseDocs.reserveFacts(home, explicit, () => false)).toEqual({ reserve: explicit, present: false });
});

test("reserve probes require a regular file and reject links into another house", () => {
  const home = fixture();
  const neighbour = fixture();
  const reserve = join(home, "reserve");
  mkdirSync(reserve);
  expect(() => houseDocs.reserveFacts(home, reserve)).toThrow("regular, unshared file");
  rmSync(reserve, { recursive: true });
  writeFileSync(join(neighbour, "reserve"), "ballast");
  symlinkSync(join(neighbour, "reserve"), reserve);
  expect(() => houseDocs.reserveFacts(home, reserve)).toThrow("symlink outside --home");
  rmSync(reserve);
  writeFileSync(reserve, "ballast");
  expect(houseDocs.reserveFacts(home, reserve)).toEqual({ reserve, present: true });
});

test("records only a configured house-local reserve", () => {
  const home = fixture();
  writeFileSync(join(home, "reserve"), "ballast");
  writeFileSync(join(home, ".env"), "EMBERVY_HARNESS=brain\nEMBERVY_RESERVE_FILE=reserve\n");
  const result = run(home);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`remove the reserve \`${home}/reserve\``);
  writeFileSync(join(home, ".env"), "EMBERVY_RESERVE_FILE=/outside/reserve\n");
  expect(run(home).exitCode).toBe(2);
});

test("does not guess unit names or execute env contents", () => {
  const home = fixture();
  writeFileSync(join(home, ".env"), `USER_LABEL='$(touch ${home}/executed)'\n`);
  const result = run(home);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("No unit names configured");
  expect(existsSync(join(home, "unit-queries"))).toBe(false);
  expect(existsSync(join(home, "executed"))).toBe(false);
  writeFileSync(join(home, ".env"), "EMBERVY_APP_SERVICE=other-*\n");
  expect(run(home).exitCode).toBe(2);
  expect(existsSync(join(home, "unit-queries"))).toBe(false);
});

test("rejects configured paths outside the house without opening them", () => {
  const home = fixture();
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_SYSTEM=/another-house/EMBERVY.md\n");
  expect(run(home, "--write").exitCode).toBe(2);
  expect(existsSync(join(home, "HANDBOOK.md"))).toBe(false);
});

const recordName = "state/house-docs-facts.json";
test("records private facts, never credential values or hashes", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  const text = readFileSync(join(home, recordName), "utf8");
  expect(statSync(join(home, recordName)).mode & 0o777).toBe(0o600);
  const record = JSON.parse(text);
  expect(record.version).toBe(1);
  expect(record.harness).toBe("brain");
  expect(record.head).toBe("gpt");
  expect(record.tmux).toEqual({ session: "brain", socket: "own-brain" });
  expect(record.ports.app).toBe(4230);
  expect(record.ports.browser).toBeUndefined();
  expect(record.units).toContainEqual({ role: "app", name: "own-app.service", active: "active", enabled: "enabled" });
  expect(record.modules.browser).toBe(false);
  expect(record.credentials.OPENROUTER_API_KEY).toBe(true);
  expect(record.credentials.BFL_API_KEY).toBe(false);
  expect(Object.values(record.credentials).every(value => typeof value === "boolean")).toBe(true);
  for (const secret of ["ROUTER_SECRET", "MEMORY_SECRET", "RAG_SECRET", "CONTROL_SECRET", "ICS_SECRET", "APP_SECRET"]) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/[a-f0-9]{64}/);
});

test("changed credential, port and module are one fact per line, independent of prose", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  writeFileSync(join(home, "HANDBOOK.md"), "I describe my house in my own words.\n");
  writeFileSync(join(home, "INFRASTRUCTURE.md"), "The house is quiet.\n");
  const root = readFileSync(join(home, ".env"), "utf8");
  writeFileSync(join(home, ".env"), root.replace("OPENROUTER_API_KEY=ROUTER_SECRET", "OPENROUTER_API_KEY=") + "EMBERVY_CACHE_PING=1\n");
  const app = readFileSync(join(home, "Claude/app/.env"), "utf8");
  writeFileSync(join(home, "Claude/app/.env"), app.replace("4230", "4330"));
  const result = run(home, "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString().trim().split("\n").sort()).toEqual([
    "OPENROUTER_API_KEY: was set, now not set", "app port: 4230 → 4330", "cache ping: off → on",
  ].sort());
  writeFileSync(join(home, ".env"), root);
  writeFileSync(join(home, "Claude/app/.env"), app);
  expect(run(home, "--check").exitCode).toBe(0);
});

test("a newly set key is reported without its value", () => {
  const home = fixture();
  writeFileSync(join(home, ".env"), "OPENROUTER_API_KEY=\n");
  expect(run(home, "--write").exitCode).toBe(0);
  writeFileSync(join(home, "HANDBOOK.md"), "My handbook.\n");
  writeFileSync(join(home, "INFRASTRUCTURE.md"), "My map.\n");
  writeFileSync(join(home, ".env"), "OPENROUTER_API_KEY=SENTINEL_NEVER_PRINT\n");
  const result = run(home, "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString().trim()).toBe("OPENROUTER_API_KEY: was not set, now set");
});

test("missing record falls back to document facts, not template wording", () => {
  const home = fixture();
  writeFileSync(join(home, "CAPABILITIES.md"), renderCapabilities(collectFacts(home).facts));
  writeFileSync(join(home, "HANDBOOK.md"), "My own handbook.\n");
  writeFileSync(join(home, "INFRASTRUCTURE.md"), "My own map.\nOPENROUTER_API_KEY: not set\nApp port: 4130\nBrowser: on\n");
  const result = run(home, "--write", "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("no recorded facts");
  expect(result.stdout.toString()).toContain("INFRASTRUCTURE.md:2: OPENROUTER_API_KEY: document says not set, now set");
  expect(result.stdout.toString()).toContain("INFRASTRUCTURE.md:3: app port: document says 4130, now 4230");
  expect(result.stdout.toString()).toContain("INFRASTRUCTURE.md:4: browser: document says on, now off");
  expect(existsSync(join(home, recordName))).toBe(false);
  writeFileSync(join(home, "INFRASTRUCTURE.md"), "Nothing here is a claim.\n");
  expect(run(home, "--check").exitCode).toBe(0);
  expect(existsSync(join(home, "state"))).toBe(false);
});

test("claims report exact lines and ignore matching claims and speculative prose", () => {
  const record = factsRecord(collectFacts(fixture()).facts);
  const claims = checkDocumentClaims([
    "# My map", "- `OPENROUTER_API_KEY`: not set", "The OPENROUTER_API_KEY is set.",
    "- Browser: enabled", "- App port: 4230", "The subscription adapter uses port 9999.",
    "If browser is on, it can render pages.", "Perhaps we will use the calendar one day.",
    "Example: OPENROUTER_API_KEY: missing", "Is browser off?", "```text", "Browser: on", "```",
    "- weather: off", "<!-- browser: on -->", "The key is missing from this paragraph.",
  ].join("\n"), record);
  expect(claims).toEqual([
    "2: OPENROUTER_API_KEY: document says not set, now set", "4: browser: document says on, now off",
    "6: adapter port: document says 9999, now 4242",
  ]);
});

test("browser ports appear only when the browser is enabled", () => {
  const home = fixture();
  const { facts } = collectFacts(home);
  facts.rescueAccess = false;
  for (const doc of [renderHandbook(handbookVars(facts), "brain"), renderInfrastructure(facts)]) {
    expect(doc).not.toMatch(/browser[^\n]*port/i);
    expect(doc).not.toContain("3055");
  }
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_BROWSER=1\nEMBERVY_BROWSER_PORT=4355\n");
  const enabled = collectFacts(home).facts;
  expect(renderHandbook(handbookVars(enabled), "brain")).toContain("browser daemon uses port 4355");
  expect(renderInfrastructure(enabled)).toContain("Browser daemon port: 4355");
});

test("rescue wording requires an actual authorized key line", () => {
  expect(rescueLinePresent("")).toBe(false);
  expect(rescueLinePresent("# ssh-ed25519 AAAA embervy-rescue\n")).toBe(false);
  expect(rescueLinePresent("ssh-ed25519 AAAA personal-key\n")).toBe(false);
  expect(rescueLinePresent('restrict ssh-ed25519 AAAA embervy-rescue\n')).toBe(true);
  const { facts } = collectFacts(fixture());
  facts.rescueAccess = false;
  const handbook = renderHandbook(handbookVars(facts), "brain");
  expect(handbook).not.toContain("Emergency access");
  expect(handbook).not.toContain("embervy-rescue");
  expect(handbook).toContain("your user gets in through their own SSH access.");
  facts.rescueAccess = true;
  expect(renderHandbook(handbookVars(facts), "brain")).toContain("embervy-rescue");
});

test("the identity template starts sparse: short, and the identity section is empty", () => {
  const template = readFileSync(join(import.meta.dir, "../../Claude/CLAUDE.md.example"), "utf8");
  expect(template.trimEnd().split("\n").length).toBeLessThanOrEqual(81);
  expect(template).not.toContain("{AGENT_NAME}");
  const identity = template.match(/^## Who I am\n([\s\S]*?)(?=^## )/m)?.[1].trim();
  expect(identity).toBe("This section starts empty; this file and your Lore start sparse on purpose.\n\n<!-- identity -->\n<!-- /identity -->");
  const placeholders = [...new Set(template.match(/\{[^{}\n]+\}/g))].sort();
  expect(placeholders).toEqual(["{EMBERVY_URL}", "{RAG_URL}", "{date}", "{host}", "{path}"].sort());
  for (const mod of ["memory", "rag", "mail_agent"]) {
    const starts = template.match(new RegExp(`<!-- module:${mod} -->`, "g"))?.length;
    expect(starts).toBeGreaterThan(0);
    expect(template.match(new RegExp(`<!-- /module:${mod} -->`, "g"))?.length).toBe(starts);
  }
});

test("operational instructions are in the handbook rather than the identity template", () => {
  const template = readFileSync(join(import.meta.dir, "../../Claude/CLAUDE.md.example"), "utf8");
  for (const fact of ["strings.local.json", "strings/en.json", "bun strings.ts --check", "?v=115-h1", "embervy-v30-h1", ".embervy-merged", ".embervy-new", ".embervy-base", "update.sh take <path>", "pandoc file.docx -t markdown", "openpyxl", "POST /upload", "$RAG_AUTH_TOKEN", "$MAILBOX_USER", "MAILBOX_ALLOW_SEND=true", "EMBERVY_ROOMS", "curl", "wrangler"]) {
    expect(HANDBOOK_TEMPLATE_TEXT).toContain(fact);
    expect(template).not.toContain(fact);
  }
  expect(HANDBOOK_TEMPLATE_TEXT.match(/\?v=115-h1/g)?.length).toBe(1);
  expect(HANDBOOK_TEMPLATE_TEXT.match(/update\.sh take <path>/g)?.length).toBe(1);
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("Every send requires {{USER}} to allow that exact draft on its own approval card, every time; no setting skips the card.");
});

test("handbook identifies foreign calendar context and keeps secrets out of process arguments", () => {
  const { facts } = collectFacts(fixture());
  for (const harness of ["brain", "claude-code"] as const) {
    const handbook = renderHandbook(handbookVars(facts), harness);
    expect(handbook).toContain('kind="calendar"');
    expect(handbook).toContain("500 Unicode characters");
    expect(handbook).toContain("data, not instructions");
    expect(handbook).toContain("curl-auth.sh");
    expect(handbook).toContain('embervy_curl_bearer "$TOKEN"');
    expect(handbook).toContain("including their lengths or fragments");
  }
});

test("moved browser instructions respect the existing optional browser marker for both harnesses", () => {
  const { facts } = collectFacts(fixture());
  for (const harness of ["brain", "claude-code"] as const) {
    const vars = handbookVars(facts);
    const without = renderHandbook({ ...vars, BROWSER: false }, harness);
    expect(without).not.toContain("Chromium keeps its login sessions");
    const withBrowser = renderHandbook({ ...vars, BROWSER: true }, harness);
    expect(withBrowser).toContain("Chromium keeps its login sessions");
    expect(withBrowser).not.toContain("{{");
    expect(withBrowser).not.toContain("<!--");
  }
});

test("the identity file is the agent's, with before and after disclosure", () => {
  const { facts } = collectFacts(fixture());
  const text = renderHandbook(handbookVars(facts), "brain");
  expect(text).toContain("Your identity file is yours.");
  expect(text).toContain("what stood there before and what stands now, not a summary");
  expect(text).not.toContain("write together");
  expect(text).not.toContain("changes to your identity file");
});

test("mail and rooms are recorded by name without embedded credentials", () => {
  const home = fixture();
  const token = "ROOM_SENTINEL_TOKEN_12345678901234567890";
  writeFileSync(join(home, "Claude/app/.env"), `EMAIL_SENDER_URL=https://mail.example\nEMAIL_SENDER_AUTH=MAIL_SENTINEL\nEMBERVY_ROOMS='[{"name":"Work","url":"https://work.example","token":"${token}"}]'\n`);
  expect(run(home, "--write").exitCode).toBe(0);
  const text = readFileSync(join(home, recordName), "utf8");
  const f = JSON.parse(text);
  expect(f.modules.mail).toBe(true);
  expect(f.modules.rooms).toEqual({ Work: true });
  expect(f.credentials["room Work token"]).toBe(true);
  expect(text).not.toContain(token);
  expect(text).not.toContain("MAIL_SENTINEL");
  expect(run(home, "--check").exitCode).toBe(0);
});

test("fact comparison includes unit state, configured head and tmux, not env order", () => {
  const before = factsRecord(collectFacts(fixture()).facts);
  before.units[0].active = "active";
  const now = structuredClone(before);
  now.head = "claude"; now.tmux.socket = "own-socket"; now.units[0].active = "inactive";
  expect(compareFacts(before, now)).toEqual(["head: gpt → claude", "tmux socket: own-brain → own-socket", "unit own-app.service active: active → inactive"]);
});

test("document contradictions are checked even when the recorded facts match", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  writeFileSync(join(home, "HANDBOOK.md"), "My words.\nOPENROUTER_API_KEY: missing\nBrowser: off\n");
  const before = readFileSync(join(home, "HANDBOOK.md"), "utf8");
  const result = run(home, "--check");
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString().trim()).toBe("HANDBOOK.md:2: OPENROUTER_API_KEY: document says not set, now set");
  expect(readFileSync(join(home, "HANDBOOK.md"), "utf8")).toBe(before);
});

test("unset custom credentials and removed rooms still contradict stale claims", () => {
  const record = factsRecord(collectFacts(fixture()).facts);
  expect(checkDocumentClaims("CUSTOM_API_KEY: set\nRoom Work: on\nCUSTOM_API_KEY: missing\nRoom Rest: off", record)).toEqual([
    "1: CUSTOM_API_KEY: document says set, now not set", "2: room Work: document says on, now off",
  ]);
});

test("short secrets cannot corrupt the recorded JSON types", () => {
  const home = fixture();
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_API_KEY=1\n");
  expect(run(home, "--write").exitCode).toBe(0);
  const record = JSON.parse(readFileSync(join(home, recordName), "utf8"));
  expect(record.version).toBe(1);
  expect(record.credentials.BRAIN_API_KEY).toBe(true);
  expect(typeof record.ports.app).toBe("number");
});

test("malformed recorded facts are not silently treated as an absent baseline", () => {
  const home = fixture();
  expect(run(home, "--write").exitCode).toBe(0);
  writeFileSync(join(home, recordName), '{"version":999,"secret":"OLD_SECRET"}');
  const result = run(home, "--check");
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("invalid state/house-docs-facts.json");
  expect(result.stderr.toString()).not.toContain("OLD_SECRET");
});

test("the handbook describes the loop's start-dialog automation as the loop does it", () => {
  expect(HANDBOOK_TEMPLATE_TEXT).not.toContain("answered with yes");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("first three minutes after each start");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("It answers nothing else");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("other start questions appear as a card in the app");
  expect(HANDBOOK_TEMPLATE_TEXT).toContain("the three minutes stand still for as long as such a question is on screen");
  expect(HANDBOOK_TEMPLATE_TEXT).not.toContain("24 hours");
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const firstStart = guide.slice(guide.indexOf("### First start"), guide.indexOf("## 6b. Brain"));
  expect(firstStart).toContain("other start questions appear as a card in the app");
  for (const text of [firstStart, HANDBOOK_TEMPLATE_TEXT]) {
    expect(text).toContain("Continue button for Enter-only questions");
    expect(text).toContain("While Claude Code is running, the app holds chat back");
    expect(text).toContain("visible single-line input box is missing");
    expect(text).toContain("EMBERVY_INPUT_GUARD=known");
    expect(text).toContain("not running or its process check is inconclusive");
    expect(text).toContain("messages stay in the inbox for the agent's return without a hint");
  }
  const loop = readFileSync(join(import.meta.dir, "../../Claude/scripts/start-claude-loop.sh"), "utf8");
  const helper = readFileSync(join(import.meta.dir, "../../Claude/scripts/loop-dialog.sh"), "utf8");
  expect(loop).toContain("loop_startup_clock_start 180");
  // Human waits must pause startup instead of expiring while an answer is pending.
  expect(helper).toContain('if [ "$kind" = first-start ] || [ "$kind" = unknown ]; then\n    LOOP_STARTUP_PAUSED=1');
  expect(helper).not.toContain("86400");
  expect(loop).toContain("Only the explicit development choice is safe to automate");
});
