import { createExtractor, type Extractor, type TreeSitterRuntime } from '@repospector/core';
import { idbCache } from './cache.js';
import { buildIndex, NoSavedIndex } from './index-archive.js';
import type { GraphEvent, GraphJob } from './messages.js';

/**
 * Classic worker (not a module) so it can load tree-sitter's UMD runtime with importScripts. Started
 * by the offscreen document for one job and terminated after it. Runtime and grammars ship in the
 * extension under ts/; the index is saved in IndexedDB on this machine (repospector-index).
 */
const scope = self as unknown as {
  importScripts(...urls: string[]): void;
  Parser?: TreeSitterRuntime & { Parser: { init(o: { locateFile: (f: string) => string }): Promise<void> } };
  onmessage: ((ev: MessageEvent<GraphJob>) => void) | null;
  postMessage(m: GraphEvent): void;
};

const asset = (file: string): string => new URL(`ts/${file}`, self.location.href).href;

async function loadExtractor(): Promise<Extractor> {
  // tree-sitter.js finds its own URL via Node's __filename or a page's document.currentScript, and a
  // worker has neither. This single-job worker gets a minimal stand-in pointing at the runtime file
  // (the vendor file stays unmodified); the worker is terminated after the job.
  (self as unknown as { document?: unknown }).document = { currentScript: { src: asset('tree-sitter.js') } };
  scope.importScripts(asset('tree-sitter.js'));
  const ts = scope.Parser;
  if (!ts) throw new Error('the parser did not load');
  await ts.Parser.init({ locateFile: asset });
  return createExtractor(ts, async (file) => new Uint8Array(await (await fetch(asset(file))).arrayBuffer()));
}

/** The parser loads only if something needs parsing: a saved commit needs none. */
function lazyExtractor(): Extractor {
  let loaded: Promise<Extractor> | undefined;
  return { extractSymbols: async (path, source) => (await (loaded ??= loadExtractor())).extractSymbols(path, source) };
}

scope.onmessage = (ev) => {
  const job = ev.data;
  const started = Date.now();
  void (async () => {
    try {
      const r = await buildIndex(job, {
        fetch: (input, init) => fetch(input, init),
        extractor: lazyExtractor(),
        cache: idbCache(),
        now: () => Date.now(),
        onProgress: (files, bytes) => scope.postMessage({ type: 'progress', files, downloadedMB: Math.round(bytes / 1024 / 1024) }),
      });
      scope.postMessage({ type: 'done', source: r.source, files: r.files, skipped: r.skipped, reused: r.reused, ms: Date.now() - started, context: r.context });
    } catch (e) {
      scope.postMessage({ type: 'error', message: (e as Error).message, ...(e instanceof NoSavedIndex ? { noSavedIndex: true } : {}) });
    }
  })();
};
