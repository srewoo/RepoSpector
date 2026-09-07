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

const RULE = Object.freeze({
    SIGNATURE: 'graph/signature-changed-callers',
    RISK: 'graph/high-risk-symbol',
    UNTESTED: 'graph/untested-blast-radius',
});
const ORDER = [RULE.SIGNATURE, RULE.RISK, RULE.UNTESTED];
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
    /** @param {{graph: Object|null, impactAnalyzer: Object|null}} deps */
    constructor({ graph = null, impactAnalyzer = null } = {}) {
        this.graph = graph;
        this.impact = impactAnalyzer;
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

        const listed = callers.slice(0, MAX_LISTED).map(c => `\`${c.filePath}:${c.line ?? '?'}\` (${c.name})`);
        const more = callers.length > MAX_LISTED ? ` and ${callers.length - MAX_LISTED} more` : '';
        return {
            ...base(file.filename, line, RULE.SIGNATURE),
            severity: 'high',
            category: 'logic',
            confidence: 0.85,
            title: `\`${sym}\` changed its signature; ${callers.length} caller(s) outside this PR were not updated`,
            description:
                `The declaration of \`${sym}\` went from \`(${change.before.join(', ')})\` to \`(${change.after.join(', ')})\`. `
                + `The code graph records ${callers.length} call site(s) in files this PR does not touch: ${listed.join(', ')}${more}. `
                + `Each still passes the old argument list. If the change is compatible in a way the diff does not show, say so here; `
                + `otherwise those callers need to change in this PR or in one that lands first.`,
            suggestion: `Update the listed callers, or keep the old parameters accepted (a default value or an overload) so existing call sites remain valid.`,
            evidence: callers.map(c => `${c.filePath}:${c.line ?? '?'}`).join('\n'),
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
