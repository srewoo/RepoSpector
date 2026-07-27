/**
 * ReviewFileContextService — give the reviewer the file, not just the hunk.
 *
 * Measured motivation. Until now `buildPerFileReviewPrompt` fed the model
 * `f.patch` and nothing else (multiPassPrompts.js). On the 50-MR benchmark that
 * pipeline matched 1.8% of what human reviewers said. Reading the human
 * comments explains why: almost none of them are answerable from a hunk.
 * "Is this the right abstraction", "this breaks the caller", "where is the test
 * for this" all need the surrounding file at minimum.
 *
 * Bastion gets this for free — its driver `git clone`s the repo, so the
 * `code-analyst` sub-agent can `Read` any path. Its `<skill_adaptations>` table
 * replaces every "diff only" fallback in the review skill with real file access.
 *
 * We cannot clone: an MV3 service worker has no filesystem, and the user pays
 * per token. So this service does the bounded equivalent —
 *
 *   1. fetch the full post-change content of each changed file,
 *   2. guess and fetch its test file,
 *
 * — under hard caps on file count, byte size and concurrency, degrading to
 * patch-only whenever a fetch fails. Every failure is soft: a review with
 * partial context is enormously better than no review.
 *
 * The absence of a test file is itself a signal — `testFileMissing` is what lets
 * the prompt raise Bastion's "new exported function has no test" finding.
 */

import { isTestFile, testCandidatesForProduction } from './testFileUtils.js';

/** Files we never fetch: no reviewer insight, and often enormous. */
const SKIP_EXT = /\.(lock|min\.js|min\.css|map|svg|png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip|gz|jar|class|pyc|so|dylib|dll|exe|bin|wasm)$/i;
const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|\.git|coverage|__snapshots__)\//;

/**
 * Lockfiles matched by NAME, not extension — the most common ones
 * (`package-lock.json`, `pnpm-lock.yaml`, `go.sum`) end in a perfectly ordinary
 * extension, so the SKIP_EXT pattern above sails straight past them. These are
 * the largest files in most diffs and carry nothing a reviewer can act on.
 */
const SKIP_NAME = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|flake\.lock)$/i;

const DEFAULTS = Object.freeze({
    // Caps chosen so a worst-case review costs ~30 extra API calls, not 300.
    maxFiles: 12,
    maxBytesPerFile: 60_000,
    maxTotalBytes: 400_000,
    concurrency: 4,
    fetchTests: true,
    maxTestCandidates: 3,
});

/** Is this path worth spending an API call on? */
function isFetchable(filename, status) {
    if (!filename) return false;
    if (status === 'removed' || status === 'deleted') return false; // nothing to read at head
    if (SKIP_EXT.test(filename)) return false;
    if (SKIP_NAME.test(filename)) return false;
    if (SKIP_PATH.test(filename)) return false;
    return true;
}

/**
 * Run `tasks` with bounded concurrency. Never rejects — a failed task resolves
 * to `null`, because one unreachable file must not abort the whole context
 * build.
 */
async function pooled(items, limit, worker) {
    const results = new Array(items.length).fill(null);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            try {
                results[i] = await worker(items[i], i);
            } catch {
                results[i] = null;
            }
        }
    });

    await Promise.all(runners);
    return results;
}

/**
 * Truncate a file to a byte budget, keeping the head and the tail.
 *
 * Middle-out rather than head-only: imports and the module docstring live at the
 * top, exports and the default export often live at the bottom, and cutting the
 * bottom off hides exactly the API surface a reviewer needs to judge coupling.
 */
export function truncateFile(content, maxBytes) {
    const s = String(content ?? '');
    if (s.length <= maxBytes) return { text: s, truncated: false };

    const headBytes = Math.floor(maxBytes * 0.65);
    const tailBytes = maxBytes - headBytes;

    const head = s.slice(0, headBytes);
    const tail = s.slice(-tailBytes);
    const omittedLines = s.slice(headBytes, s.length - tailBytes).split('\n').length;

    return {
        text: `${head}\n\n/* … ${omittedLines} lines omitted by RepoSpector to fit the context budget … */\n\n${tail}`,
        truncated: true,
    };
}

export class ReviewFileContextService {
    /**
     * @param {Object} deps
     * @param {Object} deps.pullRequestService - needs fetchFullFileContent(prUrl, path, ref)
     */
    constructor({ pullRequestService } = {}) {
        this.prService = pullRequestService;
    }

    /**
     * Build the file-context map for a PR.
     *
     * @param {string} prUrl
     * @param {Object} prData - normalized PR data (needs .files, .headSha, .branches)
     * @param {Object} [options] - overrides for DEFAULTS; plus:
     * @param {string[]} [options.onlyFiles] - restrict to these filenames (used by
     *        the incremental path so unchanged files don't get re-fetched)
     * @param {Function} [options.onProgress]
     * @returns {Promise<{
     *   byFile: Map<string, {fullContent:string|null, truncated:boolean,
     *                        testPath:string|null, testContent:string|null,
     *                        testFileMissing:boolean}>,
     *   stats: Object
     * }>}
     */
    async build(prUrl, prData, options = {}) {
        const opts = { ...DEFAULTS, ...options };
        const byFile = new Map();
        const stats = {
            requested: 0, fetched: 0, failed: 0, truncated: 0,
            testsFound: 0, testsMissing: 0, bytes: 0, skipped: 0,
        };

        if (!this.prService?.fetchFullFileContent) return { byFile, stats };

        // The ref matters. Without it GitLab defaults to `main`, which returns the
        // TARGET branch's version of the file — i.e. the code before this MR. The
        // reviewer would then be reasoning about content the diff contradicts.
        const ref = options.ref
            || prData?.headSha
            || prData?.branches?.source
            || null;

        const only = options.onlyFiles ? new Set(options.onlyFiles) : null;

        const candidates = (prData?.files || [])
            .filter(f => (!only || only.has(f.filename)))
            .filter(f => isFetchable(f.filename, f.status));

        stats.skipped = (prData?.files || []).length - candidates.length;

        // Prioritise: largest diffs first — they carry the most review risk, and
        // if the byte budget runs out we want it spent on them.
        const ordered = [...candidates].sort(
            (a, b) => ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0))
        ).slice(0, opts.maxFiles);

        stats.requested = ordered.length;

        let totalBytes = 0;

        await pooled(ordered, opts.concurrency, async (file) => {
            if (totalBytes >= opts.maxTotalBytes) return null;

            const entry = {
                fullContent: null,
                truncated: false,
                testPath: null,
                testContent: null,
                testFileMissing: false,
            };

            try {
                const res = await this.prService.fetchFullFileContent(prUrl, file.filename, ref);
                const { text, truncated } = truncateFile(res?.content ?? '', opts.maxBytesPerFile);
                entry.fullContent = text;
                entry.truncated = truncated;
                totalBytes += text.length;
                stats.fetched++;
                stats.bytes += text.length;
                if (truncated) stats.truncated++;
            } catch (e) {
                stats.failed++;
                // Soft: the prompt falls back to the patch for this file.
                console.warn(`[FileContext] ${file.filename}: ${e.message}`);
            }

            // Test lookup. Skipped for files that ARE tests — a test's test is not
            // a thing — and for files we could not read at all.
            if (opts.fetchTests && entry.fullContent && !isTestFile(file.filename)) {
                const found = await this._findTest(prUrl, file.filename, ref, prData, opts);
                if (found) {
                    entry.testPath = found.path;
                    entry.testContent = found.content;
                    stats.testsFound++;
                    totalBytes += found.content.length;
                } else {
                    entry.testFileMissing = true;
                    stats.testsMissing++;
                }
            }

            byFile.set(file.filename, entry);
            options.onProgress?.({ file: file.filename, fetched: stats.fetched, total: ordered.length });
            return entry;
        });

        return { byFile, stats };
    }

    /**
     * Locate the test file for a production file.
     *
     * Checks the PR's own changed-file list first: if the author added the test
     * in this same PR, we already have its path for free and skip the guessing
     * entirely. Only then do we spend API calls on candidate paths.
     */
    async _findTest(prUrl, filename, ref, prData, opts) {
        const candidates = testCandidatesForProduction(filename);
        if (!candidates.length) return null;

        // Free hit: the test is in this PR.
        const changed = new Set((prData?.files || []).map(f => f.filename));
        const inPr = candidates.find(c => changed.has(c));
        const ordered = inPr ? [inPr, ...candidates.filter(c => c !== inPr)] : candidates;

        for (const path of ordered.slice(0, opts.maxTestCandidates)) {
            try {
                const res = await this.prService.fetchFullFileContent(prUrl, path, ref);
                const content = res?.content;
                if (typeof content === 'string' && content.trim()) {
                    const { text } = truncateFile(content, Math.floor(opts.maxBytesPerFile / 2));
                    return { path, content: text };
                }
            } catch {
                // 404 is the expected outcome for most candidates — keep going.
            }
        }

        return null;
    }
}

export default ReviewFileContextService;
