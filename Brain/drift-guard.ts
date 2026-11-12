// Reports when the served model differs from the requested model.
import { gptServedModelMatches } from "./heads";

export interface DriftDecision {
  drift: boolean;
  ordered: string;
  served: string;
}

export interface DriftGuardState {
  substrateDrift: boolean;
  ordered: string | null;
  served: string | null;
}

export interface DriftObservation {
  state: DriftGuardState;
  marker: "drift" | "healed" | null;
}

export interface DriftTurnDecision {
  state: DriftGuardState;
  recycle: string | null;
  modelCall: boolean;
  hint: string | null;
}

export interface DriftMachine {
  initial(): DriftGuardState;
  observe(state: DriftGuardState, ordered: string, served: string | undefined): DriftObservation;
  beginTurn(state: DriftGuardState): DriftTurnDecision;
}

export function normalizeModel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, "")
    // The context-window suffix is absent from served model IDs and would cause false drift reports.
    .replace(/\[1m\]$/, "");
}

export function detectSubstrateDrift(ordered: string, served: string): DriftDecision {
  const normalizedOrdered = normalizeModel(ordered);
  const normalizedServed = normalizeModel(served);
  return {
    drift: Boolean(normalizedOrdered && normalizedServed)
      && !gptServedModelMatches(normalizedOrdered, normalizedServed),
    ordered: normalizedOrdered,
    served: normalizedServed,
  };
}

export function initialDriftGuardState(): DriftGuardState {
  return { substrateDrift: false, ordered: null, served: null };
}

export function observeSubstrateModel(
  state: DriftGuardState,
  ordered: string,
  served: string | undefined,
): DriftObservation {
  // Missing/blank delivery is unknown, never evidence of a match.
  if (!normalizeModel(served) || !normalizeModel(ordered)) return { state, marker: null };
  const decision = detectSubstrateDrift(ordered, served);
  const observed = { ...state, ordered: decision.ordered, served: decision.served };
  if (decision.drift && !state.substrateDrift) return { state: { ...observed, substrateDrift: true }, marker: "drift" };
  return { state: observed, marker: null };
}

export function beginDriftTurn(state: DriftGuardState): DriftTurnDecision {
  return { state, recycle: null, modelCall: true, hint: null };
}

export const REPORTING_DRIFT_GUARD: DriftMachine = {
  initial: initialDriftGuardState,
  observe: observeSubstrateModel,
  beginTurn: beginDriftTurn,
};
