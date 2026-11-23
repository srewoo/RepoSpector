import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createContextServer } from '../src/context-server.js';
import { git, makeRepo, write } from './helpers.js';

describe('context-only server', () => {
  it('exposes just get_context, answering at the fixed commit from the stored graph', async () => {
    const { root } = makeRepo();
    write(root, 'src/use.js', 'import { total } from "./cart";\nexport function pay(items) { return total(items); }\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'use');
    const head = git(root, 'rev-parse', 'HEAD');
    const server = await createContextServer({ root, head, cacheDir: mkdtempSync(join(tmpdir(), 'rs-ctx-cache-')) });
    const client = new Client({ name: 't', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['get_context']);
    const res = (await client.callTool({ name: 'get_context', arguments: { symbol: 'total' } })) as { content: { text: string }[] };
    const data = JSON.parse(res.content[0]?.text ?? '{}') as { index: string; usages: { kind: string; caller?: string }[] };
    expect(data.index).toBe('graph');
    expect(data.usages.filter((u) => u.kind === 'call').map((u) => u.caller)).toEqual(['pay']);
  });

  it('refuses a head that is not a full commit id', async () => {
    const { root } = makeRepo();
    await expect(createContextServer({ root, head: 'main', cacheDir: mkdtempSync(join(tmpdir(), 'rs-ctx-cache-')) })).rejects.toThrow(/full commit/);
  });
});
