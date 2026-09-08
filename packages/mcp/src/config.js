import path from 'node:path';

export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_TOOL_TOKENS = 4096;

/** Read a flag's value from an argv array, or null. */
function flag(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * A positive integer, or the fallback.
 *
 * Never returns NaN: a NaN ceiling compares false against everything and
 * silently disables the cap it was supposed to enforce.
 */
function intOr(value, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {string[]} argv Arguments after the node binary and script.
 * @param {Record<string, string|undefined>} env
 */
export function parseConfig(argv = [], env = {}) {
    return {
        repo: path.resolve(flag(argv, '--repo') || process.cwd()),
        maxFiles: intOr(flag(argv, '--max-files'), DEFAULT_MAX_FILES),
        maxToolTokens: intOr(flag(argv, '--max-tool-tokens'), DEFAULT_MAX_TOOL_TOKENS),
        // 0 means unlimited. Evicting a live snapshot costs a full re-index
        // later, so this stays opt-in rather than defaulting to a guess.
        maxCacheMb: intOr(flag(argv, '--max-cache-mb'), 0),
        // Environment only. A token passed in argv is readable from the process
        // list by any other process on the machine.
        githubToken: env.GITHUB_TOKEN || null,
        gitlabToken: env.GITLAB_TOKEN || null,
    };
}
