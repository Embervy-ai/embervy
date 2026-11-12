// Loads installer feature defaults for devices.
// Device choices take precedence.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function houseFeatureDefaults(home: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  try {
    const raw = JSON.parse(readFileSync(join(home, "config", "features.json"), "utf8"));
    for (const [key, value] of Object.entries(raw ?? {})) if (typeof value === "boolean") flags[key] = value;
    // The installer has one switch for what the gear shows as two.
    if (typeof raw?.voice_transcription === "boolean") flags.voice = flags.whisper = raw.voice_transcription;
  } catch { /* no file: every feature keeps the app's own default */ }
  return flags;
}
