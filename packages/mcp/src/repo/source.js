import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIndexableCodeFile, MAX_FILE_SIZE } from '../../../../src/utils/codeFileFilter.js';

const exec = promisify(execFile);

/**
 * Read a git worktree into the `{path, content}[]` shape every analysis
 * service expects.
 *
 * Enumeration is `git ls-files`, not a directory walk: it returns exactly the
 * tracked (plus not-yet-staged-but-not-ignored) files, which respects
 * .gitignore by construction and gets node_modules, build output, submodules
 * and sparse checkouts right without a hand-maintained exclusion list.
 * Reimplementing ignore parsing would let this disagree with what the user
 * considers "their repo".
 *
 * `--cached --others --exclude-standard` rather than the bare `-z`: a repo the
 * user just cloned or scaffolded, or this package's own fixture repo, can have
 * real files that were never `git add`ed. Restricting to committed content
 * only would index nothing for exactly the repos most likely to be indexed
 * right after checkout. --exclude-standard still applies .gitignore, so
 * node_modules and friends are excluded exactly as before.
 *
 * Filtering reuses src/utils/codeFileFilter.js so the MCP index and the
 * extension index agree about what is indexable in the same repository.
 */
/**
 * Read specific paths as they exist AT A REVISION, not in the working tree.
 *
 * `readRepoFiles` reads whatever is checked out. That is right for indexing and
 * wrong for reviewing: a review targets a revision range or a pull request, and
 * the worktree is under no obligation to be either of them. Linting the
 * worktree while the hunks come from a range produced findings on code the
 * change deletes — on a real review, against a worktree 537 commits behind the
 * range's own base. Two sections of one bundle described different code.
 *
 * A path absent from the revision (the change deleted it, or it was renamed) is
 * returned in `missing` rather than skipped silently, because "no findings for
 * this file" and "this file was never analysed" are different facts.
 *
 * @param {string} repoDir
 * @param {string} rev Anything `git show` accepts: a sha, branch, or tag.
 * @param {string[]} paths Repo-relative paths.
 * @returns {Promise<{files: Array<{path: string, content: string}>, missing: string[], skipped: Array<{path: string, reason: string}>}>}
 */
export async function readFilesAtRev(repoDir, rev, paths = []) {
    const files = [];
    const missing = [];
    const skipped = [];

    for (const rel of paths) {
        try {
            // `--` guards a path that could be read as a revision.
            const { stdout } = await exec('git', ['show', `${rev}:${rel}`], {
                cwd: repoDir,
                maxBuffer: 64 * 1024 * 1024,
            });
            if (stdout.length > MAX_FILE_SIZE) {
                skipped.push({ path: rel, reason: `larger than ${MAX_FILE_SIZE} bytes` });
                continue;
            }
            files.push({ path: rel, content: stdout });
        } catch {
            // `git show` fails for a path that does not exist at this revision,
            // which for a diff's file list is the ordinary case of a deletion.
            missing.push(rel);
        }
    }

    return { files, missing, skipped };
}

export async function readRepoFiles(repoDir, { maxFiles = 5000 } = {}) {
    let listed;
    try {
        // -z: NUL-separated, so paths with spaces or newlines survive intact.
        const { stdout } = await exec(
            'git',
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 },
        );
        listed = stdout.split('\0').filter(Boolean);
    } catch (error) {
        throw new Error(
            `Not a git repository (or git is unavailable) at ${repoDir}: ${error.message}`,
        );
    }

    const candidates = listed.filter((p) => isIndexableCodeFile(p));
    const truncated = candidates.length > maxFiles;
    const chosen = candidates.slice(0, maxFiles);

    const files = [];
    let skipped = 0;
    for (const rel of chosen) {
        const abs = path.join(repoDir, rel);
        try {
            // Size check before read: a multi-megabyte generated file that
            // passed the extension filter should not be pulled into memory.
            const { size } = fs.statSync(abs);
            if (size > MAX_FILE_SIZE) { skipped += 1; continue; }
            files.push({ path: rel, content: fs.readFileSync(abs, 'utf8') });
        } catch {
            // Deleted since ls-files, a broken symlink, or unreadable: skipping
            // one file must not fail the index.
            skipped += 1;
        }
    }

    return { files, skipped, truncated };
}
