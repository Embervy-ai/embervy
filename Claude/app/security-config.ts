// Invalid configuration must not disable an expiry or size boundary.
export function positiveFiniteSetting(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
