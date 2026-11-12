export function invalidIntegerQuery(url: URL, fields: ReadonlyArray<readonly [string, number, number]>): string | null {
  for (const [name, min, max] of fields) {
    for (const raw of url.searchParams.getAll(name)) {
      const value = Number(raw);
      if (!raw.trim() || !Number.isSafeInteger(value) || value < min || value > max) return name;
    }
  }
  return null;
}

export async function boundedBody(request: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const reject = (error: string, status: number) => Response.json({ error }, { status });
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    void request.body?.cancel().catch(() => {});
    return reject("invalid Content-Length", 400);
  }
  if (Number(declared) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    return reject("request body too large", 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextSize = size + value.byteLength;
      if (nextSize > maxBytes) {
        void reader.cancel().catch(() => {});
        return reject("request body too large", 413);
      }
      // Retaining each tiny chunk separately would leave allocation overhead unbounded.
      if (nextSize > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextSize, bytes.length * 2, 65536)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(value, size);
      size = nextSize;
    }
  } catch {
    return reject("invalid request body", 400);
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}
