import { definedNameAny, isTestPath } from './symbols.js';

/** One grep match: a whole-word occurrence of a symbol. `text` is repository content, untrusted. */
export interface WordHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface ClassifiedHits {
  /** Lines that define the symbol; non-test files first. */
  readonly definitions: WordHit[];
  /** Every other occurrence; non-test files first. */
  readonly usages: WordHit[];
}

const byTestLast = (a: WordHit, b: WordHit): number => Number(isTestPath(a.file)) - Number(isTestPath(b.file));

/** Split grep hits for one symbol into its definitions and its uses. Lexical: no parser, no scopes. */
export function classifyHits(name: string, hits: readonly WordHit[]): ClassifiedHits {
  const definitions: WordHit[] = [];
  const usages: WordHit[] = [];
  for (const h of hits) (definedNameAny(h.text, h.file) === name ? definitions : usages).push(h);
  return { definitions: definitions.sort(byTestLast), usages: usages.sort(byTestLast) };
}
