/**
 * Aegis configuration — env-var loaded, Zod-validated.
 *
 * All variables required by default; the API fails loudly at startup if any
 * are missing rather than booting into a broken state.
 */
import { z } from 'zod';

const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),

    // Postgres
    DATABASE_URL: z.string().url().default('postgres://aegis:aegis@localhost:5432/aegis'),

    // Redis (BullMQ + cache)
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // JWT
    JWT_SECRET: z.string().min(32).default('dev-secret-change-me-dev-secret-change-me-32ch'),
    JWT_ISSUER: z.string().default('aegis-dev'),
    JWT_AUDIENCE: z.string().default('repospector-extension'),

    // GitHub App — REQUIRES_USER_ACTION to populate for real reviews
    GITHUB_APP_ID: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().default('dev-webhook-secret'),

    // GitLab webhook secret
    GITLAB_WEBHOOK_SECRET: z.string().default('dev-webhook-secret'),

    // Stripe — REQUIRES_USER_ACTION to populate for real billing
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_USAGE_METER_ID: z.string().optional(),

    // Workspace root for clones
    CLONE_ROOT: z.string().default('/tmp/aegis'),
    MAX_REPOS_TO_CLONE: z.coerce.number().int().positive().default(5),
    CLONE_DEPTH: z.coerce.number().int().positive().default(50),
    REVIEW_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),

    // Limits
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
    RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}

export const config = Object.freeze(parsed.data);
