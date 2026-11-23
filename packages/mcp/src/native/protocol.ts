/**
 * Chrome native messaging framing: each message is a 32-bit length in native byte order
 * (little-endian on every platform Chrome supports) followed by that many bytes of UTF-8 JSON.
 * Chrome accepts at most 1 MB from the host and sends at most 64 MB to it.
 */
export const MAX_TO_CHROME = 1024 * 1024;
export const MAX_FROM_CHROME = 64 * 1024 * 1024;

export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_TO_CHROME) throw new Error(`reply is ${body.length} bytes; Chrome accepts at most ${MAX_TO_CHROME}`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Splits stdin bytes into messages; malformed JSON is reported, never silently skipped. */
export class FrameReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): ({ ok: true; message: unknown } | { ok: false; error: string })[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: ({ ok: true; message: unknown } | { ok: false; error: string })[] = [];
    while (this.buf.length >= 4) {
      const size = this.buf.readUInt32LE(0);
      if (size > MAX_FROM_CHROME) throw new Error(`message of ${size} bytes is over the ${MAX_FROM_CHROME}-byte limit`);
      if (this.buf.length < 4 + size) break;
      const body = this.buf.subarray(4, 4 + size).toString('utf8');
      this.buf = this.buf.subarray(4 + size);
      try {
        out.push({ ok: true, message: JSON.parse(body) as unknown });
      } catch {
        out.push({ ok: false, error: 'message is not valid JSON' });
      }
    }
    return out;
  }
}
