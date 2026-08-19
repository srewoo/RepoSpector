/**
 * siblingSweep — report the instances of a flagged pattern the reviewer missed.
 *
 * The measured recall problem is not only that findings are wrong; it is that
 * they are incomplete. `eval/README.md` records 23.0% human-comment recall — 104
 * of 135 real reviewer threads unmatched — and the injected-defect run shows the
 * shape of it: `unchecked-error` 6/9 and `loose-equality` 4/6, with the misses
 * concentrated in large files. The reviewer finds A defect of a class and stops;
 * the same class two hundred lines down goes unmentioned.
 *
 * Borrowed, with credit, from OrenAshkenazy/gh-review-loop, whose framing is the
 * clearest statement of the problem: *"Your AI reviewer flagged two instances of
 * a bug. There are five."* Its insight is that once a pattern is flagged at two
 * or more sites, the sites themselves define the pattern better than any prompt —
 * intersect their tokens and search the changed files for the rest.
 *
 * ## The safety property, which is the whole design
 *
 * A candidate must contain what the flagged sites have in COMMON, not what any
 * one of them happens to contain. Two sites flagged for `==` on a config value
 * share `==`; they do not share the variable names, so the sweep looks for `==`
 * and not for one site's incidental identifiers. Intersection is what stops a
 * sweep from generalising off one example.
 *
 * ## Deliberately advisory, deliberately narrow
 *
 * Sweep hits are reported as candidates at low confidence, never as defects, and
 * never auto-posted as inline comments. Given this repo's measured precision, a
 * mechanism that MULTIPLIES findings has to be the most conservative thing in the
 * pipeline, so it refuses on every doubt:
 *
 *   - fewer than 2 flagged sites for a class → no sweep (one example is not a pattern)
 *   - fewer than {@link MIN_SHARED_TOKENS} shared tokens → no sweep (too generic)
 *   - only stopword-ish or single-character tokens → no sweep
 *   - lines already flagged by the reviewer → not reported
 *   - never reads a file outside the diff
 *
 * An advisory report that fires falsely stops being read. A missed sibling costs
 * one informational line.
 */

import { parsePatchHunks } from './patchLines.js';

/** A class must be flagged at least this many times before its pattern is trusted. */
export const MIN_SITES = 2;

/** Below this many shared tokens the pattern is too generic to search on. */
export const MIN_SHARED_TOKENS = 2;

/** Per-class cap, so one broad pattern cannot flood a review. */
export const MAX_HITS_PER_CLASS = 5;

/**
 * Only the exact flagged line is excluded, not a window around it.
 *
 * A window was the first instinct — suppress the reviewer's own finding and any
 * line that is really the same multi-line statement. It is wrong here: real code
 * puts sibling instances on CONSECUTIVE lines (three `==` comparisons in a row,
 * four unchecked calls in a block), which is the densest and most valuable case
 * the sweep exists to catch. A window of even one line deletes exactly those.
 *
 * The same-statement risk is handled better by the token requirement: a
 * continuation line of one statement rarely carries every shared token. And the
 * sweep is advisory output, kept separate from findings, so a wrong lead costs a
 * line of text — while `dedupeFindings` still collapses real findings on its own
 * 25-line, class-aware window.
 */
const NEAR_EXISTING = 0;

/**
 * Tokens too common to carry meaning. A sweep keyed on `if` or `return` matches
 * most of the diff and is worse than silence.
 */
const STOPWORDS = new Set([
    'if', 'else', 'for', 'while', 'return', 'const', 'let', 'var', 'function', 'func',
    'def', 'class', 'import', 'from', 'export', 'new', 'this', 'self', 'true', 'false',
    'null', 'nil', 'none', 'undefined', 'and', 'or', 'not', 'in', 'is', 'the', 'to',
    'err', 'error', 'value', 'data', 'result', 'item', 'key', 'name', 'type', 'string',
    'int', 'bool', 'end', 'do', 'then', 'try', 'catch', 'with', 'as', 'at', 'by',
]);

/**
 * Reduce a line to the tokens worth intersecting.
 *
 * Operators are kept as tokens of their own — `==`, `!=`, `??`, `&&` — because a
 * loose-equality or nullish pattern lives entirely in its operator, and an
 * identifier-only tokenizer would find nothing shared between two such sites.
 */
export function tokenize(line) {
    const text = String(line || '');
    const out = new Set();

    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const tok = m[0];
        if (tok.length >= 3 && !STOPWORDS.has(tok.toLowerCase())) out.add(tok);
    }
    for (const m of text.matchAll(/(===|!==|==|!=|\?\?|&&|\|\||<<|>>|=>|->|\+\+|--)/g)) {
        out.add(m[0]);
    }
    return out;
}

/**
 * filename → unified patch, from a provider's PR payload.
 *
 * GitHub says `filename`/`patch`, GitLab says `new_path`/`diff`; both shapes are
 * accepted because the review path is provider-agnostic everywhere else.
 */
export function diffsByFile(prData) {
    const map = {};
    for (const f of (prData?.files || [])) {
        const name = f?.filename || f?.new_path || f?.path || f?.file;
        const patch = f?.patch ?? f?.diff ?? '';
        if (name && patch) map[name] = patch;
    }
    return map;
}

/** Added lines of every file in the diff: [{ file, line, content }]. */
function addedLinesOf(diffsByFile) {
    const out = [];
    for (const [file, patch] of Object.entries(diffsByFile || {})) {
        if (!patch) continue;
        for (const hunk of parsePatchHunks(patch)) {
            for (const l of hunk.lines) {
                if (l.type === 'added' && l.number.new != null) {
                    out.push({ file, line: l.number.new, content: l.content });
                }
            }
        }
    }
    return out;
}

/**
 * Defect class for sweeping.
 *
 * Prefers an explicit `ruleId` — a static rule already IS a class, and two hits
 * of one rule are the strongest possible signal that a pattern exists. Falls back
 * to the finding's own category/title shape.
 */
export function classOf(finding) {
    if (finding?.ruleId || finding?.rule) return `rule:${finding.ruleId || finding.rule}`;
    const text = String(finding?.title || finding?.message || '').toLowerCase();
    if (!text) return null;
    return 'text:' + text.replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * Find unflagged siblings of every pattern flagged at {@link MIN_SITES}+ sites.
 *
 * @param {Array<object>} findings - reported findings (post-verification)
 * @param {Record<string,string>} diffsByFile - unified patch per file
 * @returns {Array<{class:string, file:string, line:number, content:string,
 *                  sharedTokens:string[], sites:Array<{file:string,line:number}>}>}
 */
export function sweepSiblings(findings = [], diffsByFile = {}) {
    const byClass = new Map();
    for (const f of findings) {
        const cls = classOf(f);
        if (!cls || !f?.file || !Number.isFinite(Number(f.line))) continue;
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push({ file: f.file, line: Number(f.line) });
    }

    const added = addedLinesOf(diffsByFile);
    if (added.length === 0) return [];

    const lineText = new Map(added.map(a => [`${a.file}:${a.line}`, a.content]));
    const hits = [];

    for (const [cls, sites] of byClass) {
        if (sites.length < MIN_SITES) continue;

        // Intersect the tokens of every flagged site. A candidate must match what
        // the sites have in common — not what one of them happens to contain.
        let shared = null;
        let resolvedSites = 0;
        for (const site of sites) {
            const text = lineText.get(`${site.file}:${site.line}`);
            if (text == null) continue;           // site is not on an added line
            resolvedSites += 1;
            const toks = tokenize(text);
            shared = shared === null ? toks : new Set([...shared].filter(t => toks.has(t)));
        }
        if (resolvedSites < MIN_SITES) continue;
        if (!shared || shared.size < MIN_SHARED_TOKENS) continue;

        const sharedTokens = [...shared];
        const isFlagged = (file, line) =>
            sites.some(s => s.file === file && Math.abs(s.line - line) <= NEAR_EXISTING);

        const classHits = [];
        for (const cand of added) {
            if (isFlagged(cand.file, cand.line)) continue;
            const toks = tokenize(cand.content);
            if (sharedTokens.every(t => toks.has(t))) {
                classHits.push({
                    class: cls,
                    file: cand.file,
                    line: cand.line,
                    content: cand.content.trim().slice(0, 200),
                    sharedTokens,
                    sites,
                });
            }
            if (classHits.length >= MAX_HITS_PER_CLASS) break;
        }
        hits.push(...classHits);
    }

    return hits;
}

/**
 * Render the sweep as one advisory block.
 *
 * Deliberately a single summary rather than inline comments: these are candidates
 * the reviewer did not verify, and posting them at each site would present
 * unverified guesses with the same weight as adjudicated findings.
 *
 * @returns {string} markdown, or '' when nothing was swept
 */
export function renderSweep(hits = []) {
    if (hits.length === 0) return '';

    const byClass = new Map();
    for (const h of hits) {
        if (!byClass.has(h.class)) byClass.set(h.class, []);
        byClass.get(h.class).push(h);
    }

    const lines = [
        '### Possible unflagged siblings',
        '',
        'Each pattern below was flagged at 2+ places in this PR. These lines share the tokens those',
        'sites have in common and were **not** individually reviewed — treat them as leads, not findings.',
        '',
    ];

    for (const [cls, group] of byClass) {
        const label = cls.startsWith('rule:') ? `\`${cls.slice(5)}\`` : cls.slice(5);
        lines.push(`**${label}** — shared: ${group[0].sharedTokens.map(t => `\`${t}\``).join(', ')}`);
        for (const h of group) {
            lines.push(`- \`${h.file}:${h.line}\` — \`${h.content}\``);
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}

export default { sweepSiblings, renderSweep, tokenize, classOf, diffsByFile, MIN_SITES };
