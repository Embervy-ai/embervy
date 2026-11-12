import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface HouseFinding { id: string; label: string; detail: string; fix: string }

export function houseCheckBlock(findings: HouseFinding[]): string {
  return "[house check]\n" + findings.map((f) => `- ${f.label}: ${f.detail} Fix: ${f.fix}`).join("\n");
}

export function houseCheckMessage(findings: HouseFinding[]): string {
  return "The house check found a problem.\n" + findings.map((f) => `- ${f.label}: ${f.detail}`).join("\n") + "\nThe agent has the repair steps.";
}

export async function runStartupDoctor(command: string, timeoutMs = 30_000): Promise<HouseFinding[]> {
  const failure = (detail: string): HouseFinding[] => [{ id: "startup-doctor", label: "House check could not finish", detail, fix: "Run BRAIN_DOCTOR_CMD in a terminal, repair the reported problem, then restart Brain." }];
  return new Promise((done) => {
    // A private group lets the timeout stop the doctor's children too.
    // Run at the installation root so checks that use their working directory inspect the right installation.
    const home = process.env.EMBERVY_HOME?.trim() || resolve(import.meta.dir, "..");
    const child = spawn("/bin/sh", ["-c", command], { detached: true, cwd: home, env: { ...process.env, EMBERVY_HOME: home }, stdio: ["ignore", "pipe", "ignore"] });
    let output = "", settled = false;
    const finish = (findings: HouseFinding[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(findings);
    };
    const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { kill(); finish(failure("The check took longer than 30 seconds; startup problems may be unknown.")); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 1_048_576) { kill(); finish(failure("The check returned too much output; startup problems may be unknown.")); }
    });
    child.on("error", () => finish(failure("The check could not run; startup problems may be unknown.")));
    child.on("close", (code) => {
      if (settled) return;
      try {
        const result = JSON.parse(output);
        const entries = Array.isArray(result) ? result : result.checks;
        if (!Array.isArray(entries)) throw new Error("missing checks");
        // An unknown status cannot safely be treated as a passing check.
        if (!entries.every((entry) => ["OK", "SKIP", "WARN", "FAIL"].includes(entry?.status))) throw new Error("unknown status");
        const findings = entries.filter((entry) => entry.status === "WARN" || entry.status === "FAIL").map((entry) => {
          if (![entry.id, entry.label, entry.detail].every((value) => typeof value === "string")) throw new Error("invalid finding");
          return { id: entry.id, label: entry.label, detail: entry.detail, fix: typeof entry.fix === "string" ? entry.fix : "Run the house doctor in a terminal and follow its advice." };
        });
        finish(code !== 0 && !findings.length ? failure("The check exited with an error; startup problems may be unknown.") : findings);
      } catch { finish(failure("The check returned unreadable results; startup problems may be unknown.")); }
    });
  });
}
