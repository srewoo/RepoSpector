/**
 * env — read credentials from the repo's .env without adding a dependency.
 *
 * Deliberately minimal: the eval harness is the only consumer, it runs on a
 * developer's machine, and pulling dotenv in for six lines would put a runtime
 * dependency in an extension that ships none.
 *
 * Values are never logged. Callers that need to report which credential was
 * used should report the KEY name.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @param {string} [path='.env']
 * @returns {Record<string,string>}
 */
export function loadEnvFile(path = '.env') {
    const full = resolve(path);
    if (!existsSync(full)) return {};

    const out = {};
    for (const raw of readFileSync(full, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        // Strip matching surrounding quotes, which people paste in habitually.
        const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
        if (key) out[key] = value;
    }
    return out;
}

/**
 * Env file merged under process.env — a real environment variable wins, so CI
 * can override without editing a file.
 */
export function env(path = '.env') {
    return { ...loadEnvFile(path), ...process.env };
}

/** Fetch a required key, failing with an actionable message. */
export function requireKey(vars, name, hint) {
    const value = vars[name];
    if (!value) throw new Error(`${name} is not set. ${hint ?? `Add it to .env or export it.`}`);
    return value;
}

export default { env, loadEnvFile, requireKey };
