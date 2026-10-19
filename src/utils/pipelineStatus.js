/**
 * pipelineStatus — one vocabulary for "is CI red?" across hosts.
 *
 * `SkipRuleEngine` defers a review on a failing pipeline, but it read
 * `pr.pipelineStatus` while `PullRequestService` only ever wrote
 * `prData.pipeline.status` (GitLab) and nothing at all on GitHub — so the
 * rule could never fire. Both hosts now normalise into this one field.
 *
 * Accepts:
 *   - a GitLab pipeline status string (`failed`, `running`, `canceled`, ...)
 *   - an already-normalised value (`success|failed|running|none`)
 *   - a GitHub check-runs array (`[{status, conclusion}]`)
 */

export const PIPELINE_STATUS = Object.freeze({
    SUCCESS: 'success',
    FAILED: 'failed',
    RUNNING: 'running',
    NONE: 'none',
});

// `cancelled`/`canceled` count as failed on both hosts: a head commit whose
// checks were cancelled has no green CI, which is what the DEFER rule asks.
const FAILED = new Set([
    'failed', 'failure', 'failing', 'error', 'timed_out', 'cancelled', 'canceled', 'startup_failure',
]);
const RUNNING = new Set([
    'running', 'pending', 'created', 'preparing', 'waiting_for_resource', 'scheduled',
    'queued', 'in_progress', 'requested', 'waiting',
]);
const SUCCESS = new Set(['success', 'passed']);

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * @param {string|Array<{status?:string, conclusion?:string|null}>|null|undefined} raw
 * @returns {'success'|'failed'|'running'|'none'}
 */
export function normalizePipelineStatus(raw) {
    if (Array.isArray(raw)) {
        if (raw.length === 0) return PIPELINE_STATUS.NONE;
        if (raw.some(r => FAILED.has(lower(r?.conclusion)))) return PIPELINE_STATUS.FAILED;
        if (raw.some(r => lower(r?.status) !== 'completed')) return PIPELINE_STATUS.RUNNING;
        return PIPELINE_STATUS.SUCCESS;
    }
    const s = lower(raw);
    if (FAILED.has(s)) return PIPELINE_STATUS.FAILED;
    if (RUNNING.has(s)) return PIPELINE_STATUS.RUNNING;
    if (SUCCESS.has(s)) return PIPELINE_STATUS.SUCCESS;
    return PIPELINE_STATUS.NONE;
}

export default { normalizePipelineStatus, PIPELINE_STATUS };
