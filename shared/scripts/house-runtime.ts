import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { houseHome } from "./legacy-names";

type Env = Record<string, string | undefined>;
export function tmuxSocket(socket = process.env.EMBERVY_TMUX_SOCKET): string {
  return socket || "embervy";
}
export function brainTmuxSocket(socket = process.env.BRAIN_TMUX_SOCKET): string {
  return socket || "brain";
}
export function tmuxCommand(args: string[], socket = tmuxSocket()): string[] {
  return ["tmux", "-L", tmuxSocket(socket), ...args];
}
export function videoBackendUrl(path: string, env: Env = process.env): string {
  return `http://localhost:${env.EMBERVY_VIDEO_PORT || "3032"}${path}`;
}
export function chatgptAuthFile(env: Env = process.env): string {
  return env.CHATGPT_AUTH_FILE || (env.EMBERVY_TMUX_SOCKET
    ? `${houseHome(env)}/state/chatgpt-auth.json` : `${env.HOME || "/root"}/.codex/auth.json`);
}
export function pathInHouse(path: string, home: string): boolean {
  const root = home.replace(/\/+$/, "");
  return !!root && (path === root || path.startsWith(root + "/"));
}
export interface ProcessPaths { cwd(pid: number): string; argv(pid: number): string[]; unitPaths?(pid: number): string }
const procPaths: ProcessPaths = {
  cwd: pid => { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return ""; } },
  argv: pid => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return []; } },
  // Service membership survives cwd changes, so unit paths take precedence for ownership.
  unitPaths: pid => {
    try {
      const unit = readFileSync(`/proc/${pid}/cgroup`, "utf8").match(/^0::.*\/([^/\n]+\.service)$/m)?.[1];
      if (!unit) return "";
      const out = Bun.spawnSync(["systemctl", "show", "-p", "WorkingDirectory", "-p", "ExecStart", "--value", "--", unit], { stdout: "pipe", stderr: "ignore" });
      return new TextDecoder().decode(out.stdout);
    } catch { return ""; }
  },
};
const OTHER_HOUSE_UNIT = /\/opt\/embervy|\/opt\/[^/\s]+\/(Brain|Claude|shared)\//;
function unitNamesHouse(paths: string, home: string): boolean {
  return paths.split(/[\s;=]+/).some(p => pathInHouse(p, home));
}
// Unknown ownership must never become permission to signal a process.
export function ownsProcess(pid: number, home: string, probes: ProcessPaths = procPaths): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const raw = home.replace(/\/+$/, "");
  try { home = realpathSync(home); } catch { return false; }
  const unit = probes.unitPaths?.(pid) ?? "";
  if (unit) {
    if (unitNamesHouse(unit, home) || (raw && raw !== home && unitNamesHouse(unit, raw))) return true;
    if (OTHER_HOUSE_UNIT.test(unit)) return false;
  }
  return pathInHouse(probes.cwd(pid), home) || probes.argv(pid).some(arg => pathInHouse(arg, home));
}
export function housePids(args: string[], home: string): number[] {
  try {
    const out = Bun.spawnSync(["pgrep", ...args], { stdout: "pipe", stderr: "ignore" });
    return new TextDecoder().decode(out.stdout).trim().split(/\s+/).map(Number).filter(pid => ownsProcess(pid, home));
  } catch { return []; }
}
