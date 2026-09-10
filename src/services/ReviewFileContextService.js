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
 * A server-side reviewer gets this for free — it `git clone`s the repo, so any
 * path can simply be read and no step has to fall back to "diff only".
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
 * the prompt raise the "new exported function has no test" finding.
 */

import { isTestFile, testCandidatesForProduction } from './testFileUtils.js';

/**
 * What we established about a file's test coverage.
 *
 * `ABSENT` and `UNKNOWN` were the same value — a bare `null` — so a lookup that
 * failed on a rate limit was reported to the model as `Test file: NONE FOUND`
 * and came back as a missing-coverage finding (P1-5).
 */
export const TEST_DISCOVERY = Object.freeze({
    FOUND: 'found',
    ABSENT: 'absent',
    UNKNOWN: 'unknown',
});

/**
 * UTF-8 byte length.
 *
 * The byte budget was enforced against `String.length`, which counts UTF-16
 * code units: a file of CJK source or emoji-laden fixtures spends up to three
 * times the budget it is charged for.
 */
export function byteLength(text) {
    const s = String(text ?? '');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return Buffer.byteLength(s, 'utf8');
}

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
    if (byteLength(s) <= maxBytes) return { text: s, truncated: false };

    // Character slicing against a BYTE budget under-counts multibyte source:
    // a CJK or emoji-heavy file kept ~3x the bytes it was charged for. Shrink
    // the slice until the encoded result actually fits.
    let budget = maxBytes;
    for (let attempt = 0; attempt < 4; attempt++) {
        const h = Math.floor(budget * 0.65);
        if (byteLength(s.slice(0, h)) + byteLength(s.slice(-(budget - h))) <= maxBytes) break;
        budget = Math.floor(budget * 0.6);
    }

    const headBytes = Math.floor(budget * 0.65);
    const tailBytes = budget - headBytes;

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
            testsFound: 0, testsMissing: 0, testsUnknown: 0, bytes: 0, skipped: 0,
            budgetExhausted: 0,
            // Every piece of context this build did NOT deliver, named. A
            // reviewer cannot tell a file that was clean from one that was
            // never read unless the omissions are listed (P1-5).
            omitted: [],
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

        // P1-5: the budget is RESERVED before the fetch and reconciled after.
        //
        // `if (totalBytes >= max) return null` ran before an await, and
        // `totalBytes += ...` after it, so with `concurrency: 4` every in-flight
        // fetch saw the same pre-fetch total: four files could each pass the
        // check on the last of the budget and then all be added. The overshoot
        // scaled with concurrency, which is exactly the knob a user raises to
        // make reviews faster.
        let reservedBytes = 0;
        const reserve = (n) => {
            if (reservedBytes + n > opts.maxTotalBytes) return false;
            reservedBytes += n;
            return true;
        };
        const settle = (reserved, actual) => { reservedBytes += actual - reserved; };

        await pooled(ordered, opts.concurrency, async (file) => {
            // Reserve the worst case up front; give back what was not used.
            if (!reserve(opts.maxBytesPerFile)) {
                stats.budgetExhausted++;
                stats.omitted.push({ file: file.filename, reason: 'context byte budget exhausted' });
                return null;
            }

            const entry = {
                fullContent: null,
                truncated: false,
                testPath: null,
                testContent: null,
                testFileMissing: false,
            };

            let usedBytes = 0;
            try {
                const res = await this.prService.fetchFullFileContent(prUrl, file.filename, ref);
                const { text, truncated } = truncateFile(res?.content ?? '', opts.maxBytesPerFile);
                entry.fullContent = text;
                entry.truncated = truncated;
                usedBytes = byteLength(text);
                stats.fetched++;
                stats.bytes += usedBytes;
                if (truncated) {
                    stats.truncated++;
                    stats.omitted.push({
                        file: file.filename,
                        reason: `file truncated to ${opts.maxBytesPerFile} bytes`,
                    });
                }
            } catch (e) {
                stats.failed++;
                stats.omitted.push({ file: file.filename, reason: `fetch failed: ${e.message}` });
                // Soft: the prompt falls back to the patch for this file.
                console.warn(`[FileContext] ${file.filename}: ${e.message}`);
            }
            settle(opts.maxBytesPerFile, usedBytes);

            // Test lookup. Skipped for files that ARE tests — a test's test is not
            // a thing — and for files we could not read at all.
            if (opts.fetchTests && entry.fullContent && !isTestFile(file.filename)) {
                const found = await this._findTest(prUrl, file.filename, ref, prData, opts);
                entry.testDiscovery = found.status;
                entry.testDiscoveryReason = found.reason ?? null;
                if (found.status === TEST_DISCOVERY.FOUND) {
                    const testBytes = byteLength(found.content);
                    // A test body is charged against the same budget as the
                    // files. Before this it was added AFTER the check, so it was
                    // never subject to one at all.
                    if (reserve(testBytes)) {
                        entry.testPath = found.path;
                        entry.testContent = found.content;
                        stats.testsFound++;
                    } else {
                        stats.budgetExhausted++;
                        stats.omitted.push({
                            file: found.path,
                            reason: 'context byte budget exhausted before the test body fit',
                        });
                    }
                } else if (found.status === TEST_DISCOVERY.ABSENT) {
                    // The ONLY case that licenses a missing-coverage finding.
                    entry.testFileMissing = true;
                    stats.testsMissing++;
                } else {
                    stats.testsUnknown++;
                }
            }

            byFile.set(file.filename, entry);
            options.onProgress?.({ file: file.filename, fetched: stats.fetched, total: ordered.length });
            return entry;
        });

        stats.reservedBytes = reservedBytes;
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
        if (!candidates.length) {
            // No candidate path could even be guessed for this language or
            // layout. That is a limit of the guesser, not a fact about the repo.
            return { status: TEST_DISCOVERY.UNKNOWN, reason: 'no test path convention is known for this file' };
        }

        // Free hit: the test is in this PR.
        const changed = new Set((prData?.files || []).map(f => f.filename));
        const inPr = candidates.find(c => changed.has(c));
        const ordered = inPr ? [inPr, ...candidates.filter(c => c !== inPr)] : candidates;
        const tried = ordered.slice(0, opts.maxTestCandidates);

        // A repository tree, when the caller has one, settles absence without
        // spending a request — and settles it for EVERY candidate rather than
        // the first few. "Not in the tree" is a real answer; "the fetch failed"
        // never is.
        const tree = opts.repoTree instanceof Set
            ? opts.repoTree
            : (Array.isArray(opts.repoTree) ? new Set(opts.repoTree) : null);
        if (tree) {
            const present = candidates.find(c => tree.has(c));
            if (!present) {
                return {
                    status: TEST_DISCOVERY.ABSENT,
                    reason: `none of ${candidates.length} candidate path(s) exist in the repository tree`,
                    tried: candidates,
                };
            }
            // Fetch the one we know is there, rather than guessing in order.
            tried.unshift(present);
        }

        let unreadable = null;
        for (const path of tried) {
            try {
                const res = await this.prService.fetchFullFileContent(prUrl, path, ref);
                const content = res?.content;
                if (typeof content === 'string' && content.trim()) {
                    const { text } = truncateFile(content, Math.floor(opts.maxBytesPerFile / 2));
                    return { status: TEST_DISCOVERY.FOUND, path, content: text };
                }
            } catch (e) {
                // P1-5: a 404 says this candidate is not there. A 401, 429 or
                // 503 says we could not look, and must not be reported as
                // absence — `Test file: NONE FOUND` is what makes the reviewer
                // claim missing coverage.
                if (!e?.notFound) unreadable = e;
            }
        }

        if (unreadable) {
            return {
                status: TEST_DISCOVERY.UNKNOWN,
                reason: `test lookup failed (${unreadable.message}) — this is not evidence that no test exists`,
                tried,
            };
        }
        return {
            status: TEST_DISCOVERY.ABSENT,
            reason: `${tried.length} candidate path(s) checked and not present`,
            tried,
        };
    }
}

export default ReviewFileContextService;
