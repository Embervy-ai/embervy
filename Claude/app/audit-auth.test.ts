import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["forbidden", "password", "same-host"]) {
  test(`authentication audit: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-auth-"));
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port; probe.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
      cwd: dir,
      env: { PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir,
        EMBERVY_APP_PORT: String(port), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_DATA_DIR: join(dir, "data"),
        APP_PASSWORD: mode === "forbidden" ? "DEV_INSECURE_OPEN" : "test-password",
        APP_SESSION_SECRET: "test-secret", EMBERVY_TRUST_SAME_HOST: mode === "same-host" ? "1" : "0",
        EMBERVY_TERMINAL_PANEL: "0" },
      stdout: "ignore", stderr: "pipe",
    });
    try {
      if (mode === "forbidden") {
        expect(await proc.exited).not.toBe(0);
        expect(await new Response(proc.stderr).text()).toContain("EMBERVY_TRUST_SAME_HOST");
        return;
      }
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try { up = (await fetch(`${base}/health`)).ok; } catch {}
        if (!up) await Bun.sleep(50);
      }
      expect(up).toBe(true);
      for (const headers of [{}, { "cf-ray": "audit" }, { "cf-connecting-ip": "203.0.113.8" }]) {
        const response = await fetch(`${base}/api/messages`, { headers });
        expect(response.status).toBe(mode === "same-host" && Object.keys(headers).length === 0 ? 200 : 401);
        await response.arrayBuffer();
      }
    } finally {
      proc.kill(); await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}
