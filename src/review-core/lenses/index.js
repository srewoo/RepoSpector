/**
 * New finder lenses (spec §3) — the context-backed ones.
 *
 * The nine lenses in `utils/finderLensPrompts.js` read only the diff. These four
 * each need context the diff does not carry (history, nearby comments, the
 * repo's rules files, earlier review feedback), declared in `needs`. Before a
 * lens runs, every need is resolved through the context port; a need that
 * cannot be resolved makes the lens `not-run` WITH a reason, never an empty
 * "found nothing" (the completeness contract).
 *
 * Lens shape: {key, title, instruction, needs, appliesTo?, accepts?}
 *   accepts(finding) — optional post-filter the runner applies to the lens's
 *   own findings (rulesCompliance drops findings that do not quote a rule).
 */
import { CONTEXT_STATUS, ctxNotRun } from '../context/contextPort.js';
import { parsePatchHunks } from '../../utils/patchLines.js';
import { isCodeSourcePath } from '../../utils/codeFileFilter.js';
import { historyLens, resolveHistory } from './history.js';
import { codeCommentsLens, resolveComments } from './codeComments.js';
import { rulesComplianceLens, resolveRules } from './rulesCompliance.js';
import { priorPrCommentsLens, resolvePriorPr } from './priorPrComments.js';

export const NEW_LENSES = Object.freeze([historyLens, codeCommentsLens, rulesComplianceLens, priorPrCommentsLens]);

export const LENS_LIMITS = Object.freeze({
    maxFiles: 10,
    maxContextChars: 4000,
    commentRadius: 40,
    recentCommits: 5,
    priorPrLimit: 5,
});

/** Config switch per lens (spec §3.4). */
export const LENS_SWITCHES = Object.freeze({
    history: 'lensHistory',
    codeComments: 'lensCodeComments',
    rulesCompliance: 'lensRulesCompliance',
    priorPrComments: 'lensPriorPrComments',
});

const RESOLVERS = { history: resolveHistory, comments: resolveComments, rules: resolveRules, priorPr: resolvePriorPr };
const NEEDS_PORT = new Set(['history', 'comments', 'priorPr']);

/** The new lenses whose switch is not explicitly false in a resolved config. */
export function enabledNewLenses(config = {}) {
    return NEW_LENSES.filter(l => config?.[LENS_SWITCHES[l.key]] !== false);
}

/**
 * Changed code files worth context lookups: not deleted, code by extension,
 * top `maxFiles` by churn. For each: base-side span to blame, and the new-side
 * changed line numbers to look for comments around.
 */
export function selectTargets(files = [], maxFiles = LENS_LIMITS.maxFiles) {
    // Patch length stands in for churn only when the host sent no counts.
    const churn = f => (f.additions == null && f.deletions == null
        ? String(f.patch || '').length
        : (f.additions ?? 0) + (f.deletions ?? 0));
    return files
        .filter(f => f?.filename && f.status !== 'removed' && isCodeSourcePath(f.filename))
        .map((f, index) => ({ f, index }))
        .sort((a, b) => churn(b.f) - churn(a.f) || a.index - b.index)
        .slice(0, maxFiles)
        .map(({ f }) => {
            const oldNums = [];
            const newLines = [];
            for (const h of parsePatchHunks(f.patch)) {
                for (const l of h.lines) {
                    if (l.number.old != null) oldNums.push(l.number.old);
                    if (l.type === 'added') newLines.push(l.number.new);
                }
            }
            const oldSpan = f.status === 'added' || !oldNums.length
                ? null
                : { start: Math.min(...oldNums), end: Math.max(...oldNums) };
            return { path: f.filename, oldSpan, newLines };
        });
}

const cap = (text, max) => (text.length > max
    ? `${text.slice(0, max)}\n… (lens context truncated at ${max} chars)`
    : text);

/**
 * Resolve every need of one lens.
 *
 * @returns {Promise<{status:'ok', text:string} | {status:'not-run', reason:string}>}
 */
export async function gatherLensContext(lens, {
    files = [], contextPort = null, rulesFiles = [], baseSha = null, headSha = null, limits = {},
} = {}) {
    const lim = { ...LENS_LIMITS, ...limits };
    const targets = selectTargets(files, lim.maxFiles);
    const parts = [];
    for (const need of lens.needs || []) {
        const resolve = RESOLVERS[need];
        if (!resolve) return ctxNotRun(`unknown context need "${need}"`);
        if (NEEDS_PORT.has(need) && !contextPort) return ctxNotRun(`no context source for "${need}"`);
        if (NEEDS_PORT.has(need) && !targets.length) return ctxNotRun('no changed code files');
        let res;
        try {
            res = await resolve({ targets, contextPort, rulesFiles, baseSha, headSha, limits: lim });
        } catch (e) {
            res = ctxNotRun(`${need} context failed: ${e?.message || 'unknown error'}`);
        }
        if (res?.status !== CONTEXT_STATUS.OK) return ctxNotRun(res?.reason || `${need} context unavailable`);
        parts.push(res.text);
    }
    return { status: CONTEXT_STATUS.OK, text: cap(parts.join('\n\n'), lim.maxContextChars) };
}

/**
 * Split lenses into those that can run (with their context) and those that
 * cannot. Lenses with no `needs` pass straight through. Context is resolved
 * once per review here, so later finder rounds reuse it.
 *
 * @returns {Promise<{runnable:Array, contexts:Map<string,string>, skipped:Array<{lens:string, status:'not-run', reason:string}>}>}
 */
export async function prepareLensContexts(lenses, opts = {}) {
    const contexts = new Map();
    const skipped = [];
    const results = await Promise.all((lenses || []).map(async (lens) => (
        lens.needs?.length ? { lens, res: await gatherLensContext(lens, opts) } : { lens, res: null }
    )));
    const runnable = [];
    for (const { lens, res } of results) {
        if (!res) { runnable.push(lens); continue; }
        if (res.status === CONTEXT_STATUS.OK) {
            contexts.set(lens.key, res.text);
            runnable.push(lens);
        } else {
            skipped.push({ lens: lens.key, status: CONTEXT_STATUS.NOT_RUN, reason: res.reason });
        }
    }
    return { runnable, contexts, skipped };
}

export default { NEW_LENSES, LENS_LIMITS, LENS_SWITCHES, enabledNewLenses, gatherLensContext, prepareLensContexts, selectTargets };
