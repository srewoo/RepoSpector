/**
 * ReviewGraphContextService — injects code-knowledge-graph context into PR review.
 *
 * This is what lets the reviewer catch bugs that depend on code OUTSIDE the diff:
 * a changed signature whose callers were not updated, a narrowed return type that
 * breaks a consumer, a behaviour change in a function with no test covering it.
 * A diff alone cannot show any of that.
 *
 * The context is built SYMBOL-FIRST rather than blob-first. The previous version
 * passed the whole added-lines blob to `getContextForQuestion`, a chat-oriented
 * entry point that guesses at symbol mentions — so the reviewer got a generic
 * neighbourhood dump. Here we extract the symbols the diff actually defines or
 * modifies and ask the graph precise questions about each:
 *
 *   callers          → who breaks if this contract changed
 *   blast radius     → how far a behaviour change propagates
 *   untested-in-blast→ which impacted code has no test (TESTED_BY edges)
 *   safety check     → the graph's own risk read on touching this symbol
 *
 * Fully local: the graph lives in IndexedDB and is queried in-process. No network.
 */

import { resolveBudget } from '../utils/reviewContextBudget.js';
import { CallerSourceService } from './CallerSourceService.js';

/** Identifiers that are never worth a graph lookup. */
const NOISE = new Set([
    'if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var',
    'class', 'new', 'this', 'true', 'false', 'null', 'undefined', 'import',
    'export', 'default', 'async', 'await', 'try', 'catch', 'throw', 'typeof',
    'def', 'self', 'func', 'type', 'struct', 'interface', 'package', 'public',
    'private', 'static', 'void', 'int', 'string', 'bool', 'err', 'nil',
]);

/**
 * Declaration patterns across the languages RepoSpector supports. Matching the
 * DECLARATION (not every mention) is what keeps the symbol set small and the
 * graph queries relevant — a diff mentions hundreds of identifiers but usually
 * defines a handful.
 */
const DECL_PATTERNS = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,   // js/ts
    /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,   // js/ts/py
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, // js arrow fn
    /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g, // ts
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm,                   // python
    /func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g,                   // go
    /^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm, // java-ish
    /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm,                   // bare method
];

export class ReviewGraphContextService {
    /**
     * @param {Object} deps
     * @param {Object} deps.codeGraphPipeline
     * @param {Object} [deps.vectorStore] - when present, the callers the graph
     *   names also get their SOURCE inlined; without it the service behaves
     *   exactly as it did before, emitting summaries only.
     */
    constructor({ codeGraphPipeline, vectorStore } = {}) {
        this.pipeline = codeGraphPipeline;
        this.callerSource = vectorStore
            ? new CallerSourceService({ codeGraphPipeline, vectorStore })
            : null;
    }

    /** Is a usable graph available for this repo? Loads it if persisted. */
    async ensureGraph(repoId) {
        if (!this.pipeline || !repoId) return false;
        try {
            if (this.pipeline.graph?.nodeCount === 0) {
                const has = await this.pipeline.hasGraph(repoId);
                if (has) await this.pipeline.loadGraph(repoId);
            }
            return (this.pipeline.graph?.nodeCount || 0) > 0;
        } catch (e) {
            console.warn('ReviewGraphContext: ensureGraph failed (non-fatal):', e?.message);
            return false;
        }
    }

    /**
     * Build per-file graph context for the changed files.
     *
     * @param {Object} prData - normalized PR data (has .files with .filename/.patch)
     * @param {string} repoId
     * @param {Object} [opts] - { maxFiles, maxCharsPerFile, maxSymbolsPerFile }
     * @returns {Promise<{available:boolean, byFile:Record<string,string>, combined:string, stats:Object}>}
     */
    async buildForReview(prData, repoId, opts = {}) {
        const budget = resolveBudget({ overrides: opts.budget || undefined });
        const {
            maxFiles = budget.graphMaxFiles,
            maxCharsPerFile = budget.graphCharsPerFile,
            maxSymbolsPerFile = budget.graphSymbolsPerFile,
        } = opts;
        const empty = { available: false, byFile: {}, combined: '', stats: { symbols: 0, filesWithContext: 0 } };

        const ok = await this.ensureGraph(repoId);
        if (!ok) return empty;

        const byFile = {};
        const files = (prData?.files || []).slice(0, maxFiles);
        let symbolCount = 0;
        const impactedFiles = new Set();
        const changedFileNames = new Set(files.map(f => f.filename).filter(Boolean));

        // Caller SOURCE, resolved once for every changed symbol in the PR.
        // Batched deliberately: the vector store is indexed by repo, so a
        // per-file read would rescan every chunk in the repository.
        const allSymbols = [];
        for (const f of files) {
            if (!f.filename) continue;
            const declared = this._extractDeclaredSymbols(this._addedLines(f.patch));
            allSymbols.push(...declared.slice(0, maxSymbolsPerFile));
        }
        const callerSource = await this._buildCallerSource(
            [...new Set(allSymbols)], repoId, budget, changedFileNames,
        );

        for (const f of files) {
            if (!f.filename) continue;

            const added = this._addedLines(f.patch);
            const symbols = this._extractDeclaredSymbols(added).slice(0, maxSymbolsPerFile);

            const sections = [];

            for (const sym of symbols) {
                const section = this._buildSymbolSection(sym, impactedFiles);
                if (section) {
                    sections.push(section);
                    symbolCount++;
                }
                // The callers' actual code, right under the summary that names
                // them. This is what lets the model decide whether a contract
                // change breaks them instead of only noting that it might.
                const source = callerSource.bySymbol[sym];
                if (source) {
                    sections.push(
                        `**Source of the callers of \`${sym}\`** — judge against this whether the change breaks them. `
                        + 'These excerpts come from the repository index, not the diff; do not report findings on their line numbers.\n\n'
                        + source,
                    );
                }
            }

            // Fall back to the generic neighbourhood query when no declaration
            // was recognised (a diff can be pure call-site edits, or a language
            // the declaration patterns don't cover).
            if (sections.length === 0) {
                const code = added || f.fullContent || f.patch || '';
                if (code.trim()) {
                    try {
                        const ctx = this.pipeline.getContextForQuestion('', code);
                        if (ctx && String(ctx).trim()) sections.push(String(ctx));
                    } catch (e) {
                        console.warn(`ReviewGraphContext: query failed for ${f.filename}:`, e?.message);
                    }
                }
            }

            if (sections.length) {
                byFile[f.filename] = sections.join('\n\n').slice(0, maxCharsPerFile);
            }
        }

        // Repo-level warning: files OUTSIDE this PR that depend on what it changed.
        // This is the single highest-value cross-file signal — "you changed a
        // contract and did not update its consumers" — and it is invisible in a diff.
        const externalImpact = [...impactedFiles].filter(p => !changedFileNames.has(p));
        let impactSection = '';
        if (externalImpact.length) {
            const shown = externalImpact.slice(0, 15);
            impactSection = [
                '### Files outside this PR that depend on the changed symbols',
                'If this PR altered a signature, return shape, or behavioural contract,',
                'these files are the breakage surface and are NOT part of the diff:',
                ...shown.map(p => `- ${p}`),
                externalImpact.length > shown.length
                    ? `- ...and ${externalImpact.length - shown.length} more`
                    : '',
            ].filter(Boolean).join('\n');
        }

        const combined = [
            ...Object.entries(byFile).map(([file, ctx]) => `### ${file}\n${ctx}`),
            impactSection,
        ].filter(Boolean).join('\n\n');

        return {
            available: Object.keys(byFile).length > 0,
            byFile,
            combined,
            externalImpact,
            stats: {
                symbols: symbolCount,
                filesWithContext: Object.keys(byFile).length,
                externalImpactedFiles: externalImpact.length,
            },
        };
    }

    /**
     * Caller source for every changed symbol, or an empty result.
     *
     * Soft in every direction: no vector store, no budget, or a failed read all
     * degrade to the summaries-only behaviour this service had before.
     */
    async _buildCallerSource(symbols, repoId, budget, changedFileNames) {
        const empty = { bySymbol: {}, stats: { callers: 0 } };
        if (!this.callerSource || !repoId) return empty;
        if (!budget?.callerSources) return empty;

        const result = await this.callerSource.build(symbols, repoId, {
            perSymbol: budget.callerSources,
            maxLines: budget.callerSourceLines,
            excludeFiles: changedFileNames,
        });
        if (result.stats.callers > 0) {
            console.log(
                `🔗 Inlined source for ${result.stats.callers} caller(s) `
                + `across ${result.stats.symbols} changed symbol(s)`,
            );
        }
        return result;
    }

    /**
     * Everything the graph knows about one changed symbol, formatted for a prompt.
     * Side effect: records the files touched by the blast radius into `impactedFiles`.
     */
    _buildSymbolSection(symbol, impactedFiles) {
        const parts = [];

        // Callers / callees — the contract-breakage view.
        try {
            const view = this.pipeline.getSymbolContext(symbol);
            if (view && String(view).trim()) parts.push(String(view).trim());
        } catch (e) {
            console.warn(`ReviewGraphContext: symbol context failed for ${symbol}:`, e?.message);
        }

        // Risk read from the graph's own impact analyzer.
        try {
            const safety = this.pipeline.safetyCheck?.(symbol);
            if (safety) {
                const line = typeof safety === 'string'
                    ? safety
                    : [safety.level && `risk: ${safety.level}`,
                        safety.reason,
                        safety.affectedCount != null && `${safety.affectedCount} symbol(s) affected`]
                        .filter(Boolean).join(' · ');
                if (line) parts.push(`**Change safety for \`${symbol}\`:** ${line}`);
            }
        } catch { /* optional signal */ }

        // Test gaps in the blast radius — "this change can break X and nothing
        // tests X" is exactly the review comment a human reviewer wants surfaced.
        try {
            const untested = this.pipeline.getUntestedInBlastRadius?.(symbol, { maxDepth: 2 });
            const list = Array.isArray(untested) ? untested : untested?.symbols;
            if (Array.isArray(list) && list.length) {
                const names = list.slice(0, 6).map(u => {
                    const name = typeof u === 'string' ? u : (u?.name || u?.properties?.name);
                    const file = typeof u === 'object' ? (u?.filePath || u?.properties?.filePath) : null;
                    return file ? `\`${name}\` (${file})` : `\`${name}\``;
                });
                parts.push(
                    `**Untested code in the blast radius of \`${symbol}\`** (${list.length}):\n`
                    + names.map(n => `- ${n}`).join('\n')
                    + (list.length > names.length ? `\n- ...and ${list.length - names.length} more` : '')
                );
                for (const u of list) {
                    const file = typeof u === 'object' ? (u?.filePath || u?.properties?.filePath) : null;
                    if (file) impactedFiles.add(file);
                }
            }
        } catch { /* optional signal */ }

        // Record caller files as impacted so the repo-level section can warn
        // about consumers living outside the diff.
        try {
            const nodes = this.pipeline.graph?.findNodeByName?.(symbol) || [];
            for (const node of nodes.slice(0, 3)) {
                const incoming = this.pipeline.graph.getRelationshipsTo(node.id) || [];
                for (const rel of incoming) {
                    if (rel.type !== 'CALLS') continue;
                    const caller = this.pipeline.graph.getNode(rel.sourceId);
                    const file = caller?.properties?.filePath;
                    if (file) impactedFiles.add(file);
                }
            }
        } catch { /* optional signal */ }

        if (!parts.length) return null;
        return parts.join('\n\n');
    }

    /** Symbols DECLARED (not merely mentioned) in a block of added code. */
    _extractDeclaredSymbols(code) {
        if (!code || typeof code !== 'string') return [];
        const found = new Set();
        for (const pattern of DECL_PATTERNS) {
            pattern.lastIndex = 0;
            let m;
            while ((m = pattern.exec(code)) !== null) {
                const name = m[1];
                if (!name || name.length < 3) continue;
                if (NOISE.has(name) || NOISE.has(name.toLowerCase())) continue;
                found.add(name);
            }
        }
        return [...found];
    }

    /** Extract just the added ("+") lines from a unified diff patch. */
    _addedLines(patch) {
        if (!patch || typeof patch !== 'string') return '';
        return patch
            .split('\n')
            .filter(l => l.startsWith('+') && !l.startsWith('+++'))
            .map(l => l.slice(1))
            .join('\n');
    }
}

export default ReviewGraphContextService;
