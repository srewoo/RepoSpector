/**
 * ReviewReuseContextService — "does this already exist in the codebase?"
 *
 * That is the FIRST question on Michaela Greiler's code review checklist, and
 * the one every diff-only reviewer structurally cannot answer. PR-Agent, the
 * two GitHub Actions, and every other tool in the comparison see only the
 * patch, so the best any of them can do is guess — and a guessed duplication
 * claim is worse than silence, because the author knows their own codebase and
 * a wrong one costs the reviewer its credibility.
 *
 * RepoSpector can answer it for real: the repo is already indexed for RAG with
 * BM25 + HNSW hybrid retrieval. This service asks that index, per symbol the
 * diff DEFINES, whether something similar already exists somewhere the diff is
 * not touching — and hands the lens actual paths and code rather than a hunch.
 *
 * ── Why it is retrieval-first, not model-first ──────────────────────────────
 *
 * The lens never speculates. It receives candidate prior implementations or it
 * receives nothing, and when it receives nothing it is told to report nothing.
 * That inverts the usual failure mode: instead of a model inventing plausible
 * duplication, the worst case here is a missed duplication, which costs a
 * finding rather than the reviewer's trust.
 *
 * ── Why hits inside the diff are dropped ────────────────────────────────────
 *
 * The index is built from the repo as last indexed, so a MODIFIED function's
 * previous body still sits at its own path. Retrieval will return it as the
 * closest match to itself, every time. Reporting that as duplication would make
 * every edit to an existing function look like a reimplementation of it, so any
 * hit in a file the PR touches is discarded — see `_isChangedFile`.
 *
 * Entirely optional: an unindexed repo, a failed embed, or a symbol with no
 * neighbours all yield `available: false` and the lens is skipped.
 */

import {
    extractDeclaredSymbols,
    addedLines,
    declarationLineFor,
} from '../utils/declaredSymbols.js';

export const REUSE_DEFAULTS = Object.freeze({
    /**
     * Symbols probed per file, and in total.
     *
     * Each probe is one embedding plus one hybrid search. Both are local, but a
     * 60-file PR declaring 5 symbols each would still be 300 index round-trips
     * on the critical path of a review the user is waiting for.
     */
    maxSymbolsPerFile: 3,
    maxSymbolsTotal: 10,
    /** Candidate prior implementations kept per symbol. */
    maxHitsPerSymbol: 2,
    /**
     * Similarity floor for a hit to be worth showing.
     *
     * Deliberately well above RAGService's 0.3 default. A weak match here does
     * not produce a weak finding, it produces a WRONG one — "you reimplemented
     * this" pointing at unrelated code is the single most credibility-damaging
     * thing this lens could say.
     */
    minScore: 0.55,
    /** Characters of each candidate's code shown to the lens. */
    maxSnippetChars: 600,
    /** Ceiling on the whole rendered block. */
    maxContextChars: 6000,
});

/** Test files are poor duplication evidence: parallel test helpers are normal. */
const TEST_PATH = /(\.test\.|\.spec\.|_test\.|test_|\/tests?\/|\/__tests__\/)/i;

export class ReviewReuseContextService {
    /**
     * @param {Object} deps
     * @param {Object} deps.ragService - provides retrieveContext(repoId, query, limit, opts)
     */
    constructor({ ragService } = {}) {
        this.ragService = ragService;
    }

    /**
     * Build the reuse-candidate block for a PR.
     *
     * @param {Object} prData - normalized PR data; needs `files[].filename` + `.patch`
     * @param {string} repoId
     * @param {Partial<typeof REUSE_DEFAULTS>} [opts]
     * @returns {Promise<{available: boolean, context: string, stats: Object}>}
     */
    async buildForReview(prData, repoId, opts = {}) {
        const o = { ...REUSE_DEFAULTS, ...opts };
        const stats = { symbolsProbed: 0, symbolsWithHits: 0, hits: 0, skipped: null };
        const unavailable = (reason) => ({
            available: false,
            context: '',
            stats: { ...stats, skipped: reason },
        });

        if (!this.ragService || typeof this.ragService.retrieveContext !== 'function') {
            return unavailable('no-rag-service');
        }
        if (!repoId) return unavailable('no-repo-id');

        const files = (prData?.files || []).filter(f => f?.filename && f?.patch);
        if (!files.length) return unavailable('no-files');

        const changedFiles = new Set(files.map(f => f.filename));
        const probes = this._selectProbes(files, o);
        if (!probes.length) return unavailable('no-new-declarations');

        const found = [];
        for (const probe of probes) {
            stats.symbolsProbed++;
            const hits = await this._findPriorArt(probe, repoId, changedFiles, o);
            if (hits.length) {
                stats.symbolsWithHits++;
                stats.hits += hits.length;
                found.push({ ...probe, hits });
            }
        }

        if (!found.length) return unavailable('no-prior-art');

        return { available: true, context: this._render(found, o), stats };
    }

    /**
     * Choose which declared symbols to probe.
     *
     * Longer names first within a file. A three-character name is far more
     * likely to collide with unrelated code than a descriptive one, so when the
     * per-file cap bites, spend it where a hit means something.
     */
    _selectProbes(files, o) {
        const probes = [];
        for (const file of files) {
            const added = addedLines(file.patch);
            if (!added.trim()) continue;

            const symbols = extractDeclaredSymbols(added)
                .sort((a, b) => b.length - a.length)
                .slice(0, o.maxSymbolsPerFile);

            for (const symbol of symbols) {
                probes.push({
                    symbol,
                    filename: file.filename,
                    declaration: declarationLineFor(added, symbol),
                });
            }
        }
        // Global cap applied after per-file selection, so one enormous file
        // cannot consume the whole budget before other files are considered.
        return probes.slice(0, o.maxSymbolsTotal);
    }

    /** Retrieve existing code resembling one new declaration. */
    async _findPriorArt(probe, repoId, changedFiles, o) {
        // The declaration line carries parameter names and types; a bare symbol
        // name is a weak query that matches half a codebase.
        const query = [probe.symbol, probe.declaration].filter(Boolean).join(' ');

        let results;
        try {
            results = await this.ragService.retrieveContext(repoId, query, o.maxHitsPerSymbol * 4, {
                minScore: o.minScore,
                rerank: true,
            });
        } catch (e) {
            // An unindexed repo or a failed embed must not fail the review.
            console.warn(`Reuse probe for ${probe.symbol} failed (non-fatal):`, e?.message);
            return [];
        }

        if (!Array.isArray(results)) return [];

        const kept = [];
        const seenPaths = new Set();
        for (const r of results) {
            const filePath = r?.filePath || r?.metadata?.filePath;
            const content = r?.content || r?.metadata?.content;
            if (!filePath || !content) continue;

            // The symbol's own prior version, or a sibling hunk of this PR.
            if (this._isChangedFile(filePath, changedFiles)) continue;
            if (TEST_PATH.test(filePath)) continue;
            // One candidate per file: two chunks of the same file are one piece
            // of evidence, not two.
            if (seenPaths.has(filePath)) continue;

            const score = r.relevanceScore ?? r.score ?? 0;
            if (score < o.minScore) continue;

            seenPaths.add(filePath);
            kept.push({
                filePath,
                score,
                snippet: String(content).slice(0, o.maxSnippetChars),
            });
            if (kept.length >= o.maxHitsPerSymbol) break;
        }
        return kept;
    }

    /**
     * Is this retrieved path one the PR touches?
     *
     * Compared both ways because index paths and diff paths do not always share
     * a root — one may be repo-relative and the other prefixed. A suffix match
     * in either direction is the conservative read, and being conservative here
     * costs a missed finding while being wrong costs a false accusation.
     */
    _isChangedFile(filePath, changedFiles) {
        if (changedFiles.has(filePath)) return true;
        for (const changed of changedFiles) {
            if (filePath.endsWith(changed) || changed.endsWith(filePath)) return true;
        }
        return false;
    }

    /** Render the candidates as a bounded prompt block. */
    _render(found, o) {
        const parts = [];
        for (const { symbol, filename, declaration, hits } of found) {
            const lines = [`### New declaration: \`${symbol}\` in \`${filename}\``];
            if (declaration) lines.push(`Declared as: \`${declaration}\``);
            lines.push('Existing code elsewhere in the repo that resembles it:');
            for (const hit of hits) {
                lines.push(
                    `- \`${hit.filePath}\` (similarity ${hit.score.toFixed(2)}):`,
                    '```',
                    hit.snippet,
                    '```',
                );
            }
            parts.push(lines.join('\n'));
        }

        const body = parts.join('\n\n');
        const clipped = body.length > o.maxContextChars
            ? `${body.slice(0, o.maxContextChars)}\n...(more candidates omitted)...`
            : body;

        return [
            '## Possible prior implementations (retrieved from the indexed repository)',
            'Each block pairs a declaration this PR ADDS with existing code that the',
            'repository index found similar. These are CANDIDATES, not confirmed',
            'duplication — the similarity is lexical and semantic, not semantic proof.',
            'Judge each one: a genuine reimplementation of existing behaviour is a',
            'finding; a similar shape serving a different purpose is not.',
            '',
            clipped,
        ].join('\n');
    }
}

export default ReviewReuseContextService;
