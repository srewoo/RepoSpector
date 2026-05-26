/**
 * Single shared pg.Pool. Min 5, max 30 per CLAUDE.md §6 MSSQL pool guidance
 * (same heuristic applies to Postgres for this workload).
 *
 * Note: we use Postgres rather than MSSQL because BullMQ already needs Redis
 * and the dev experience for Postgres in docker-compose is simpler. MSSQL
 * remains in CLAUDE.md as the org default; this is a documented deviation.
 */
import pg from 'pg';
import { config } from '../config.js';

const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    min: 5,
    max: 30,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('pg pool error:', err);
});

export { pool };

export async function withTx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
