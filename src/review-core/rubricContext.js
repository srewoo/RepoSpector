import { parsePatchHunks } from '../utils/patchLines.js';
import { claimsRule } from './rubricScorer.js';

/**
 * The per-finding context the rubric scorer reads (spec §2.1): the diff hunk
 * around the finding (±20 lines), the pre-change side of the same lines, and —
 * only for a finding that claims a rule — the loaded rules files, capped.
 *
 * Pure and transport-free: the extension, the MCP server and the eval harness
 * all build the scorer's `contextFor` here, so all three score from the same
 * view of the change.
 */

export const RUBRIC_HUNK_RADIUS = 20;
export const RUBRIC_RULES_CHARS = 4000;

// One definition of "claims a rule", owned by the scorer that caps on it.
export { claimsRule };

function hunksOf(file) {
    return file?.hunks ?? parsePatchHunks(file?.patch ?? file?.diff ?? '');
}

function pathOf(file) {
    return file?.newPath ?? file?.filename ?? file?.new_path ?? file?.path ?? null;
}

function pickHunk(hunks, target) {
    if (!hunks.length) return null;
    if (!Number.isFinite(target)) return hunks[0];
    const containing = hunks.find((h) => h.lines.some((l) => l.number.new === target));
    if (containing) return containing;
    return [...hunks].sort((a, b) => Math.abs(a.newStart - target) - Math.abs(b.newStart - target))[0];
}

function renderWindow(path, hunk, target, radius) {
    const out = [`--- ${path}`];
    const pre = [];
    let pos = hunk.newStart;
    for (const l of hunk.lines) {
        // A deleted line has no new-side number; it sits where the next new line would.
        const at = l.number.new ?? pos;
        if (l.number.new != null) pos = l.number.new + 1;
        if (Number.isFinite(target) && Math.abs(at - target) > radius) continue;
        const mark = l.type === 'added' ? '+' : l.type === 'deleted' ? '-' : ' ';
        out.push(`${mark}${l.content}`);
        if (l.type !== 'added') pre.push(l.content);
    }
    // Nothing within ±radius of the finding: give the scorer no context rather than a bare header.
    if (out.length === 1) return { hunk: '', preChangeLines: '' };
    return { hunk: out.join('\n'), preChangeLines: pre.join('\n') };
}

function rulesTextFor(rulesFiles) {
    return rulesFiles
        .map((r) => `# ${r.path}\n${r.text}`)
        .join('\n\n')
        .slice(0, RUBRIC_RULES_CHARS);
}

/**
 * @param {{files?: Array<object>, rulesFiles?: Array<{path: string, text: string}>, radius?: number}} input
 * @returns {(finding: object) => {hunk: string, preChangeLines: string, rulesText: string}}
 */
export function createRubricContextFor({ files = [], rulesFiles = [], radius = RUBRIC_HUNK_RADIUS } = {}) {
    const byPath = new Map(files.filter((f) => pathOf(f)).map((f) => [pathOf(f), hunksOf(f)]));
    const rulesText = rulesFiles.length ? rulesTextFor(rulesFiles) : '';

    return (finding) => {
        const path = finding?.file ?? finding?.filePath ?? null;
        const target = Number(finding?.line);
        const hunk = pickHunk(byPath.get(path) ?? [], target);
        const view = hunk ? renderWindow(path, hunk, target, radius) : { hunk: '', preChangeLines: '' };
        return { ...view, rulesText: claimsRule(finding) ? rulesText : '' };
    };
}

export default { createRubricContextFor, claimsRule, RUBRIC_HUNK_RADIUS, RUBRIC_RULES_CHARS };
