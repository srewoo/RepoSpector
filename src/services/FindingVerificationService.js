import { VERIFICATION_SYSTEM_PROMPT, buildVerificationPrompt } from '../utils/verificationPrompts.js';
import { assessFinding, assessIntent, dedupeFindings, EVIDENCE } from '../utils/findingEvidence.js';
import { assessSpeculation } from '../utils/findingSpeculation.js';
import { checkStaticPremise } from '../utils/staticRulePremise.js';
import { diffsByFile as buildDiffsByFile } from '../utils/siblingSweep.js';
import { assessImportClaim } from '../utils/importClaimGate.js';
import { markLowValue } from '../utils/lowValueGate.js';
import { PRIORITY } from '../utils/callBudget.js';
import { isDeterministicSource } from '../utils/findingSources.js';

/**
 * FindingVerificationService — adversarial second pass to cut false positives.
 *
 * For each generated finding it asks the model (the user's own BYOK model) to try
 * to REFUTE the finding against the diff, in batches. Findings the verifier
 * confidently refutes are dropped; survivors may have their severity re-calibrated.
 *
 * Design choices that protect RECALL (so precision gains don't cost true positives):
 *  - fail-open: if no verdict comes back for a finding, it is KEPT.
 *  - a finding is dropped only when the verdict says keep=false with confidence >=
 *    dropThreshold. With votes>1, a majority of drop-votes is required.
 *  - static-analysis findings (source==='static', deterministic regex/OSV/secrets)
 *    are NOT sent to the verifier by default — they are ground truth, not guesses.
 */
export class FindingVerificationService {
    constructor({ llmService } = {}) {
        this.llmService = llmService;
    }

    /**
     * @param {Array<Object>} findings - flat findings (each may carry a `source`)
     * @param {Object} opts
     * @param {Object} opts.prData
     * @param {Object} opts.settings - { provider, model, apiKey }
     * @param {number} [opts.votes=1] - independent verification votes per batch
     * @param {number} [opts.batchSize=8]
     * @param {number} [opts.dropThreshold=0.6] - min confidence to actually drop
     * @param {boolean} [opts.verifyStatic=false] - also verify deterministic findings
     * @param {boolean} [opts.llmRefutation=false] - run the LLM refuter after the
     *        deterministic gates. Off by default: on the measured 50-MR set the
     *        refuter kept 42 of 42 findings that adjudication then rejected, so it
     *        cost a full round-trip per batch for no measured discrimination. The
     *        gates below carry the whole effect and are free. Turn it on to
     *        re-measure, or when a repo's findings are dominated by claims the
     *        gates cannot mechanically check.
     * @param {Function} [opts.onProgress]
     * @returns {Promise<{ findings: Array, dropped: Array, stats: Object, usage: {input:number,output:number} }>}
     */
    async verify(findings = [], opts = {}) {
        const {
            prData = {},
            settings = {},
            votes = 1,
            batchSize = 8,
            dropThreshold = 0.6,
            verifyStatic = false,
            llmRefutation = false,
            onProgress = null
        } = opts;

        if (findings.length === 0) {
            return { findings, dropped: [], stats: this._emptyStats(0), usage: { input: 0, output: 0 } };
        }

        const diffsByFile = this._buildDiffsByFile(prData);

        // ── Stage 0: deterministic gates, before any token is spent ──
        //
        // The LLM verifier passed 42 of 42 findings that independent adjudication
        // then rejected. Several were mechanically disprovable: a cited line not in
        // the diff, a construct that appears only on REMOVED lines (flagging what
        // the PR fixed), a named API absent from the file. A model should never
        // have been asked to do a check that code can do exactly.
        const { kept: deduped, duplicates } = dedupeFindings(findings);

        const evidenceDropped = [];
        const survivorsOfEvidence = [];
        for (const f of deduped) {
            const patch = diffsByFile[f.file] || diffsByFile[f.filePath] || '';

            // Premise: does the code the finding describes actually exist here?
            const assessment = assessFinding(f, patch);
            if (assessment.verdict === EVIDENCE.REFUTED) {
                evidenceDropped.push({ ...f, _drop: { reason: assessment.reason, by: 'evidence-gate' } });
                continue;
            }

            // Intent: the premise holds, but the code documents this as deliberate,
            // or the "behaviour change" is a feature-flag cleanup removing an
            // already-unreachable branch. Measured on a frozen labelled set these
            // two account for 9 and 5 false positives respectively.
            const intent = assessIntent(f, patch);
            if (intent.verdict === EVIDENCE.REFUTED) {
                evidenceDropped.push({ ...f, _drop: { reason: intent.reason, by: 'intent-gate' } });
                continue;
            }

            // Static-rule line mapping. A static finding's title is its rule id,
            // which names no code, so the construct gates above extract nothing
            // and never fire — and static findings bypass the LLM refuter by
            // design. Before this check a mis-mapped static hit had nothing at
            // all standing between it and the PR. Adjudication called this class
            // "the most mechanically fixable of the six".
            const premise = checkStaticPremise(f, patch);
            if (!premise.ok) {
                evidenceDropped.push({ ...f, _drop: { reason: premise.reason, by: 'static-premise-gate' } });
                continue;
            }

            // "X is not imported" when the import is visible in the very diff the
            // model was shown. Fires in one direction only — an import that is
            // not visible proves nothing, because a patch is a window.
            const importClaim = assessImportClaim(f, patch);
            if (importClaim.refuted) {
                evidenceDropped.push({ ...f, _drop: { reason: importClaim.reason, by: 'import-claim-gate' } });
                continue;
            }

            // Ungrounded speculation — the LARGEST measured false-positive class.
            // Passed the assessment so a GROUNDED finding is exempt: proof beats
            // grammar, and hedging is how careful reviewers write.
            const speculation = assessSpeculation(f, assessment);
            if (speculation.verdict === EVIDENCE.REFUTED) {
                evidenceDropped.push({ ...f, _drop: { reason: speculation.reason, by: 'speculation-gate' } });
                continue;
            }

            survivorsOfEvidence.push({ ...f, _evidence: assessment });
        }

        // Per-gate counts, not just a total. A gate that silently stops firing —
        // a rule id that changed shape, a regex that no longer matches — looks
        // exactly like a clean run when only the sum is reported.
        const byGate = evidenceDropped.reduce((acc, f) => {
            const g = f._drop?.by || 'unknown';
            acc[g] = (acc[g] || 0) + 1;
            return acc;
        }, {});

        if (duplicates.length || evidenceDropped.length) {
            const detail = Object.entries(byGate).map(([g, n]) => `${g}=${n}`).join(' ');
            console.log(`🔬 Evidence gate: ${duplicates.length} duplicate(s), ${evidenceDropped.length} refuted before the LLM${detail ? ` (${detail})` : ''}`);
        }

        // Demote (never drop) micro-performance and style restatements, so they
        // cannot consume the limited inline-comment budget. Runs after the
        // refutation gates: there is no point ranking a finding that is wrong.
        const { findings: markedSurvivors, demoted: lowValueCount } = markLowValue(survivorsOfEvidence);
        survivorsOfEvidence.length = 0;
        survivorsOfEvidence.push(...markedSurvivors);
        if (lowValueCount) {
            console.log(`🔉 Demoted ${lowValueCount} low-value restatement(s) out of the inline budget`);
        }

        // Partition: deterministic findings bypass verification unless asked.
        const toVerify = [];
        const passthrough = [];
        survivorsOfEvidence.forEach((f, i) => {
            const vid = `V${i}`;
            const tagged = { ...f, vid };
            // Escalations bypass the refuter, and must.
            //
            // An escalation's entire claim is "this cannot be settled from the
            // diff". The refuter's job is to ask whether a finding is
            // substantiated by the diff, so it will refute every escalation,
            // confidently and correctly — and deleting them all would silently
            // remove the one output that exists to say "ask a human". The
            // question survives to be asked; it is not asserted as a defect.
            if (f.needsHumanReview) passthrough.push(tagged);
            else if (!verifyStatic && isDeterministicSource(f.source)) passthrough.push(tagged);
            else toVerify.push(tagged);
        });

        // No LLM available, the refuter disabled, or nothing left for it: the
        // deterministic gates still stand on their own and their drops are
        // reported. This is the DEFAULT path — see `llmRefutation`.
        if (!this.llmService || !llmRefutation || toVerify.length === 0) {
            const stats = this._emptyStats(findings.length, passthrough.length);
            stats.duplicates = duplicates.length;
            stats.evidenceRefuted = evidenceDropped.length;
            stats.refutedByGate = byGate;
            stats.lowValueDemoted = lowValueCount;
            stats.kept = passthrough.length + toVerify.length;
            stats.dropped = duplicates.length + evidenceDropped.length;
            stats.llmRefutation = false;
            return {
                findings: [...passthrough, ...toVerify].map(this._strip),
                dropped: [...duplicates, ...evidenceDropped],
                stats,
                usage: { input: 0, output: 0 },
            };
        }

        const batches = this._chunk(toVerify, batchSize);
        const usage = { input: 0, output: 0 };

        onProgress?.({ phase: 'verifying', message: `Verifying ${toVerify.length} findings...`, total: toVerify.length });

        // Collect verdict votes: vid -> array of {keep, confidence, correctedSeverity, reason}
        const verdictsByVid = new Map();

        const batchResults = await Promise.all(batches.map(async (batch) => {
            const prompt = buildVerificationPrompt(batch, { prTitle: prData.title, diffsByFile });
            const localVerdicts = [];
            for (let v = 0; v < Math.max(1, votes); v++) {
                try {
                    const resp = await this.llmService.streamChat(
                        [
                            { role: 'system', content: VERIFICATION_SYSTEM_PROMPT },
                            { role: 'user', content: prompt }
                        ],
                        { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false, budgetStage: 'verify', budgetPriority: PRIORITY.IMPORTANT }
                    );
                    usage.input += resp?.usage?.input || 0;
                    usage.output += resp?.usage?.output || 0;
                    const parsed = this._parseVerdicts(resp?.content || resp);
                    for (const verdict of parsed) localVerdicts.push(verdict);
                } catch (e) {
                    // fail-open for this vote
                    console.warn('Verification batch failed (keeping findings):', e?.message);
                }
            }
            return localVerdicts;
        }));

        for (const list of batchResults) {
            for (const verdict of list) {
                if (!verdict?.vid) continue;
                if (!verdictsByVid.has(verdict.vid)) verdictsByVid.set(verdict.vid, []);
                verdictsByVid.get(verdict.vid).push(verdict);
            }
        }

        // Apply verdicts
        const survivors = [];
        const dropped = [];
        for (const f of toVerify) {
            const votesFor = verdictsByVid.get(f.vid) || [];
            const decision = this._aggregate(votesFor, dropThreshold);
            if (decision.drop) {
                dropped.push({ ...this._strip(f), _drop: decision });
            } else {
                const kept = this._strip(f);
                if (decision.correctedSeverity && decision.correctedSeverity !== kept.severity) {
                    kept._originalSeverity = kept.severity;
                    kept.severity = decision.correctedSeverity;
                }
                kept.verification = {
                    verified: votesFor.length > 0,
                    confidence: decision.confidence,
                    reason: decision.reason,
                    votes: votesFor.length
                };
                survivors.push(kept);
            }
        }

        const finalFindings = [...passthrough.map(this._strip), ...survivors];
        const allDropped = [...duplicates, ...evidenceDropped, ...dropped];
        const stats = {
            input: findings.length,
            duplicates: duplicates.length,
            evidenceRefuted: evidenceDropped.length,
            verified: toVerify.length,
            passthrough: passthrough.length,
            kept: finalFindings.length,
            dropped: allDropped.length,
            droppedByLlm: dropped.length,
            resurfacedSeverity: survivors.filter(s => s._originalSeverity).length,
            llmRefutation: true
        };

        onProgress?.({ phase: 'verifying', message: `Verified — dropped ${dropped.length} likely false positives.`, ...stats });

        return { findings: finalFindings, dropped: allDropped, stats, usage };
    }

    /** Aggregate votes → decision. Fail-open: no votes ⇒ keep. */
    _aggregate(votes, dropThreshold) {
        if (!votes.length) {
            return { drop: false, confidence: 0, reason: 'no verdict returned — kept (fail-open)', correctedSeverity: null };
        }
        const dropVotes = votes.filter(v => v.keep === false);
        const keepVotes = votes.filter(v => v.keep === true);
        // Require a majority of drop-votes AND sufficient confidence to actually drop.
        const majorityDrop = dropVotes.length > keepVotes.length;
        const avgDropConf = dropVotes.length
            ? dropVotes.reduce((a, v) => a + (Number(v.confidence) || 0), 0) / dropVotes.length
            : 0;
        if (majorityDrop && avgDropConf >= dropThreshold) {
            return { drop: true, confidence: avgDropConf, reason: dropVotes[0].reason || 'refuted', correctedSeverity: null };
        }
        // Kept — pick the highest-confidence keep verdict's corrected severity.
        const best = keepVotes.sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))[0] || votes[0];
        return {
            drop: false,
            confidence: Number(best.confidence) || 0,
            reason: best.reason || 'survived verification',
            correctedSeverity: this._normSeverity(best.correctedSeverity)
        };
    }

    _normSeverity(s) {
        const k = String(s || '').toLowerCase();
        return ['critical', 'high', 'medium', 'low'].includes(k) ? k : null;
    }

    /**
     * filename -> unified patch, accepting every shape a caller may pass.
     *
     * `PullRequestService` normalizes both hosts to `{filename, patch}`, but the
     * orchestrator, the eval harness and tests all hand raw host shapes through
     * (`new_path`/`diff` on GitLab, `path` on some paths). A missed key here does
     * not throw — it yields an empty map, every gate sees `patch === ''` and
     * fails open, and the deterministic gates (the ONLY false-positive filter
     * enabled by default) become a silent no-op. Be liberal about the keys.
     */
    // Delegates so the verifier and the sibling sweep can never disagree about
    // which patch belongs to which file — they gate and sweep the same bytes.
    _buildDiffsByFile(prData) {
        return buildDiffsByFile(prData);
    }

    _parseVerdicts(text) {
        if (!text || typeof text !== 'string') return [];
        let cleaned = text.trim();
        if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
        if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();
        const tryParse = (s) => {
            try {
                const o = JSON.parse(s);
                if (Array.isArray(o?.verdicts)) return o.verdicts;
                if (Array.isArray(o)) return o;
            } catch { /* ignore */ }
            return null;
        };
        return tryParse(cleaned) || tryParse((cleaned.match(/\{[\s\S]*\}/) || [])[0] || '') || [];
    }

    /** Drop internal bookkeeping before a finding leaves this service. */
    _strip(f) {
        const { vid: _vid, _evidence, ...rest } = f;
        // Keep the premise verdict as provenance — it explains why a finding was
        // trusted — but not the raw source line, which would bloat every payload.
        if (_evidence?.verdict) rest.premise = _evidence.verdict;
        return rest;
    }

    _chunk(arr, n) {
        const out = [];
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
    }

    _emptyStats(input, passthrough = 0) {
        return { input, duplicates: 0, evidenceRefuted: 0, verified: 0, passthrough, kept: input, dropped: 0, droppedByLlm: 0, resurfacedSeverity: 0 };
    }
}

export default FindingVerificationService;
