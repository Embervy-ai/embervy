import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, handbookVars, renderHandbook } from "../../shared/tools/house-docs";

test("generated Brain handbook explains human setup and agent-managed key preferences", () => {
  const home = mkdtempSync(join(tmpdir(), "house-docs-setup-"));
  try {
    for (const harness of ["brain", "claude-code"]) {
      writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\n`);
      const { facts } = collectFacts(home, { queryUnits: false });
      const text = renderHandbook(handbookVars(facts), facts.harness);
      if (harness === "brain") {
        expect(text).toContain("KIMI_CODE_KEY");
        expect(text).toContain("BRAIN_HEAD_SETUP_HIDE=kimi");
        expect(text).toContain("never an available head");
      } else expect(text).not.toContain("BRAIN_HEAD_SETUP_HIDE");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
