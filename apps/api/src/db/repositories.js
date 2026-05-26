/**
 * Repository layer — pg queries only. Services call repos; repos never call
 * services. Parameterized queries everywhere (no string interpolation into SQL).
 */
import { pool, withTx } from './pool.js';

/* ────────────────────────── tenant + user ────────────────────────── */

export const TenantRepo = {
    async create({ name, plan = 'free' }) {
        const { rows } = await pool.query(
            `INSERT INTO tenant (name, plan) VALUES ($1, $2) RETURNING *`,
            [name, plan],
        );
        return rows[0];
    },
    async byId(id) {
        const { rows } = await pool.query(`SELECT * FROM tenant WHERE id = $1`, [id]);
        return rows[0] ?? null;
    },
    async setStripe(id, { customerId, subscriptionId }) {
        await pool.query(
            `UPDATE tenant SET stripe_customer_id = $2, stripe_subscription_id = $3, updated_at = now() WHERE id = $1`,
            [id, customerId, subscriptionId],
        );
    },
};

export const UserRepo = {
    async upsertByEmail({ email, tenantId, role = 'member' }) {
        const { rows } = await pool.query(
            `INSERT INTO app_user (email, tenant_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
             RETURNING *`,
            [email, tenantId, role],
        );
        return rows[0];
    },
    async byEmail(email) {
        const { rows } = await pool.query(`SELECT * FROM app_user WHERE email = $1`, [email]);
        return rows[0] ?? null;
    },
};

/* ───────────────────────── mr_review ──────────────────────── */

export const MrReviewRepo = {
    async create({ tenantId, jobId, platform, repoFullName, mrIid, headSha, targetSha }) {
        const { rows } = await pool.query(
            `INSERT INTO mr_review
               (tenant_id, job_id, platform, repo_full_name, mr_iid, head_sha, target_sha)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [tenantId, jobId, platform, repoFullName, mrIid, headSha, targetSha ?? null],
        );
        return rows[0];
    },

    async byJobId(jobId) {
        const { rows } = await pool.query(`SELECT * FROM mr_review WHERE job_id = $1`, [jobId]);
        return rows[0] ?? null;
    },

    /**
     * Cache lookup — return the most recent done review for the same MR head_sha.
     * Foundation for the head_sha invalidation that ADR-0001 asks for at the
     * service layer (the extension also has per-hunk cache; both layers coexist).
     */
    async findCached({ tenantId, platform, repoFullName, mrIid, headSha }) {
        const { rows } = await pool.query(
            `SELECT * FROM mr_review
             WHERE tenant_id = $1 AND platform = $2
               AND repo_full_name = $3 AND mr_iid = $4
               AND head_sha = $5 AND status = 'done'
             ORDER BY completed_at DESC LIMIT 1`,
            [tenantId, platform, repoFullName, mrIid, headSha],
        );
        return rows[0] ?? null;
    },

    async setRunning(jobId) {
        await pool.query(
            `UPDATE mr_review SET status = 'running' WHERE job_id = $1`,
            [jobId],
        );
    },

    async setDone(jobId, { verdict, report, cacheHits, tokensIn, tokensOut, costCents }) {
        await pool.query(
            `UPDATE mr_review
             SET status = 'done', verdict = $2, report = $3,
                 cache_hits = $4, tokens_in = $5, tokens_out = $6, cost_cents = $7,
                 completed_at = now()
             WHERE job_id = $1`,
            [jobId, verdict, report, cacheHits, tokensIn, tokensOut, costCents],
        );
    },

    async setFailed(jobId, error) {
        await pool.query(
            `UPDATE mr_review
             SET status = 'failed', error = $2, completed_at = now()
             WHERE job_id = $1`,
            [jobId, error?.message ?? String(error)],
        );
    },
};

/* ───────────────────────── standards ──────────────────────── */

export const StandardsRepo = {
    async get(tenantId) {
        const { rows } = await pool.query(
            `SELECT * FROM standards_bundle WHERE tenant_id = $1`,
            [tenantId],
        );
        return rows[0] ?? null;
    },
    async put(tenantId, contents) {
        return withTx(async (client) => {
            const cur = await client.query(
                `SELECT version FROM standards_bundle WHERE tenant_id = $1 FOR UPDATE`,
                [tenantId],
            );
            const nextVersion = (cur.rows[0]?.version ?? 0) + 1;
            await client.query(
                `INSERT INTO standards_bundle (tenant_id, version, contents, updated_at)
                 VALUES ($1, $2, $3, now())
                 ON CONFLICT (tenant_id) DO UPDATE
                 SET version = EXCLUDED.version, contents = EXCLUDED.contents, updated_at = now()`,
                [tenantId, nextVersion, contents],
            );
            return { version: nextVersion };
        });
    },
};

/* ───────────────────────── feedback + usage ──────────────────────── */

export const FeedbackRepo = {
    async record({ mrReviewId, findingId, action, reason, userId }) {
        const { rows } = await pool.query(
            `INSERT INTO finding_feedback (mr_review_id, finding_id, action, reason, user_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [mrReviewId, findingId, action, reason ?? null, userId ?? null],
        );
        return rows[0];
    },
};

export const UsageRepo = {
    async emit({ tenantId, kind, tokensIn = 0, tokensOut = 0, costCents = 0, metadata = null }) {
        const { rows } = await pool.query(
            `INSERT INTO usage_event (tenant_id, kind, tokens_in, tokens_out, cost_cents, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [tenantId, kind, tokensIn, tokensOut, costCents, metadata],
        );
        return rows[0];
    },
    async pendingForStripe(limit = 1000) {
        const { rows } = await pool.query(
            `SELECT * FROM usage_event
             WHERE stripe_reported = false
             ORDER BY created_at ASC LIMIT $1`,
            [limit],
        );
        return rows;
    },
    async markStripeReported(ids) {
        if (!ids.length) return;
        await pool.query(
            `UPDATE usage_event SET stripe_reported = true WHERE id = ANY($1::uuid[])`,
            [ids],
        );
    },
};

/* ───────────────────────── webhook installs ──────────────────────── */

export const WebhookInstallRepo = {
    async upsert({ tenantId, platform, installationId, accountLogin }) {
        const { rows } = await pool.query(
            `INSERT INTO webhook_install (tenant_id, platform, installation_id, account_login)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (platform, installation_id) DO UPDATE
             SET account_login = EXCLUDED.account_login
             RETURNING *`,
            [tenantId, platform, installationId, accountLogin],
        );
        return rows[0];
    },
    async byInstallation(platform, installationId) {
        const { rows } = await pool.query(
            `SELECT * FROM webhook_install WHERE platform = $1 AND installation_id = $2`,
            [platform, installationId],
        );
        return rows[0] ?? null;
    },
};
