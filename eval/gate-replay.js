#!/usr/bin/env node
/**
 * gate-replay — replay the deterministic gates over an adjudicated corpus.
 *
 * `score.js` answers "how good was that run?". This answers a different and
 * cheaper question: **"what would the gates have done to findings we have
 * already judged?"** No model, no network, no tokens — every gate in
 * `findingEvidence`, `staticRulePremise` and `findingSpeculation` is pure
 * functions over a stored patch, so a corpus with `adjudications` is enough to
 * measure them exactly.
 *
 * That matters because the alternative is unfalsifiable. A new gate always looks
 * good in a unit test written by the person who wrote the gate; the only honest
 * question is how many ADJUDICATED true positives it destroys to remove a given
 * number of adjudicated false positives.
 *
 *   node eval/gate-replay.js --corpus eval/corpus/public-prs.json
 *   node eval/gate-replay.js --corpus eval/corpus/public-prs.json --show-kills
 *
 * Reading the output: `TP killed` is the number that decides whether a gate
 * ships. Precision gain is worthless if it is bought by deleting real bugs, and
 * this repo's own convention is that a wrong refutation is the expensive
 * direction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assessFinding, assessIntent, EVIDENCE } from '../src/utils/findingEvidence.js';
import { checkStaticPremise } from '../src/utils/staticRulePremise.js';
import { assessSpeculation } from '../src/utils/findingSpeculation.js';
import { assessImportClaim } from '../src/utils/importClaimGate.js';
import { diffsByFile } from '../src/utils/siblingSweep.js';

function arg(name, fallback = null) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const showKills = process.argv.includes('--show-kills');
const corpusPath = arg('--corpus', 'eval/corpus/public-prs.json');

const corpus = JSON.parse(fs.readFileSync(path.resolve(corpusPath), 'utf8'));

/**
 * Verdict for one prediction, by (file, line).
 *
 * Exact match only. `scoring.js` deliberately spreads a `true_positive` across
 * neighbours within the line tolerance; that is right for scoring a run and
 * wrong here, because it would credit a gate for sparing a finding nobody
 * judged. Unjudged stays unjudged.
 */
function verdictFor(caseObj, pred) {
    const hit = (caseObj.adjudications || []).find(
        a => a.file === pred.file && Number(a.line) === Number(pred.line)
    );
    return hit?.verdict || 'unadjudicated';
}

/** Run every deterministic gate in pipeline order; first refusal wins. */
function runGates(finding, patch) {
    const assessment = assessFinding(finding, patch);
    if (assessment.verdict === EVIDENCE.REFUTED) {
        return { dropped: true, by: 'evidence-gate', reason: assessment.reason };
    }
    const intent = assessIntent(finding, patch);
    if (intent.verdict === EVIDENCE.REFUTED) {
        return { dropped: true, by: 'intent-gate', reason: intent.reason };
    }
    const premise = checkStaticPremise(finding, patch);
    if (!premise.ok) {
        return { dropped: true, by: 'static-premise-gate', reason: premise.reason };
    }
    const imp = assessImportClaim(finding, patch);
    if (imp.refuted) {
        return { dropped: true, by: 'import-claim-gate', reason: imp.reason };
    }
    const spec = assessSpeculation(finding, assessment);
    if (spec.verdict === EVIDENCE.REFUTED) {
        return { dropped: true, by: 'speculation-gate', reason: spec.reason };
    }
    return { dropped: false, by: null, reason: null };
}

const tally = {
    total: 0,
    kept: { true_positive: 0, false_positive: 0, unadjudicated: 0 },
    killed: { true_positive: 0, false_positive: 0, unadjudicated: 0 },
};
const byGate = {};
const kills = [];

for (const c of corpus.cases || []) {
    const patches = diffsByFile(c.prData);
    for (const pred of c.predictions || []) {
        tally.total += 1;
        const verdict = verdictFor(c, pred);
        // `rule` is the corpus's own field name for a static rule id.
        const finding = { ...pred, ruleId: pred.ruleId || pred.rule };
        const patch = patches[pred.file] || '';
        const out = runGates(finding, patch);

        if (out.dropped) {
            tally.killed[verdict] += 1;
            byGate[out.by] = byGate[out.by] || { true_positive: 0, false_positive: 0, unadjudicated: 0 };
            byGate[out.by][verdict] += 1;
            kills.push({ case: c.id, verdict, gate: out.by, file: pred.file, line: pred.line, title: pred.title, reason: out.reason });
        } else {
            tally.kept[verdict] += 1;
        }
    }
}

const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

const adjBefore = tally.kept.true_positive + tally.killed.true_positive
    + tally.kept.false_positive + tally.killed.false_positive;
const tpBefore = tally.kept.true_positive + tally.killed.true_positive;
const adjAfter = tally.kept.true_positive + tally.kept.false_positive;

console.log(`\nGate replay — ${corpusPath}`);
console.log(`${corpus.cases?.length || 0} case(s), ${tally.total} prediction(s)\n`);

console.log(`Adjudicated precision BEFORE gates: ${pct(tpBefore, adjBefore)}  (${tpBefore}/${adjBefore})`);
console.log(`Adjudicated precision AFTER  gates: ${pct(tally.kept.true_positive, adjAfter)}  (${tally.kept.true_positive}/${adjAfter})`);
console.log('');
console.log(`Findings removed:  ${tally.killed.true_positive + tally.killed.false_positive + tally.killed.unadjudicated} of ${tally.total}`);
console.log(`  false positives: ${tally.killed.false_positive}   ← the point`);
console.log(`  TRUE positives:  ${tally.killed.true_positive}   ← the cost, and the number that decides whether this ships`);
console.log(`  unadjudicated:   ${tally.killed.unadjudicated}`);
console.log('');
console.log('By gate (fp / tp / unadjudicated):');
for (const [gate, n] of Object.entries(byGate)) {
    console.log(`  ${gate.padEnd(22)} ${String(n.false_positive).padStart(4)} / ${String(n.true_positive).padStart(3)} / ${String(n.unadjudicated).padStart(4)}`);
}

if (showKills) {
    console.log('\nEvery true positive removed (audit these first):');
    const tpKills = kills.filter(k => k.verdict === 'true_positive');
    if (tpKills.length === 0) console.log('  (none)');
    for (const k of tpKills) {
        console.log(`  [${k.gate}] ${k.case} ${k.file}:${k.line} — ${k.title}`);
        console.log(`      ${k.reason}`);
    }
}
console.log('');
