// byte-range.ts — one `Range: bytes=…` header against an object of known size.
// Safari on iOS plays a video only when the server answers byte ranges (it
// asks for bytes=0-1 first); the memory worker serves videos from R2, so it
// has to cut the object itself. One range only — multipart ranges answer the
// whole object, which every client accepts.

export type ByteRange = { offset: number; length: number };

/**
 * null = no usable range (absent, malformed or several): serve the whole object.
 * "unsatisfiable" = a well-formed range outside the object: answer 416.
 */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (size <= 0) return "unsatisfiable";
  if (m[1] === "") {
    // suffix range: the last N bytes
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return "unsatisfiable";
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

/** The Content-Range value for a served range. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
}
