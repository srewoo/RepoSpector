import { requestCompletion, samplingStatus } from '../sampling.js';
import {
    admitDeterministic,
    ASSERTION,
} from '../../../../src/utils/deterministicAdmission.js';
import { createCompleteness, describeCompleteness } from '../../../../src/utils/reviewCompleteness.js';
import { AWAITING_CALL } from './delegation.js';

/**
 * findings — `review_pr` stops at evidence and starts naming defects.
 *
 * Two sources, kept apart on purpose because they are different claims:
 *
 *   DETERMINISTIC. Graph-impact and missing-test findings, computed from the
 *   diff and the code graph with no model involved. They cost nothing, they are
 *   reproducible, and they carry a rule id you can look up — but a graph edge
 *   is an inference, so they are admitted at `graph-inferred` and cannot block.
 *
 *   MODEL-GENERATED. Produced by asking the CLIENT's model through MCP
 *   sampling. No key lives here; the user's own session model answers, and the
 *   client can refuse. Every one is a candidate: on the single merge request
 *   this was first exercised against, three of five model candidates were
 *   refuted by evidence the model had not consulted.
 *
 * The rule that governs the whole module: an unavailable check reports itself
 * as unavailable. If sampling is off, the section says the model pass did not
 * run and why. It never returns an empty findings list that a reader could
 * mistake for "nothing is wrong" — the failure this project exists to stop.
 */

const SYSTEM_PROMPT = `You review code changes and report only defects you can point at.

Report a finding only when you can name:
  - the input, state or caller that triggers it,
  - what goes wrong as a result,
  - and the line in the diff that causes it.

Do not report style preferences, naming, formatting, or "consider" suggestions.
Do not restate what the diff does. Do not report a defect in code the diff does
not change unless the change is what makes it reachable.

If the evidence does not let you establish a defect, say so and report nothing.
An empty findings list is a valid and often correct answer.

Respond with JSON only:
{"findings":[{"file":"path","line":123,"severity":"critical|high|medium|low",
"title":"one line","description":"what breaks, and the trigger","evidence":"the exact line from the diff"}]}`;

/**
 * Deterministic findings — Option A. No model, no key, no network.
 *
 * These two finders exist in the repository and were simply never wired into
 * the MCP bundle, so a server that had the code to produce them shipped without
 * them.
 */
export async function deterministicFindings(diffFiles, indexer, prData) {
    const out = [];
    const errors = [];

    try {
        const { GraphImpactFindingsService } = await import(
            '../../../../src/services/GraphImpactFindingsService.js'
        );
        const { ImpactAnalyzer } = await import('../../../../src/services/ImpactAnalyzer.js');
        const graph = indexer?.pipeline?.graph ?? null;
        if (graph) {
            const impact = indexer.pipeline.impactAnalyzer || new ImpactAnalyzer(graph);
            // `readSource` left unset: this service may only ASSERT a broken
            // caller when it has read the call expression, and the MCP path has
            // no line-accurate reader wired yet. Absent it, the rule degrades to
            // a question rather than a claim — which is correct, not a gap.
            const svc = new GraphImpactFindingsService({ graph, impactAnalyzer: impact });
            out.push(...svc.build(prData).findings);
        }
    } catch (e) {
        errors.push(`graph-impact: ${e?.message || 'failed'}`);
    }

    try {
        const { findMissingTests } = await import('../../../../src/utils/missingTestFinder.js');
        out.push(...findMissingTests(prData));
    } catch (e) {
        errors.push(`missing-test: ${e?.message || 'failed'}`);
    }

    return { findings: out, errors };
}

/**
 * Model-generated findings — Option B, through the client's model.
 *
 * @returns {Promise<{findings: Array, available: boolean, reason: string|null, model: string|null, raw: string|null}>}
 */
export async function modelFindings(server, { hunks, context = '', maxTokens = 3000 }) {
    const prompt = [
        'Review this change.',
        '',
        '## Diff',
        hunks,
        ...(context ? ['', '## Supporting context', context] : []),
    ].join('\n');

    const completion = await requestCompletion(server, {
        system: SYSTEM_PROMPT,
        prompt,
        maxTokens,
    });

    if (!completion.text) {
        return {
            findings: [],
            available: false,
            reason: completion.reason,
            model: completion.model,
            raw: null,
        };
    }

    const parsed = parseFindings(completion.text);
    if (parsed === null) {
        // Unparseable output is a failed check, not a clean one — the same
        // distinction the completeness contract draws for the extension.
        return {
            findings: [],
            available: false,
            reason: 'the model returned output that could not be parsed as findings',
            model: completion.model,
            raw: completion.text.slice(0, 500),
        };
    }

    return {
        findings: parsed,
        available: true,
        reason: null,
        model: completion.model,
        raw: null,
    };
}

/** JSON, possibly fenced or with prose around it. Returns null when unparseable. */
export function parseFindings(text) {
    const stripped = String(text)
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

    const attempt = (s) => {
        try {
            const o = JSON.parse(s);
            const list = Array.isArray(o) ? o : o?.findings;
            return Array.isArray(list) ? list : null;
        } catch {
            return null;
        }
    };

    return attempt(stripped) ?? attempt((stripped.match(/\{[\s\S]*\}/) || [])[0] ?? '');
}

/**
 * Assemble the `findings` section.
 *
 * Deterministic and model-generated findings are merged into one list but never
 * flattened into one KIND of claim: each carries an `assertionLevel`, so a
 * reader can tell a graph inference from a model's judgement without reading
 * the prose.
 */
export async function buildFindingsSection({
    server, diffFiles, indexer, prData, hunks, context = '', revision = null,
    // The delegated-review session opened for this bundle, when one was. Its
    // presence is what turns an unavailable model pass from a dead end into a
    // check the host agent can close.
    reviewId = null,
}) {
    const deterministic = await deterministicFindings(diffFiles, indexer, prData);
    const admitted = admitDeterministic(deterministic.findings, 'graph', { revision });

    const sampling = samplingStatus(server);
    const model = sampling.available
        ? await modelFindings(server, { hunks, context })
        : { findings: [], available: false, reason: sampling.reason, model: null, raw: null };

    const modelFound = (model.findings || []).map((f) => ({
        file: f.file ?? f.filePath ?? null,
        line: f.line ?? null,
        severity: f.severity ?? 'medium',
        title: f.title ?? null,
        description: f.description ?? null,
        evidence: f.evidence ?? null,
        source: 'llm',
        // Never `validated`: the model asserted this, nothing checked it. The
        // host agent reading this bundle is expected to try to refute it.
        assertionLevel: 'model-asserted',
        validationStatus: 'unvalidated',
    }));

    // A pass that could not run is an incomplete review, and the contract says
    // so in the same vocabulary the extension uses.
    // Three rungs, not two.
    //
    // Sampling ran            → the check is satisfied here.
    // Sampling unavailable,
    //   review delegated      → the check is OPEN, not failed: the host agent
    //                           reading this bundle is the model pass, and it
    //                           closes the contract by calling
    //                           `submit_review_findings`. Still `required`,
    //                           because having ASKED is not evidence that it
    //                           happened — only the callback is.
    // Sampling unavailable,
    //   no session            → the old behaviour: nothing can close it.
    const delegatedTo = !model.available && reviewId ? reviewId : null;
    const completeness = createCompleteness({
        unavailableChecks: [
            ...(model.available ? [] : [{
                name: delegatedTo
                    ? `model-generated findings (delegated to the host agent — awaiting ${AWAITING_CALL})`
                    : 'model-generated findings',
                reason: delegatedTo
                    ? `${model.reason}; this review is delegated to you as review_id ${delegatedTo}`
                    : model.reason,
                required: true,
            }]),
            ...deterministic.errors.map((reason) => ({
                name: 'deterministic finders', reason, required: false,
            })),
        ],
    });

    return {
        findings: [...admitted.admitted, ...modelFound],
        counts: {
            deterministic: admitted.admitted.length,
            modelGenerated: modelFound.length,
            rejectedForProvenance: admitted.rejected.length,
        },
        modelPass: {
            ran: model.available,
            reason: model.reason,
            model: model.model,
            ...(delegatedTo
                ? { delegated: true, reviewId: delegatedTo, awaiting: AWAITING_CALL }
                : {}),
            ...(model.raw ? { unparsedOutput: model.raw } : {}),
        },
        note: model.available
            ? 'Model-generated findings are CANDIDATES asserted by a model and checked by '
                + 'nothing. Try to refute each one against the source before repeating it. '
                + 'Deterministic findings carry a rule id and are reproducible, but a graph '
                + 'edge is an inference, not a proof.'
            : delegatedTo
                ? 'NO MODEL RAN IN THIS SERVER — it holds no key and this client offers no '
                    + 'sampling, so YOU are the reasoning pass. The findings below, if any, are '
                    + 'deterministic only, and their emptiness is not evidence the change is '
                    + `clean. Read the evidence sections, then record what you conclude with `
                    + `${AWAITING_CALL} (review_id ${delegatedTo}). Until that call arrives this `
                    + 'review is recorded as incomplete, because asking is not the same as being '
                    + 'answered.'
                : 'THE MODEL PASS DID NOT RUN. The findings below, if any, are deterministic only. '
                    + 'This is NOT evidence that the change is clean — it means the reasoning check '
                    + 'was unavailable. Review the evidence sections yourself.',
        completeness: describeCompleteness(completeness) || null,
    };
}

export default { buildFindingsSection, deterministicFindings, modelFindings, parseFindings };
