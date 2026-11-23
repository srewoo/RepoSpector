/**
 * Streaming reader for the tar archives GitHub and GitLab serve (`git archive` output: ustar with pax
 * headers). Yields regular files only, with the archive's top folder (`<repo>-<sha>/`) removed.
 * Files over `maxFileBytes` are skipped without buffering them. No Node or DOM APIs: runs anywhere.
 */
export interface TarFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface TarOptions {
  /** Larger files are skipped (counted in `skipped`), never held in memory. */
  readonly maxFileBytes: number;
  /** Return false to skip a file by path before its bytes are read. */
  readonly want?: (path: string, size: number) => boolean;
}

export interface TarStats {
  files: number;
  skipped: number;
}

const BLOCK = 512;
const decoder = new TextDecoder();

/** Reads exactly n bytes across chunk boundaries, or fewer at the end of the stream. */
class ByteReader {
  private buf = new Uint8Array(0);
  private done = false;
  constructor(private readonly it: AsyncIterator<Uint8Array>) {}

  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else {
        const next = new Uint8Array(this.buf.length + r.value.length);
        next.set(this.buf);
        next.set(r.value, this.buf.length);
        this.buf = next;
      }
    }
  }

  async read(n: number): Promise<Uint8Array> {
    await this.fill(n);
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(Math.min(n, this.buf.length));
    return out;
  }

  /** Discards n bytes without keeping more than one chunk. */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0) {
        await this.fill(1);
        if (this.buf.length === 0) return;
      }
      const take = Math.min(left, this.buf.length);
      this.buf = this.buf.subarray(take);
      left -= take;
    }
  }
}

const field = (h: Uint8Array, start: number, len: number): string => {
  const raw = h.subarray(start, start + len);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
};
const octal = (h: Uint8Array, start: number, len: number): number => parseInt(field(h, start, len).trim() || '0', 8);
const padded = (size: number): number => Math.ceil(size / BLOCK) * BLOCK;

/** pax extended header records: "<len> key=value\n". Only `path` matters here. */
function paxPath(data: Uint8Array): string | undefined {
  const text = decoder.decode(data);
  for (const line of text.split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

const stripTop = (p: string): string => p.replace(/^\.?\//, '').split('/').slice(1).join('/');

export async function* tarFiles(chunks: AsyncIterable<Uint8Array>, opts: TarOptions, stats: TarStats = { files: 0, skipped: 0 }): AsyncGenerator<TarFile> {
  const r = new ByteReader(chunks[Symbol.asyncIterator]());
  let longName: string | undefined;
  for (;;) {
    const h = await r.read(BLOCK);
    if (h.length < BLOCK || h.every((b) => b === 0)) return; // end of archive
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    if (type === 'x' || type === 'L') {
      // Extended header for the next entry (pax), or a GNU long name.
      const data = await r.read(size);
      await r.skip(padded(size) - size);
      longName = type === 'x' ? paxPath(data) : field(data, 0, size);
      continue;
    }
    const prefix = field(h, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    longName = undefined;
    const path = stripTop(name);
    const regular = type === '0' || type === '\0';
    if (!regular || !path || size > opts.maxFileBytes || (opts.want && !opts.want(path, size))) {
      if (regular && path) stats.skipped++;
      await r.skip(padded(size));
      continue;
    }
    const data = await r.read(size);
    await r.skip(padded(size) - size);
    stats.files++;
    yield { path, data };
  }
}
