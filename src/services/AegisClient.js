/**
 * AegisClient — thin client for the RepoSpector backend (apps/api).
 *
 * Submits an MR review to the backend and polls for completion. The backend
 * returns the canonical VerdictReport from @repospector/review-core, so the
 * extension UI can render it identically to a locally-run review.
 *
 * Falls back to local pipeline on transport error — the caller decides
 * whether to retry remote or just run local.
 */

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 4 * 60 * 1000;

export class AegisClient {
    /**
     * @param {object} opts
     * @param {string} opts.baseUrl - e.g. http://localhost:8080
     * @param {string} [opts.jwt]   - bearer token; in dev, set devTenant instead
     * @param {string} [opts.devTenant] - dev-only header
     * @param {Function} [opts.fetch] - injectable for tests
     */
    constructor({ baseUrl, jwt, devTenant, fetch: f } = {}) {
        if (!baseUrl) throw new Error('AegisClient requires baseUrl');
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.jwt = jwt;
        this.devTenant = devTenant;
        this.fetch = f || globalThis.fetch.bind(globalThis);
    }

    _headers(extra = {}) {
        const h = { 'Content-Type': 'application/json', ...extra };
        if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
        if (this.devTenant) h['X-Aegis-Dev-Tenant'] = this.devTenant;
        return h;
    }

    async health() {
        const res = await this.fetch(`${this.baseUrl}/v1/health`);
        if (!res.ok) throw new Error(`health_http_${res.status}`);
        return res.json();
    }

    /**
     * Submit an MR review. Returns { jobId, cached, report? }.
     * If `cached` is true, `report` is already populated.
     */
    async submitReview({ mrUrl, headSha, targetSha, gitToken, llm, settings }) {
        const res = await this.fetch(`${this.baseUrl}/v1/review/mr`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({
                mr_url: mrUrl,
                head_sha: headSha,
                target_sha: targetSha,
                git_token: gitToken,
                llm,
                settings,
            }),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`submit_http_${res.status}: ${text.slice(0, 200)}`);
        }
        const body = await res.json();
        return {
            jobId: body.job_id,
            cached: body.cached === true,
            report: body.report ?? null,
        };
    }

    async getReview(jobId) {
        const res = await this.fetch(`${this.baseUrl}/v1/review/${jobId}`, {
            headers: this._headers(),
        });
        if (!res.ok) throw new Error(`get_http_${res.status}`);
        return res.json();
    }

    /**
     * Submit + poll until done/failed/timeout. Returns the same shape as
     * the local orchestrator: a canonical VerdictReport.
     */
    async runReview(args, { onProgress, signal } = {}) {
        const submission = await this.submitReview(args);
        if (submission.cached && submission.report) {
            onProgress?.({ step: 'remote_cached', jobId: submission.jobId });
            return submission.report;
        }

        const start = Date.now();
        let lastStatus = 'queued';
        while (Date.now() - start < POLL_TIMEOUT_MS) {
            if (signal?.aborted) throw new Error('aborted');
            await sleep(POLL_INTERVAL_MS);
            const polled = await this.getReview(submission.jobId);
            if (polled.status !== lastStatus) {
                onProgress?.({ step: 'remote_status', status: polled.status, jobId: submission.jobId });
                lastStatus = polled.status;
            }
            if (polled.status === 'done') return polled.report;
            if (polled.status === 'failed') {
                throw new Error(`remote_review_failed: ${polled.error ?? 'unknown'}`);
            }
        }
        throw new Error('remote_review_timeout');
    }

    /** Fetch the tenant's standards bundle. */
    async getStandards() {
        const res = await this.fetch(`${this.baseUrl}/v1/standards`, {
            headers: this._headers(),
        });
        if (!res.ok) throw new Error(`standards_http_${res.status}`);
        return res.json();
    }

    /** Record dismiss/accept feedback on a finding. */
    async sendFeedback({ jobId, findingId, action, reason }) {
        const res = await this.fetch(`${this.baseUrl}/v1/feedback`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({
                job_id: jobId, finding_id: findingId, action, reason,
            }),
        });
        if (!res.ok) throw new Error(`feedback_http_${res.status}`);
        return res.json();
    }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
