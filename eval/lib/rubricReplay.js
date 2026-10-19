/**
 * rubricReplay — the rubric threshold, its deterministic caps and the unscored
 * policy, re-applied to stored predictions (spec §5.1). No model, no network.
 *
 * What it cannot measure, stated so nobody reads it as more: it replays the
 * scorer's stored judgements, it does not re-judge, and it says nothing about
 * recall the new lenses add. Those need `eval:real` / `eval:injected` runs.
 */

import { applyCaps, filterByRubric, DEFAULT_MIN_RUBRIC_SCORE } from '../../src/review-core/rubricScorer.js';
import { renderRepoRulesText } from '../../src/review-core/repoRulesText.js';
import { CustomRulesService } from '../../src/services/CustomRulesService.js';

/** `.repospector.yaml` → its rule entries only (the shared renderer), never the settings block. */
function repoYamlRulesText(yaml) {
    const svc = new CustomRulesService();
    return renderRepoRulesText(svc.validateConfig(svc.parseYAML(yaml)));
}

const RULES_FILE_RE = /(^|\/)(CLAUDE\.md|AGENTS\.md|\.repospector\.yaml)$/;

/** Rules files the case cached in `fileContents` — the same set `eval/run.js` scores with. */
export function rulesFilesForCase(kase) {
    return Object.entries(kase?.fileContents ?? {})
        .filter(([p]) => RULES_FILE_RE.test(p))
        .map(([p, v]) => ({ path: p, text: typeof v === 'string' ? v : (v?.content ?? '') }))
        .map((r) => (/\.repospector\.yaml$/.test(r.path) ? { ...r, text: repoYamlRulesText(r.text) } : r))
        .filter((r) => r.text);
}

export function parseRubricThreshold(raw) {
    const s = String(raw ?? '').trim();
    const n = Number(s);
    if (!/^\d+$/.test(s) || n > 100) {
        return { ok: false, error: `--rubric-threshold needs an integer 0-100, got ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: n };
}

const blank = () => ({ true_positive: 0, false_positive: 0, unadjudicated: 0 });

function replayScored(pred, rulesTexts, report) {
    const r = pred.rubric;
    let score = r.score;
    let capReason = r.capReason ?? null;
    let preExistingCap = r.preExisting === true && capReason != null;
    // Recompute the caps only when the rules files are cached; without them the
    // quoted-rule cap would fire on every rule claim, which the live run did not.
    if (rulesTexts.length > 0) {
        const value = {
            score: r.rawScore ?? r.score,
            preExisting: r.preExisting === true,
            quotedRule: r.quotedRule ?? null,
            reason: r.reason ?? '',
        };
        const finding = { ...pred, ...(pred.citationRule ? { citation: { rule: pred.citationRule } } : {}) };
        const capped = applyCaps(value, finding, { rulesTexts });
        score = capped.score;
        capReason = capped.capReason;
        preExistingCap = value.preExisting && capReason != null;
    }
    if (capReason) report.capped[preExistingCap ? 'preExisting' : 'rule'] += 1;
    return { ...pred, rubric: { ...r, score, capReason } };
}

/**
 * @param {Array<object>} cases  corpus cases whose `predictions` already passed the deterministic gates
 * @param {{threshold?: number, verdictFor: (kase: object, finding: object) => string}} opts
 */
export function replayRubric(cases, { threshold = DEFAULT_MIN_RUBRIC_SCORE, verdictFor }) {
    const report = {
        threshold,
        hasRubricData: false,
        input: 0,
        noData: 0,
        status: { scored: 0, unscored: 0, bypassed: 0 },
        capped: { preExisting: 0, rule: 0 },
        postable: blank(),
        notVerified: blank(),
        dropped: blank(),
    };

    for (const c of cases) {
        const rulesTexts = rulesFilesForCase(c).map((r) => r.text);
        const replayed = [];
        for (const pred of c.predictions ?? []) {
            report.input += 1;
            if (!pred?.rubric) { report.noData += 1; continue; }
            report.hasRubricData = true;
            const status = pred.rubric.status;
            report.status[status] = (report.status[status] ?? 0) + 1;
            replayed.push(status === 'scored' ? replayScored(pred, rulesTexts, report) : pred);
        }
        const gate = filterByRubric(replayed, { minRubricScore: threshold });
        for (const [bucket, list] of [['postable', gate.postable], ['notVerified', gate.notVerified], ['dropped', gate.dropped]]) {
            for (const f of list) {
                const v = verdictFor(c, f);
                report[bucket][v] = (report[bucket][v] ?? 0) + 1;
            }
        }
    }
    return report;
}

const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const row = (t) => `${String(t.true_positive).padStart(4)} / ${String(t.false_positive).padStart(4)} / ${String(t.unadjudicated).padStart(4)}`;

export function formatRubricReplay(rep) {
    if (!rep.hasRubricData) {
        return [
            '',
            `Rubric replay — threshold ${rep.threshold}`,
            `  no rubric data — re-run \`npm run eval:run\` to capture it (${rep.noData} prediction(s) carry none).`,
            '  This is NOT a pass: nothing was replayed.',
        ].join('\n');
    }
    const adj = rep.postable.true_positive + rep.postable.false_positive;
    return [
        '',
        `Rubric replay — threshold ${rep.threshold}`,
        `  predictions after gates: ${rep.input}  (scored ${rep.status.scored}, unscored ${rep.status.unscored}, `
            + `bypassed ${rep.status.bypassed}, no rubric data ${rep.noData})`,
        `  caps applied:            pre-existing ${rep.capped.preExisting}, unquoted rule ${rep.capped.rule}`,
        '  stage (tp / fp / unadjudicated):',
        `    postable      ${row(rep.postable)}`,
        `    not verified  ${row(rep.notVerified)}   ← kept, not posted inline`,
        `    dropped       ${row(rep.dropped)}   ← TRUE positives here are the cost`,
        `  Adjudicated precision of postable: ${pct(rep.postable.true_positive, adj)}  (${rep.postable.true_positive}/${adj})`,
    ].join('\n');
}

export default { rulesFilesForCase, parseRubricThreshold, replayRubric, formatRubricReplay };
