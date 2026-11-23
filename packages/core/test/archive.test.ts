import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tarFiles, type TarStats } from '../src/archive/tar.js';

/** A real `git archive` (what GitHub and GitLab serve), with a long path that needs a pax header. */
function gitArchive(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'rs-tar-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'buffer', maxBuffer: 1 << 26 });
  git('init', '-q');
  const deep = `src/${'very-long-directory-name/'.repeat(6)}deep.ts`;
  mkdirSync(join(dir, deep, '..'), { recursive: true });
  writeFileSync(join(dir, deep), 'export const deep = 1;\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.py'), 'def f():\n    return g()\n');
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(5000, 1));
  writeFileSync(join(dir, 'empty.txt'), '');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x');
  // --prefix mimics GitHub's "<owner>-<repo>-<sha>/" top folder.
  return git('archive', '--format=tar', '--prefix=o-r-abc123/', 'HEAD');
}

/** Splits bytes into awkward chunk sizes, as a network stream would. */
async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function collect(bytes: Uint8Array, chunk: number, maxFileBytes = 1 << 20, want?: (p: string, s: number) => boolean) {
  const stats: TarStats = { files: 0, skipped: 0 };
  const out: Record<string, string> = {};
  for await (const f of tarFiles(chunked(bytes, chunk), { maxFileBytes, ...(want ? { want } : {}) }, stats)) out[f.path] = new TextDecoder().decode(f.data);
  return { out, stats };
}

describe('tarFiles', () => {
  const tar = new Uint8Array(gitArchive());

  it('reads every regular file of a git archive, without the top folder, across any chunking', async () => {
    for (const chunk of [7, 512, 4096, 1 << 20]) {
      const { out } = await collect(tar, chunk);
      expect(out['src/a.py']).toBe('def f():\n    return g()\n');
      expect(Object.keys(out).some((p) => p.endsWith('/deep.ts') && p.length > 100)).toBe(true); // pax long path
      expect(out['empty.txt']).toBe('');
      expect(Object.keys(out).every((p) => !p.startsWith('o-r-abc123'))).toBe(true);
    }
  });

  it('skips files over the size limit and files the caller does not want, without reading them', async () => {
    const { out, stats } = await collect(tar, 1000, 1000, (p) => !p.endsWith('.txt'));
    expect(out['big.bin']).toBeUndefined();
    expect(out['empty.txt']).toBeUndefined();
    expect(out['src/a.py']).toBeDefined();
    expect(stats).toEqual({ files: 2, skipped: 2 });
  });

  it('stops cleanly on a truncated archive', async () => {
    const { out } = await collect(tar.subarray(0, 1500), 512);
    expect(Object.keys(out).length).toBeLessThanOrEqual(1);
  });
});
