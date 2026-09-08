import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import { pruneOrphans, enforceSizeCap } from '../repo/cache.js';

/**
 * Build or rebuild the index for the configured repository.
 *
 * Exists as a first-class tool rather than leaving indexing implicit for two
 * reasons. A user who has just cloned or pulled wants to index deliberately,
 * not discover it as a 60-second pause inside their first search. And there is
 * otherwise no way to force a rebuild: manifest hashing means a warm repo
 * reprocesses only changed files, which is right almost always and wrong
 * exactly when the index is suspected corrupt.
 */
/** Bytes as MB, for a line a human reads rather than a machine parses. */
function mb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Cache upkeep requested on this call, as report lines.
 *
 * Both operations delete cached data, so neither runs unless asked, and both
 * protect the snapshot this call is using — evicting the index you just built
 * would be absurd. Failures are reported rather than thrown: cache upkeep must
 * never turn a successful index into a failed tool call.
 */
async function maintainCache(args, ctx, indexer) {
    const notes = [];
    const keep = [indexer.snapshotPath];

    if (args.prune) {
        try {
            const r = await pruneOrphans({ keep });
            notes.push(r.removed.length
                ? `Pruned ${r.removed.length} orphaned index(es), freeing ${mb(r.freedBytes)}.`
                : 'Pruned nothing: every identifiable cached index still has its repository.');
            if (r.unlabelled) {
                notes.push(
                    `${r.unlabelled} cached index(es) predate path labelling and cannot be `
                    + 'identified, so they were left alone. They are labelled the next time '
                    + 'their repository is used.',
                );
            }
        } catch (error) {
            notes.push(`Prune failed: ${error.message}`);
        }
    }

    const capMb = args.max_cache_mb ?? ctx.config.maxCacheMb;
    if (capMb > 0) {
        try {
            const r = await enforceSizeCap({ maxBytes: capMb * 1024 * 1024, keep });
            notes.push(r.evicted.length
                ? `Cache over ${capMb} MB: evicted ${r.evicted.length} least-recently-used `
                    + `index(es), freeing ${mb(r.freedBytes)}.`
                : `Cache is ${mb(r.totalBytes)}, within the ${capMb} MB limit.`);
        } catch (error) {
            notes.push(`Cache limit enforcement failed: ${error.message}`);
        }
    }

    return notes;
}

export const INDEX_REPO_TOOL = {
    name: 'index_repo',
    description:
        'Build or refresh the code index (embeddings + call graph) for the configured repository. '
        + 'Call this after cloning or pulling. Pass force:true to discard the incremental manifest '
        + 'and rebuild from scratch. Also maintains the on-disk cache: prune:true deletes snapshots '
        + 'whose repository no longer exists, and max_cache_mb evicts the least recently used '
        + 'snapshots until the cache fits.',
    inputSchema: {
        type: 'object',
        properties: {
            force: {
                type: 'boolean',
                description: 'Discard the incremental manifest and rebuild every file.',
            },
            max_files: {
                type: 'integer',
                description: 'Override the file ceiling for this build.',
            },
            prune: {
                type: 'boolean',
                description: 'Delete cached indexes whose repository no longer exists on disk. '
                    + 'Never deletes an index it cannot identify, nor one in use.',
            },
            max_cache_mb: {
                type: 'integer',
                description: 'Evict least-recently-used cached indexes until the whole cache fits '
                    + 'this many megabytes. Evicted repositories re-index on next use.',
            },
            ...REPO_ARG,
        },
    },

    async handler(args, ctx) {
        try {
            const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
            const build = await indexer.ensureIndexed({
                force: Boolean(args.force),
                maxFiles: args.max_files || ctx.config.maxFiles,
            });

            const last = indexer.lastBuild();
            const lines = [`Repository: ${indexer.repoId}`];
            const cacheNotes = await maintainCache(args, ctx, indexer);

            if (!build.built && !last) {
                lines.push('Index was already warm — loaded from the existing snapshot.');
                lines.push('Pass force:true to rebuild it from scratch.');
            } else {
                const b = last || build;
                lines.push(`Files indexed: ${b.files}`);
                if (b.skipped) lines.push(`Skipped (unreadable or over the size limit): ${b.skipped}`);
                if (b.truncated) {
                    lines.push(
                        `Stopped at the file ceiling — raise it with --max-files or the max_files argument.`,
                    );
                }
                lines.push(`Parser: ${b.parser}`);
                if (b.parser === 'regex-fallback') {
                    lines.push(
                        'Tree-sitter was unavailable, so symbols came from regex extraction. '
                        + 'Results are usable but less precise.',
                    );
                }
            }

            const stats = indexer.stats();
            if (stats) {
                lines.push(`Graph: ${stats.nodeCount ?? '?'} nodes, ${stats.relationshipCount ?? '?'} edges`);
            }
            lines.push(`Snapshot: ${indexer.snapshotPath}`);
            lines.push(...cacheNotes);

            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (error) {
            // Structured, not thrown: the caller is a model and can act on a
            // message that names the cause.
            return {
                isError: true,
                content: [{ type: 'text', text: `index_repo failed: ${error.message}` }],
            };
        }
    },
};
