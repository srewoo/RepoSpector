#!/usr/bin/env node
/**
 * Merge MCP-host reviewer results into a copy of the imported OpenQodex corpus.
 *
 *   node eval/merge-mcp-results.js <corpus.json> <results-dir> <map.json> <out.json> [floor]
 *
 * Each results file is the JSON a reviewer agent returns:
 * {cases: [{repo, review_id, findings: [{file, line, title, description, rubric_score}]}]}.
 * A finding is kept when its rubric score is at least `floor` (default 50, the
 * observation floor) or it has none; pass 80 to score inline findings only.
 *
 * The server's own deterministic findings (config-lint rule hits on added
 * lines) are part of what an MCP review reports, so they are added here with
 * the same function the server uses. NO_DETERMINISTIC=1 scores the host alone.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configLintFindings } from '../packages/mcp/src/tools/findings.js';

const [corpusPath, dir, mapPath, out, floorArg] = process.argv.slice(2);
const floor = Number(floorArg ?? 50);
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const byRepo = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    for (const c of JSON.parse(readFileSync(join(dir, f), 'utf8')).cases) byRepo[c.repo] = c;
}
let reviewed = 0;
for (const kase of corpus.cases) {
    const repo = Object.keys(map).find((k) => map[k] === kase.id);
    const r = byRepo[repo];
    kase.productPath = 'mcp-host';
    kase.manifest = { productPath: 'mcp-host', hostAgent: { name: 'claude-code-subagent', model: process.env.HOST_MODEL ?? 'unknown' } };
    if (!r) { kase.predictions = []; delete kase.runStats; continue; }
    reviewed++;
    kase.predictions = (r.findings ?? [])
        .filter((f) => f.rubric_score == null || f.rubric_score >= floor)
        .map((f) => ({ ...f, posted: f.rubric_score == null || f.rubric_score >= 80 }));
    if (process.env.NO_DETERMINISTIC !== '1') {
        kase.predictions.push(...configLintFindings(kase.prData.files ?? [])
            .map((f) => ({ ...f, posted: true, rubric_score: null })));
    }
    kase.runStats = { reviewId: r.review_id, submitted: r.findings?.length ?? 0 };
}
writeFileSync(out, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(`${reviewed}/${corpus.cases.length} case(s) merged, rubric floor ${floor} → ${out}`);
