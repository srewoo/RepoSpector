/**
 * BillingService — Stripe metered subscriptions.
 *
 * Model: each tenant has at most one Subscription with a single price item
 * configured as `metered` (per-MR-review). UsageRepo emits an event per
 * billable action; a periodic job reports the deltas to Stripe.
 *
 * REQUIRES_USER_ACTION:
 *   - Create a Stripe product "Aegis Pro" with a metered price
 *   - Note the price id and meter id, set STRIPE_USAGE_METER_ID
 *   - Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in env
 *
 * Free tier: 100 reviews/month. We don't gate at the API edge — gating is
 * advisory until billing is fully live. The plan check is centralized here
 * so future changes are one-line.
 */
import Stripe from 'stripe';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { TenantRepo, UsageRepo } from '../db/repositories.js';

const FREE_TIER_MR_REVIEWS_PER_MONTH = 100;

let _stripe = null;
function stripe() {
    if (!_stripe && config.STRIPE_SECRET_KEY) {
        _stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    }
    return _stripe;
}

/**
 * Pre-flight check before a billable action. Returns
 *   { allowed: true } when ok
 *   { allowed: false, reason } when over the free tier and no subscription
 */
export async function preflight(tenantId) {
    const tenant = await TenantRepo.byId(tenantId);
    if (!tenant) return { allowed: false, reason: 'tenant_not_found' };
    if (tenant.plan !== 'free') return { allowed: true };

    // Count this calendar month's mr_review usage events.
    const usage = await monthlyMrReviewCount(tenantId);
    if (usage < FREE_TIER_MR_REVIEWS_PER_MONTH) return { allowed: true };
    return {
        allowed: false,
        reason: 'free_tier_exhausted',
        usage,
        limit: FREE_TIER_MR_REVIEWS_PER_MONTH,
    };
}

async function monthlyMrReviewCount(tenantId) {
    // Quick query — counts events emitted this calendar month.
    const { pool } = await import('../db/pool.js');
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM usage_event
         WHERE tenant_id = $1 AND kind IN ('mr_review','webhook_review')
           AND created_at >= date_trunc('month', now())`,
        [tenantId],
    );
    return rows[0]?.n ?? 0;
}

/**
 * Periodic reporter — drains UsageRepo.pendingForStripe() and reports each
 * tenant's aggregate to the configured meter. Idempotent on
 * `idempotency_key`. Failures are logged; events stay pending and the next
 * tick retries.
 *
 * Returns { reported, skipped, batches } for ops visibility.
 */
export async function reportUsageToStripe({ batchSize = 500 } = {}) {
    const client = stripe();
    if (!client || !config.STRIPE_USAGE_METER_ID) {
        return { reported: 0, skipped: 0, batches: 0, reason: 'stripe_not_configured' };
    }
    const events = await UsageRepo.pendingForStripe(batchSize);
    if (!events.length) return { reported: 0, skipped: 0, batches: 0 };

    // Group by tenant for one meter event per tenant per batch.
    const byTenant = new Map();
    for (const e of events) {
        if (!byTenant.has(e.tenant_id)) byTenant.set(e.tenant_id, []);
        byTenant.get(e.tenant_id).push(e);
    }

    let reported = 0;
    let skipped = 0;
    for (const [tenantId, group] of byTenant) {
        const tenant = await TenantRepo.byId(tenantId);
        if (!tenant?.stripe_customer_id) {
            // Free-tier tenants have no Stripe customer — events stay
            // unbilled but we still mark them reported so we don't reprocess.
            await UsageRepo.markStripeReported(group.map((e) => e.id));
            skipped += group.length;
            continue;
        }
        const billable = group.filter(
            (e) => e.kind === 'mr_review' || e.kind === 'webhook_review',
        );
        if (!billable.length) {
            await UsageRepo.markStripeReported(group.map((e) => e.id));
            continue;
        }
        try {
            await client.billing.meterEvents.create({
                event_name: config.STRIPE_USAGE_METER_ID,
                payload: {
                    stripe_customer_id: tenant.stripe_customer_id,
                    value: String(billable.length),
                },
                identifier: `aegis-${tenantId}-${group[0].id}`,
            });
            await UsageRepo.markStripeReported(group.map((e) => e.id));
            reported += billable.length;
        } catch (err) {
            logger.error({ err: err.message, tenantId }, 'stripe_report_failed');
            // Leave pending — next tick retries.
        }
    }
    return { reported, skipped, batches: byTenant.size };
}

/**
 * Handle Stripe webhook events. Wire in routes/billing.js.
 */
export async function handleStripeWebhook(event) {
    switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
            const sub = event.data.object;
            const customerId = sub.customer;
            // Find tenant by stripe_customer_id and bump plan.
            const { pool } = await import('../db/pool.js');
            const { rows } = await pool.query(
                `SELECT id FROM tenant WHERE stripe_customer_id = $1`,
                [customerId],
            );
            if (rows[0]) {
                const plan = sub.status === 'active' ? 'pro' : 'free';
                await pool.query(
                    `UPDATE tenant SET plan = $2, stripe_subscription_id = $3, updated_at = now() WHERE id = $1`,
                    [rows[0].id, plan, sub.id],
                );
            }
            return;
        }
        case 'customer.subscription.deleted': {
            const { pool } = await import('../db/pool.js');
            await pool.query(
                `UPDATE tenant SET plan = 'free', stripe_subscription_id = NULL, updated_at = now()
                 WHERE stripe_subscription_id = $1`,
                [event.data.object.id],
            );
            return;
        }
        default:
            // Ignored event types are normal.
            return;
    }
}

export const _internals = { stripe, monthlyMrReviewCount, FREE_TIER_MR_REVIEWS_PER_MONTH };
