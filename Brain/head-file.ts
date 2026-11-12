import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Share the runtime's path defaults without importing its startup side effects.
export function headFile(env: Record<string, string | undefined> = process.env): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const stateDir = env.BRAIN_STATE_DIR ?? join(here, "state");
  return env.BRAIN_HEAD_FILE || join(stateDir, "brain-head.json");
}
