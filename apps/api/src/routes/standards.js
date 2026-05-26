import { z } from 'zod';
import { StandardsRepo } from '../db/repositories.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const standardsSchema = z.object({
    rules: z.array(z.object({
        id: z.string(),
        category: z.string().optional(),
        severity: z.enum(['blocking', 'suggestion', 'nitpick']).optional(),
        pattern: z.string().optional(),
        message: z.string().optional(),
    })).optional(),
    languages: z.record(z.any()).optional(),
    custom_prompts: z.record(z.string()).optional(),
});

export async function standardsRoutes(fastify) {
    fastify.get('/v1/standards', { preHandler: requireAuth }, async (req, reply) => {
        const row = await StandardsRepo.get(req.auth.tenantId);
        if (!row) return reply.send({ version: 0, contents: {} });
        return reply.send({ version: row.version, contents: row.contents });
    });

    fastify.put('/v1/standards', {
        preHandler: [requireAuth, requireRole('admin')],
    }, async (req, reply) => {
        const parsed = standardsSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
        }
        const { version } = await StandardsRepo.put(req.auth.tenantId, parsed.data);
        return reply.send({ version });
    });
}
