/**
 * Encrypted store for model keys and git tokens.
 *
 * At rest (chrome.storage.local): AES-GCM-256 ciphertext per secret, each with a fresh 96-bit nonce,
 * under a key derived from the user's passphrase with PBKDF2-SHA-256. The passphrase is never stored.
 * Unlocked (chrome.storage.session: memory only, extension pages only, gone when the browser closes):
 * the derived key. Session-only mode keeps the secrets themselves in session storage and nothing on disk.
 * Secrets are never logged and never handed to content scripts.
 */

export interface Area {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export type VaultStatus = 'none' | 'locked' | 'unlocked' | 'session-only';

export class VaultError extends Error {}

interface Sealed {
  readonly iv: string;
  readonly ct: string;
}

interface StoredVault {
  readonly v: 1;
  readonly salt: string;
  readonly iterations: number;
  readonly check: Sealed;
  readonly items: Record<string, Sealed>;
}

/** OWASP 2023 guidance for PBKDF2-HMAC-SHA256. Tests pass a lower count. */
export const DEFAULT_ITERATIONS = 600_000;
const MIN_PASSPHRASE = 10;
const MAX_SECRET = 16_384;
const NAME = /^[a-z]+:[A-Za-z0-9:/._-]{1,200}$/;
const CHECK = 'repospector-vault-check';
const LOCAL_KEY = 'vault';
const SESSION_KEY = 'vaultKey';
const SESSION_SECRETS = 'vaultSessionSecrets';

const b64 = (bytes: ArrayBuffer | Uint8Array): string => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = new TextEncoder();

export class Vault {
  private readonly iterations: number;

  constructor(
    private readonly local: Area,
    private readonly session: Area,
    opts: { iterations?: number } = {},
  ) {
    this.iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  }

  async status(): Promise<VaultStatus> {
    if ((await this.session.get(SESSION_SECRETS))[SESSION_SECRETS]) return 'session-only';
    if (!(await this.stored())) return 'none';
    return (await this.session.get(SESSION_KEY))[SESSION_KEY] ? 'unlocked' : 'locked';
  }

  /** Creates the vault with a new passphrase and leaves it unlocked. Replaces any existing vault. */
  async setup(passphrase: string): Promise<void> {
    if (passphrase.length < MIN_PASSPHRASE) throw new VaultError(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const raw = await this.derive(passphrase, salt, this.iterations);
    const key = await this.importKey(raw);
    const vault: StoredVault = { v: 1, salt: b64(salt), iterations: this.iterations, check: await seal(key, CHECK), items: {} };
    await this.session.remove(SESSION_SECRETS);
    await this.local.set({ [LOCAL_KEY]: vault });
    await this.session.set({ [SESSION_KEY]: b64(raw) });
  }

  async unlock(passphrase: string): Promise<void> {
    const vault = await this.stored();
    if (!vault) throw new VaultError('no vault yet; set a passphrase first');
    const raw = await this.derive(passphrase, unb64(vault.salt), vault.iterations);
    const ok = await open(await this.importKey(raw), vault.check).then((t) => t === CHECK, () => false);
    if (!ok) throw new VaultError('wrong passphrase');
    await this.session.set({ [SESSION_KEY]: b64(raw) });
  }

  async lock(): Promise<void> {
    await this.session.remove(SESSION_KEY);
  }

  /** Secrets held in memory only, for this browser session; nothing is written to disk. */
  async useSessionOnly(): Promise<void> {
    await this.session.set({ [SESSION_SECRETS]: {} });
  }

  async setSecret(name: string, value: string): Promise<void> {
    if (!NAME.test(name)) throw new VaultError('invalid secret name');
    if (value.length === 0 || value.length > MAX_SECRET) throw new VaultError('secret is empty or too long');
    const mem = await this.sessionSecrets();
    if (mem) return this.session.set({ [SESSION_SECRETS]: { ...mem, [name]: value } });
    const vault = await this.requireStored();
    await this.local.set({ [LOCAL_KEY]: { ...vault, items: { ...vault.items, [name]: await seal(await this.key(), value) } } });
  }

  async getSecret(name: string): Promise<string | undefined> {
    const mem = await this.sessionSecrets();
    if (mem) return mem[name];
    const vault = await this.requireStored();
    const sealed = vault.items[name];
    if (!sealed) return undefined;
    try {
      return await open(await this.key(), sealed);
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError('could not decrypt; the stored secret was changed or the vault is damaged');
    }
  }

  async removeSecret(name: string): Promise<void> {
    const mem = await this.sessionSecrets();
    if (mem) {
      const { [name]: _gone, ...rest } = mem;
      return this.session.set({ [SESSION_SECRETS]: rest });
    }
    const vault = await this.requireStored();
    const { [name]: _gone, ...items } = vault.items;
    await this.local.set({ [LOCAL_KEY]: { ...vault, items } });
  }

  /** Names only, never values. */
  async listSecrets(): Promise<string[]> {
    const mem = await this.sessionSecrets();
    if (mem) return Object.keys(mem).sort();
    return Object.keys((await this.stored())?.items ?? {}).sort();
  }

  async reset(): Promise<void> {
    await this.local.remove(LOCAL_KEY);
    await this.session.remove(SESSION_KEY);
    await this.session.remove(SESSION_SECRETS);
  }

  private async stored(): Promise<StoredVault | undefined> {
    return (await this.local.get(LOCAL_KEY))[LOCAL_KEY] as StoredVault | undefined;
  }

  private async requireStored(): Promise<StoredVault> {
    const v = await this.stored();
    if (!v) throw new VaultError('no vault yet; set a passphrase first');
    return v;
  }

  private async sessionSecrets(): Promise<Record<string, string> | undefined> {
    return (await this.session.get(SESSION_SECRETS))[SESSION_SECRETS] as Record<string, string> | undefined;
  }

  private async key(): Promise<CryptoKey> {
    const raw = (await this.session.get(SESSION_KEY))[SESSION_KEY];
    if (typeof raw !== 'string') throw new VaultError('the vault is locked; unlock it with your passphrase');
    return this.importKey(unb64(raw));
  }

  private async derive(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
    const base = await crypto.subtle.importKey('raw', utf8.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  }

  private importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
}

async function seal(key: CryptoKey, text: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(text))) };
}

async function open(key: CryptoKey, sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct));
  return new TextDecoder().decode(plain);
}
