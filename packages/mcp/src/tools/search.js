import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import { capList, capText } from './cap.js';
import { guarded } from './guarded.js';

/** Levenshtein-free near-miss: shared prefix or case-insensitive containment. */
function nearMisses(target, candidates, limit = 5) {
    const t = String(target).toLowerCase();
    return candidates
        .filter((c) => {
            const l = c.toLowerCase();
            return l.includes(t) || t.includes(l) || l.slice(0, 4) === t.slice(0, 4);
        })
        .filter((c) => c !== target)
        .slice(0, limit);
}

/**
 * All known symbol names, straight from the graph.
 *
 * getStats() does not expose a symbol-name list (it only returns
 * nodeCount/relationshipCount/nodesByLabel/relationshipsByType — verified
 * against CodeGraphPipeline.getStats() and KnowledgeGraphService.getStats()),
 * so near-misses are read off the graph's own nodes instead.
 */
function knownSymbolNames(indexer) {
    const nodes = indexer.pipeline.graph?.getAllNodes?.() || [];
    const names = nodes.map((n) => n.properties?.name).filter(Boolean);
    return [...new Set(names)];
}

/**
 * Ordering tiers, matching `reviewScope.reviewPriorityRank`: source outranks
 * prose, prose outranks lockfiles and generated output.
 *
 * A retrieval hit in a changelog is almost never the answer to "how does this
 * work" — `CHANGES.md` came back SECOND for a question about click's completion
 * machinery, ahead of `shell_completion.py`. Retrieval score alone cannot see
 * that, because a changelog genuinely does discuss the topic at length.
 */
function pathTier(filename) {
    const name = String(filename || '');
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i.test(name)) return 3;
    if (/(\.min\.(js|css)|\.map|\.snap)$/i.test(name)) return 3;
    if (/(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS)(\.[a-z]+)?$/i.test(name)) return 3;
    if (/\.(md|markdown|mdx|txt|rst|adoc|asciidoc|org)$/i.test(name)) return 2;
    return 1;
}

/** Trim a snippet to a readable window, saying so when it cuts. */
function windowed(content, maxLines) {
    const lines = String(content).replace(/\s+$/, '').split('\n');
    if (lines.length <= maxLines) return { text: lines.join('\n'), shown: lines.length, total: lines.length };
    return {
        text: lines.slice(0, maxLines).join('\n'),
        shown: maxLines,
        total: lines.length,
    };
}

export const SEARCH_CODE_TOOL = {
    name: 'search_code',
    description:
        'Search the indexed repository for code relevant to a natural-language or keyword query. '
        + 'Hybrid keyword + semantic retrieval. Returns ranked snippets with file paths, line '
        + 'spans and relevance scores, each trimmed to a readable window.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'What to look for.' },
            k: { type: 'integer', description: 'Maximum results (default 10).' },
            max_lines: {
                type: 'integer',
                description: 'Lines of each snippet to show before trimming (default 60). '
                    + 'Raise it to read more of a hit without a second call; the line span '
                    + 'in the header tells you where to open the file yourself.',
            },
            ...REPO_ARG,
        },
        required: ['query'],
    },
    handler: guarded('search_code', async (args, ctx) => {
        const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
        await indexer.ensureIndexed({});
        const limit = args.k || 10;
        const maxLines = Math.max(5, args.max_lines || 60);

        // RAGService.retrieveContext(repoId, query, limit, options) returns a
        // FLAT ARRAY of chunk objects by default (formatOutput defaults to
        // false — see RAGService.js retrieveContext/deduplicateResults),
        // each with .content and .filePath. It is never an object wrapping
        // the chunks, so there is no top-level shape to fall back on.
        const chunks = await indexer.rag.retrieveContext(indexer.repoId, args.query, limit);

        // Collapse hits whose spans overlap in the same file. The RAG layer
        // dedupes per file by COUNT (maxChunksPerFile), which still returned
        // `docs/shell-completion.md` twice — once at :1 and once at :146, the
        // second inside the first — so the same prose was paid for twice.
        const seen = [];
        const deduped = [];
        for (const c of chunks) {
            const start = Number.isFinite(c.startLine) ? c.startLine : null;
            const end = start != null ? start + String(c.content).split('\n').length - 1 : null;
            const overlaps = start != null && seen.some(
                (s) => s.file === c.filePath && start <= s.end && end >= s.start,
            );
            if (overlaps) continue;
            if (start != null) seen.push({ file: c.filePath, start, end });
            deduped.push({ ...c, _start: start, _end: end });
        }

        // Stable sort: keep retrieval order within a tier, demote prose and
        // generated files below source.
        const ordered = deduped
            .map((c, i) => ({ c, i, tier: pathTier(c.filePath) }))
            .sort((a, b) => (a.tier - b.tier) || (a.i - b.i))
            .map(({ c }) => c);

        if (ordered.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `No indexed content matched "${args.query}". `
                        + 'Absence from this index is not absence from the repository: '
                        + 'call repo_overview to check what was indexed, or index_repo if it may be stale.',
                }],
            };
        }

        const capped = capList(
            ordered,
            (c) => {
                // startLine is genuinely optional: RAGService.js sets it to
                // `chunk.startLine ?? null` when building chunks.
                const span = c._start != null
                    ? `:${c._start}-${c._end}`
                    : '';
                const raw = c.relevanceScore ?? c.score;
                const score = Number.isFinite(raw) ? ` (score ${Number(raw).toFixed(3)})` : '';
                const win = windowed(c.content, maxLines);
                const note = win.shown < win.total
                    ? `\n… ${win.total - win.shown} more lines in this chunk — open ${c.filePath} or raise max_lines`
                    : '';
                return `--- ${c.filePath}${span}${score}\n${win.text.trim()}${note}`;
            },
            ctx.config.maxToolTokens,
        );

        return { content: [{ type: 'text', text: capped.text }] };
    }),
};

export const GET_SYMBOL_TOOL = {
    name: 'get_symbol',
    description:
        'Look up one symbol (function, class, method) and return where it is defined, its span, '
        + 'and its immediate graph neighbours. Returns paths and line spans, not whole files — '
        + 'read the file yourself if you need the body.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Exact symbol name.' },
            ...REPO_ARG,
        },
        required: ['name'],
    },
    handler: guarded('get_symbol', async (args, ctx) => {
        const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
        await indexer.ensureIndexed({});

        // getSymbolContext returns a formatted STRING (multi-section prose:
        // symbol view, impact, process flow, community) or null — never an
        // object with separate span/path fields. The path:line already
        // appears inline in that text (see CodeGraphPipeline._getSymbolView).
        const view = indexer.pipeline.getSymbolContext(args.name);
        if (!view) {
            // Offer near-misses: a model handed a bare "not found" retries blindly.
            const known = knownSymbolNames(indexer);
            const suggestions = nearMisses(args.name, known);
            const hint = suggestions.length
                ? ` Did you mean: ${suggestions.join(', ')}?`
                : ' Call repo_overview to confirm the index is built.';
            return {
                content: [{ type: 'text', text: `No symbol named "${args.name}" in the index.${hint}` }],
            };
        }

        const capped = capText(view, ctx.config.maxToolTokens);
        const text = capped.truncated ? `${capped.text}\n\n[${capped.note}]` : capped.text;
        return { content: [{ type: 'text', text }] };
    }),
};

export const FIND_CALLERS_TOOL = {
    name: 'find_callers',
    description:
        'List the call sites of a symbol, with the confidence the graph assigns to each edge.',
    inputSchema: {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Exact symbol name.' },
            limit: { type: 'integer', description: 'Maximum call sites (default 20).' },
            ...REPO_ARG,
        },
        required: ['symbol'],
    },
    handler: guarded('find_callers', async (args, ctx) => {
        const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
        await indexer.ensureIndexed({});

        // getCallerRefs returns an array of {name, filePath, startLine, confidence}
        // — verified against CodeGraphPipeline.getCallerRefs. startLine can be
        // null (caller.properties?.startLine ?? null), confidence is always a number.
        const refs = indexer.pipeline.getCallerRefs(args.symbol, args.limit || 20) || [];
        if (refs.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `Nothing in the index calls "${args.symbol}". It may be an entry point, `
                        + 'called dynamically, or called from a file type the parser does not cover.',
                }],
            };
        }

        const capped = capList(
            refs,
            (r) => {
                const line = r.startLine != null ? r.startLine : '?';
                return `${r.filePath}:${line} — ${r.name} (confidence ${r.confidence})`;
            },
            ctx.config.maxToolTokens,
        );
        return { content: [{ type: 'text', text: capped.text }] };
    }),
};
