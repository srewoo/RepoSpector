/**
 * /v1/billing/* — Stripe billing surfaces.
 *   POST /v1/billing/webhook   ← Stripe → Aegis (no auth, HMAC-verified)
 *   POST /v1/billing/checkout  ← extension → Aegis → Stripe Checkout URL
 *
 * The checkout endpoint returns a hosted Stripe Checkout URL; the extension
 * opens it in a new tab. Stripe handles all card data — Aegis never touches it.
 */
import Stripe from 'stripe';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { handleStripeWebhook } from '../services/billingService.js';
import { TenantRepo } from '../db/repositories.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

export async function billingRoutes(fastify) {
    fastify.post('/v1/billing/webhook', async (req, reply) => {
        if (!config.STRIPE_WEBHOOK_SECRET || !config.STRIPE_SECRET_KEY) {
            return reply.code(501).send({ error: 'stripe_not_configured' });
        }
        const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
        let event;
        try {
            event = stripe.webhooks.constructEvent(
                req.rawBody,
                req.headers['stripe-signature'],
                config.STRIPE_WEBHOOK_SECRET,
            );
        } catch (err) {
            logger.warn({ err: err.message }, 'stripe_webhook_bad_signature');
            return reply.code(400).send({ error: 'bad_signature' });
        }
        await handleStripeWebhook(event);
        return reply.send({ received: true });
    });

    fastify.post('/v1/billing/checkout', {
        preHandler: [requireAuth, requireRole('admin')],
    }, async (req, reply) => {
        if (!config.STRIPE_SECRET_KEY) {
            return reply.code(501).send({ error: 'stripe_not_configured' });
        }
        const tenant = await TenantRepo.byId(req.auth.tenantId);
        const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

        // Create customer if needed
        let customerId = tenant.stripe_customer_id;
        if (!customerId) {
            const cust = await stripe.customers.create({
                metadata: { tenant_id: tenant.id, tenant_name: tenant.name },
            });
            customerId = cust.id;
            await TenantRepo.setStripe(tenant.id, { customerId, subscriptionId: null });
        }

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            // REQUIRES_USER_ACTION: replace with your actual price id
            line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
            success_url: req.body?.success_url ?? 'https://repospector.com/billing/success',
            cancel_url: req.body?.cancel_url ?? 'https://repospector.com/billing/cancel',
        });
        return reply.send({ url: session.url });
    });
}
