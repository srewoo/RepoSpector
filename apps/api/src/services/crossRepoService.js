/**
 * CrossRepoService — Bastion's killer feature implemented for Aegis.
 *
 * Given an MR's brief.shared_contracts + brief.changed_signatures, find
 * consumer repos and verify they don't break.
 *
 * Two-phase:
 *   1. Resolve consumer repos. Right now from a `consumers` field on the
 *      tenant's standards bundle (manual list per shared contract). Future:
 *      auto-discovery via service registry / SourceGraph MCP.
 *   2. For each consumer (capped by MAX_REPOS_TO_CLONE - 1), clone + grep
 *      for the changed symbols. Emit `cross-repo-coupling:<repo>` findings.
 */
import { logger } from '../lib/logger.js';
import { StandardsRepo } from '../db/repositories.js';

export async function runCrossRepoVerification({ tenantId, brief, cloneService, llmService }) {
    if (!brief?.shared_contracts?.length && !brief?.changed_signatures?.length) {
        return { findings: [], consumersChecked: 0 };
    }

    const standards = await StandardsRepo.get(tenantId);
    const consumerMap = standards?.contents?.consumers ?? {};

    // Build list of distinct consumer repos to clone for this MR.
    const consumerRepos = new Set();
    for (const contract of brief.shared_contracts ?? []) {
        for (const r of consumerMap[contract] ?? []) consumerRepos.add(r);
    }
    for (const sig of brief.changed_signatures ?? []) {
        const symbolKey = sig.split('::').at(-1);
        for (const r of consumerMap[`symbol:${symbolKey}`] ?? []) consumerRepos.add(r);
    }
    if (consumerRepos.size === 0) {
        return { findings: [], consumersChecked: 0 };
    }

    const changedSymbols = (brief.changed_signatures ?? [])
        .concat(brief.removed_exports ?? [])
        .map((s) => s.split('::').at(-1))
        .filter(Boolean);

    const findings = [];
    let consumersChecked = 0;

    for (const repo of consumerRepos) {
        try {
            const { dir, name } = await cloneService.clone({
                cloneUrl: repo,
                branch: 'main', // best-effort; reviewers can override per-tenant
            });
            const hits = await cloneService.grepSymbols(dir, changedSymbols);
            consumersChecked++;

            if (hits.length === 0) {
                // No references — consumer not affected.
                continue;
            }

            // Aggregate to a single finding per consumer + offending symbol.
            const bySymbol = new Map();
            for (const h of hits) {
                const k = symbolFromMatch(h.match, changedSymbols);
                if (!k) continue;
                if (!bySymbol.has(k)) bySymbol.set(k, []);
                bySymbol.get(k).push(h);
            }
            for (const [symbol, refs] of bySymbol) {
                findings.push({
                    phase: 'deep',
                    severity: 'blocking',
                    category: 'architecture',
                    file: null,         // cross-repo: doesn't live in the MR
                    line: null,
                    rule: `cross-repo-coupling:${name}`,
                    title: `Consumer ${name} references changed symbol \`${symbol}\``,
                    suggestion: `${refs.length} reference(s) in ${name} call \`${symbol}\`. ` +
                                `Examples: ${refs.slice(0, 3).map((r) => `${r.file}:${r.line}`).join(', ')}. ` +
                                `Verify the contract change is backward-compatible or coordinate the rollout.`,
                    source: 'cross-repo',
                });
            }
        } catch (err) {
            logger.warn({ err: err.message, repo }, 'cross_repo_clone_failed');
            findings.push({
                phase: 'deep',
                severity: 'suggestion',
                category: 'tooling',
                rule: `cross-repo-clone-failed:${repo}`,
                title: `Could not verify consumer ${repo}`,
                suggestion: `Consumer repo ${repo} failed to clone: ${err.message}. ` +
                            `Manual verification recommended for shared-contract changes.`,
                source: 'cross-repo',
            });
        }
    }

    // Silence the unused-param lint for now — the LLM hook is wired for a
    // future "rank by impact" pass.
    void llmService;
    return { findings, consumersChecked };
}

function symbolFromMatch(matchText, symbols) {
    for (const s of symbols) {
        if (matchText.includes(s)) return s;
    }
    return null;
}
