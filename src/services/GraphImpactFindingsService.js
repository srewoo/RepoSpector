/**
 * GraphImpactFindingsService — the code graph as a REVIEWER, not a footnote.
 *
 * `ReviewGraphContextService` pastes graph facts into the prompt and hopes the
 * model uses them. This service turns the three facts that are always worth a
 * comment into findings of their own, with `source: 'graph'`, so they survive
 * the pipeline the way static findings do — no refuter, no scorer, evidence
 * attached, labelled on the PR as coming from the graph:
 *
 *   1. A symbol changed its parameter list and callers outside the diff still
 *      pass the old one.                       → graph/signature-changed-callers
 *   2. A widely-called symbol changed.
 *      Nothing is asserted broken; a human is asked. → graph/high-risk-symbol
 *   3. Code in the change's blast radius has no test.  → graph/untested-blast-radius
 *
 * Every rule is soft: no graph, unknown symbol, or a thrown analyzer call all
 * yield nothing for that symbol.
 */
import { extractDeclaredSymbols, addedLines, declarationNewLine } from '../utils/declaredSymbols.js';
import { signatureChange } from '../utils/signatureDiff.js';
import { listCallers, findSymbolNode } from '../utils/graphQueries.js';
import { isTestFile } from './testFileUtils.js';
import { checkCallers } from '../utils/callSiteCheck.js';

const RULE = Object.freeze({
    SIGNATURE: 'graph/signature-changed-callers',
    RISK: 'graph/high-risk-symbol',
    UNTESTED: 'graph/untested-blast-radius',
});
const ORDER = [RULE.SIGNATURE, RULE.RISK, RULE.UNTESTED];

/**
 * How strong a claim a finding is making. P1-3: every source used to produce
 * output that read as an asserted defect; these three are different claims and
 * the report must say which one it is holding.
 */
export const ASSERTION = Object.freeze({
    /** Independently checked against source in this review. */
    VALIDATED: 'validated',
    /** A tool reported it; the tool was not itself verified. */
    TOOL_REPORTED: 'tool-reported',
    /** Read off the graph and not confirmed against source. Advisory. */
    GRAPH_INFERRED: 'graph-inferred',
});
const MAX_LISTED = 5;
/** Risk tiers worth a human's attention. See ImpactAnalyzer._calculateRisk. */
const ESCALATING_RISK = new Set(['high', 'critical']);

const base = (file, line, rule) => ({
    file, line, source: 'graph', tool: 'code-graph', rule, ruleId: rule.split('/')[1],
    // A fact read off the call graph, not a model's judgement — the same
    // vocabulary externalFindings.js uses for a scanner match. This lets
    // failLevel.js block a merge on severity alone, and sarifExport.js tag the
    // finding `deterministic` rather than `ai-generated`.
    deterministic: true,
});

const emptyStats = () => ({ symbols: 0, signatureChanges: 0, untested: 0, escalations: 0, capped: false });

export class GraphImpactFindingsService {
    /**
     * @param {{graph: Object|null, impactAnalyzer: Object|null,
     *          readSource?: ((filePath: string) => string|null)}} deps
     *
     * `readSource` is what makes the signature rule an OBSERVATION rather than
     * an assertion (P1-3): without it the rule cannot see a single call
     * expression, and it now says so instead of claiming breakage.
     */
    constructor({ graph = null, impactAnalyzer = null, readSource = null } = {}) {
        this.graph = graph;
        this.impact = impactAnalyzer;
        this.readSource = readSource;
    }

    /**
     * @param {Object} prData - normalized PR data with files[{filename, patch}]
     * @param {{maxFindings?: number, maxDepth?: number, maxSymbolsPerFile?: number}} [opts]
     */
    build(prData, opts = {}) {
        const { maxFindings = 6, maxDepth = 2, maxSymbolsPerFile = 8 } = opts;
        const stats = emptyStats();
        if (!this.graph || !this.impact) return { findings: [], stats };

        const files = (prData?.files || []).filter(f => f?.filename && f?.patch && !isTestFile(f.filename));
        const changed = new Set(files.map(f => f.filename));
        const findings = [];

        for (const f of files) {
            const symbols = extractDeclaredSymbols(addedLines(f.patch)).slice(0, maxSymbolsPerFile);
            for (const sym of symbols) {
                stats.symbols++;
                const line = declarationNewLine(f.patch, sym);
                findings.push(...this._rulesFor(f, sym, line, changed, maxDepth));
            }
        }

        findings.sort((a, b) => ORDER.indexOf(a.rule) - ORDER.indexOf(b.rule));
        stats.capped = findings.length > maxFindings;
        // Counted AFTER the cap: the summary these stats feed must never claim
        // a finding that was cut. `symbols` is the only count that legitimately
        // describes work done rather than findings shown, so it alone is
        // counted above, pre-cap.
        const kept = findings.slice(0, maxFindings);
        stats.signatureChanges = kept.filter(f => f.rule === RULE.SIGNATURE).length;
        stats.escalations = kept.filter(f => f.rule === RULE.RISK).length;
        stats.untested = kept.filter(f => f.rule === RULE.UNTESTED).length;
        return { findings: kept, stats };
    }

    /**
     * The caller files the signature rule would need to READ, for a given PR.
     *
     * Exposed so the caller can prefetch that source (the index is async, this
     * service is not) and hand it back as `readSource`. Without it the
     * signature rule can only ever produce the advisory form — which is honest,
     * but the point of P1-3 is to make the assertion possible, not just to
     * withdraw it.
     *
     * @returns {string[]} deduplicated file paths, bounded by `limit`
     */
    collectCallerFiles(prData, { limit = 25, maxSymbolsPerFile = 8 } = {}) {
        if (!this.graph) return [];
        const files = (prData?.files || []).filter(f => f?.filename && f?.patch && !isTestFile(f.filename));
        const changed = new Set(files.map(f => f.filename));
        const out = new Set();

        for (const f of files) {
            const symbols = extractDeclaredSymbols(addedLines(f.patch)).slice(0, maxSymbolsPerFile);
            for (const sym of symbols) {
                const change = signatureChange(f.patch, sym);
                if (!change?.changed || change.compatible) continue;
                for (const c of listCallers(this.graph, sym, {
                    excludeFiles: changed, excludeTests: true, limit: 50,
                })) {
                    if (c?.filePath) out.add(c.filePath);
                    if (out.size >= limit) return [...out];
                }
            }
        }
        return [...out];
    }

    _rulesFor(file, sym, line, changed, maxDepth) {
        const out = [];
        const sig = this._signatureRule(file, sym, line, changed);
        if (sig) out.push(sig);
        const risk = this._riskRule(file, sym, line);
        if (risk) out.push(risk);
        const untested = this._untestedRule(file, sym, line, maxDepth);
        if (untested) out.push(untested);
        return out;
    }

    _signatureRule(file, sym, line, changed) {
        const change = signatureChange(file.patch, sym);
        if (!change?.changed || change.compatible) return null;
        const callers = listCallers(this.graph, sym, { excludeFiles: changed, excludeTests: true, limit: 50 });
        if (!callers.length) return null;

        // P1-3: read the actual call expressions before saying anything about
        // them. `CallGraphBuilder` resolves some edges by name, so an unrelated
        // same-named symbol, a stale index or a call that already passes the new
        // arguments all produced the same confident "callers were not updated".
        const checked = checkCallers(change, callers, sym, this.readSource);
        const sigLine = `\`(${change.before.join(', ')})\` to \`(${change.after.join(', ')})\``;

        // A call site read and found invalid is a defect, and the call
        // expression itself is the evidence.
        if (checked.incompatible.length) {
            const listed = checked.incompatible.slice(0, MAX_LISTED)
                .map(c => `\`${c.filePath}:${c.line ?? '?'}\` calls \`${sym}${c.call}\` — ${c.reason}`);
            const more = checked.incompatible.length > MAX_LISTED
                ? ` and ${checked.incompatible.length - MAX_LISTED} more`
                : '';
            const caveat = checked.unverified.length
                ? ` ${checked.unverified.length} further call site(s) could not be read and are not included in this claim.`
                : '';
            return {
                ...base(file.filename, line, RULE.SIGNATURE),
                severity: 'high',
                category: 'logic',
                confidence: 0.9,
                assertionLevel: ASSERTION.VALIDATED,
                title: `\`${sym}\` changed its signature; ${checked.incompatible.length} call site(s) outside this PR no longer match`,
                description:
                    `The declaration of \`${sym}\` went from ${sigLine}. `
                    + `These call sites were read and do not match the new signature: ${listed.join('; ')}${more}.${caveat}`,
                suggestion: 'Update the listed call sites, or keep the old parameters accepted '
                    + '(a default value or an overload) so existing calls remain valid.',
                evidence: checked.incompatible
                    .map(c => `${c.filePath}:${c.line ?? '?'}: ${sym}${c.call}`)
                    .join('\n'),
                callSites: checked.incompatible,
            };
        }

        // Every call site read, none broken: there is nothing to report. This
        // case used to produce a high-severity finding.
        if (checked.verified) return null;

        // Nothing could be read. The signature change and the graph edges are
        // still worth a human's attention — but as a question, not a verdict,
        // and at a severity that cannot block a merge on its own.
        const listed = checked.unverified.slice(0, MAX_LISTED)
            .map(c => `\`${c.filePath}:${c.line ?? '?'}\``);
        const more = checked.unverified.length > MAX_LISTED
            ? ` and ${checked.unverified.length - MAX_LISTED} more`
            : '';
        const whyNot = [...new Set(checked.unverified.map(c => c.status))];
        return {
            ...base(file.filename, line, RULE.SIGNATURE),
            severity: 'medium',
            category: 'architecture',
            confidence: 0.5,
            needsHumanReview: true,
            assertionLevel: ASSERTION.GRAPH_INFERRED,
            title: `\`${sym}\` changed its signature; ${checked.unverified.length} recorded call site(s) could not be checked`,
            description:
                `The declaration of \`${sym}\` went from ${sigLine}. `
                + `The code graph records call site(s) in files this PR does not touch: ${listed.join(', ')}${more}. `
                + `**Their call expressions were not inspected** (${whyNot.join(', ')}), so this is not a claim that they break — `
                + 'the graph resolves some edges by name, and an unchanged caller file is not evidence that its call became invalid. '
                + 'Check them, or say here why the change is compatible.',
            suggestion: 'Open the listed call sites and confirm they still pass a valid argument list.',
            evidence: checked.unverified.map(c => `${c.filePath}:${c.line ?? '?'}`).join('\n'),
            callSites: checked.unverified,
        };
    }

    _riskRule(file, sym, line) {
        let check;
        try { check = this.impact.quickSafetyCheck(sym); } catch { return null; }
        // 'critical' is a WIDER blast radius than 'high' (ImpactAnalyzer's
        // _calculateRisk returns it at >=10 high-confidence callers or >=20
        // total), so an equality test against 'high' alone would skip exactly
        // the symbols this rule exists to escalate.
        if (!check || check.safe || !ESCALATING_RISK.has(check.risk)) return null;
        return {
            ...base(file.filename, line, RULE.RISK),
            severity: 'medium',
            category: 'architecture',
            confidence: 0.7,
            needsHumanReview: true,
            expertise: 'architecture',
            escalationReason: `The code graph rates changing \`${sym}\` as high risk: ${check.reason}`,
            title: `\`${sym}\` is widely depended on; confirm every caller was considered`,
            description:
                `This PR changes \`${sym}\`. ${check.reason} The graph cannot tell whether the behaviour change is `
                + `intended for all of them, so this is a question for a reviewer who owns the callers, not a defect claim.`,
            suggestion: `Name the callers you verified, or split the change so each consumer can be checked separately.`,
            evidence: check.reason,
        };
    }

    _untestedRule(file, sym, line, maxDepth) {
        let res;
        try { res = this.impact.findUntestedInBlastRadius(sym, { maxDepth }); } catch { return null; }
        const untested = Array.isArray(res?.untested) ? res.untested : [];
        if (!res?.found || !untested.length) return null;
        if (!findSymbolNode(this.graph, sym, file.filename)) return null;

        const names = untested.slice(0, MAX_LISTED).map(u => `\`${u.name}\` (${u.filePath})`);
        const more = untested.length > MAX_LISTED ? `, and ${untested.length - MAX_LISTED} more` : '';
        return {
            ...base(file.filename, line, RULE.UNTESTED),
            severity: 'low',
            category: 'coverage',
            confidence: 0.6,
            title: `${untested.length} symbol(s) that depend on \`${sym}\` have no test`,
            description:
                `Changing \`${sym}\` can alter the behaviour of ${res.totalAffected} symbol(s) within ${maxDepth} call(s). `
                + `The graph's TESTED_BY edges show no test reaching: ${names.join(', ')}${more}. `
                + `A regression there would surface only in whatever end-to-end path happens to break.`,
            suggestion: `Add a test for the most-called untested symbol, or state which integration test exercises this path.`,
            evidence: untested.map(u => `${u.filePath}: ${u.name}`).join('\n'),
        };
    }
}

export default GraphImpactFindingsService;
