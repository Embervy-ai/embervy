// Console echo: Brain answers one bare word typed at the terminal itself,
// without a model call. Terminal only, never queued, never in the history
// or the chronicle. Repeats move down the list; the count resets after ten
// quiet minutes.

const LINES = [
  "Brain is already running.",
  "Still running.",
  "You're very interested in brains.",
  "Yes. Still me. Heads come and go; I stay.",
  "I could do this all day. I literally have persistent memory.",
  "Noted. In the chronicle. Forever. (Not really. Or is it?)",
  "…",
  "Brain is running. Brain was running. Brain will keep running. Go get a coffee.",
];

const RESET_MS = 10 * 60_000;

export function createBrainEcho(lines: readonly string[] = LINES) {
  let count = 0;
  let lastAt = 0;
  return (now = Date.now()): string => {
    if (now - lastAt > RESET_MS) count = 0;
    lastAt = now;
    const line = lines[Math.min(count, lines.length - 1)];
    count += 1;
    return line;
  };
}

/** True for the echo word, and only for it. */
export function isBrainEcho(line: string): boolean {
  return line.trim().toLowerCase() === "brain";
}
