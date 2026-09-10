import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

/**
 * On-disk index cache: where it lives, and how to reclaim it.
 *
 * A snapshot directory is named `sha256(absolute repo path).slice(0, 16)`. That
 * keeps two repositories with the same basename apart, but it is one-way: given
 * a directory there was no way to tell which repository it belonged to, and
 * nothing ever deleted one. Both together mean the cache grows without bound
 * and cannot be cleaned selectively:
 *
 *   - Point the server at a repository once and its index is kept forever.
 *   - Rename a parent directory and the hash changes, so the index is silently
 *     rebuilt from scratch while the old copy stays behind, unreachable.
 *   - A user wanting to reclaim the space cannot tell which directory is which,
 *     so the only option is deleting all of it and re-indexing everything.
 *
 * `repo-path.txt` fixes the second half: recording the path makes an orphan
 * detectable, which is what `pruneOrphans` relies on. It cannot be backfilled
 * from the hash, so a snapshot written before this existed stays unlabelled
 * until it is next used — `labelIfMissing` is what eventually labels those.
 */

export const INDEX_BASE_DIR = path.join(os.homedir(), '.repospector', 'index');

const REPO_PATH_FILE = 'repo-path.txt';

/** Record which repository a snapshot directory belongs to. */
export async function recordRepoPath(dir, repoPath) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, REPO_PATH_FILE), repoPath, 'utf8');
}

/** The repository a snapshot belongs to, or null when it predates labelling. */
export async function readRepoPath(dir) {
    try {
        const p = (await fs.readFile(path.join(dir, REPO_PATH_FILE), 'utf8')).trim();
        return p || null;
    } catch {
        return null;
    }
}

/**
 * Label a snapshot that predates labelling, so a later prune can judge it.
 * Best-effort: a read-only cache directory must not fail a warm start.
 */
export async function labelIfMissing(dir, repoPath) {
    if (await readRepoPath(dir)) return false;
    try {
        await recordRepoPath(dir, repoPath);
        return true;
    } catch {
        return false;
    }
}

async function dirSize(dir) {
    let total = 0;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await dirSize(full);
        else {
            try { total += (await fs.stat(full)).size; } catch { /* vanished */ }
        }
    }
    return total;
}

/**
 * Delete snapshots whose repository no longer exists.
 *
 * Conservative by design: an UNLABELLED snapshot is never deleted, because
 * "no label" means "cannot tell", not "orphaned" — deleting on that basis would
 * throw away the index of a repository that is alive and well. Those are
 * counted and reported so the caller can say the space exists but cannot be
 * reclaimed selectively.
 *
 * @param {{base?: string, keep?: string[], dryRun?: boolean}} [options]
 *   `keep` protects live snapshots (the repositories this process is using) even
 *   if a path check would misfire. `dryRun` reports without deleting.
 * @returns {Promise<{removed: Array<{dir: string, repo: string, bytes: number}>,
 *   unlabelled: number, kept: number, freedBytes: number, base: string}>}
 */
export async function pruneOrphans({ base = INDEX_BASE_DIR, keep = [], dryRun = false } = {}) {
    const protectedDirs = new Set(keep);
    const result = {
        removed: [], unlabelled: 0, kept: 0, freedBytes: 0, base,
    };

    let entries;
    try {
        entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
        return result; // No cache yet: nothing to prune.
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        if (protectedDirs.has(dir)) { result.kept += 1; continue; }

        const repo = await readRepoPath(dir);
        if (!repo) { result.unlabelled += 1; continue; }

        // The repository still exists — its index is live, keep it.
        try {
            await fs.stat(repo);
            result.kept += 1;
            continue;
        } catch { /* gone: this snapshot is an orphan */ }

        let bytes = 0;
        try { bytes = await dirSize(dir); } catch { /* ignore */ }
        if (!dryRun) await fs.rm(dir, { recursive: true, force: true });
        result.removed.push({ dir, repo, bytes });
        result.freedBytes += bytes;
    }

    return result;
}

/** Most recent mtime anywhere inside a snapshot — its last use. */
async function lastUsed(dir) {
    let newest = 0;
    try {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const when = entry.isDirectory()
                ? await lastUsed(full)
                : (await fs.stat(full)).mtimeMs;
            if (when > newest) newest = when;
        }
    } catch { /* unreadable: treat as ancient so it is evicted first */ }
    return newest;
}

/**
 * Evict least-recently-used snapshots until the cache fits `maxBytes`.
 *
 * Pruning orphans does not bound growth on its own — a user with forty live
 * repositories keeps forty indexes, all legitimately labelled. This does bound
 * it. Evicting a live repository's snapshot is safe but not free: the next call
 * rebuilds it, which for a large repository is minutes of embedding. So it is
 * off unless asked for, matching how npm and pip treat their own caches, and it
 * never touches the snapshots named in `keep`.
 *
 * @param {{base?: string, maxBytes: number, keep?: string[], dryRun?: boolean}} options
 * @returns {Promise<{evicted: Array<{dir: string, repo: string|null, bytes: number}>,
 *   freedBytes: number, totalBytes: number, maxBytes: number}>}
 */
/**
 * Total size of the index cache, and how many snapshots it holds.
 *
 * Read-only, and deliberately separate from `enforceSizeCap`: the default of
 * "unlimited" is a considered choice — evicting a live snapshot costs a full
 * re-index — but nothing ever TOLD anyone the cache was growing, so a real
 * machine reached 2.5 GB across 452 snapshots without a word. Visibility is the
 * missing half of that decision, not eviction.
 *
 * @returns {Promise<{totalBytes: number, snapshots: number}>}
 */
export async function cacheFootprint({ base = INDEX_BASE_DIR } = {}) {
    let entries;
    try {
        entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
        return { totalBytes: 0, snapshots: 0 };
    }
    let totalBytes = 0;
    let snapshots = 0;
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        snapshots += 1;
        totalBytes += await dirSize(path.join(base, entry.name)).catch(() => 0);
    }
    return { totalBytes, snapshots };
}

export async function enforceSizeCap({
    base = INDEX_BASE_DIR, maxBytes, keep = [], dryRun = false,
}) {
    const out = {
        evicted: [], freedBytes: 0, totalBytes: 0, maxBytes,
    };
    if (!(maxBytes > 0)) return out; // Not configured: unlimited.

    const protectedDirs = new Set(keep);
    let entries;
    try {
        entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
        return out;
    }

    const snapshots = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        const bytes = await dirSize(dir).catch(() => 0);
        out.totalBytes += bytes;
        if (protectedDirs.has(dir)) continue; // Counts against the cap, never evicted.
        snapshots.push({ dir, bytes, used: await lastUsed(dir) });
    }

    // Oldest first, so the cache keeps what is actually being worked on.
    snapshots.sort((a, b) => a.used - b.used);

    let over = out.totalBytes - maxBytes;
    for (const snap of snapshots) {
        if (over <= 0) break;
        const repo = await readRepoPath(snap.dir);
        if (!dryRun) await fs.rm(snap.dir, { recursive: true, force: true });
        out.evicted.push({ dir: snap.dir, repo, bytes: snap.bytes });
        out.freedBytes += snap.bytes;
        over -= snap.bytes;
    }

    return out;
}
