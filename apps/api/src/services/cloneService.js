/**
 * CloneService — shallow git clone into per-job workspaces.
 *
 * Security model:
 *   - Workspace path is jobId-scoped, e.g. /tmp/aegis/<jobId>/<repo-slug>/
 *   - Tokens (when present) are passed via the URL `https://x-access-token:<tok>@host/...`
 *     and the URL is never logged. simple-git redacts query/userinfo in errors.
 *   - On finish (success OR error) the entire jobId workspace is rm-rf'd.
 *
 * Latency: shallow clone depth=50 is usually <8s on a 100-MB repo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export class CloneService {
    constructor(jobId, opts = {}) {
        this.jobId = jobId;
        this.root = path.join(opts.root ?? config.CLONE_ROOT, jobId);
        this.depth = opts.depth ?? config.CLONE_DEPTH;
        this.maxRepos = opts.maxRepos ?? config.MAX_REPOS_TO_CLONE;
        this.cloned = []; // [{ name, dir }]
    }

    async ensureRoot() {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    }

    /**
     * Clone a single repo, returning the local directory.
     */
    async clone({ cloneUrl, branch, token }) {
        if (this.cloned.length >= this.maxRepos) {
            throw new Error(`clone_cap_reached:${this.maxRepos}`);
        }
        await this.ensureRoot();

        const name = repoSlug(cloneUrl);
        const dir = path.join(this.root, name);
        const authedUrl = applyToken(cloneUrl, token);

        logger.info({ jobId: this.jobId, name, depth: this.depth, branch }, 'cloning');
        const git = simpleGit({ baseDir: this.root });
        const args = ['--depth', String(this.depth)];
        if (branch) args.push('--branch', branch);
        try {
            await git.clone(authedUrl, name, args);
            this.cloned.push({ name, dir });
            return { dir, name };
        } catch (err) {
            // simple-git masks tokens already; double-redact just in case.
            const safe = String(err.message).replace(/https:\/\/[^@]+@/g, 'https://[REDACTED]@');
            throw new Error(`clone_failed: ${safe}`);
        }
    }

    /**
     * Produce the diff that the review pipeline expects.
     */
    async diff(repoDir, { targetBranch, sourceBranch }) {
        const git = simpleGit({ baseDir: repoDir });
        // Three-dot diff matches what code reviewers see on GitHub/GitLab.
        const range = `origin/${targetBranch}...origin/${sourceBranch}`;
        try {
            return await git.raw(['diff', range]);
        } catch (_err) {
            // Fallback for shallow clones where origin/<branch> wasn't fetched.
            return await git.raw(['diff', `${targetBranch}...${sourceBranch}`]);
        }
    }

    /**
     * `grep -r` for a list of symbols in a cloned repo. Used by the
     * cross-repo coupling check — given a set of changed-export names, find
     * consumer files in *this* repo that reference them.
     */
    async grepSymbols(repoDir, symbols) {
        if (!symbols.length) return [];
        const git = simpleGit({ baseDir: repoDir });
        // Combine into one regex for one fork+exec.
        const pattern = symbols
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|');
        try {
            const out = await git.raw([
                'grep', '-n', '-E', '--', pattern, 'HEAD',
            ]);
            return parseGrepOutput(out);
        } catch (_err) {
            // grep exits non-zero when there are no matches.
            return [];
        }
    }

    async cleanup() {
        try {
            await fs.rm(this.root, { recursive: true, force: true });
        } catch (err) {
            logger.warn({ err: err.message, root: this.root }, 'cleanup_failed');
        }
    }
}

function repoSlug(cloneUrl) {
    return cloneUrl
        .replace(/\.git$/, '')
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9._-]/g, '_');
}

function applyToken(cloneUrl, token) {
    if (!token) return cloneUrl;
    return cloneUrl.replace(/^(https?:\/\/)/, `$1x-access-token:${encodeURIComponent(token)}@`);
}

function parseGrepOutput(out) {
    const hits = [];
    for (const line of String(out).split('\n')) {
        // `HEAD:src/foo.ts:42:matched line`
        const m = line.match(/^HEAD:([^:]+):(\d+):(.*)$/);
        if (m) hits.push({ file: m[1], line: parseInt(m[2], 10), match: m[3] });
    }
    return hits;
}
