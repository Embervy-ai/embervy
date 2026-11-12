export const REQUEST_BODY_MAX = 1024 * 1024;

export async function boundedRequest(req: Request, maxBytes = REQUEST_BODY_MAX): Promise<Request | Response> {
  const tooLarge = () => Response.json({ error: "request body too large" }, { status: 413, headers: { "Cache-Control": "private, no-store" } });
  if (Number(req.headers.get("content-length") || 0) > maxBytes) {
    void req.body?.cancel().catch(() => {});
    return tooLarge();
  }
  if (!req.body) return req;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  } catch {
    return Response.json({ error: "invalid request body" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  } finally {
    reader.releaseLock();
  }
  return new Request(req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks, size), signal: req.signal });
}
