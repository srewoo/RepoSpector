#!/usr/bin/env node
/**
 * Cache each case's post-change file content, so the harness can exercise the
 * file-context path.
 *
 *   node eval/fetch-content.js --corpus eval/corpus/public-prs.json
 *   node eval/inject.js --in eval/corpus/public-prs.json --out eval/corpus/injected.json
 *   node eval/run.js --corpus eval/corpus/injected.json
 *
 * ── Why this exists ──
 *
 * `eval/run.js` built its review context as `{ staticFindings, contextBudget }`
 * and nothing else. Every feature that depends on seeing the FILE rather than the
 * hunk was therefore untested by the harness that exists to test them:
 *
 *   ReviewFileContextService  full-file context (the single largest context
 *                             upgrade in the pipeline, per its own header)
 *   dynamicContext            hunk expansion — needs content to expand INTO
 *   reviewContextBudget       every key that differs between its `legacy` and
 *                             `default` profiles governs RAG, graph or file
 *                             context, so the documented A/B was guaranteed null
 *
 * The extension gets this content from `PullRequestService.fetchFullFileContent`
 * at review time. The harness cannot: a run has to be reproducible offline and
 * must not spend a review's worth of API calls on every re-run. So content is
 * fetched ONCE into the corpus, exactly like patches already are.
 *
 * ── Fidelity ──
 *
 * The caps mirror `ReviewFileContextService.DEFAULTS` (12 files, 60 kB each,
 * 400 kB total) rather than being generous. A harness that hands the reviewer
 * more context than production does measures a reviewer nobody ships — the same
 * failure `run.js`'s own header warns about, and the reason its
 * `maxFilesToReview` was raised from 20 to 100.
 *
 * Files are read from raw.githubusercontent.com at the case's `headSha`. Pinning
 * the SHA is the whole game: the default branch has moved on since these PRs
 * merged, and content from a later commit would disagree with the cached patch,
 * at which point `verifyAlignment` refuses to expand and this all silently does
 * nothing.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/** Mirrors ReviewFileContextService.DEFAULTS — see the header. */
const CAPS = Object.freeze({
    maxFiles: 12,
    maxBytesPerFile: 60_000,
    maxTotalBytes: 400_000,
    concurrency: 4,
});

/** Same exclusions ReviewFileContextService applies. */
const SKIP_EXT = /\.(lock|min\.js|min\.css|map|svg|png|jpe?g|gif|ico|woff2?|ttf|eot|pdf|zip|gz|jar|class|pyc|so|dylib|dll|exe|bin|wasm)$/i;
const SKIP_NAME = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|flake\.lock)$/i;
const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|\.git|coverage|__snapshots__)\//;

function parseArgs(argv) {
    const args = { corpus: 'eval/corpus/public-prs.json', only: null, force: false, limit: Infinity };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--corpus') args.corpus = argv[++i];
        else if (a === '--only') args.only = argv[++i];
        else if (a === '--limit') args.limit = Number(argv[++i]);
        else if (a === '--force') args.force = true;
        else if (a === '--help' || a === '-h') args.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

/** `owner/repo` from a PR/MR URL. */
export function repoFromUrl(url) {
    const m = String(url || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
    return m ? `${m[1]}/${m[2]}` : null;
}

/** Is this path worth a request? Same test the service applies. */
function isFetchable(file) {
    const name = file?.filename;
    if (!name) return false;
    if (file.status === 'removed' || file.status === 'deleted') return false;
    return !SKIP_EXT.test(name) && !SKIP_NAME.test(name) && !SKIP_PATH.test(name);
}

async function pooled(items, limit, worker) {
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const i = cursor++;
            await worker(items[i]);
        }
    });
    await Promise.all(runners);
}

/**
 * Fetch one file at a pinned SHA.
 * @returns {Promise<{text:string, truncated:boolean}|null>} null on any failure
 */
async function fetchFile(repo, sha, path, token) {
    const url = `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
    const headers = token ? { Authorization: `token ${token}` } : {};

    try {
        const resp = await fetch(url, { headers });
        if (!resp.ok) return null;
        const text = await resp.text();
        // Truncation is recorded, not hidden: `dynamicContext` refuses to expand
        // truncated content, and a run has to be able to say why.
        if (text.length > CAPS.maxBytesPerFile) {
            return { text: text.slice(0, CAPS.maxBytesPerFile), truncated: true };
        }
        return { text, truncated: false };
    } catch {
        return null;
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log([
            'Usage: node eval/fetch-content.js [options]',
            '',
            '  --corpus <file>   Corpus to populate (default eval/corpus/public-prs.json)',
            '  --only <case-id>  Just one case',
            '  --limit <n>       At most n cases',
            '  --force           Re-fetch cases that already have content',
            '',
            'Reads GITHUB_TOKEN from the environment when present (higher rate limit).',
        ].join('\n'));
        return;
    }

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
    const path = resolve(args.corpus);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const cases = Array.isArray(parsed) ? parsed : parsed.cases;

    const selected = cases
        .filter(c => (args.only ? c.id === args.only : true))
        .filter(c => args.force || !c.fileContents)
        .slice(0, args.limit);

    if (!selected.length) {
        console.log('Nothing to do — every selected case already has fileContents (use --force to re-fetch).');
        return;
    }

    console.log(`Fetching file content for ${selected.length} case(s)${token ? '' : ' (no GITHUB_TOKEN — lower rate limit)'}\n`);

    let totalFiles = 0;
    let totalFailed = 0;

    for (const kase of selected) {
        const repo = repoFromUrl(kase.url);
        const sha = kase.prData?.headSha;

        if (!repo || !sha) {
            // A case whose SHA we do not know cannot be fetched reproducibly, and
            // guessing a ref is how the content ends up disagreeing with the patch.
            console.log(`  ${kase.id}: skipped — ${!repo ? 'not a GitHub PR URL' : 'no headSha in the corpus'}`);
            continue;
        }

        const candidates = (kase.prData.files || [])
            .filter(isFetchable)
            // Largest diffs first, exactly as ReviewFileContextService prioritises:
            // if the byte budget runs out, it should be spent on the riskiest files.
            .sort((a, b) => ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0)))
            .slice(0, CAPS.maxFiles);

        const contents = {};
        let bytes = 0;
        let failed = 0;
        let truncated = 0;

        await pooled(candidates, CAPS.concurrency, async (file) => {
            if (bytes >= CAPS.maxTotalBytes) return;
            const res = await fetchFile(repo, sha, file.filename, token);
            if (!res) { failed++; return; }
            contents[file.filename] = res.text;
            bytes += res.text.length;
            if (res.truncated) truncated++;
        });

        kase.fileContents = contents;
        const got = Object.keys(contents).length;
        totalFiles += got;
        totalFailed += failed;

        console.log(
            `  ${kase.id}: ${got}/${candidates.length} file(s), ${(bytes / 1024).toFixed(0)} kB`
            + (truncated ? `, ${truncated} truncated` : '')
            + (failed ? `, ${failed} failed` : ''),
        );

        // Save after every case: a rate-limit stop should not lose the work.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(Array.isArray(parsed) ? cases : parsed, null, 2));
    }

    console.log(`\n${totalFiles} file(s) cached, ${totalFailed} failed. Written to ${args.corpus}`);
    console.log('Re-run eval/inject.js if you use an injected corpus — it keeps content in step with the mutated patches.');
}

main().catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
});
