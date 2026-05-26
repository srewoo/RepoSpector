/**
 * /v1/webhook/* — GitHub App + GitLab system hook endpoints.
 *
 * Each platform: verify signature → derive tenant from installation →
 * enqueue review for the MR head SHA.
 *
 * REQUIRES_USER_ACTION:
 *   - Register a GitHub App at https://github.com/settings/apps/new
 *     subscribe to: pull_request (opened, synchronize, reopened, ready_for_review)
 *     copy App ID, private key, webhook secret into env
 *   - GitLab project / group webhook with X-Gitlab-Token = GITLAB_WEBHOOK_SECRET
 *     subscribe to: Merge request events
 */
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getReviewQueue } from '../lib/queue.js';
import { MrReviewRepo, UsageRepo, WebhookInstallRepo } from '../db/repositories.js';
import { parseMrUrl } from '../lib/parseGitUrl.js';
import {
    verifyGithubSignature,
    verifyGitlabToken,
} from '../lib/webhookSignature.js';

// We need the raw body to verify signatures. Tell Fastify to keep it.
async function rawBodyParser(req, payload) {
    const chunks = [];
    for await (const chunk of payload) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    req.rawBody = raw;
    return raw.length ? JSON.parse(raw.toString('utf8')) : {};
}

export async function webhookRoutes(fastify) {
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, async (req, body) => {
        req.rawBody = body;
        return body.length ? JSON.parse(body.toString('utf8')) : {};
    });

    /* ───────────────────────── GitHub ───────────────────────── */

    fastify.post('/v1/webhook/github', async (req, reply) => {
        const sig = req.headers['x-hub-signature-256'];
        if (!verifyGithubSignature(req.rawBody, sig, config.GITHUB_WEBHOOK_SECRET)) {
            logger.warn({ headers: req.headers }, 'github_webhook_bad_signature');
            return reply.code(401).send({ error: 'bad_signature' });
        }
        const event = req.headers['x-github-event'];

        // Pre-install handshake — accept and ack so the App page shows ✓.
        if (event === 'ping') return reply.send({ ok: true });

        if (event === 'installation') {
            const action = req.body?.action;
            if (action === 'created' || action === 'new_permissions_accepted') {
                // Without auth context we can't bind to a tenant; the
                // installer must hit /v1/installations/bind from the
                // extension. We just record the install for now.
                logger.info({ install: req.body?.installation?.id }, 'github_install_pending_bind');
            }
            return reply.send({ ok: true });
        }

        if (event !== 'pull_request') return reply.send({ ok: true, ignored: event });

        const action = req.body?.action;
        if (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(action)) {
            return reply.send({ ok: true, ignored_action: action });
        }

        const pr = req.body.pull_request;
        const installationId = String(req.body.installation?.id ?? '');
        if (!installationId) return reply.code(400).send({ error: 'missing_installation' });

        const install = await WebhookInstallRepo.byInstallation('github', installationId);
        if (!install) {
            logger.warn({ installationId }, 'github_install_not_bound');
            return reply.code(202).send({ ok: true, status: 'install_not_bound' });
        }

        const mrUrl = pr.html_url;
        const gitInfo = parseMrUrl(mrUrl);
        if (!gitInfo) return reply.code(400).send({ error: 'unparseable_pr_url' });

        return enqueueWebhookReview({
            reply,
            tenantId: install.tenant_id,
            gitInfo,
            headSha: pr.head.sha,
            targetSha: pr.base.sha,
            triggerKind: `github:${action}`,
        });
    });

    /* ───────────────────────── GitLab ───────────────────────── */

    fastify.post('/v1/webhook/gitlab', async (req, reply) => {
        const token = req.headers['x-gitlab-token'];
        if (!verifyGitlabToken(token, config.GITLAB_WEBHOOK_SECRET)) {
            return reply.code(401).send({ error: 'bad_token' });
        }
        const event = req.headers['x-gitlab-event'];
        if (event !== 'Merge Request Hook') {
            return reply.send({ ok: true, ignored: event });
        }
        const attrs = req.body?.object_attributes ?? {};
        if (!['open', 'reopen', 'update'].includes(attrs.action)) {
            return reply.send({ ok: true, ignored_action: attrs.action });
        }

        const projectId = String(req.body?.project?.id ?? '');
        const install = await WebhookInstallRepo.byInstallation('gitlab', projectId);
        if (!install) return reply.code(202).send({ ok: true, status: 'project_not_bound' });

        const mrUrl = attrs.url;
        const gitInfo = parseMrUrl(mrUrl);
        if (!gitInfo) return reply.code(400).send({ error: 'unparseable_mr_url' });

        return enqueueWebhookReview({
            reply,
            tenantId: install.tenant_id,
            gitInfo,
            headSha: attrs.last_commit?.id ?? attrs.source_branch,
            targetSha: attrs.target_branch,
            triggerKind: `gitlab:${attrs.action}`,
        });
    });
}

async function enqueueWebhookReview({ reply, tenantId, gitInfo, headSha, targetSha, triggerKind }) {
    // Cache check — head_sha invalidation. If we already reviewed this exact
    // head, fan out the cached result and skip the LLM.
    const cached = await MrReviewRepo.findCached({
        tenantId, platform: gitInfo.platform,
        repoFullName: gitInfo.repoFullName,
        mrIid: gitInfo.mrIid, headSha,
    });
    if (cached) {
        return reply.send({
            ok: true, cached: true, job_id: cached.job_id,
        });
    }

    const jobId = crypto.randomUUID();
    await MrReviewRepo.create({
        tenantId, jobId,
        platform: gitInfo.platform,
        repoFullName: gitInfo.repoFullName,
        mrIid: gitInfo.mrIid,
        headSha, targetSha,
    });
    const queue = getReviewQueue();
    await queue.add(
        'review',
        { jobId, tenantId, gitInfo, headSha, targetSha, settings: {}, triggerKind },
        { jobId, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
    );
    await UsageRepo.emit({
        tenantId, kind: 'webhook_review',
        metadata: { trigger: triggerKind, head_sha: headSha },
    });
    return reply.send({ ok: true, job_id: jobId });
}
