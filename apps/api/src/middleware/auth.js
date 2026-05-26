/**
 * Auth middleware. Two paths:
 *   - JWT bearer token from the extension (preferred)
 *   - Dev-only `X-Aegis-Dev-Tenant: <uuid>` header when NODE_ENV=development
 *
 * Webhook routes have their own HMAC verification and bypass this middleware.
 */
import { config } from '../config.js';
import { TenantRepo } from '../db/repositories.js';
import { logger } from '../lib/logger.js';

export async function requireAuth(req, reply) {
    // Dev escape hatch — lets us curl the API without a JWT during local dev.
    if (config.NODE_ENV === 'development') {
        const devTenant = req.headers['x-aegis-dev-tenant'];
        if (devTenant) {
            const tenant = await TenantRepo.byId(devTenant);
            if (tenant) {
                req.auth = { tenantId: tenant.id, userId: null, role: 'dev', plan: tenant.plan };
                return;
            }
        }
    }

    try {
        await req.jwtVerify();
        const { sub, tenantId, role, plan } = req.user;
        if (!tenantId) {
            return reply.code(401).send({ error: 'jwt_missing_tenant' });
        }
        req.auth = { tenantId, userId: sub, role: role ?? 'member', plan: plan ?? 'free' };
    } catch (err) {
        logger.debug({ err: err.message }, 'jwt_verify_failed');
        return reply.code(401).send({ error: 'unauthorized' });
    }
}

/** Gate by minimum role. */
export function requireRole(min) {
    const order = { dev: 99, owner: 3, admin: 2, member: 1 };
    return async (req, reply) => {
        if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
        if ((order[req.auth.role] ?? 0) < (order[min] ?? 0)) {
            return reply.code(403).send({ error: 'forbidden', required: min });
        }
    };
}
