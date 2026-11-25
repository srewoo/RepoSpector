import type { Category } from './finding.js';

export interface FingerprintInput {
  readonly file: string;
  readonly category: Category | 'ci';
  readonly claim: string;
  readonly symbol?: string | undefined;
}

/** Lowercase, drop digits (line numbers move between pushes) and punctuation, keep letters in any script. */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a 64-bit over UTF-8 bytes. Sync and dependency-free so it runs in the browser and Node. */
function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Identity of a finding across runs: file, enclosing symbol, category and normalized claim. */
export function fingerprint(input: FingerprintInput): string {
  return fnv1a64([input.file, input.symbol ?? '', input.category, normalizeClaim(input.claim)].join('\u0000'));
}
