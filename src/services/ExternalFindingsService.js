/**
 * ExternalFindingsService — get the team's own scanners' findings into the review.
 *
 * `externalFindings.js` parses SARIF/rdjson. This decides WHERE a report comes
 * from, and there are three sources, in descending order of how much work the
 * user has to do:
 *
 *   1. GitHub check-run annotations. Zero configuration. Every CI check that
 *      reports annotations — and every reviewdog/`github-pr-check` job, every
 *      CodeQL upload, every `problem matcher` in an Action — already exposes them
 *      through the Checks API against the PR's head SHA. This is the source that
 *      works out of the box, and it is why it is first.
 *
 *   2. A declared CI artifact. `.repospector.yaml` names a job and a path; the
 *      file is fetched from the pipeline that ran on this PR's head. Needed
 *      because GitLab has no annotations equivalent, and because a SARIF file
 *      carries rule documentation URLs and CVSS scores that annotations flatten
 *      away.
 *
 *   3. A report handed over directly (pasted, or read from a file). The escape
 *      hatch for a scanner that runs on someone's laptop.
 *
 * ── Why annotations are not enough on their own ──
 *
 * An annotation has a path, a line, a title and a message. A SARIF result has all
 * of that plus the rule id, the rule's `helpUri`, and often a
 * `security-severity`. The URL is the part that makes a finding checkable by the
 * reviewer, so where both are available the artifact wins.
 *
 * ── Failure is always soft ──
 *
 * No token, no pipeline, a 404 on the artifact path, a malformed report: each
 * returns zero findings and a `sources[]` entry saying what happened. A review
 * that loses its external findings is worse than one that never had them, but far
 * better than one that fails.
 */

import { parseReport, toReviewFindings, FORMAT } from '../utils/externalFindings.js';

/** Never spend more than this on external reports, however many are declared. */
const MAX_SOURCES = 5;
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

export class ExternalFindingsService {
    /**
     * @param {Object} deps
     * @param {Object} deps.pullRequestService - needs fetchCheckAnnotations / fetchJobArtifact
     */
    constructor({ pullRequestService = null } = {}) {
        this.prService = pullRequestService;
    }

    /**
     * Collect external findings for a PR.
     *
     * @param {Object} args
     * @param {string} args.prUrl
     * @param {Object} args.prData - needs .headSha
     * @param {Object} [args.config] - `.repospector.yaml`, for `externalFindings:`
     * @param {Array}  [args.reports] - pre-supplied raw reports: [{name, content, format?}]
     * @param {Object} [args.options]
     * @returns {Promise<{findings:Array, sources:Array, stats:Object}>}
     */
    async collect({ prUrl, prData, config = null, reports = [], options = {} } = {}) {
        const findings = [];
        const sources = [];
        const stats = { sources: 0, ok: 0, failed: 0, findings: 0, tools: [] };

        const declared = Array.isArray(config?.externalFindings)
            ? config.externalFindings.slice(0, MAX_SOURCES)
            : [];

        // ── 3. Directly supplied reports (cheapest, and always trusted to exist)
        for (const report of reports.slice(0, MAX_SOURCES)) {
            sources.push(this._ingest(report.name || 'supplied report', report.content, report.format, findings, stats));
        }

        // ── 2. Declared CI artifacts
        for (const spec of declared) {
            if (sources.length >= MAX_SOURCES) break;
            sources.push(await this._fromArtifact(prUrl, prData, spec, findings, stats));
        }

        // ── 1. GitHub check annotations, unless the repo declared its own sources
        //
        // Skipped when artifacts are declared, on purpose: the same scanner
        // usually produces both, and ingesting each would report every finding
        // twice with different metadata. The declared artifact is the richer of
        // the two, so it wins.
        if (!declared.length && options.checkAnnotations !== false && sources.length < MAX_SOURCES) {
            const fromChecks = await this._fromCheckAnnotations(prUrl, prData, findings, stats);
            if (fromChecks) sources.push(fromChecks);
        }

        stats.sources = sources.length;
        stats.findings = findings.length;
        stats.tools = [...new Set(findings.map(f => f.tool).filter(Boolean))];

        return { findings: toReviewFindings(findings), sources, stats };
    }

    /** Parse one raw report into `findings`, returning a source record. */
    _ingest(name, content, format, findings, stats) {
        if (!content) {
            stats.failed++;
            return { name, ok: false, error: 'report was empty' };
        }
        if (typeof content === 'string' && content.length > MAX_REPORT_BYTES) {
            stats.failed++;
            return { name, ok: false, error: `report is larger than ${MAX_REPORT_BYTES} bytes` };
        }

        const parsed = parseReport(content, { format: format || null });
        if (parsed.error) {
            stats.failed++;
            return { name, ok: false, error: parsed.error, format: parsed.format };
        }

        findings.push(...parsed.findings);
        stats.ok++;
        return {
            name,
            ok: true,
            format: parsed.format,
            findings: parsed.findings.length,
            tools: parsed.stats.tools,
            droppedByParser: parsed.stats.dropped,
        };
    }

    /**
     * Fetch a declared artifact from the pipeline that ran on this PR's head.
     *
     * @param {Object} spec - {job, path, format?, name?}
     */
    async _fromArtifact(prUrl, prData, spec, findings, stats) {
        const name = spec?.name || `${spec?.job || '?'}:${spec?.path || '?'}`;

        if (!spec?.path) {
            stats.failed++;
            return { name, ok: false, error: 'externalFindings entry needs a `path`' };
        }
        if (!this.prService?.fetchJobArtifact) {
            stats.failed++;
            return { name, ok: false, error: 'this host does not support artifact fetching' };
        }

        try {
            const content = await this.prService.fetchJobArtifact(prUrl, {
                job: spec.job || null,
                path: spec.path,
                // The artifact MUST come from the pipeline for the commit under
                // review. An artifact from an older pipeline describes code that
                // is not in this diff, and its findings would land on lines that
                // have since moved.
                ref: prData?.headSha || null,
            });
            return this._ingest(name, content, spec.format, findings, stats);
        } catch (e) {
            stats.failed++;
            return { name, ok: false, error: e?.message || 'artifact fetch failed' };
        }
    }

    /**
     * Read GitHub check-run annotations for the head SHA.
     *
     * Annotations are converted to the same finding shape rather than to SARIF
     * first: a round-trip through SARIF would invent rule ids and helpUris that
     * the annotation never carried, which is precisely the kind of fabricated
     * precision this whole feature exists to avoid.
     */
    async _fromCheckAnnotations(prUrl, prData, findings, stats) {
        if (!this.prService?.fetchCheckAnnotations) return null;

        try {
            const annotations = await this.prService.fetchCheckAnnotations(prUrl, prData?.headSha || null);
            if (!annotations?.length) return null;

            const LEVEL = { failure: 'high', warning: 'medium', notice: 'low' };
            let added = 0;

            for (const a of annotations) {
                if (!a?.path) continue;
                const message = a.message || a.title;
                if (!message) continue;

                findings.push({
                    // The check's name is the closest thing to a rule id an
                    // annotation has. Prefixed so it is never mistaken for one of
                    // RepoSpector's own rules in the ledger.
                    ruleId: a.title ? `check:${a.title}` : `check:${a.checkName || 'annotation'}`,
                    severity: LEVEL[a.level] || 'medium',
                    category: 'lint',
                    message,
                    filePath: a.path,
                    line: Number.isInteger(a.startLine) ? a.startLine : null,
                    endLine: Number.isInteger(a.endLine) ? a.endLine : null,
                    column: null,
                    codeSnippet: null,
                    // An annotation has no rule documentation. The check's own URL
                    // is the honest substitute — it points at the run that made
                    // the claim, which is still something the reviewer can open.
                    ruleUrl: a.detailsUrl || null,
                    ruleDescription: null,
                    cwe: null,
                    tool: a.checkName || 'CI check',
                    fingerprint: null,
                });
                added++;
            }

            stats.ok++;
            return { name: 'GitHub check annotations', ok: true, format: 'annotations', findings: added };
        } catch (e) {
            stats.failed++;
            return { name: 'GitHub check annotations', ok: false, error: e?.message };
        }
    }

    /**
     * Markdown for the review, naming every source and what it contributed.
     *
     * Always rendered when a source was consulted, including failures. A review
     * that silently lost its CodeQL findings looks identical to one where CodeQL
     * found nothing — and the second is a much stronger claim than the first.
     *
     * @param {{sources:Array, stats:Object}} result
     * @returns {string}
     */
    static renderSection(result) {
        const sources = result?.sources || [];
        if (!sources.length) return '';

        const lines = ['### External scanner findings', ''];

        for (const s of sources) {
            if (s.ok) {
                const tools = s.tools?.length ? ` (${s.tools.join(', ')})` : '';
                lines.push(`- ✅ **${s.name}**${tools} — ${s.findings} finding(s)`
                    + (s.droppedByParser ? `, ${s.droppedByParser} unusable` : ''));
            } else {
                lines.push(`- ⚠️ **${s.name}** — not read: ${s.error}`);
            }
        }

        if (sources.some(s => s.ok && s.findings > 0)) {
            lines.push('', 'These come from your own tools, not from this review\'s model. '
                + 'They are reported as found, with a link to each rule where one exists.');
        }

        return lines.join('\n');
    }
}

export { FORMAT };
export default ExternalFindingsService;
