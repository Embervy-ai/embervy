import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const appSocket of [undefined, "app-socket"]) {
for (const args of [[], ["--settings", "a file with spaces and 'single' and \"double\" quotes", "--setting-sources", "project,local", "", "$(touch should-not-exist); * \\ end", "line\nbreak"]]) {
  test(`manual wrapper loads house env, app socket ${appSocket}, and forwards ${args.length} arguments`, () => {
    const root = mkdtempSync(join(tmpdir(), "loop-wrapper-"));
    const home = join(root, "house with 'quotes'");
    try {
      mkdirSync(join(home, "Claude/scripts"), { recursive: true });
      mkdirSync(join(root, "bin"));
      mkdirSync(join(home, "Claude/app"));
      writeFileSync(join(home, ".env"), "EMBERVY_TMUX_SOCKET=house-socket\n");
      writeFileSync(join(home, "Claude/app/.env"), appSocket ? `EMBERVY_TMUX_SOCKET=${appSocket}\n` : "");
      writeFileSync(join(home, "Claude/scripts/start-claude-loop.sh"), '#!/bin/bash\nfor arg in "$@"; do printf "%s\\0" "$arg"; done > "$EMBERVY_HOME/args"\n');
      writeFileSync(join(root, "bin/tmux"), `#!/bin/bash
[ "$1" = -L ] && [ "$2" = "${appSocket ?? "house-socket"}" ] || exit 91
printf '%s\\n' "$2" >> "$EMBERVY_HOME/sockets"
shift 2
case "$1" in
  list-sessions|has-session) exit 1 ;;
  new-session) bash -c "\${@: -1}" ;;
  *) exit 90 ;;
esac
`, { mode: 0o755 });
      const result = Bun.spawnSync(["bash", join(import.meta.dir, "loop-wrapper.sh"), ...args], {
        cwd: root, env: { PATH: `${root}/bin:${process.env.PATH}`, HOME: root, EMBERVY_HOME: home },
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(home, "sockets"), "utf8").trim().split("\n")).toEqual(Array(4).fill(appSocket ?? "house-socket"));
      const bytes = readFileSync(join(home, "args"), "utf8");
      expect(bytes ? bytes.slice(0, -1).split("\0") : []).toEqual(args);
      expect(Bun.file(join(root, "should-not-exist")).size).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
}
