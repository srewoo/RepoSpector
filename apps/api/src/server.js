/**
 * Aegis HTTP server. Fastify with security middleware, JWT auth, routes,
 * and clean shutdown handling.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { closeConnection } from './lib/queue.js';
import { pool } from './db/pool.js';

import { reviewRoutes } from './routes/review.js';
import { standardsRoutes } from './routes/standards.js';
import { feedbackRoutes } from './routes/feedback.js';
import { webhookRoutes } from './routes/webhooks.js';
import { billingRoutes } from './routes/billing.js';

export async function buildApp() {
    const app = Fastify({
        logger,
        bodyLimit: config.BODY_LIMIT_BYTES,
        trustProxy: true,
    });

    // Security headers
    await app.register(helmet, {
        contentSecurityPolicy: false, // API only — no HTML rendered
    });

    // CORS — extension origin is chrome-extension://<id>, which we don't
    // know in advance. In dev we accept all; in prod we accept the
    // Aegis-issued extension origin.
    await app.register(cors, {
        origin: config.NODE_ENV === 'production'
            ? [/^chrome-extension:\/\//, /^https:\/\/[a-z0-9-]+\.repospector\.com$/]
            : true,
        credentials: true,
    });

    // Rate limiting — coarse global cap; webhook + review routes can override.
    await app.register(rateLimit, {
        max: config.RATE_LIMIT_PER_MIN,
        timeWindow: '1 minute',
        skipOnError: true,
        keyGenerator: (req) => req.headers['x-aegis-dev-tenant'] ?? req.ip,
    });

    // JWT plugin (extension passes `Authorization: Bearer <jwt>`)
    await app.register(jwt, {
        secret: config.JWT_SECRET,
        sign: { iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE, expiresIn: '15m' },
        verify: { allowedIss: config.JWT_ISSUER, allowedAud: config.JWT_AUDIENCE },
    });

    // ── Routes ────────────────────────────────────────────────────────
    app.get('/v1/health', async () => ({
        status: 'ok',
        service: 'aegis',
        version: '0.1.0',
        time: new Date().toISOString(),
    }));

    app.get('/v1/readiness', async (_req, reply) => {
        try {
            await pool.query('SELECT 1');
            return { ready: true };
        } catch (err) {
            return reply.code(503).send({ ready: false, error: err.message });
        }
    });

    await app.register(reviewRoutes);
    await app.register(standardsRoutes);
    await app.register(feedbackRoutes);
    await app.register(webhookRoutes);
    await app.register(billingRoutes);

    // Generic 404
    app.setNotFoundHandler((_req, reply) => {
        reply.code(404).send({ error: 'not_found' });
    });

    // Generic error
    app.setErrorHandler((err, _req, reply) => {
        logger.error({ err: err.message, stack: err.stack }, 'unhandled_error');
        reply.code(err.statusCode ?? 500).send({
            error: err.code ?? 'internal_error',
            message: config.NODE_ENV === 'production' ? undefined : err.message,
        });
    });

    return app;
}

async function start() {
    const app = await buildApp();
    try {
        await app.listen({ host: config.HOST, port: config.PORT });
    } catch (err) {
        logger.error({ err }, 'failed_to_start');
        process.exit(1);
    }

    const shutdown = async (signal) => {
        logger.info({ signal }, 'shutting_down');
        try {
            await app.close();
            await closeConnection();
            await pool.end();
        } finally {
            process.exit(0);
        }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only start the server when executed directly — tests import buildApp().
if (import.meta.url === `file://${process.argv[1]}`) {
    start();
}
