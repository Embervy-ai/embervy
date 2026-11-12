import { expect, test } from "bun:test";
import { createBrainEcho, isBrainEcho } from "./echo";

test("brain, brain, brain: Brain gets more annoyed, then stays at the last line", () => {
  const echo = createBrainEcho();
  const t = 1_000_000;
  expect(echo(t)).toBe("Brain is already running.");
  expect(echo(t + 1)).toBe("Still running.");
  expect(echo(t + 2)).toBe("You're very interested in brains.");
  for (let i = 0; i < 10; i++) echo(t + 3 + i);
  expect(echo(t + 20)).toContain("Go get a coffee.");
});

test("ten quiet minutes and Brain has calmed down", () => {
  const echo = createBrainEcho();
  echo(0); echo(1); echo(2);
  expect(echo(2 + 10 * 60_000 + 1)).toBe("Brain is already running.");
});

test("only the bare word triggers it", () => {
  expect(isBrainEcho("brain")).toBe(true);
  expect(isBrainEcho("  Brain ")).toBe(true);
  expect(isBrainEcho("brain status")).toBe(false);
  expect(isBrainEcho("/brain")).toBe(false);
});
