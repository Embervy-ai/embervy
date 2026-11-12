// Defines how conversation history reaches a model.

import { REPORTING_DRIFT_GUARD, type DriftMachine } from "./drift-guard";
import type { BridgeCleaning } from "./wake-bridge";

type Env = Record<string, string | undefined>;

export interface ProjectionHead { name: string; model: string; transport: string }

export interface ProjectionSeam {
  messages<T extends { role: string; content?: unknown }>(messages: T[], model: string, substrateDrift: boolean): { messages: T[]; event: Record<string, number> | null };
  text(text: string, model: string, substrateDrift: boolean): string;
  outgoing(model: string, text: string): string;
  commands: readonly string[];
  helpLines: string;
  command(command: string, argument: string, head: ProjectionHead): { text: string; rebirth: string | null } | null;
  drift: DriftMachine;
  bridgeCleaning: BridgeCleaning | null;
}

export function projectionSeamFromEnv(_env: Env): ProjectionSeam {
  return {
    messages: (messages) => ({ messages: [...messages], event: null }),
    text: (text) => text,
    outgoing: (_model, text) => text,
    commands: [],
    helpLines: "",
    command: () => null,
    drift: REPORTING_DRIFT_GUARD,
    bridgeCleaning: null,
  };
}
