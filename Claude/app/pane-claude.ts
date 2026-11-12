import { join } from "node:path";

// Use the loop's session-based check: the foreground command can still be a waiting shell.
export async function paneHasClaude(
  target: string,
  socket: string,
  { env = process.env, timeoutMs = 1000 }: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<boolean> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn([
      "bash", "-c", 'source "$1" && embervy_pane_has_claude "$2"', "app-pane-check",
      join(import.meta.dir, "../../shared/scripts/house-runtime.sh"), target,
    ], { env: { ...env, EMBERVY_TMUX_SOCKET: socket }, stdout: "ignore", stderr: "ignore" });
    return await Promise.race([
      proc.exited.then(code => code === 0),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          // An inconclusive probe must leave chat on the normal inbox/wake path.
          try { proc?.kill("SIGKILL"); } catch {}
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
