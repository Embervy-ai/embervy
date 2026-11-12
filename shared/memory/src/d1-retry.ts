export type RetryPause = (milliseconds: number) => Promise<void>;

const pause: RetryPause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function isRetryableD1Error(error: unknown): boolean {
  const message = error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error ? String(error.message)
    : String(error);
  return [
    "Network connection lost",
    "storage caused object to be reset",
    "reset because its code was updated",
  ].some(text => message.includes(text));
}

export async function retryD1Write<T>(
  write: () => Promise<T>,
  options: { pause?: RetryPause; recover?: () => Promise<T | undefined> } = {},
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isRetryableD1Error(error)) throw error;
    // A lost acknowledgement does not mean an insert failed to commit.
    const recovered = await options.recover?.();
    if (recovered !== undefined) return recovered;
    await (options.pause ?? pause)(2000 + Math.random() * 2000);
    // Keeping this outside the try prevents a retry of the retry.
    return write();
  }
}
