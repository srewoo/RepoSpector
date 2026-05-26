const { AegisClient } = require('../../src/services/AegisClient.js');

function makeFetch(impl) {
    return jest.fn(async (url, opts) => impl(url, opts));
}

describe('AegisClient', () => {
    it('throws if baseUrl missing', () => {
        expect(() => new AegisClient({})).toThrow(/baseUrl/);
    });

    it('GET /v1/health hits the right URL (no auth required)', async () => {
        const fetch = makeFetch(async (url) => {
            expect(url).toBe('http://aegis.test/v1/health');
            return { ok: true, json: async () => ({ status: 'ok' }) };
        });
        const c = new AegisClient({ baseUrl: 'http://aegis.test/', jwt: 't', fetch });
        await expect(c.health()).resolves.toEqual({ status: 'ok' });
    });

    it('submitReview posts canonical body and returns jobId', async () => {
        const fetch = makeFetch(async (url, opts) => {
            expect(url).toBe('http://aegis.test/v1/review/mr');
            const body = JSON.parse(opts.body);
            expect(body.mr_url).toBe('https://github.com/o/r/pull/1');
            expect(body.head_sha).toBe('abc1234');
            return { ok: true, json: async () => ({ job_id: 'jjj', status: 'queued' }) };
        });
        const c = new AegisClient({ baseUrl: 'http://aegis.test', devTenant: 'dev', fetch });
        const r = await c.submitReview({ mrUrl: 'https://github.com/o/r/pull/1', headSha: 'abc1234' });
        expect(r).toEqual({ jobId: 'jjj', cached: false, report: null });
    });

    it('runReview returns the report when first response is cached', async () => {
        const report = { verdict: 'APPROVE', findings: [] };
        const fetch = makeFetch(async () => ({
            ok: true,
            json: async () => ({ job_id: 'jjj', cached: true, report }),
        }));
        const c = new AegisClient({ baseUrl: 'http://aegis.test', devTenant: 'dev', fetch });
        const r = await c.runReview({ mrUrl: 'https://github.com/o/r/pull/1', headSha: 'abc1234' });
        expect(r).toBe(report);
    });

    it('runReview polls until status=done', async () => {
        let n = 0;
        const report = { verdict: 'BLOCK', findings: [] };
        const fetch = jest.fn(async (url) => {
            n++;
            if (url.endsWith('/v1/review/mr')) {
                return { ok: true, json: async () => ({ job_id: 'jjj', status: 'queued' }) };
            }
            // polling
            if (n < 3) return { ok: true, json: async () => ({ status: 'running' }) };
            return { ok: true, json: async () => ({ status: 'done', report }) };
        });
        const c = new AegisClient({ baseUrl: 'http://aegis.test', devTenant: 'dev', fetch });
        const out = await c.runReview({ mrUrl: 'https://github.com/o/r/pull/1', headSha: 'abc1234' });
        expect(out).toBe(report);
        expect(fetch.mock.calls.length).toBeGreaterThan(2);
    }, 20_000);

    it('runReview rejects on failed', async () => {
        const fetch = jest.fn(async (url) => {
            if (url.endsWith('/v1/review/mr')) {
                return { ok: true, json: async () => ({ job_id: 'jjj', status: 'queued' }) };
            }
            return { ok: true, json: async () => ({ status: 'failed', error: 'boom' }) };
        });
        const c = new AegisClient({ baseUrl: 'http://aegis.test', devTenant: 'dev', fetch });
        await expect(c.runReview({ mrUrl: 'https://github.com/o/r/pull/1', headSha: 'abc1234' }))
            .rejects.toThrow(/boom/);
    });

    it('sendFeedback POSTs the right shape', async () => {
        const fetch = makeFetch(async (url, opts) => {
            expect(url).toBe('http://aegis.test/v1/feedback');
            expect(JSON.parse(opts.body)).toEqual({
                job_id: 'j', finding_id: 'f', action: 'dismiss', reason: 'noisy',
            });
            return { ok: true, json: async () => ({ id: 'fb', recorded_at: 'now' }) };
        });
        const c = new AegisClient({ baseUrl: 'http://aegis.test', devTenant: 'dev', fetch });
        await c.sendFeedback({ jobId: 'j', findingId: 'f', action: 'dismiss', reason: 'noisy' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
