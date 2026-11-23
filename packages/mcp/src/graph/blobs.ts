import { spawn } from 'node:child_process';

/** Upper bound on content read through one cat-file process, so memory stays bounded. */
const BATCH_BYTES = 32 * 1024 * 1024;

/**
 * Reads blobs by id through `git cat-file --batch`, one process per batch instead of one per
 * file. Yields [blob, content]; blobs git cannot find are skipped.
 */
export async function* readBlobs(root: string, blobs: readonly { blob: string; size: number }[]): AsyncGenerator<[string, string]> {
  let batch: string[] = [];
  let bytes = 0;
  for (const b of blobs) {
    if (!/^[0-9a-f]{40,64}$/.test(b.blob)) continue;
    if (batch.length > 0 && bytes + b.size > BATCH_BYTES) {
      yield* await catBatch(root, batch);
      batch = [];
      bytes = 0;
    }
    batch.push(b.blob);
    bytes += b.size;
  }
  if (batch.length > 0) yield* await catBatch(root, batch);
}

function catBatch(root: string, blobs: readonly string[]): Promise<[string, string][]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      resolve(parseBatch(Buffer.concat(chunks)));
    });
    child.stdin.end(blobs.join('\n') + '\n');
  });
}

/** `<id> blob <size>\n<content>\n` records; `<id> missing\n` for unknown ids. */
export function parseBatch(buf: Buffer): [string, string][] {
  const out: [string, string][] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    pos = nl + 1;
    if (header[1] !== 'blob' || header[2] === undefined) continue;
    const size = Number(header[2]);
    out.push([header[0] ?? '', buf.subarray(pos, pos + size).toString('utf8')]);
    pos += size + 1;
  }
  return out;
}
