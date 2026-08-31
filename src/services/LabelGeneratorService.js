/**
 * LabelGeneratorService — labels for a PR, derived from what the diff actually is.
 *
 * pr-agent's `/generate_labels` asks a model to pick labels from descriptions the
 * team writes in config. This does the same job DETERMINISTICALLY, because almost
 * every label a reviewer wants is a fact about the diff rather than a judgement
 * about it: whether it touches a migration, whether it ships tests, whether it
 * moves a lockfile, how big it is, whether the security scanners fired.
 *
 * Deterministic matters more here than it sounds:
 *
 *   - It is free. Labels are the cheapest useful output in a PR UI and should not
 *     cost a model call, least of all on a user's own key.
 *   - It is reproducible. A label that changes between two runs of the same
 *     commit is a label nobody can filter a board on.
 *   - It is auditable. `reasons` says which files produced each label, so a
 *     wrong one is a rule to fix rather than a prompt to re-roll.
 *
 * Teams that want semantic labels of their own get them through
 * `.repospector.yaml` with a `pattern` per label — a regex over changed paths
 * and added lines. That covers "touches billing", "affects the public API" and
 * the rest of what custom labels are actually used for, without a round trip.
 *
 * Nothing here writes to the host; `PullRequestService.setLabels` does that, and
 * only when the caller asks.
 */

/** Size buckets, by total changed lines. Chosen to match how teams triage. */
const SIZE_BUCKETS = Object.freeze([
    { label: 'size/XS', maxLoc: 10 },
    { label: 'size/S', maxLoc: 50 },
    { label: 'size/M', maxLoc: 200 },
    { label: 'size/L', maxLoc: 600 },
    { label: 'size/XL', maxLoc: Infinity },
]);

const TEST_PATH = /(^|\/)(tests?|spec|__tests__|e2e)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|Test\.java$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|alembic|liquibase|flyway)\/|\.sql$/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum)$/i;
const MANIFEST = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|Cargo\.toml|Gemfile)$/i;
const CI_PATH = /(^|\/)(\.github\/workflows|\.gitlab-ci\.yml|Jenkinsfile|\.circleci|azure-pipelines\.yml)/i;
const INFRA_PATH = /(^|\/)(terraform|helm|k8s|kubernetes|charts)\/|\.(tf|tfvars)$|(^|\/)Dockerfile|docker-compose\.ya?ml$/i;
const DOCS_ONLY = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
const CONFIG_PATH = /\.(ya?ml|toml|ini|env|properties)$|(^|\/)config\//i;

/** Public-API surface: a change here can break a consumer outside the repo. */
const API_PATH = /(^|\/)(api|openapi|proto|graphql|schema)\/|\.(proto|graphql|gql)$|openapi\.(ya?ml|json)$/i;

export class LabelGeneratorService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.pullRequestService] - only needed to APPLY labels
     */
    constructor({ pullRequestService = null } = {}) {
        this.pullRequestService = pullRequestService;
    }

    /**
     * Derive labels for a PR.
     *
     * @param {Object} args
     * @param {Object} args.prData - normalized PR data (.files, .title)
     * @param {Array}  [args.findings] - verified findings, for risk labels
     * @param {Array}  [args.customLabels] - [{name, pattern, flags?, target?}] from config
     * @param {Object} [args.options]
     * @returns {{labels:string[], reasons:Object<string,string[]>, skipped:Array}}
     */
    generate({ prData, findings = [], customLabels = [], options = {} } = {}) {
        const files = prData?.files || [];
        const reasons = {};
        const skipped = [];

        const add = (label, why) => {
            if (!label) return;
            if (!reasons[label]) reasons[label] = [];
            if (why && !reasons[label].includes(why)) reasons[label].push(why);
        };

        const paths = files.map(f => f.filename).filter(Boolean);
        const loc = files.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);

        // ── Size ──
        if (files.length) {
            const bucket = SIZE_BUCKETS.find(b => loc <= b.maxLoc);
            add(bucket.label, `${loc} changed line(s) across ${files.length} file(s)`);
        }

        // ── What the diff touches ──
        const matched = (re) => paths.filter(p => re.test(p));

        const tests = matched(TEST_PATH);
        const production = paths.filter(p => !TEST_PATH.test(p) && !DOCS_ONLY.test(p));

        if (tests.length) add('tests', `${tests.length} test file(s)`);

        // "no tests" is the label reviewers actually want, and it is only
        // meaningful when production code moved: a docs-only PR has no business
        // being flagged for missing tests.
        if (production.length && !tests.length) {
            add('needs-tests', `${production.length} production file(s) changed, no test file touched`);
        }

        for (const [re, label, what] of [
            [MIGRATION_PATH, 'database', 'migration or SQL file'],
            [LOCKFILE, 'dependencies', 'lockfile'],
            [MANIFEST, 'dependencies', 'dependency manifest'],
            [CI_PATH, 'ci', 'CI configuration'],
            [INFRA_PATH, 'infrastructure', 'infrastructure definition'],
            [API_PATH, 'api', 'API or schema definition'],
        ]) {
            const hits = matched(re);
            if (hits.length) add(label, `${what}: ${hits.slice(0, 3).join(', ')}`);
        }

        // Docs-only and config-only are exclusive claims about the WHOLE diff, so
        // they are computed over every path rather than by matching any one.
        if (paths.length && paths.every(p => DOCS_ONLY.test(p))) {
            add('documentation', 'every changed file is documentation');
        } else if (paths.length && paths.every(p => CONFIG_PATH.test(p) || DOCS_ONLY.test(p))) {
            add('configuration', 'only configuration and docs changed');
        }

        // ── Risk, from findings the pipeline actually verified ──
        // Severity alone is model-assigned and inflated; these read the CATEGORY
        // and the blocking flag, which the deterministic gates have already
        // filtered. See utils/findingsFlatten.js.
        const blocking = findings.filter(f => f.blocking || f.severity === 'critical');
        if (blocking.length) {
            add('review/blocking', `${blocking.length} blocking finding(s)`);
        }
        const security = findings.filter(f => f.type === 'security' || f.category === 'security' || f.cwe);
        if (security.length) {
            add('security', `${security.length} security finding(s)`);
        }

        // ── Migration risk: a schema change without a rollback path ──
        // Cheap to detect, expensive to miss.
        if (matched(MIGRATION_PATH).length) {
            const hasDown = files.some(f => MIGRATION_PATH.test(f.filename || '')
                && /\b(down|rollback|revert)\b/i.test(f.patch || ''));
            if (!hasDown) add('migration/no-rollback', 'migration changed with no visible down/rollback');
        }

        // ── Custom labels from .repospector.yaml ──
        for (const custom of customLabels) {
            if (!custom?.name || !custom?.pattern) {
                skipped.push({
                    label: custom?.name || '(unnamed)',
                    reason: custom?.name
                        ? 'no `pattern` — describe the label as a regex over paths or added lines'
                        : 'entry has no `name`',
                });
                continue;
            }

            let re;
            try {
                // Anchored to the config author's intent, not ours: they write the
                // pattern, we do not wrap it. An invalid regex is reported rather
                // than silently dropping the label.
                re = new RegExp(custom.pattern, custom.flags || 'i');
            } catch (e) {
                skipped.push({ label: custom.name, reason: `invalid pattern: ${e.message}` });
                continue;
            }

            const target = custom.target === 'content' ? 'content' : 'path';
            let hit = null;

            for (const f of files) {
                if (target === 'path') {
                    if (re.test(f.filename || '')) { hit = f.filename; break; }
                } else {
                    const added = String(f.patch || '')
                        .split('\n')
                        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
                        .join('\n');
                    if (re.test(added)) { hit = f.filename; break; }
                }
            }

            if (hit) add(custom.name, `custom rule matched ${target} in ${hit}`);
        }

        const labels = Object.keys(reasons).sort();
        const max = Number.isFinite(options.maxLabels) ? options.maxLabels : 10;

        return {
            labels: labels.slice(0, max),
            reasons,
            skipped,
        };
    }

    /**
     * Apply labels to the PR, keeping the ones a human already put there.
     *
     * ADDITIVE on purpose. Replacing the set would silently delete a triager's
     * `priority/p1` or a release manager's `cherry-pick` the first time a review
     * ran, and a tool that quietly undoes human curation gets turned off.
     *
     * @param {string} prUrl
     * @param {string[]} labels
     * @param {Object} [opts]
     * @param {string[]} [opts.existing] - current labels, if already known
     * @returns {Promise<{applied:string[], alreadyPresent:string[]}>}
     */
    async apply(prUrl, labels = [], { existing = null } = {}) {
        if (!this.pullRequestService?.setLabels) {
            throw new Error('Applying labels needs a PullRequestService with setLabels()');
        }
        if (!labels.length) return { applied: [], alreadyPresent: [] };

        let current = existing;
        if (!Array.isArray(current)) {
            const pr = await this.pullRequestService.fetchPullRequest(prUrl);
            current = (pr?.labels || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
        }

        const alreadyPresent = labels.filter(l => current.includes(l));
        const toAdd = labels.filter(l => !current.includes(l));
        if (!toAdd.length) return { applied: [], alreadyPresent };

        await this.pullRequestService.setLabels(prUrl, [...current, ...toAdd]);
        return { applied: toAdd, alreadyPresent };
    }
}

export default LabelGeneratorService;
