/**
 * BullMQ queue + worker bindings. One queue today (`review`); add others by
 * pattern when needed (`analytics`, `clone-cleanup`, ...).
 */
import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

let _connection = null;
function connection() {
    if (!_connection) {
        _connection = new IORedis(config.REDIS_URL, {
            maxRetriesPerRequest: null, // BullMQ requirement
            enableReadyCheck: true,
        });
    }
    return _connection;
}

export const QUEUE_REVIEW = 'review';

export function getReviewQueue() {
    return new Queue(QUEUE_REVIEW, { connection: connection() });
}

export function getReviewEvents() {
    return new QueueEvents(QUEUE_REVIEW, { connection: connection() });
}

export function makeReviewWorker(processor, opts = {}) {
    return new Worker(QUEUE_REVIEW, processor, {
        connection: connection(),
        concurrency: opts.concurrency ?? 2,
        // Per-job hard timeout — the worker's git+LLM work shouldn't run
        // forever. BullMQ surfaces this as a "stalled" + retry/failure cycle.
        lockDuration: opts.lockDuration ?? config.REVIEW_TIMEOUT_MS + 30_000,
    });
}

export async function closeConnection() {
    if (_connection) {
        await _connection.quit();
        _connection = null;
    }
}
