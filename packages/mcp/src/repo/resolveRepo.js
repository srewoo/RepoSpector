import path from 'node:path';
import os from 'node:os';
import { existsSync, statSync } from 'node:fs';

/**
 * Which repository a tool call is about.
 *
 * `--repo` alone forces one repository per client entry, so a user working
 * across several has to edit `claude_desktop_config.json` and restart the
 * client to switch — and in Claude Desktop there is no useful working
 * directory to fall back on. Accepting `repo` per call means one config entry
 * serves every repository on the machine, and the model can name the one the
 * user is talking about.
 *
 * `~` is expanded here because nothing else will: the client spawns the server
 * directly rather than through a shell, so a literal `~/work/api` arrives
 * unexpanded and would resolve to a nonexistent `./~/work/api`.
 */

/** Reusable schema fragment: every tool takes the same optional `repo`. */
export const REPO_ARG = Object.freeze({
    repo: {
        type: 'string',
        description: 'Absolute path to the git worktree to analyse. Defaults to '
            + "the server's --repo. Use this to work across several repositories "
            + 'from one client entry.',
    },
});

/**
 * @param {{config: {repo: string}}} ctx
 * @param {{repo?: string}} [args]
 * @returns {string} An absolute path to an existing directory.
 * @throws {Error} When `repo` is given but unusable — a wrong path must say so
 *   rather than silently analysing whatever the server was started with.
 */
export function resolveRepo(ctx, args = {}) {
    const requested = args?.repo;
    if (requested === undefined || requested === null || requested === '') {
        return ctx.config.repo;
    }
    if (typeof requested !== 'string') {
        throw new Error(`repo must be a path string, received ${typeof requested}.`);
    }

    const expanded = requested === '~' || requested.startsWith('~/')
        ? path.join(os.homedir(), requested.slice(1))
        : requested;
    const resolved = path.resolve(expanded);

    if (!existsSync(resolved)) {
        throw new Error(
            `repo path does not exist: ${resolved}. Pass an absolute path to a `
            + 'git worktree that is cloned locally.',
        );
    }
    if (!statSync(resolved).isDirectory()) {
        throw new Error(`repo path is not a directory: ${resolved}.`);
    }
    return resolved;
}
