import { getIndexer } from '../repo/indexer.js';
import { resolveRepo, REPO_ARG } from '../repo/resolveRepo.js';
import { capText } from './cap.js';
import { guarded } from './guarded.js';

export const IMPACT_OF_CHANGE_TOOL = {
    name: 'impact_of_change',
    description:
        'Given a symbol, report what changing it would reach: dependents, the community it '
        + 'belongs to, and which of the affected code has test coverage.',
    inputSchema: {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Exact symbol name.' },
            depth: { type: 'integer', description: 'Traversal depth (default 2).' },
            ...REPO_ARG,
        },
        required: ['symbol'],
    },
    handler: guarded('impact_of_change', async (args, ctx) => {
        const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
        await indexer.ensureIndexed({});

        // safetyCheck -> ImpactAnalyzer.quickSafetyCheck: {safe, reason, risk?}
        // when the pipeline has an impactAnalyzer, else null (no graph built).
        //
        // `depth` is forwarded: it used to reach only the untested-blast-radius
        // call below, so asking for depth 4 changed half the answer and left
        // the safety verdict computed at a hardcoded 3.
        const depth = args.depth || 2;
        const safety = indexer.pipeline.safetyCheck(args.symbol, { maxDepth: depth });
        // getUntestedInBlastRadius -> ImpactAnalyzer.findUntestedInBlastRadius:
        // always {found, untested, ...} when an impactAnalyzer exists — even
        // for an unknown symbol it returns {found: false, untested: []}, never
        // an array on its own and never null unless there is no analyzer at
        // all. `.found` is therefore the authoritative "symbol exists" signal;
        // an unknown symbol still leaves `safety` truthy (quickSafetyCheck
        // returns {safe:true, reason:'...not found...'} rather than null), so
        // `safety` cannot be used to detect "not found".
        const untested = indexer.pipeline.getUntestedInBlastRadius(args.symbol, {
            maxDepth: args.depth || 2,
        });

        if (!untested || untested.found === false) {
            return {
                content: [{
                    type: 'text',
                    text: `No symbol named "${args.symbol}" in the graph. Use get_symbol to check the `
                        + 'name, or index_repo if the index may be stale.',
                }],
            };
        }

        const body = JSON.stringify({ symbol: args.symbol, safety, untested }, null, 2);
        const capped = capText(body, ctx.config.maxToolTokens);
        const text = capped.truncated ? `${capped.text}\n\n[${capped.note}]` : capped.text;
        return { content: [{ type: 'text', text }] };
    }),
};

export const REPO_OVERVIEW_TOOL = {
    name: 'repo_overview',
    description:
        'Summarise the indexed repository: graph size, index health, and which parser produced '
        + 'the symbols. Call this first to confirm the index is built.',
    inputSchema: { type: 'object', properties: { ...REPO_ARG } },
    handler: guarded('repo_overview', async (args, ctx) => {
        const indexer = await getIndexer(ctx, resolveRepo(ctx, args));
        await indexer.ensureIndexed({});

        // getStats() -> CodeGraphPipeline.getStats() -> KnowledgeGraphService.getStats():
        // {nodeCount, relationshipCount, nodesByLabel, relationshipsByType}.
        const stats = indexer.pipeline.getStats() || {};
        const last = indexer.lastBuild();
        const parser = indexer.parserMode();
        const lines = [
            `Repository: ${indexer.repoId}`,
            `Path: ${resolveRepo(ctx, args)}`,
            `Graph: ${stats.nodeCount ?? '?'} nodes, ${stats.relationshipCount ?? '?'} edges`,
            `Parser: ${parser}`,
        ];
        if (parser === 'regex-fallback') {
            lines.push(
                'Tree-sitter was unavailable, so symbols came from regex extraction — usable but '
                + 'less precise for multi-line signatures and call targets.',
            );
        }
        if (parser === 'unknown') {
            // `unknown` is the ABSENCE of a record, not a determination that the
            // parser was poor. Snapshots written before parser-mode tracking
                // existed carry no `parser-mode.txt`, and the warm-restore path
            // never loads tree-sitter, so this printed a bare "unknown" that
            // read as a finding about the repository — on RepoSpector's own
            // index, which is exactly where it is least reassuring.
            lines.push(
                'Not recorded: this snapshot predates parser tracking, so which extractor built it '
                + 'cannot be recovered. Run index_repo with force:true to rebuild and label it.',
            );
        }
        if (last) {
            lines.push(`Last build: ${last.files} files indexed, ${last.skipped} skipped`);
        } else {
            // A warm restore has no `lastBuild`, and dropping the line entirely
            // made a healthy restored index look like a failed build. Report
            // what the loaded graph does know instead of going quiet.
            const fileNodes = stats.nodesByLabel?.File;
            lines.push(
                `Restored from snapshot (no build this session)${
                    Number.isFinite(fileNodes) ? `, ${fileNodes} files in the graph` : ''
                }.`,
            );
        }
        const commit = typeof indexer.indexedCommit === 'function'
            ? await indexer.indexedCommit().catch(() => null)
            : null;
        if (commit) lines.push(`Index built from commit: ${commit}`);
        lines.push(`Snapshot: ${indexer.snapshotPath}`);

        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
};
