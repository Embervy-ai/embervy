import { openSync, closeSync, fstatSync, readSync } from "node:fs";

const BLOCK_BYTES = 64 * 1024;

export function readJsonlBatch(path: string, offset: number, maxLines = 50): { lines: string[]; offset: number } {
  const fd = openSync(path, "r");
  const lines: string[] = [];
  let nextOffset = offset;
  try {
    const size = fstatSync(fd).size;
    let position = offset;
    let pending = Buffer.alloc(0);
    while (position < size && lines.length < maxLines) {
      const block = Buffer.alloc(Math.min(BLOCK_BYTES, size - position));
      const count = readSync(fd, block, 0, block.length, position);
      if (!count) break;
      const base = position - pending.length;
      position += count;
      const data = Buffer.concat([pending, block.subarray(0, count)]);
      let start = 0;
      let newline: number;
      while ((newline = data.indexOf(10, start)) >= 0) {
        lines.push(data.subarray(start, newline).toString("utf8"));
        nextOffset = base + newline + 1;
        start = newline + 1;
        if (lines.length === maxLines) return { lines, offset: nextOffset };
      }
      pending = Buffer.from(data.subarray(start));
    }
    return { lines, offset: nextOffset };
  } finally { closeSync(fd); }
}

export class JsonlHistory {
  private entries: any[] = [];
  private offset = 0;
  private pending = Buffer.alloc(0);
  private identity = "";

  constructor(private path: string, private limit = 200, private accept: (entry: any) => boolean = () => true) {}

  private parse(line: Buffer): any | undefined {
    try {
      const entry = JSON.parse(line.toString("utf8"));
      return entry && typeof entry === "object" && this.accept(entry) ? entry : undefined;
    } catch { return undefined; }
  }

  read(): any[] {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "r");
      const stat = fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== this.identity || stat.size < this.offset) {
        this.entries = [];
        this.pending = Buffer.alloc(0);
        let position = stat.size;
        let remainder = Buffer.alloc(0);
        let end = true;
        while (position > 0 && this.entries.length < this.limit) {
          const size = Math.min(BLOCK_BYTES, position);
          position -= size;
          const block = Buffer.alloc(size);
          readSync(fd, block, 0, size, position);
          const data = Buffer.concat([block, remainder]);
          let right = data.length;
          let newline: number;
          while ((newline = data.lastIndexOf(10, right - 1)) >= 0 && right > 0) {
            const line = data.subarray(newline + 1, right);
            if (end) { this.pending = Buffer.from(line); end = false; }
            else {
              const entry = this.parse(line);
              if (entry) this.entries.unshift(entry);
            }
            right = newline;
            if (this.entries.length >= this.limit) break;
          }
          remainder = Buffer.from(data.subarray(0, right));
        }
        if (position === 0 && this.entries.length < this.limit) {
          if (end) this.pending = remainder;
          else {
            const entry = this.parse(remainder);
            if (entry) this.entries.unshift(entry);
          }
        }
        this.offset = stat.size;
        this.identity = identity;
      } else {
        while (this.offset < stat.size) {
          const size = Math.min(BLOCK_BYTES, stat.size - this.offset);
          const block = Buffer.alloc(size);
          const count = readSync(fd, block, 0, size, this.offset);
          if (!count) break;
          this.offset += count;
          const data = Buffer.concat([this.pending, block.subarray(0, count)]);
          let start = 0;
          let newline: number;
          while ((newline = data.indexOf(10, start)) >= 0) {
            const entry = this.parse(data.subarray(start, newline));
            if (entry) {
              this.entries.push(entry);
              if (this.entries.length > this.limit) this.entries.shift();
            }
            start = newline + 1;
          }
          this.pending = Buffer.from(data.subarray(start));
        }
      }
      return this.entries.map(entry => ({ ...entry }));
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
