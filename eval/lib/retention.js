/**
 * retention — where candidates go to die. P1-7.
 *
 * The harness reported how many findings came out and how many a human agreed
 * with. It could not answer the question that decides whether a precision
 * change was worth shipping: *which stage removed the true positives?* Buying
 * precision by deleting real defects looks identical, in a summary, to buying
 * it by deleting false ones.
 *
 * So every stage that can remove a candidate records what it removed, keyed by
 * the stable prediction id from `lib/ids.js`. Once adjudications exist, the
 * report can say "the precision gate dropped 14 candidates, 3 of which a human
 * called real" — which is the cost side of the trade, and the number that
 * decides it.
 */

import { predictionId } from './ids.js';

/** The stages a candidate passes through, in order. */
export const STAGES = Object.freeze([
    'generated',
    'multi-finder',
    'citations',
    'verification',
    'scoring',
    'precision-gate',
    'hypothesis-validation',
    'deterministic-admission',
    'diff-scope',
    'posting-policy',
]);

export function createRetention() {
    return {
        /** stage -> { in, out, dropped: [{id, file, line, title, reason}] } */
        stages: [],
        _seen: new Set(),
    };
}

/**
 * Record one stage's effect.
 *
 * Both sides are passed in rather than a delta, because a stage that also ADDS
 * candidates (the deterministic re-adds) would otherwise report a negative drop
 * and hide what it removed.
 */
export function recordStage(retention, stage, before = [], after = [], reasonOf = null) {
    const afterIds = new Set(after.map(predictionId));
    const dropped = before
        .filter((f) => !afterIds.has(predictionId(f)))
        .map((f) => ({
            id: predictionId(f),
            file: f.file ?? f.filePath ?? null,
            line: f.line ?? null,
            title: f.title ?? null,
            severity: f.severity ?? null,
            source: f.source ?? null,
            reason: (typeof reasonOf === 'function' ? reasonOf(f) : null)
                ?? f._precisionDrop
                ?? f.filteredBecause
                ?? f._admissionDrop
                ?? stage,
        }));

    const beforeIds = new Set(before.map(predictionId));
    const added = after.filter((f) => !beforeIds.has(predictionId(f))).length;

    retention.stages.push({
        stage,
        in: before.length,
        out: after.length,
        added,
        droppedCount: dropped.length,
        dropped,
    });
    return retention;
}

/**
 * Attribute each dropped candidate to a human verdict, once adjudications exist.
 *
 * `adjudications` are the corpus's, carrying `predictionId` (P0-3). A drop with
 * no verdict is `unknown` and is reported as such — counting it as a correct
 * suppression is precisely the self-congratulation this is meant to prevent.
 */
export function scoreRetention(retention, adjudications = []) {
    const verdictById = new Map();
    for (const a of adjudications) {
        if (a?.predictionId) verdictById.set(String(a.predictionId), a.verdict);
    }

    return retention.stages.map((s) => {
        let trueDropped = 0;
        let falseDropped = 0;
        let unknownDropped = 0;
        for (const d of s.dropped) {
            const verdict = verdictById.get(d.id);
            if (verdict === 'true_positive') trueDropped++;
            else if (verdict === 'false_positive') falseDropped++;
            else unknownDropped++;
        }
        return {
            stage: s.stage,
            in: s.in,
            out: s.out,
            added: s.added,
            droppedCount: s.droppedCount,
            // The cost side of every precision change.
            trueDropped,
            falseDropped,
            unknownDropped,
        };
    });
}

/** A table a reader can act on. */
export function formatRetention(scored = []) {
    if (!scored.length) return '';
    const rows = scored.map((s) => (
        `  ${String(s.stage).padEnd(26)}`
        + `${String(s.in).padStart(4)} → ${String(s.out).padEnd(4)}`
        + `  dropped ${String(s.droppedCount).padStart(3)}`
        + `  (real ${s.trueDropped}, false ${s.falseDropped}, unjudged ${s.unknownDropped})`
    ));
    return ['', 'Candidate retention by stage:', ...rows].join('\n');
}

export default { STAGES, createRetention, recordStage, scoreRetention, formatRetention };
