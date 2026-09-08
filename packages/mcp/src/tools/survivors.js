import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isCodeSourcePath } from '../../../../src/utils/codeFileFilter.js';

const exec = promisify(execFile);

/**
 * References to removed symbols that survive OUTSIDE the change.
 *
 * The bundle's structural blind spot: every other section is scoped to the
 * diff, so a reference to a deleted symbol in a file the change never opens
 * cannot appear. On the merge request that drove this work, four of six
 * findings were exactly that shape — a whole retrieval channel left dead in an
 * untouched file, a comment citing a deleted function as a live precedent, and
 * three documents still advertising a deleted HTTP route and a retired search
 * mode. No amount of improving the diff sections reaches them.
 *
 * What does reach them: take the names just established as removed and look for
 * them in the rest of the repository at the reviewed revision. `git grep` over
 * a revision (not the worktree) keeps this consistent with every other section,
 * costs one process per name, and respects .gitignore for free.
 *
 * A hit is EVIDENCE, not a defect: a name can legitimately survive in a
 * changelog, an ADR recording the removal, or a comment explaining it. The
 * section says where the name still is and leaves the judgement to the reader —
 * which is the same contract as the rest of the bundle.
 */

/** Documentation is worth flagging but is not the same as live code. */
const DOC_RE = /\.(md|markdown|mdx|txt|rst|adoc|asciidoc|org)$/i;

/**
 * Is this a file whose reference a reviewer can act on — source or prose?
 *
 * From the real re-run: searching for `connect` returned
 * `data/vectors/case-index.json` (a 152,039-case index), `package-lock.json`,
 * a k8s manifest and a conversation fixture, all labelled `code`. A name
 * inside serialised data is not a reference to a symbol; it is a coincidence
 * of text, and it crowds out the hits that mean something.
 */
function isReportablePath(filePath) {
    return isCodeSourcePath(filePath) || DOC_RE.test(filePath);
}

/**
 * Names too short or too generic to search for.
 *
 * A one- or two-character name matches everywhere, and a name like `get`,
 * `main` or `execute` is a method on half the objects in a repository. Searching
 * for them floods the section with noise and buries the specific names that
 * carry signal, so they are skipped and NAMED as skipped — a reader must not
 * read their absence as "nothing references them".
 */
const TOO_COMMON = new Set([
    'get', 'set', 'main', 'run', 'execute', 'handle', 'handler', 'init', 'index',
    'constructor', 'render', 'parse', 'format', 'value', 'data', 'result', 'error',
    'name', 'type', 'id', 'key', 'add', 'remove', 'update', 'create', 'delete',
    'start', 'stop', 'close', 'open', 'read', 'write', 'send', 'call', 'apply',
    'test', 'expect', 'describe', 'it', 'before', 'after', 'setup', 'teardown',
]);

const MIN_NAME_LENGTH = 4;

function isSearchable(name) {
    const n = String(name || '');
    return n.length >= MIN_NAME_LENGTH && !TOO_COMMON.has(n.toLowerCase());
}

/**
 * @param {string} repo
 * @param {string} rev Revision to search — the same one the hunks describe.
 * @param {string[]} names Symbols the change removes.
 * @param {string[]} changedFiles Paths the change touches; excluded from hits.
 * @param {{maxNames?: number, maxFilesPerName?: number, maxLinesPerFile?: number}} [opts]
 */
export async function findSurvivingReferences(repo, rev, names = [], changedFiles = [], opts = {}) {
    const maxNames = opts.maxNames ?? 40;
    const maxFilesPerName = opts.maxFilesPerName ?? 12;
    const maxLinesPerFile = opts.maxLinesPerFile ?? 3;

    const unique = [...new Set(names.filter(Boolean))];
    const skipped = unique.filter((n) => !isSearchable(n));
    const searchable = unique.filter(isSearchable);
    const queried = searchable.slice(0, maxNames);
    const notes = [];
    if (searchable.length > queried.length) {
        notes.push(`name list capped at ${maxNames} of ${searchable.length}`);
    }

    const touched = new Set(changedFiles);
    // 6, measured: on the real re-run `connect` matched 9 files and
    // `onModuleInit` 12 — both framework hooks, both noise — while the names
    // that carried signal matched 1 and 3. A leftover reference is rare by
    // nature; a name spread wider than this is part of the vocabulary.
    const genericThreshold = opts.genericThreshold ?? 6;
    const references = [];
    const namesTooCommonInRepo = [];
    const namesWithNoReferences = [];
    let searchFailed = null;

    for (const name of queried) {
        let stdout = '';
        try {
            // -F -w: fixed string, whole word — `Dense` must not match
            // `DenseCandidate`. `-I` skips binaries.
            const r = await exec(
                'git',
                ['grep', '-n', '-I', '-F', '-w', '--', name, rev],
                { cwd: repo, maxBuffer: 32 * 1024 * 1024 },
            );
            stdout = r.stdout;
        } catch (error) {
            // git grep exits 1 for "no matches", which is not an error. Any
            // other failure (a revision that does not exist) is reported once.
            if (error?.code === 1) {
                namesWithNoReferences.push(name);
                continue;
            }
            searchFailed = error?.message || String(error);
            break;
        }

        const byFile = new Map();
        for (const line of stdout.split('\n')) {
            if (!line) continue;
            // `<rev>:<path>:<line>:<text>`
            const withoutRev = line.startsWith(`${rev}:`) ? line.slice(rev.length + 1) : line;
            const firstColon = withoutRev.indexOf(':');
            if (firstColon < 0) continue;
            const filePath = withoutRev.slice(0, firstColon);
            const rest = withoutRev.slice(firstColon + 1);
            const secondColon = rest.indexOf(':');
            if (secondColon < 0) continue;
            const lineNo = Number.parseInt(rest.slice(0, secondColon), 10);
            const text = rest.slice(secondColon + 1);

            if (touched.has(filePath)) continue;
            if (!isReportablePath(filePath)) continue;
            if (!byFile.has(filePath)) byFile.set(filePath, []);
            const lines = byFile.get(filePath);
            if (lines.length < maxLinesPerFile) {
                lines.push({ line: lineNo, text: text.trim().slice(0, 200) });
            }
        }

        if (byFile.size === 0) {
            namesWithNoReferences.push(name);
            continue;
        }

        // Genericity measured, not guessed. `onModuleInit` and `connect` are
        // framework hooks: they matched a dozen unrelated processors, comments
        // and cache services on the real re-run, burying the specific names
        // under them. A name spread across this much of the repository is not
        // a leftover reference, and listing it file by file is noise — so it
        // is reported as generic, with its count, and left unlisted.
        if (byFile.size > genericThreshold) {
            namesTooCommonInRepo.push({ name, files: byFile.size });
            continue;
        }

        const filesForName = [...byFile.entries()]
            // Code before documentation: a live reference outranks a mention.
            .sort((a, b) => (DOC_RE.test(a[0]) ? 1 : 0) - (DOC_RE.test(b[0]) ? 1 : 0))
            .slice(0, maxFilesPerName)
            .map(([filePath, lines]) => ({
                path: filePath,
                kind: DOC_RE.test(filePath) ? 'docs' : 'code',
                lines,
            }));

        references.push({
            name,
            files: filesForName,
            ...(byFile.size > maxFilesPerName
                ? { moreFiles: byFile.size - maxFilesPerName }
                : {}),
        });
    }

    if (searchFailed) {
        return {
            references: [],
            namesWithNoReferences: [],
            namesSkipped: skipped,
            namesQueried: 0,
            note: `could not search the repository at ${rev}: ${searchFailed}`,
        };
    }

    return {
        references,
        namesWithNoReferences,
        ...(namesTooCommonInRepo.length > 0 ? { namesTooCommonInRepo } : {}),
        namesSkipped: skipped,
        namesQueried: queried.length,
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        guidance: 'a surviving reference is evidence, not a verdict: a name may legitimately '
            + 'remain in an ADR or a comment recording its removal. Code references outrank '
            + 'documentation ones. Only source and documentation files are searched — a name '
            + 'inside serialised data is a coincidence of text. Names in namesSkipped were too '
            + 'short or generic to search, and names in namesTooCommonInRepo matched too much '
            + 'of the repository to be a leftover; for both, nothing was looked for',
    };
}

export default { findSurvivingReferences };
