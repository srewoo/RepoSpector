/**
 * /v1/review/* — submit + poll MR reviews.
 *
 * Submit is fire-and-forget: enqueues a BullMQ job and returns the job id.
 * Polling fetches the persisted mr_review row. Result is the full
 * VerdictReport (canonical schema from @repospector/review-core).
 */
import { z } from 'zod';
import { getReviewQueue } from '../lib/queue.js';
import { MrReviewRepo, UsageRepo } from '../db/repositories.js';
import { parseMrUrl } from '../lib/parseGitUrl.js';
import { requireAuth } from '../middleware/auth.js';

const submitSchema = z.object({
    mr_url: z.string().url(),
    head_sha: z.string().min(7).max(64),
    target_sha: z.string().min(7).max(64).optional(),
    // BYO credentials — short-lived, never persisted. The worker uses these
    // for the clone and then discards them.
    git_token: z.string().min(1).optional(),
    llm: z.object({
        provider: z.string(),
        model: z.string(),
        api_key: z.string().min(1),
    }).optional(),
    settings: z.object({
        focus_areas: z.array(z.string()).optional(),
        max_files: z.number().int().positive().optional(),
        chunking: z.record(z.any()).optional(),
    }).optional(),
});

export async function reviewRoutes(fastify) {
    fastify.post('/v1/review/mr', { preHandler: requireAuth }, async (req, reply) => {
        const parsed = submitSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: 'invalid_body',
                details: parsed.error.flatten(),
            });
        }
        const { mr_url, head_sha, target_sha, git_token, llm, settings } = parsed.data;
        const gitInfo = parseMrUrl(mr_url);
        if (!gitInfo) {
            return reply.code(400).send({ error: 'unsupported_mr_url' });
        }

        // Cache lookup — if we already reviewed this exact head_sha for this
        // tenant + MR, return the cached result without enqueuing.
        const cached = await MrReviewRepo.findCached({
            tenantId: req.auth.tenantId,
            platform: gitInfo.platform,
            repoFullName: gitInfo.repoFullName,
            mrIid: gitInfo.mrIid,
            headSha: head_sha,
        });
        if (cached) {
            return reply.send({
                job_id: cached.job_id,
                status: 'done',
                cached: true,
                verdict: cached.verdict,
                report: cached.report,
            });
        }

        // Reserve a row first so /v1/review/:jobId can always return something.
        const jobId = crypto.randomUUID();
        await MrReviewRepo.create({
            tenantId: req.auth.tenantId,
            jobId,
            platform: gitInfo.platform,
            repoFullName: gitInfo.repoFullName,
            mrIid: gitInfo.mrIid,
            headSha: head_sha,
            targetSha: target_sha,
        });

        // Enqueue the actual work. The worker has the orchestrator wired in.
        const queue = getReviewQueue();
        await queue.add(
            'review',
            {
                jobId,
                tenantId: req.auth.tenantId,
                gitInfo,
                headSha: head_sha,
                targetSha: target_sha,
                gitToken: git_token,        // discarded by worker after clone
                llm,
                settings: settings ?? {},
            },
            {
                jobId,                  // BullMQ job id = our job id, for idempotency
                removeOnComplete: 100,  // keep last 100 for debugging
                removeOnFail: 100,
                attempts: 2,
                backoff: { type: 'exponential', delay: 5_000 },
            },
        );

        // Usage event — webhook-triggered reviews also produce one.
        await UsageRepo.emit({
            tenantId: req.auth.tenantId,
            kind: 'mr_review',
            metadata: { mr_url, head_sha },
        });

        return reply.code(202).send({
            job_id: jobId,
            status: 'queued',
            poll_url: `/v1/review/${jobId}`,
        });
    });

    fastify.get('/v1/review/:jobId', { preHandler: requireAuth }, async (req, reply) => {
        const row = await MrReviewRepo.byJobId(req.params.jobId);
        if (!row || row.tenant_id !== req.auth.tenantId) {
            return reply.code(404).send({ error: 'not_found' });
        }
        return reply.send({
            job_id: row.job_id,
            status: row.status,
            verdict: row.verdict,
            report: row.report,
            error: row.error,
            stats: {
                cacheHits: row.cache_hits,
                tokensIn: row.tokens_in,
                tokensOut: row.tokens_out,
                costCents: row.cost_cents,
            },
            created_at: row.created_at,
            completed_at: row.completed_at,
        });
    });
}
