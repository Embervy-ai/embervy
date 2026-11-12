#!/usr/bin/env bun
import { loadHeadState } from "../move";
import { headFile } from "../head-file";

export function effectiveHead(env: Record<string, string | undefined> = process.env): string {
  try {
    return loadHeadState(headFile(env), env).head.name;
  } catch {
    // A diagnostic must not prevent the restart loop from starting the runtime.
    return env.BRAIN_HEAD || "api";
  }
}

if (import.meta.main) console.log(effectiveHead());
