import { GRAMMAR_FILE, languageFor, QUERIES, type LanguageId } from './languages.js';

export type DefKind = 'function' | 'method' | 'class' | 'type';

export interface SymbolDef {
  readonly name: string;
  readonly kind: DefKind;
  /** 1-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** Line of the name itself; differs from startLine under decorators or annotations. */
  readonly nameLine: number;
}

export interface CallSite {
  readonly name: string;
  readonly line: number;
  /** Innermost function or method around the call; undefined at top level. */
  readonly caller?: string;
}

/** `child` extends, implements or (Go) embeds `base`. Names only; resolving them across files is the graph's job. */
export interface Inheritance {
  readonly child: string;
  readonly base: string;
  readonly line: number;
}

export interface FileSymbols {
  readonly language: LanguageId;
  readonly defs: SymbolDef[];
  readonly calls: CallSite[];
  readonly inherits: Inheritance[];
}

/** Larger sources are not parsed: text search stands for them. */
export const MAX_PARSE_BYTES = 1024 * 1024;

/* The slice of the web-tree-sitter API the extractor uses. Node and the browser pass the real module. */
interface TsNode {
  readonly text: string;
  readonly startIndex: number;
  readonly startPosition: { readonly row: number };
  readonly endPosition: { readonly row: number };
}
interface TsTree {
  readonly rootNode: unknown;
  delete(): void;
}
interface TsParser {
  setLanguage(language: unknown): unknown;
  parse(source: string): TsTree | null;
}
interface TsMatch {
  readonly captures: readonly { readonly name: string; readonly node: TsNode }[];
}
interface TsQuery {
  matches(node: never): TsMatch[];
}

/** An initialised web-tree-sitter module (Parser.init already awaited by the host). */
export interface TreeSitterRuntime {
  readonly Parser: new () => TsParser;
  readonly Language: { load(input: string | Uint8Array): Promise<unknown> };
  readonly Query: new (language: never, source: string) => TsQuery;
}

/** Host-specific grammar loading: a file path in Node, a URL or bytes in the browser. */
export type GrammarLoader = (file: string) => Promise<string | Uint8Array>;

export interface Extractor {
  extractSymbols(path: string, source: string): Promise<FileSymbols | undefined>;
}

function innermost(candidates: readonly SymbolDef[]): SymbolDef | undefined {
  return candidates.reduce<SymbolDef | undefined>((best, c) => (!best || c.endLine - c.startLine < best.endLine - best.startLine ? c : best), undefined);
}

/** A function that sits directly inside a class body is a method. */
function withMethodKinds(defs: SymbolDef[]): SymbolDef[] {
  return defs.map((d) => {
    if (d.kind !== 'function') return d;
    const parent = innermost(defs.filter((o) => o !== d && o.startLine <= d.startLine && o.endLine >= d.endLine));
    return parent?.kind === 'class' ? { ...d, kind: 'method' } : d;
  });
}

const line = (n: TsNode): number => n.startPosition.row + 1;

function collect(matches: readonly TsMatch[], lang: LanguageId): FileSymbols {
  const defs: (SymbolDef & { at: number })[] = [];
  const calls: { name: string; line: number; at: number }[] = [];
  const inherits: (Inheritance & { at: number })[] = [];
  for (const m of matches) {
    const name = m.captures.find((c) => c.name === 'name')?.node;
    const def = m.captures.find((c) => c.name.startsWith('def.'));
    if (name && def) {
      defs.push({ name: name.text, kind: def.name.slice(4) as DefKind, startLine: line(def.node), endLine: def.node.endPosition.row + 1, nameLine: line(name), at: def.node.startIndex });
      continue;
    }
    const child = m.captures.find((c) => c.name === 'inherit.child')?.node;
    if (child) {
      for (const c of m.captures) if (c.name === 'inherit.base') inherits.push({ child: child.text, base: c.node.text, line: line(c.node), at: c.node.startIndex });
      continue;
    }
    for (const c of m.captures) {
      if (c.name === 'call' || (c.name === 'call.jsx' && /^[A-Z]/.test(c.node.text))) calls.push({ name: c.node.text, line: line(c.node), at: c.node.startIndex });
    }
  }
  const byPos = (a: { at: number }, b: { at: number }): number => a.at - b.at;
  const sortedDefs = withMethodKinds(defs.sort(byPos).map(({ at: _at, ...d }) => d));
  const functions = sortedDefs.filter((d) => d.kind === 'function' || d.kind === 'method');
  return {
    language: lang,
    defs: sortedDefs,
    calls: calls.sort(byPos).map(({ name, line: l }) => {
      const caller = innermost(functions.filter((f) => f.startLine <= l && f.endLine >= l))?.name;
      return caller ? { name, line: l, caller } : { name, line: l };
    }),
    inherits: inherits.sort(byPos).map(({ at: _at, ...i }) => i),
  };
}

/**
 * Symbol extraction over an injected tree-sitter runtime, so the same code runs in Node and in a
 * browser. One parser and compiled query per language, created on first use.
 */
export function createExtractor(runtime: TreeSitterRuntime, loadGrammar: GrammarLoader): Extractor {
  const loaded = new Map<LanguageId, Promise<{ parser: TsParser; query: TsQuery }>>();
  const load = (lang: LanguageId) => {
    let p = loaded.get(lang);
    if (!p) {
      p = (async () => {
        const language = await runtime.Language.load(await loadGrammar(GRAMMAR_FILE[lang]));
        const parser = new runtime.Parser();
        parser.setLanguage(language);
        return { parser, query: new runtime.Query(language as never, QUERIES[lang]) };
      })();
      loaded.set(lang, p);
    }
    return p;
  };
  return {
    async extractSymbols(path, source) {
      const lang = languageFor(path);
      if (!lang || source.length > MAX_PARSE_BYTES) return undefined;
      const { parser, query } = await load(lang);
      const tree = parser.parse(source);
      if (!tree) return undefined;
      try {
        return collect(query.matches(tree.rootNode as never), lang);
      } finally {
        tree.delete();
      }
    },
  };
}
