/**
 * Stable identity for predictions and reference defects — P0-3.
 *
 * The scorer used to match an adjudication to a prediction by file and nearby
 * line. That is not identity: two findings five lines apart are two claims, and
 * the human verdict on one of them was being credited to the other. A run could
 * therefore report precision it had not measured — the exact failure mode that
 * makes an evaluator unusable for approving changes to the thing it evaluates.
 *
 * Identity here is content-derived rather than assigned, because the corpus is
 * regenerated from runs: `makeFindingId()` embeds a timestamp, so the same
 * finding gets a different id on every run and no verdict would ever survive a
 * re-run. A hash of (file, line, rule, title) is stable across runs and
 * distinguishes co-located findings, which is exactly what the verdict needs.
 */

/** Normalize a path for identity: no leading ./, no leading/trailing slash. */
function normPath(p) {
    return String(p ?? '')
        .replace(/^\.\//, '')
        .replace(/^\/+|\/+$/g, '')
        .trim();
}

/** Collapse whitespace and case so trivial re-wording keeps the same id. */
function normText(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * FNV-1a, run with two different offset bases and concatenated.
 *
 * Written out rather than imported from `node:crypto` so the same function is
 * available to the browser-side corpus tooling and to jest's CommonJS
 * transform without a conditional import. 64 bits is ample to keep a few
 * hundred findings per corpus collision-free.
 */
export function hashId(text) {
    const s = String(text);
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a ^= c;
        a = Math.imul(a, 0x01000193) >>> 0;
        b ^= c;
        b = Math.imul(b, 0x811c9dc5) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * The identity of one predicted finding.
 *
 * An explicit `predictionId` always wins, so a corpus can pin identity that
 * content alone would not preserve (a re-worded title, a shifted line).
 */
export function predictionId(prediction) {
    if (prediction?.predictionId) return String(prediction.predictionId);
    const file = normPath(prediction?.file ?? prediction?.filePath ?? prediction?.path);
    const line = prediction?.line ?? prediction?.lineNumber ?? prediction?.startLine ?? '';
    const rule = normText(prediction?.rule);
    const title = normText(prediction?.title ?? prediction?.message ?? prediction?.suggestion);
    return `p_${hashId([file, line, rule, title].join(' '))}`;
}

/**
 * The identity of one reference defect (an injected defect, or a human
 * comment standing in for one). Recall is matched against this one-to-one.
 */
export function defectId(reference) {
    if (reference?.defectId) return String(reference.defectId);
    if (reference?.id) return String(reference.id);
    const file = normPath(reference?.file ?? reference?.filePath ?? reference?.path);
    const line = reference?.line ?? reference?.lineNumber ?? '';
    const tag = normText(reference?.tag);
    const body = normText(reference?.body ?? reference?.title ?? reference?.description).slice(0, 200);
    return `d_${hashId([file, line, tag, body].join(' '))}`;
}

export default { hashId, predictionId, defectId };
