import { join } from "node:path";

type SpawnOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: "ignore";
  stderr: "ignore" | "pipe";
};
type Options = {
  cwd: string;
  env: Record<string, string | undefined>;
  cmd?: string[];
  timeoutMs?: number;
  stdout?: "ignore";
  stderr?: "ignore" | "pipe";
  firstPort?: number;
  spawn?: (cmd: string[], options: SpawnOptions) => ReturnType<typeof Bun.spawn>;
};

export function testPort(excluded: ReadonlySet<number> = new Set()): number {
  for (;;) {
    const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = socket.port;
    socket.stop(true);
    if (port !== 3030 && !excluded.has(port)) return port;
  }
}

export async function startTestApp(options: Options) {
  const attempted = new Set<number>();
  const failures: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = attempt === 0 && options.firstPort !== undefined ? options.firstPort : testPort(attempted);
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 3030) throw new Error("Invalid test app port");
    attempted.add(port);
    const password = crypto.randomUUID();
    const env = { ...options.env, EMBERVY_APP_PORT: String(port), EMBERVY_APP_HOST: "127.0.0.1", APP_PASSWORD: password };
    const base = `http://127.0.0.1:${port}`;
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let ready = false;
    let reason = "identity deadline exceeded";
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      proc = (options.spawn ?? ((cmd, opts) => Bun.spawn(cmd, opts)))(options.cmd ?? [process.execPath, "run", join(import.meta.dir, "server.ts")], {
        cwd: options.cwd, env, stdout: "ignore", stderr: options.stderr ?? "ignore",
      });
      let exited = false;
      const exit = proc.exited.then(() => { exited = true; controller.abort(); });
      const alive = () => !exited && proc!.exitCode === null && proc!.signalCode === null;
      while (!controller.signal.aborted && alive()) {
        try {
          // A healthy foreign app cannot authenticate a fresh per-child password.
          const response = await fetch(`${base}/api/auth`, {
            method: "POST", redirect: "error",
            headers: { "content-type": "application/json", "cf-ray": "test-start", "cf-connecting-ip": "127.0.0.1" },
            body: JSON.stringify({ password }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]),
          });
          const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
          const body = await response.json().catch(() => null) as { ok?: boolean } | null;
          if (response.status === 200 && body?.ok === true && cookie && alive() && !controller.signal.aborted) {
            ready = true;
            return { base, port, proc, password, cookie, env };
          }
          reason = `identity not proven (auth HTTP ${response.status})`;
        } catch {
          reason = "identity not proven (auth request failed or timed out)";
        }
        if (!controller.signal.aborted) await Promise.race([Bun.sleep(100), exit]);
      }
      reason = alive() ? `${reason}; deadline ${timeoutMs}ms exceeded` : `child exited (code ${proc.exitCode}, signal ${proc.signalCode ?? "none"})`;
    } catch {
      reason = "child could not be spawned";
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (proc && !ready) {
        proc.kill("SIGKILL");
        await proc.exited;
        if (proc.stderr instanceof ReadableStream) await proc.stderr.cancel().catch(() => {});
      }
    }
    failures.push(`port ${port}: ${reason}`);
  }
  throw new Error(`Test app failed after 3 attempts: ${failures.join("; ")}`);
}
