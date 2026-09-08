/**
 * Unified-diff grammar: turning diff text into per-file entries.
 *
 * Split out of diff.js so one parser serves both callers — `git diff` output
 * and a diff the client already holds and passes as `diff` (fetched, say, by an
 * authenticated GitLab or GitHub MCP server, which is what lets RepoSpector
 * need no token of its own). One grammar means renames, empty additions and
 * mode-only changes classify identically no matter where the diff came from.
 */

/**
 * Classify a file chunk that has no `@@` hunk marker.
 *
 * `git diff` omits the hunk entirely for three cases: a content-unchanged
 * rename ("similarity index 100%"), an added file with no content, and a
 * deleted file with no content. The original parser treated "no hunk" as
 * "nothing changed, skip it" and dropped all three — invisibly, since the
 * tool still reported success. A rename or an emptied file is a real change
 * a reviewer needs to see, so it is emitted with an empty patch and a
 * `status` instead of being silently omitted.
 *
 * `previousFilename` matches the field name `PullRequestService
 * .fetchPullRequest` already produces for a rename, so `collectDiffFiles`
 * hands Task 8's `review_pr` one shape regardless of source.
 *
 * @param {string} chunk - one file's chunk, header line included
 * @param {string} filename
 * @returns {{filename: string, patch: string, status: string, previousFilename?: string}}
 */
function classifyHunkless(chunk, filename) {
    const renamedFrom = chunk.match(/\nrename from (.+)/);
    if (renamedFrom && /\nrename to /.test(chunk)) {
        return {
            filename,
            patch: '',
            status: 'renamed',
            previousFilename: renamedFrom[1].trim(),
        };
    }
    if (/\nnew file mode/.test(chunk)) {
        return { filename, patch: '', status: 'added' };
    }
    if (/\ndeleted file mode/.test(chunk)) {
        // 'removed', not the more natural-sounding 'deleted': this must match
        // PullRequestService.js's vocabulary ('added'|'removed'|'modified'|
        // 'renamed' on both its GitHub and GitLab paths) so collectDiffFiles
        // presents one status shape regardless of source.
        return { filename, patch: '', status: 'removed' };
    }
    // Anything else with no hunk (e.g. a pure mode change) still gets an
    // entry rather than being dropped — "unknown but real" beats invisible.
    return { filename, patch: '', status: 'modified' };
}

/**
 * Split unified-diff text into the per-file shape `windowFile` expects.
 *
 * Exported because it serves two callers with the same grammar: `git diff`
 * output, and a diff a client fetched elsewhere and passed as `diff`. One
 * parser means renames, empty additions and mode-only changes are classified
 * identically no matter where the diff came from.
 *
 * @param {string} text Unified diff, `diff --git` headers included.
 * @returns {Array<{filename: string, patch: string, status?: string}>}
 */
export function parseUnifiedDiff(text) {
    const src = String(text || '');

    if (src.includes('diff --git ')) {
        const files = [];
        for (const chunk of src.split(/^diff --git /m).filter(Boolean)) {
            const header = chunk.split('\n')[0] || '';
            const match = header.match(/b\/(.+)$/);
            const filename = match ? match[1].trim() : 'unknown';
            const at = chunk.indexOf('\n@@');
            if (at < 0) {
                files.push(classifyHunkless(chunk, filename));
                continue;
            }
            files.push({ filename, patch: chunk.slice(at + 1) });
        }
        return files;
    }

    // `diff -u` and several API responses omit the `diff --git` header but still
    // name both sides. Worth handling: a client fetching through another MCP
    // server may hand over this form, and rejecting it would push the user back
    // to configuring a token here.
    if (/^--- /m.test(src) && /^\+\+\+ /m.test(src)) {
        return parsePlainUnifiedDiff(src);
    }

    // Not a diff. Returning an entry named 'unknown' — as the git branch does
    // for a hunkless chunk — would invent a changed file that does not exist
    // and report analysis against it. An empty list lets the tool say plainly
    // that it found no changed files.
    return [];
}

/** The `--- old` / `+++ new` form, with no `diff --git` header. */
function parsePlainUnifiedDiff(src) {
    const files = [];
    for (const block of src.split(/^(?=--- )/m)) {
        if (!block.startsWith('--- ')) continue;
        const lines = block.split('\n');
        const plus = lines.find((l) => l.startsWith('+++ '));
        if (!plus) continue;

        const strip = (v) => v.replace(/\t.*$/, '').trim().replace(/^[ab]\//, '');
        const newPath = strip(plus.slice(4));
        const oldPath = strip(lines[0].slice(4));

        const at = block.indexOf('\n@@');
        const patch = at >= 0 ? block.slice(at + 1) : '';
        if (newPath === '/dev/null') {
            files.push({ filename: oldPath, patch, status: 'removed' });
        } else {
            files.push({
                filename: newPath || 'unknown',
                patch,
                ...(oldPath === '/dev/null' ? { status: 'added' } : {}),
            });
        }
    }
    return files;
}
