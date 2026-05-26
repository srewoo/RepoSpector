/**
 * Review worker. Runs in its own process (or container) — boots, listens
 * on the BullMQ `review` queue, processes jobs one at a time per slot.
 *
 * Job lifecycle:
 *   1. Mark mr_review.status = running
 *   2. Clone the source repo
 *   3. Compute the diff (three-dot, target...source) + reconstruct file list
 *   4. Run @repospector/review-core ReviewOrchestrator against the diff
 *   5. If brief.shared_contracts non-empty → cross-repo verification
 *   6. Persist the merged VerdictReport
 *   7. Always cleanup the workspace
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { makeReviewWorker } from '../lib/queue.js';
import { MrReviewRepo, UsageRepo } from '../db/repositories.js';
import { CloneService } from '../services/cloneService.js';
import { runCrossRepoVerification } from '../services/crossRepoService.js';
import { LLMClient } from '../services/llmClient.js';
import {
    buildChunkUserPrompt,
    parseLLMReviewJson,
    PROMPTS,
} from '../services/reviewPrompt.js';
import { AdaptiveLearningService } from '../services/adaptiveLearningService.js';
import {
    ReviewOrchestrator,
    buildVerdictReport,
    toCanonicalFinding,
    PHASE,
} from '@repospector/review-core';

/**
 * Real BackendDeepEngine — one LLM call per chunk, structured JSON output,
 * findings lifted to canonical schema by the orchestrator.
 *
 * Falls back to a no-op when no LLM credentials are supplied (e.g. a
 * webhook-triggered review where the tenant hasn't configured a key). In
 * that case the standards/static findings still flow through the
 * orchestrator's standards phase.
 */
class BackendDeepEngine {
    constructor({ llm, adaptive }) {
        this.llm = llm;
        this.adaptive = adaptive;
        // Accumulators visible to the worker after each execute().
        this.tokensIn = 0;
        this.tokensOut = 0;
        this.costCents = 0;
    }

    async execute(prData, context, _settings, _options, onProgress) {
        if (!this.llm?.apiKey) {
            onProgress?.({ phase: 'deep_skipped_no_llm' });
            return {
                analysis: '_Deep review skipped — no LLM credentials for this trigger._',
                perFileFindings: [],
                failedFiles: [],
                tokenUsage: { input: 0, output: 0 },
            };
        }

        // The orchestrator passes the brief + chunk-info on every call.
        const brief = context?.mrBrief ?? {};
        const chunkInfo = context?.chunkInfo ?? { index: 1, total: 1 };
        const chunk = {
            index: chunkInfo.index,
            total: chunkInfo.total,
            files: prData?.files ?? [],
        };

        const dismissedRules = this.adaptive
            ? await safeDismissedHints(this.adaptive)
            : [];

        const userPrompt = buildChunkUserPrompt({
            chunk,
            brief,
            mrContext: context?.mrContext,
            dismissedRules,
        });

        onProgress?.({
            phase: 'deep_llm_call',
            chunkIndex: chunk.index,
            chunkTotal: chunk.total,
            model: this.llm.model,
        });

        const client = new LLMClient({
            provider: this.llm.provider,
            model: this.llm.model,
            apiKey: this.llm.apiKey,
        });

        let resp;
        try {
            resp = await client.chat(
                [
                    { role: 'system', content: PROMPTS.SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
                { jsonMode: true, maxTokens: 4096, temperature: 0.1 },
            );
        } catch (err) {
            logger.warn({ err: err.message, chunk: chunk.index }, 'llm_call_failed');
            return {
                analysis: `_LLM call failed for chunk ${chunk.index}: ${err.message}_`,
                perFileFindings: [],
                failedFiles: chunk.files.map((f) => ({ filename: f.filename, error: err.message })),
                tokenUsage: { input: 0, output: 0 },
            };
        }

        this.tokensIn += resp.tokensIn;
        this.tokensOut += resp.tokensOut;
        this.costCents += resp.costCents;

        const parsed = parseLLMReviewJson(resp.content);
        const perFileFindings = parsed.findings.map((f) => ({
            severity: f.severity,
            category: f.category,
            file: f.file,
            line: f.line,
            title: f.title,
            message: f.suggestion ?? f.title ?? '',
            rule: f.rule,
            source: 'llm',
        }));

        return {
            analysis: parsed.summary || '',
            perFileFindings,
            failedFiles: [],
            tokenUsage: { input: resp.tokensIn, output: resp.tokensOut },
        };
    }
}

async function safeDismissedHints(adaptive) {
    try {
        return await adaptive.dismissedRulesForPrompt();
    } catch (err) {
        logger.warn({ err: err.message }, 'adaptive_hints_failed');
        return [];
    }
}

async function processJob(job) {
    const data = job.data;
    logger.info({ jobId: data.jobId, repo: data.gitInfo.repoFullName }, 'review_start');
    await MrReviewRepo.setRunning(data.jobId);
    const clone = new CloneService(data.jobId);

    try {
        // 1. Clone source repo
        const { dir } = await clone.clone({
            cloneUrl: data.gitInfo.cloneUrl,
            token: data.gitToken,
        });

        // 2. Compute diff + build a minimal prData shape that review-core
        //    knows how to chunk. We don't reconstruct the full PR API
        //    payload — just enough that the orchestrator can chunk + brief.
        const rawDiff = await clone.diff(dir, {
            targetBranch: data.targetSha ?? 'main',
            sourceBranch: data.headSha,
        });
        const files = filesFromDiff(rawDiff);
        const prData = {
            state: 'open',
            isDraft: false,
            mergeable: true,
            stats: {
                additions: files.reduce((a, f) => a + (f.additions ?? 0), 0),
                deletions: files.reduce((a, f) => a + (f.deletions ?? 0), 0),
            },
            files,
            author: { login: 'webhook' },
            title: `review job ${data.jobId}`,
        };

        // 3. Run the orchestrator
        const adaptive = new AdaptiveLearningService({ tenantId: data.tenantId });
        const deepEngine = new BackendDeepEngine({ llm: data.llm, adaptive });
        const orchestrator = new ReviewOrchestrator({ multiPassEngine: deepEngine });
        const report = await orchestrator.review(
            prData,
            { staticFindings: [] },
            data.llm ?? { provider: 'stub', model: 'stub', apiKey: 'stub' },
            data.settings ?? {},
            (ev) => { job.updateProgress(ev).catch(() => {}); },
        );

        // 4. Cross-repo coupling, if the brief asks for it
        let crossRepoFindings = [];
        let consumersChecked = 0;
        if (report.meta?.brief?.shared_contracts?.length
            || report.meta?.brief?.changed_signatures?.length) {
            const result = await runCrossRepoVerification({
                tenantId: data.tenantId,
                brief: report.meta.brief,
                cloneService: clone,
                llmService: null, // future hook
            });
            crossRepoFindings = result.findings.map((f) =>
                toCanonicalFinding(f, { phase: PHASE.DEEP, source: 'cross-repo' }),
            );
            consumersChecked = result.consumersChecked;
        }

        // 5. Adaptive learning — post-filter findings the tenant has
        //    repeatedly dismissed. Survives DB errors so a failing adaptive
        //    lookup never blocks a review.
        const merged = [...(report.findings ?? []), ...crossRepoFindings];
        let kept = merged;
        let suppressed = [];
        try {
            const filtered = await adaptive.filterFindings(merged);
            kept = filtered.kept;
            suppressed = filtered.suppressed;
        } catch (err) {
            logger.warn({ err: err.message }, 'adaptive_filter_failed');
        }

        // 6. Build final report
        const finalReport = buildVerdictReport({
            findings: kept,
            summary: {
                deep: report.summary.deep + (crossRepoFindings.length
                    ? `\n\nCross-repo verification: ${consumersChecked} consumer(s) checked, ${crossRepoFindings.length} issue(s).`
                    : '') + (suppressed.length
                    ? `\n\nAdaptive learning: ${suppressed.length} finding(s) suppressed based on prior dismissals.`
                    : ''),
                standards: report.summary.standards,
            },
            meta: {
                ...report.meta,
                consumersChecked,
                crossRepoFindings: crossRepoFindings.length,
                adaptiveSuppressed: suppressed.length,
                tokens: { in: deepEngine.tokensIn, out: deepEngine.tokensOut },
                costCents: deepEngine.costCents,
            },
        });

        // 7. Persist with real token + cost numbers
        await MrReviewRepo.setDone(data.jobId, {
            verdict: finalReport.verdict,
            report: finalReport,
            cacheHits: 0,
            tokensIn: deepEngine.tokensIn,
            tokensOut: deepEngine.tokensOut,
            costCents: deepEngine.costCents,
        });
        await UsageRepo.emit({
            tenantId: data.tenantId,
            kind: 'mr_review_done',
            metadata: { jobId: data.jobId, verdict: finalReport.verdict },
        });
        logger.info({ jobId: data.jobId, verdict: finalReport.verdict }, 'review_done');
        return { ok: true, jobId: data.jobId };
    } catch (err) {
        logger.error({ jobId: data.jobId, err: err.message }, 'review_failed');
        await MrReviewRepo.setFailed(data.jobId, err);
        throw err; // BullMQ records the failure + handles attempts/backoff
    } finally {
        await clone.cleanup();
    }
}

/**
 * Tiny diff-text → files[] adapter. The extension uses a richer DiffParser
 * but our worker only needs filename + additions/deletions + patch for the
 * orchestrator's chunker/brief.
 */
function filesFromDiff(rawDiff) {
    const files = [];
    let cur = null;
    for (const line of String(rawDiff).split('\n')) {
        const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (m) {
            if (cur) files.push(cur);
            cur = {
                filename: m[2],
                previous_filename: m[1] !== m[2] ? m[1] : undefined,
                additions: 0,
                deletions: 0,
                patch: '',
            };
            continue;
        }
        if (!cur) continue;
        cur.patch += line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) cur.additions++;
        if (line.startsWith('-') && !line.startsWith('---')) cur.deletions++;
    }
    if (cur) files.push(cur);
    return files;
}

// Boot
const worker = makeReviewWorker(processJob, { concurrency: 2 });
worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'job_failed');
});
worker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'job_completed');
});

logger.info({ env: config.NODE_ENV, root: config.CLONE_ROOT }, 'review_worker_up');

const shutdown = async (signal) => {
    logger.info({ signal }, 'worker_shutting_down');
    await worker.close();
    process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
