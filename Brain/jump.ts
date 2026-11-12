/**
 * jump.ts — moving the agent between Brain and another harness: not part of this build.
 *
 * Brain asks this module for the chat commands, the help line and the map
 * entry of such a move, and for what it adds to the wake bridge. In this
 * build there is none: no command, no help line, no map entry, nothing added
 * to the bridge (a bridge Brain did not write itself is kept as an imported
 * bridge, see wake-bridge.ts). The module reads no environment variable.
 *
 * The shape of JumpSeam is what brain.ts calls; keep it.
 */

import type { BridgeJump } from "./wake-bridge";

type Env = Record<string, string | undefined>;

/** What brain.ts lends the module. */
export interface JumpHost {
  logDir: string;
  sterile: boolean;
  log(event: Record<string, unknown>): void;
}

export interface JumpSeam {
  /** Chat commands this module owns (terminal and app). */
  commands: readonly string[];
  /** The module's commands in the map's command line, in its order. */
  mapCommands: readonly string[];
  /** Line of /help for the module's command, "" or ending in a newline. */
  helpLine: string;
  /** Runs one of `commands`; null when the command is not the module's. */
  command(command: string, via: string): Promise<string> | null;
  /** What the module adds to the wake bridge; null = nothing. */
  bridge: BridgeJump | null;
}

export function jumpSeamFromEnv(_env: Env, _host: JumpHost): JumpSeam {
  return {
    commands: [],
    mapCommands: [],
    helpLine: "",
    command: () => null,
    bridge: null,
  };
}
