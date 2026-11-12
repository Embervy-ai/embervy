// Defines account selection and rate-limit handling for the model process.

type Env = Record<string, string | undefined>;

export interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;   
  resetsAt?: number;
  isUsingOverage?: boolean;
}

export type FlipOutcome =
  | { kind: "flipped"; from: string; to: string; why: string; notice: string }
  | { kind: "skipped"; reason: string; notice?: string }
  | { kind: "none" };

export interface AccountSeam {
  name(): string | null;
  pipeEnv(): { name: string | null; set: Record<string, string>; unset: string[] };
  factsLead(engineUrl: string | undefined): string;
  statusField(ownLogin: boolean): string;
  commands: readonly string[];
  helpLine: string;
  helpStatusWord: string;
  command(command: string, argument: string, sterile: boolean): { text: string; switched: boolean } | null;
  onRateLimit(info: RateLimitInfo, nowMs: number, sterile: boolean): FlipOutcome;
}

export const STATUS_TOOL_ACCOUNT_WORD = "";

export function accountSeamFromEnv(_env: Env, _stateDir: string, _home?: string): AccountSeam {
  return {
    name: () => null,
    // Unset inherited configuration so the CLI uses its default subscription login.
    pipeEnv: () => ({ name: null, set: {}, unset: ["CLAUDE_CONFIG_DIR"] }),
    factsLead: () => "",
    statusField: () => "",
    commands: [],
    helpLine: "",
    helpStatusWord: "",
    command: () => null,
    onRateLimit: () => ({ kind: "none" }),
  };
}
