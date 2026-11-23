import { describe, expect, it } from 'vitest';
import { testSecret } from '../src/key-test.js';

// Opt-in: LIVE_GH_TOKEN=$(gh auth token) npx vitest run packages/extension/test/live-key-test.test.ts
const token = process.env.LIVE_GH_TOKEN;

describe.skipIf(!token)('Test token against real GitHub (read-only GET /user)', () => {
  it('names the signed-in account, and a bad token is rejected', async () => {
    const hosts = [{ kind: 'github' as const, origin: 'https://github.com' }];
    expect(await testSecret('host:https://github.com', token ?? '', { hosts })).toMatch(/^Token works: signed in as \S+\. (It can post draft reviews|It can read public pull requests but cannot post|This is a fine-grained token)/);
    await expect(testSecret('host:https://github.com', 'ghp_000000000000000000000000000000000000', { hosts })).rejects.toThrow(/GitHub rejected this token \(401\)/);
  }, 60_000);
});
