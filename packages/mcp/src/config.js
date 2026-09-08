import path from 'node:path';

export const DEFAULT_MAX_FILES = 5000;

/**
 * Tokens one tool response may occupy.
 *
 * 12000, not the 4096 this shipped with. Measured on a real 22-file merge
 * request: at 4096 `review_pr` returned every section but heavily trimmed —
 * 15 of 26 hunk windows, an emptied symbol list — while at 12000 the whole
 * diff of an ordinary change fits alongside the analysis sections. The budget
 * is the difference between a usable review and a summary of one, so the
 * working value ships as the default instead of waiting to be discovered.
 *
 * Raise it with `--max-tool-tokens` for a very large change; every section
 * sheds gracefully and says what it dropped, so a smaller value degrades
 * rather than breaks.
 */
export const DEFAULT_MAX_TOOL_TOKENS = 12000;

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

/** Was `--help` (or `-h`) asked for? */
export function wantsHelp(argv = []) {
    return argv.includes('--help') || argv.includes('-h');
}

/**
 * Usage, printed for `--help`.
 *
 * The flags were documented only in the package README, which nobody reads
 * from inside a client config. A server whose entire contract is "one response
 * must fit a context window" has to be able to state how that is tuned, and
 * where to put the flag — users edit JSON in a client config, not a shell, so
 * the example shows both.
 */
export function helpText() {
    return [
        'repospector-mcp — repository graph and retrieval context over MCP.',
        '',
        'Usage: repospector-mcp [options]',
        '',
        'Options:',
        `  --repo <path>            Default repository for calls that do not name one`,
        `                           (default: the working directory). Tools also accept`,
        `                           a per-call \`repo\`, so one entry serves every`,
        `                           repository on the machine.`,
        `  --max-tool-tokens <n>    Tokens ONE tool response may occupy`,
        `                           (default: ${DEFAULT_MAX_TOOL_TOKENS}). Raise it for a large`,
        `                           review: \`review_pr\` divides this budget across its`,
        `                           sections, and each one sheds detail and says what it`,
        `                           dropped rather than being cut off.`,
        `  --max-files <n>          Cap on files read while indexing`,
        `                           (default: ${DEFAULT_MAX_FILES}).`,
        '  --max-cache-mb <n>       Cap on the on-disk index cache in MB (default: 0,',
        '                           meaning unlimited — evicting a live snapshot costs a',
        '                           full re-index, so it stays opt-in).',
        '  -h, --help               Print this and exit.',
        '',
        'Passing a flag from a client config — the usual case — goes in "args":',
        '',
        '  "mcpServers": {',
        '    "repospector": {',
        '      "command": "npx",',
        '      "args": ["-y", "repospector-mcp", "--max-tool-tokens", "24000"]',
        '    }',
        '  }',
        '',
        'Git host credentials are read from the ENVIRONMENT only, never a flag:',
        '  GITHUB_TOKEN, GITLAB_TOKEN   Needed only when this server fetches a private',
        '                               diff itself; passing `diff` avoids them. Anything',
        '                               in argv is readable from the process list by any',
        '                               other process on the machine. These are git-host',
        '                               credentials, not model API keys — this package',
        '                               has no model API key of any kind.',
        '',
    ].join('\n');
}
