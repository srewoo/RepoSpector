import { z } from 'zod';
import { FeedbackRepo, MrReviewRepo } from '../db/repositories.js';
import { requireAuth } from '../middleware/auth.js';

const feedbackSchema = z.object({
    job_id: z.string(),
    finding_id: z.string(),
    action: z.enum(['accept', 'dismiss', 'edit']),
    reason: z.string().max(500).optional(),
});

export async function feedbackRoutes(fastify) {
    fastify.post('/v1/feedback', { preHandler: requireAuth }, async (req, reply) => {
        const parsed = feedbackSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
        }
        const review = await MrReviewRepo.byJobId(parsed.data.job_id);
        if (!review || review.tenant_id !== req.auth.tenantId) {
            return reply.code(404).send({ error: 'review_not_found' });
        }
        const row = await FeedbackRepo.record({
            mrReviewId: review.id,
            findingId: parsed.data.finding_id,
            action: parsed.data.action,
            reason: parsed.data.reason,
            userId: req.auth.userId,
        });
        return reply.send({ id: row.id, recorded_at: row.created_at });
    });
}
