import { describe, expect, it } from 'vitest';
import { Vault, VaultError, type Area } from '../src/vault.js';

/** In-memory stand-in for chrome.storage.local / .session. */
function area(): Area & { dump(): string } {
  const data = new Map<string, unknown>();
  return {
    async get(key: string) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(key: string) {
      data.delete(key);
    },
    dump: () => JSON.stringify([...data]),
  };
}

const PASS = 'correct horse battery staple';
const KEY = 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE';

async function setUp() {
  const local = area();
  const session = area();
  const vault = new Vault(local, session, { iterations: 1000 });
  await vault.setup(PASS);
  return { local, session, vault };
}

describe('Vault', () => {
  it('starts empty, then stores secrets encrypted at rest', async () => {
    const { local, vault } = await setUp();
    expect(await vault.status()).toBe('unlocked');
    await vault.setSecret('provider:anthropic', KEY);
    expect(await vault.getSecret('provider:anthropic')).toBe(KEY);
    expect(local.dump()).not.toContain(KEY);
    expect(local.dump()).not.toContain(PASS);
    expect(await vault.listSecrets()).toEqual(['provider:anthropic']);
  });

  it('locks: secrets unreadable until unlocked with the right passphrase', async () => {
    const { local, session, vault } = await setUp();
    await vault.setSecret('provider:anthropic', KEY);
    await vault.lock();
    expect(await vault.status()).toBe('locked');
    await expect(vault.getSecret('provider:anthropic')).rejects.toThrow(VaultError);
    await expect(vault.unlock('wrong passphrase!!')).rejects.toThrow(/wrong passphrase/);
    const again = new Vault(local, session, { iterations: 1000 });
    await again.unlock(PASS);
    expect(await again.getSecret('provider:anthropic')).toBe(KEY);
  });

  it('survives a new Vault instance in the same browser session (service worker restart)', async () => {
    const { local, session, vault } = await setUp();
    await vault.setSecret('host:https://github.com', 'ghp_x');
    expect(await new Vault(local, session, { iterations: 1000 }).getSecret('host:https://github.com')).toBe('ghp_x');
  });

  it('detects tampered ciphertext', async () => {
    const { local, vault } = await setUp();
    await vault.setSecret('provider:anthropic', KEY);
    const { vault: stored } = (await local.get('vault')) as { vault: { items: Record<string, { ct: string }> } };
    const item = stored.items['provider:anthropic'];
    if (item) item.ct = `A${item.ct.slice(1)}`;
    await local.set({ vault: stored });
    await expect(vault.getSecret('provider:anthropic')).rejects.toThrow(/could not decrypt/);
  });

  it('uses a fresh nonce per secret', async () => {
    const { local, vault } = await setUp();
    await vault.setSecret('a:x', 'same');
    await vault.setSecret('b:x', 'same');
    const { vault: stored } = (await local.get('vault')) as { vault: { items: Record<string, { iv: string; ct: string }> } };
    expect(stored.items['a:x']?.iv).not.toBe(stored.items['b:x']?.iv);
    expect(stored.items['a:x']?.ct).not.toBe(stored.items['b:x']?.ct);
  });

  it('session-only mode never writes secrets to persistent storage', async () => {
    const local = area();
    const session = area();
    const vault = new Vault(local, session, { iterations: 1000 });
    await vault.useSessionOnly();
    expect(await vault.status()).toBe('session-only');
    await vault.setSecret('provider:anthropic', KEY);
    expect(await vault.getSecret('provider:anthropic')).toBe(KEY);
    expect(local.dump()).not.toContain(KEY);
    expect(local.dump()).toBe('[]');
  });

  it('rejects short passphrases, bad names, and oversized secrets', async () => {
    const vault = new Vault(area(), area(), { iterations: 1000 });
    await expect(vault.setup('short')).rejects.toThrow(/at least 10/);
    const { vault: v } = await setUp();
    await expect(v.setSecret('../x', 'v')).rejects.toThrow(/name/);
    await expect(v.setSecret('provider:x', 'x'.repeat(20_000))).rejects.toThrow(/too long/);
  });

  it('reset deletes everything', async () => {
    const { local, session, vault } = await setUp();
    await vault.setSecret('provider:anthropic', KEY);
    await vault.reset();
    expect(await vault.status()).toBe('none');
    expect(local.dump()).toBe('[]');
    expect(session.dump()).toBe('[]');
  });
});
