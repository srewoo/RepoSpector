import {
    NEW_LENSES, gatherLensContext, LENS_LIMITS, LENS_SWITCHES, enabledNewLenses,
} from '../../../../src/review-core/lenses/index.js';
import { validateRepoSettings } from '../../../../src/utils/repoSettingsSchema.js';
import { REVIEW_QUALITY_DEFAULTS } from '../../../../src/utils/configPrecedence.js';
import { buildLensFinderPrompt } from '../../../../src/utils/finderLensPrompts.js';
import { scoreFindings, filterByRubric } from '../../../../src/review-core/rubricScorer.js';
import { createRubricContextFor } from '../../../../src/review-core/rubricContext.js';
import { parseRepoUrl } from '../../../../src/review-core/permalink.js';
import { MODEL_STATUS } from '../../../../src/review-core/modelPort.js';
import { PRIORITY } from '../../../../src/utils/callBudget.js';
import { normalizePipelineStatus } from '../../../../src/utils/pipelineStatus.js';
import { evaluateSkipRules } from '../../../../src/services/SkipRuleEngine.js';
import { readFilesAtRev } from '../repo/source.js';
import { CustomRulesService } from '../../../../src/services/CustomRulesService.js';
import { renderRepoRulesText } from '../../../../src/review-core/repoRulesText.js';

/**
 * The review-quality stages of `buildFindingsSection` (spec §1.3, MCP column):
 * the four new lenses, the rubric scorer and its threshold, permalinks, and the
 * host-supplied pipeline status. Kept out of findings.js so that file stays the
 * model pass and its trust labelling.
 */

const RULES_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'];
const MAX_RULE_DIRS = 10;
const LINKED_ISSUE_CHARS = 2000;
const REPO_CONFIG = '.repospector.yaml';

/**
 * Root and changed-directory CLAUDE.md / AGENTS.md, plus .repospector.yaml, at
 * the reviewed revision. No revision → none: reading the worktree would quote
 * rules from a different commit than the one under review.
 *
 * `.repospector.yaml` is parsed and validated exactly as the extension does
 * (CustomRulesService + repoSettingsSchema): its rule entries become the rules
 * text (the shared renderer, never the settings block), and its validated
 * `settings` come back as `repoConfig` for `resolveMcpQuality`.
 *
 * @returns {Promise<{rulesFiles: Array<{path: string, text: string}>,
 *   repoConfig: {settings: object, configWarnings: string[]}|null}>}
 */
export async function loadRulesFiles(repoPath, rev, diffFiles = []) {
    if (!repoPath || !rev) return { rulesFiles: [], repoConfig: null };
    const dirs = new Set(['']);
    for (const f of diffFiles) {
        const parts = String(f?.filename ?? '').split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const candidates = [...dirs].slice(0, MAX_RULE_DIRS + 1)
        .flatMap((d) => RULES_FILE_NAMES.map((n) => (d ? `${d}/${n}` : n)));
    candidates.push(REPO_CONFIG);
    const { files } = await readFilesAtRev(repoPath, rev, candidates);
    let repoConfig = null;
    const rulesFiles = [];
    for (const f of files) {
        if (f.path !== REPO_CONFIG) {
            rulesFiles.push({ path: f.path, text: f.content });
            continue;
        }
        const svc = new CustomRulesService();
        const parsed = svc.validateConfig(svc.parseYAML(f.content));
        if (!parsed) continue;
        repoConfig = { settings: parsed.settings, configWarnings: parsed.configWarnings };
        const text = renderRepoRulesText(parsed);
        if (text) rulesFiles.push({ path: f.path, text });
    }
    return { rulesFiles, repoConfig };
}

export function linkedIssueText(requirements) {
    return (Array.isArray(requirements) ? requirements : [])
        .map((r) => [r?.id, r?.title, r?.body].filter(Boolean).join(' — '))
        .filter(Boolean)
        .join('\n')
        .slice(0, LINKED_ISSUE_CHARS);
}

export function toLensCandidate(f, lensKey) {
    return {
        file: f?.file ?? f?.filePath ?? null,
        line: f?.line ?? null,
        severity: f?.severity ?? 'medium',
        title: f?.title ?? null,
        description: f?.description ?? null,
        evidence: f?.evidence ?? null,
        lens: lensKey,
        ...(lensKey === 'rulesCompliance'
            ? { category: 'conventions', quotedRule: f?.quotedRule ?? null }
            : {}),
        source: 'llm',
        assertionLevel: 'model-asserted',
        validationStatus: 'unvalidated',
    };
}

function lensMessages(lens, contextText, o) {
    const { system, user } = buildLensFinderPrompt(lens, {
        prTitle: o.prTitle || 'Unknown',
        diffText: o.hunks,
        prDescription: o.prDescription,
        linkedIssue: o.linkedIssue,
        // T5's own slot for gathered context, so it is rendered exactly once.
        lensContext: contextText,
    });
    const parts = Array.isArray(user) ? user.map((p) => p.text) : [String(user)];
    return [
        { role: 'system', content: system },
        { role: 'user', content: parts.join('\n\n') },
    ];
}

async function runOneLens(lens, o) {
    const skip = (reason) => ({ findings: [], report: { lens: lens.key, status: 'not-run', reason }, delegated: null });
    if (typeof lens.appliesTo === 'function' && !lens.appliesTo(o.diffFiles)) {
        return skip('no changed file this lens applies to');
    }
    if (!o.contextPort) return skip('no repository context was supplied to this review');

    let gathered;
    try {
        gathered = await gatherLensContext(lens, {
            files: o.diffFiles,
            contextPort: o.contextPort,
            rulesFiles: o.rulesFiles,
            baseSha: o.baseSha,
            headSha: o.headSha,
            limits: o.lensLimits ?? LENS_LIMITS,
        });
    } catch (e) {
        return skip(`gathering this lens's context failed: ${e?.message || 'unknown'}`);
    }
    if (gathered.status !== 'ok') return skip(gathered.reason);

    const res = await o.modelPort(lensMessages(lens, gathered.text, o), {
        stage: `lens:${lens.key}`,
        priority: PRIORITY.OPTIONAL,
    });
    if (res.status === MODEL_STATUS.DELEGATED) {
        return {
            findings: [],
            report: { lens: lens.key, status: 'delegated', requestId: res.request.id },
            // Compact on purpose: the diff is already in the bundle's `hunks`,
            // so the host needs the lens's question and its context, not a
            // second copy of the change per lens.
            delegated: {
                requestId: res.request.id,
                lens: lens.key,
                // `context` carries repository data and caller-supplied text.
                trust: 'untrusted',
                title: lens.title,
                instruction: lens.instruction,
                context: gathered.text,
            },
        };
    }
    if (res.status !== MODEL_STATUS.OK) return skip(res.reason);
    const parsed = o.parse(res.text);
    if (parsed === null) return skip('the model returned output that could not be parsed as findings');
    // The lens's own post-filter (rulesCompliance drops findings that quote no rule).
    const kept = typeof lens.accepts === 'function' ? parsed.filter(lens.accepts) : parsed;
    return {
        findings: kept.map((f) => toLensCandidate(f, lens.key)),
        report: { lens: lens.key, status: 'ok', findings: kept.length },
        delegated: null,
    };
}

/**
 * Run the four new lenses. Each resolves its context through the port first;
 * a lens whose context is unavailable is reported not-run with the reason.
 *
 * @returns {Promise<{findings: Array, lensReport: Array, delegated: Array}>}
 */
export async function runNewLenses(o) {
    const enabled = o.lenses ?? NEW_LENSES;
    // A lens the caller switched off is reported, never silently absent.
    const off = NEW_LENSES.filter((l) => !enabled.includes(l)).map((l) => ({
        lens: l.key, status: 'not-run', reason: `${LENS_SWITCHES[l.key]} is false`,
    }));
    const results = await Promise.all(enabled.map((lens) => runOneLens(lens, o)));
    return {
        findings: results.flatMap((r) => r.findings),
        lensReport: [...results.map((r) => r.report), ...off],
        delegated: results.map((r) => r.delegated).filter(Boolean),
    };
}

/**
 * The review-quality switches for one MCP call (spec §3.4). The `settings`
 * argument uses the same flat keys and the same validation as
 * `.repospector.yaml`. Layers, lowest first: shared defaults, the repo file's
 * validated settings, the call's `settings` — the call overrides the repo.
 *
 * @param {unknown} raw - `review_pr`'s `settings` argument
 * @param {{settings?: object, configWarnings?: string[]}|null} [repo] - from `loadRulesFiles`
 * @returns {{minRubricScore: number, lenses: Array, lensLimits: object, configWarnings: string[]}}
 */
export function resolveMcpQuality(raw, repo = null) {
    const { settings, warnings } = validateRepoSettings(raw);
    const cfg = { ...REVIEW_QUALITY_DEFAULTS, ...(repo?.settings ?? {}), ...settings };
    return {
        minRubricScore: cfg.minRubricScore,
        lenses: enabledNewLenses(cfg),
        lensLimits: { ...LENS_LIMITS, priorPrLimit: cfg.priorPrLimit },
        configWarnings: [...(repo?.configWarnings ?? []).map((w) => `${REPO_CONFIG}: ${w}`), ...warnings],
    };
}

/**
 * Score model-asserted findings and apply the threshold (spec §2.5).
 * `kept` = postable + not verified; not-verified findings are kept but flagged.
 */
export async function gateByRubric({ findings, modelPort, diffFiles = [], rulesFiles = [], minRubricScore }) {
    if (!findings.length) return { kept: [], dropped: [], notVerified: [], stats: null };
    const scored = await scoreFindings(findings, {
        modelPort,
        contextFor: createRubricContextFor({ files: diffFiles, rulesFiles }),
        rulesTexts: rulesFiles.map((r) => r.text),
        // Its own namespace: never confusable with the `rubric-<submission>-<i>`
        // ids `submit_review_findings` issues and accepts answers for.
        requestIdFor: (f, i) => `bundle-rubric-${i}`,
    });
    const gate = filterByRubric(scored.findings, { minRubricScore });
    return {
        kept: [...gate.postable, ...gate.notVerified],
        dropped: gate.dropped,
        notVerified: gate.notVerified,
        stats: scored.stats,
    };
}

/**
 * `https://<host>/<owner>/<repo>/pull/<n>` → a GitHub permalink target, parsed
 * locally. `parseRepoUrl` only knows configured GitHub Enterprise hosts, and
 * this URL is caller-supplied, so it must never register its host: the global
 * registry decides where `GITHUB_TOKEN` is sent. Used for permalinks only.
 */
function githubPullRef(url) {
    const m = String(url).match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+(?:[/?#]|$)/i);
    return m ? { platform: 'github', host: m[1].toLowerCase(), projectPath: `${m[2]}/${m[3]}` } : null;
}

/**
 * Where permalinks point: the host-supplied `pr_ref` first, else `pr_url`.
 * A permalink must pin a full commit, so anything short of 40 hex is refused.
 *
 * @returns {{target: {platform, host, projectPath, headSha}|null, reason: string|null}}
 */
export function permalinkTargetFrom({ prRef = null, prUrl = null, headSha = null } = {}) {
    const url = String(prRef?.url ?? prUrl ?? '');
    const repo = parseRepoUrl(url) ?? githubPullRef(url);
    if (!repo) {
        return { target: null, reason: 'pass pr_ref.url (the PR/MR URL) so findings can carry permalinks' };
    }
    const sha = prRef?.head_sha ?? headSha;
    if (!/^[0-9a-f]{40}$/i.test(String(sha ?? ''))) {
        return { target: null, reason: 'pass pr_ref.head_sha (the full 40-character head SHA) so permalinks pin a commit' };
    }
    return { target: { ...repo, headSha: sha }, reason: null };
}

/** The `pipeline` bundle section: host-supplied status through the shared skip rules. */
export function renderPipelineSection(args = {}) {
    if (args.pipeline_status == null) {
        return JSON.stringify({
            status: 'not-run',
            reason: 'pass `pipeline_status` (success | failed | running | none), read from the PR '
                + 'check runs or MR pipeline with your GitHub/GitLab MCP',
        }, null, 2);
    }
    const status = normalizePipelineStatus(args.pipeline_status);
    const deferred = evaluateSkipRules({ pipelineStatus: status }).reason === 'failing_pipeline';
    return JSON.stringify({
        status,
        deferred,
        trust: 'caller-supplied',
        note: deferred
            ? 'DEFER: the pipeline is failing. Findings may be symptoms of the broken build; '
                + 'fix the pipeline and review again before acting on this review.'
            : `pipeline status: ${status}`,
    }, null, 2);
}

export default {
    loadRulesFiles, runNewLenses, gateByRubric, permalinkTargetFrom, renderPipelineSection,
    linkedIssueText, toLensCandidate,
};
