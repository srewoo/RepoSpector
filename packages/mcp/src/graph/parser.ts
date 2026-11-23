import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createExtractor, type Extractor, type FileSymbols, type TreeSitterRuntime } from '@repospector/core';

export { languageFor, MAX_PARSE_BYTES, type CallSite, type DefKind, type FileSymbols, type Inheritance, type SymbolDef } from '@repospector/core';

/** Node host for the core extractor: runtime and grammars come from @vscode/tree-sitter-wasm on disk. */
const require = createRequire(import.meta.url);
const WASM_DIR = dirname(require.resolve('@vscode/tree-sitter-wasm'));
let extractor: Promise<Extractor> | undefined;

async function init(): Promise<Extractor> {
  const ts = require('@vscode/tree-sitter-wasm') as TreeSitterRuntime & { Parser: { init(o: { locateFile: (f: string) => string }): Promise<void> } };
  await ts.Parser.init({ locateFile: (file: string) => join(WASM_DIR, file) });
  return createExtractor(ts, async (file) => join(WASM_DIR, file));
}

export async function extractSymbols(path: string, source: string): Promise<FileSymbols | undefined> {
  extractor ??= init();
  return (await extractor).extractSymbols(path, source);
}
