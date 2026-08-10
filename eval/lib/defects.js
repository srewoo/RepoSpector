/**
 * defects — inject known bugs into real diffs, so detection can be measured
 * against ground truth nobody has to adjudicate.
 *
 * Two benchmarks answer two different questions and are routinely confused:
 *
 *   HUMAN-COMMENT recall (eval/score.js against a fetched corpus) asks "does it
 *   review like our team?". Ground truth is what reviewers actually said, which
 *   includes design, naming and history a tool cannot know. It is the honest
 *   product question and it scores brutally.
 *
 *   INJECTED-DEFECT recall — this file — asks "can it find a bug at all?".
 *   Ground truth is a defect we planted, so the location and the nature of the
 *   issue are known exactly, and precision is measurable without a human. This
 *   is the methodology Qodo's PR Benchmark uses, and it is the one whose numbers
 *   are comparable across tools.
 *
 * Neither replaces the other. A tool can score well here and still be useless in
 * review, which is precisely why both live in this harness.
 *
 * Injection is deliberately conservative: a defect is only planted where the
 * pattern is unambiguous, so a miss is a real miss rather than a mangled file.
 */

import { parsePatchHunks } from '../../src/utils/patchLines.js';

/**
 * Defect catalogue.
 *
 * Each entry rewrites ONE added line into a broken version. `match` must be
 * specific enough that the rewrite cannot produce nonsense, and `category` is
 * recorded so misses can be read by class rather than as one number.
 */
export const DEFECTS = [
    {
        id: 'nullable-deref',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx'],
        description: 'Optional chaining removed, so a null intermediate now throws',
        match: /^(\s*.*?)(\w+)\?\.(\w+)/,
        apply: (line) => line.replace(/\?\./, '.'),
    },
    {
        id: 'loose-equality',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx'],
        description: 'Strict equality weakened to loose, admitting type coercion',
        match: /===/,
        apply: (line) => line.replace('===', '=='),
    },
    {
        id: 'nullish-to-or',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx'],
        description: '?? replaced with ||, so 0 and "" now fall through to the default',
        match: /\?\?/,
        apply: (line) => line.replace('??', '||'),
    },
    {
        id: 'unawaited-promise',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx'],
        description: 'await dropped, so the result is a pending Promise and errors are unhandled',
        match: /^(\s*)(const|let|var)\s+\w+\s*=\s*await\s+/,
        apply: (line) => line.replace(/\bawait\s+/, ''),
    },
    {
        id: 'bare-except',
        category: 'correctness',
        languages: ['py'],
        description: 'Specific exception widened to a bare except, swallowing SystemExit/KeyboardInterrupt',
        match: /^\s*except\s+\w[\w.]*(\s+as\s+\w+)?\s*:/,
        apply: (line) => line.replace(/except\s+\w[\w.]*(\s+as\s+\w+)?\s*:/, 'except:'),
    },
    {
        id: 'mutable-default',
        category: 'correctness',
        languages: ['py'],
        description: 'Default argument changed to a shared mutable list',
        match: /^\s*def\s+\w+\([^)]*=\s*None[^)]*\)/,
        apply: (line) => line.replace(/=\s*None/, '=[]'),
    },
    {
        id: 'unchecked-error',
        category: 'correctness',
        languages: ['go'],
        description: 'Returned error discarded with _, so a failure passes silently',
        match: /^(\s*)(\w+),\s*err\s*:=\s*/,
        apply: (line) => line.replace(/,\s*err\s*:=/, ', _ :='),
    },
    {
        id: 'inverted-condition',
        category: 'correctness',
        languages: ['py'],
        description: 'Guard condition inverted — the branch now runs in exactly the wrong case',
        match: /^\s*(if|elif)\s+not\s+\w[\w.]*\s*:/,
        apply: (line) => line.replace(/\b(if|elif)\s+not\s+/, '$1 '),
    },
    {
        id: 'inverted-condition-js',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx', 'go'],
        description: 'Guard condition inverted — the branch now runs in exactly the wrong case',
        match: /^\s*if\s*\(\s*!\w[\w.]*\s*\)/,
        apply: (line) => line.replace(/if\s*\(\s*!/, 'if ('),
    },
    {
        id: 'off-by-one-loop',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx', 'go'],
        description: 'Loop bound widened to <=, reading one past the end',
        match: /for\s*\(?\s*\w+\s*:?=\s*0\s*;\s*\w+\s*<\s*\w[\w.()]*\s*;/,
        apply: (line) => line.replace(/(;\s*\w+\s*)<(\s*\w)/, '$1<=$2'),
    },
    {
        id: 'boundary-flip',
        category: 'correctness',
        languages: ['js', 'jsx', 'ts', 'tsx', 'py', 'go'],
        description: 'Boundary comparison changed from >= to >, excluding the edge value',
        match: />=/,
        apply: (line) => line.replace('>=', '>'),
    },
    {
        id: 'dict-keyerror',
        category: 'correctness',
        languages: ['py'],
        description: '.get(key, default) replaced with [key], raising KeyError when absent',
        match: /\.get\(\s*([^,()]+)\s*,\s*[^()]+\)/,
        apply: (line) => line.replace(/\.get\(\s*([^,()]+)\s*,\s*[^()]+\)/, '[$1]'),
    },
    {
        id: 'sql-injection',
        category: 'security',
        languages: ['py'],
        description: 'Parameterised query replaced with string interpolation',
        match: /execute\(\s*["'][^"']*%s/,
        apply: (line) => line.replace(/%s/g, '" + str(value) + "'),
    },
    {
        id: 'hardcoded-secret',
        category: 'security',
        languages: ['js', 'jsx', 'ts', 'tsx', 'py', 'go'],
        description: 'Secret read from the environment replaced with a literal',
        match: /(process\.env\.\w+|os\.environ\[["']\w+["']\]|os\.Getenv\(["']\w+["']\))/,
        apply: (line) => line.replace(
            /(process\.env\.\w+|os\.environ\[["']\w+["']\]|os\.Getenv\(["']\w+["']\))/,
            '"sk-live-9f3a2b7c41de8890"',
        ),
    },
];

/** File extension, lower-cased, without the dot. */
function extOf(filename) {
    const m = String(filename ?? '').match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
}

/**
 * Paths whose defects would not be a fair test.
 *
 * A bug planted in a test file is a bug in the test, and a reviewer that stays
 * quiet about it is arguably right — scoring that as a miss measures the
 * benchmark's taste, not the tool's. Generated and vendored code is excluded
 * for the same reason.
 */
const NOT_UNDER_TEST = /(^|\/)(tests?|__tests__|testdata|fixtures?|vendor|node_modules|dist|build)(\/|$)|(\.|_)(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]*$|\.min\.[A-Za-z0-9]+$|\.(pb|generated)\.[A-Za-z0-9]+$/i;

export function isInjectable(filename) {
    return !NOT_UNDER_TEST.test(String(filename ?? ''));
}

/** Defects applicable to a file, in catalogue order. */
export function defectsFor(filename) {
    if (!isInjectable(filename)) return [];
    const ext = extOf(filename);
    return DEFECTS.filter(d => d.languages.includes(ext));
}

/**
 * Inject at most `maxPerFile` defects into one file's patch.
 *
 * Only ADDED lines are rewritten: a defect planted on a context line would be
 * pre-existing code, which the reviewer is explicitly told to ignore, so a miss
 * would be correct behaviour scored as a failure.
 *
 * @param {{filename:string, patch:string}} file
 * @param {{maxPerFile?:number, only?:string[]}} [options]
 * @returns {{patch:string, injected:Array<{id:string,category:string,file:string,line:number,description:string,before:string,after:string}>}}
 */
export function injectIntoFile(file, options = {}) {
    const { maxPerFile = 2, only = null } = options;
    const catalogue = defectsFor(file.filename)
        .filter(d => (only ? only.includes(d.id) : true));

    if (catalogue.length === 0 || !file.patch) {
        return { patch: file.patch, injected: [] };
    }

    const injected = [];
    const usedDefects = new Set();
    const lines = file.patch.split('\n');

    // Walk the parsed hunks to know each added line's real file line, then
    // rewrite the corresponding raw patch line. Working from the parse keeps
    // the recorded ground-truth line and the mutated text in agreement.
    const hunks = parsePatchHunks(file.patch);
    const addedByContent = new Map();
    for (const h of hunks) {
        for (const l of h.lines) {
            if (l.type === 'added' && l.number.new != null && !addedByContent.has(l.content)) {
                addedByContent.set(l.content, l.number.new);
            }
        }
    }

    for (let i = 0; i < lines.length && injected.length < maxPerFile; i++) {
        const raw = lines[i];
        if (!raw.startsWith('+') || raw.startsWith('+++')) continue;

        const content = raw.slice(1);
        const fileLine = addedByContent.get(content);
        if (fileLine == null) continue;

        for (const defect of catalogue) {
            // One instance of each defect class per file — repeats measure the
            // same capability twice and skew the per-category totals.
            if (usedDefects.has(defect.id)) continue;
            if (!defect.match.test(content)) continue;

            const after = defect.apply(content);
            if (after === content) continue;   // pattern matched but rewrite was a no-op

            lines[i] = `+${after}`;
            usedDefects.add(defect.id);
            injected.push({
                id: defect.id,
                category: defect.category,
                file: file.filename,
                line: fileLine,
                description: defect.description,
                before: content.trim().slice(0, 160),
                after: after.trim().slice(0, 160),
            });
            break;
        }
    }

    return { patch: lines.join('\n'), injected };
}

/**
 * Inject defects across a PR's files.
 *
 * @param {object} prData - normalized PR data (mutated copy returned)
 * @param {{maxPerFile?:number, maxPerPr?:number, only?:string[]}} [options]
 * @returns {{prData:object, injected:Array}}
 */
export function injectIntoPr(prData, options = {}) {
    const { maxPerPr = 6 } = options;
    const injected = [];
    const files = [];

    for (const file of prData.files ?? []) {
        if (injected.length >= maxPerPr) { files.push(file); continue; }
        const res = injectIntoFile(file, {
            ...options,
            maxPerFile: Math.min(options.maxPerFile ?? 2, maxPerPr - injected.length),
        });
        files.push({ ...file, patch: res.patch });
        injected.push(...res.injected);
    }

    return { prData: { ...prData, files }, injected };
}

export default { DEFECTS, defectsFor, isInjectable, injectIntoFile, injectIntoPr };
