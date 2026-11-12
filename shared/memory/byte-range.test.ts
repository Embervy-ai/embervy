// Byte ranges for memory videos: iOS Safari plays a video
// only when the server answers its range requests.
import { expect, test } from "bun:test";
import { contentRange, parseByteRange } from "./src/byte-range";

test("parseByteRange: the ranges a video player sends", () => {
  expect(parseByteRange("bytes=0-1", 1000)).toEqual({ offset: 0, length: 2 });
  expect(parseByteRange("bytes=500-", 1000)).toEqual({ offset: 500, length: 500 });
  expect(parseByteRange("bytes=900-5000", 1000)).toEqual({ offset: 900, length: 100 });
  expect(parseByteRange("bytes=-100", 1000)).toEqual({ offset: 900, length: 100 });
  expect(parseByteRange("bytes=-5000", 1000)).toEqual({ offset: 0, length: 1000 });
});

test("parseByteRange: no usable range serves the whole object, an impossible one is 416", () => {
  for (const h of [null, undefined, "", "bytes=", "bytes=-", "items=0-1", "bytes=0-1,5-9", "bytes=a-b"]) expect(parseByteRange(h, 1000)).toBeNull();
  for (const h of ["bytes=1000-", "bytes=1000-1001", "bytes=5-2", "bytes=-0"]) expect(parseByteRange(h, 1000)).toBe("unsatisfiable");
  expect(parseByteRange("bytes=0-1", 0)).toBe("unsatisfiable");
});

test("contentRange", () => {
  expect(contentRange({ offset: 0, length: 2 }, 1000)).toBe("bytes 0-1/1000");
  expect(contentRange({ offset: 900, length: 100 }, 1000)).toBe("bytes 900-999/1000");
});
