import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFilesAtRev } from '../repo/source.js';
import { parsedFilesFrom } from '../tools/anchor.js';
import { ctxOk, ctxNotRun } from '../../../../src/review-core/context/contextPort.js';

const exec = promisify(execFile);

/**
 * ContextPort for the MCP server (spec §1.2).
 *
 * This server never calls GitHub or GitLab for review context. An MCP server
 * cannot call another MCP server — only the host can — so platform data
 * arrives as `review_pr` arguments the host fetched with its own git MCP, and
 * history comes from local git on the indexed repository. Every method
 * returns not-run with a reason instead of throwing, so a lens that cannot get
 * its context is reported as skipped, never as clean.
 */

export const PRIOR_PR_HINT = 'pass `prior_pr_comments`, fetched with your GitHub/GitLab MCP';

/** Caller-supplied labels: one short line, so they cannot pose as prompt structure. */
const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
const firstLine = (e) => String(e?.stderr || e?.message || 'failed').trim().split('\n')[0];

/** `git blame --porcelain` → [{start, end, sha, message, date}], consecutive lines of one commit merged. */
export function parseBlamePorcelain(text) {
    const meta = new Map();
    const lines = [];
    let cur = null;
    for (const raw of String(text).split('\n')) {
        const head = raw.match(/^([0-9a-f]{40}) \d+ (\d+)/);
        if (head) {
            cur = { sha: head[1], line: Number(head[2]) };
            if (!meta.has(cur.sha)) meta.set(cur.sha, { message: '', date: null });
            continue;
        }
        if (!cur) continue;
        if (raw.startsWith('summary ')) meta.get(cur.sha).message = raw.slice('summary '.length);
        else if (raw.startsWith('committer-time ')) {
            meta.get(cur.sha).date = new Date(Number(raw.slice('committer-time '.length)) * 1000).toISOString();
        } else if (raw.startsWith('\t')) {
            lines.push(cur);
            cur = null;
        }
    }
    const ranges = [];
    for (const l of lines) {
        const last = ranges[ranges.length - 1];
        if (last && last.sha === l.sha && last.end === l.line - 1) {
            last.end = l.line;
            continue;
        }
        ranges.push({ start: l.line, end: l.line, sha: l.sha, ...meta.get(l.sha) });
    }
    return ranges;
}

/**
 * The post-change file as far as the hunks show it. Lines no hunk covers are
 * blank rather than guessed, so line numbers stay true for comment extraction
 * around the change.
 */
export function postImageFromDiff(parsedFiles, filePath) {
    const file = parsedFiles.find((f) => f.newPath === filePath);
    if (!file) return null;
    const known = file.hunks.flatMap((h) => h.lines).filter((l) => l.number.new != null);
    if (!known.length) return null;
    const out = new Array(Math.max(...known.map((l) => l.number.new))).fill('');
    for (const l of known) out[l.number.new - 1] = l.content;
    return out.join('\n');
}

async function git(repoPath, args) {
    return exec('git', args, { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 });
}

async function blameLines(repoPath, rev, filePath, a, b) {
    try {
        const { stdout } = await git(repoPath, ['blame', '--porcelain', '-L', `${a},${b}`, rev, '--', filePath]);
        return stdout;
    } catch (e) {
        // A window that runs past the end of the file is clamped once, not failed.
        const total = Number(String(e?.stderr ?? '').match(/has only (\d+) lines?/)?.[1]);
        if (Number.isInteger(total) && total >= a && total < b) {
            return blameLines(repoPath, rev, filePath, a, total);
        }
        throw e;
    }
}

/**
 * @param {{repoPath?: string|null, priorPrComments?: Array<object>|null, headSha?: string|null,
 *          baseSha?: string|null, diffFiles?: Array<object>}} input
 * @returns {import('../../../../src/review-core/context/contextPort.js').ContextPort}
 */
export function createMcpContextPort({
    repoPath = null, priorPrComments = null, headSha = null, baseSha = null, diffFiles = [],
} = {}) {
    const parsed = parsedFilesFrom(diffFiles);
    const noRepo = () => ctxNotRun('no local repository is indexed, so git history cannot be read');
    const noBase = () => ctxNotRun('no base revision is known; pass pr_ref.base_sha or review a local range');
    // Revisions can come from `pr_ref`, i.e. the caller. One that starts with
    // `-` would be read by git as an option, so it is refused, not run.
    const badRev = (rev) => (String(rev).startsWith('-') ? ctxNotRun(`refusing revision ${JSON.stringify(rev)}`) : null);

    return {
        async blame(filePath, { ref = null, startLine = 1, endLine = null } = {}) {
            if (!repoPath) return noRepo();
            const rev = ref ?? baseSha;
            if (!rev) return noBase();
            if (badRev(rev)) return badRev(rev);
            const a = Math.max(1, Math.floor(Number(startLine) || 1));
            const b = Math.max(a, Math.floor(Number(endLine ?? a) || a));
            try {
                return ctxOk({ ranges: parseBlamePorcelain(await blameLines(repoPath, rev, filePath, a, b)) });
            } catch (e) {
                return ctxNotRun(`git blame ${filePath} at ${rev} failed: ${firstLine(e)}`);
            }
        },

        async recentCommits(filePath, { ref = null, limit = 5 } = {}) {
            if (!repoPath) return noRepo();
            const rev = ref ?? baseSha;
            if (!rev) return noBase();
            if (badRev(rev)) return badRev(rev);
            try {
                const { stdout } = await git(repoPath, [
                    'log', `-n${Math.max(1, Math.floor(Number(limit) || 5))}`,
                    '--format=%H%x1f%cI%x1f%s', rev, '--', filePath,
                ]);
                const commits = stdout.split('\n').filter(Boolean).map((line) => {
                    const [sha, date, message] = line.split('\x1f');
                    return { sha, message, date };
                });
                return ctxOk({ commits });
            } catch (e) {
                return ctxNotRun(`git log ${filePath} at ${rev} failed: ${firstLine(e)}`);
            }
        },

        async priorPrComments(filePath, { limitPrs = 5 } = {}) {
            if (!Array.isArray(priorPrComments)) return ctxNotRun(PRIOR_PR_HINT);
            const own = priorPrComments.filter((c) => c && c.path === filePath && String(c.body ?? '').trim());
            const prs = [...new Set(own.map((c) => String(c.pr_ref ?? '')))].slice(0, Math.max(1, limitPrs));
            const comments = own
                .filter((c) => prs.includes(String(c.pr_ref ?? '')))
                .map((c) => ({
                    path: c.path,
                    prRef: c.pr_ref == null ? null : oneLine(c.pr_ref),
                    author: c.author == null ? null : oneLine(c.author),
                    body: String(c.body),
                    ...(Number.isInteger(c.line) ? { line: c.line } : {}),
                }));
            return ctxOk({ comments });
        },

        async fileContent(filePath, ref = null) {
            const rev = ref ?? headSha;
            if (repoPath && rev && !badRev(rev)) {
                const { files } = await readFilesAtRev(repoPath, rev, [filePath]);
                if (files.length) return ctxOk({ text: files[0].content, source: 'revision' });
            }
            const post = postImageFromDiff(parsed, filePath);
            if (post !== null) return ctxOk({ text: post, source: 'diff-post-image' });
            return ctxNotRun(`${filePath} is not readable at ${rev ?? 'an unknown head'} and the diff `
                + 'carries no post-image for it');
        },
    };
}

export default { createMcpContextPort, parseBlamePorcelain, postImageFromDiff, PRIOR_PR_HINT };
