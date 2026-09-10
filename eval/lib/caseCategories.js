/**
 * caseCategories — what the corpus does and does not cover. P1-7.
 *
 * A benchmark's headline number is a statement about the cases in it. The
 * current corpus is public pull requests with human comments, which means every
 * figure it produces describes "PRs that attracted review comments" — and says
 * nothing about the shapes that break this reviewer hardest: a clean PR (where
 * every finding is a cost), a deletion-only change (P1-1), a change whose
 * provider output is malformed (P0-4), a repository the index never finished.
 *
 * Rather than silently averaging over whatever happens to be in the file, the
 * report states which categories are represented and which are ABSENT. An
 * absent category is not a passed one.
 */

export const CATEGORIES = Object.freeze({
    CLEAN: 'clean',
    MULTI_FILE: 'multi-file',
    DELETIONS: 'deletions',
    MIGRATION: 'migration',
    CONCURRENCY: 'concurrency',
    PERMISSIONS: 'permissions',
    MALFORMED_PROVIDER: 'malformed-provider-output',
    INCOMPLETE_REPO: 'incomplete-repository',
});

/** Why each shape is worth its own bucket, rendered into the report. */
export const CATEGORY_WHY = Object.freeze({
    [CATEGORIES.CLEAN]: 'no reference defect — every finding is a false positive',
    [CATEGORIES.MULTI_FILE]: 'a defect whose evidence spans files, which patch-only review cannot see',
    [CATEGORIES.DELETIONS]: 'removals as behaviour changes (P1-1)',
    [CATEGORIES.MIGRATION]: 'schema or data migrations, where ordering and rollback matter',
    [CATEGORIES.CONCURRENCY]: 'races and interleavings, which static reasoning most often gets wrong',
    [CATEGORIES.PERMISSIONS]: 'authorization changes, the highest-consequence class',
    [CATEGORIES.MALFORMED_PROVIDER]: 'truncated or non-JSON provider output (P0-1)',
    [CATEGORIES.INCOMPLETE_REPO]: 'an index or diff that could not be fully read (P0-4)',
});

/** An explicit `categories` array wins; otherwise infer what we safely can. */
export function categoriesOf(kase) {
    if (Array.isArray(kase?.categories) && kase.categories.length) {
        return [...new Set(kase.categories.map(String))];
    }

    const out = new Set();
    const files = kase?.prData?.files ?? kase?.files ?? [];
    const refs = (kase?.humanComments ?? []).filter((c) => c?.substantive !== false);

    if (refs.length === 0) out.add(CATEGORIES.CLEAN);
    if (files.length >= 5) out.add(CATEGORIES.MULTI_FILE);

    const patches = files.map((f) => String(f?.patch ?? f?.diff ?? ''));
    const onlyDeletes = patches.length > 0 && patches.every((p) => (
        p && !p.split('\n').some((l) => l.startsWith('+') && !l.startsWith('+++'))
    ));
    if (onlyDeletes) out.add(CATEGORIES.DELETIONS);

    const names = files.map((f) => String(f?.filename ?? '')).join(' ');
    if (/migration|migrate|schema|alembic|flyway|liquibase/i.test(names)) out.add(CATEGORIES.MIGRATION);
    if (/auth|permission|acl|rbac|policy|role/i.test(names)) out.add(CATEGORIES.PERMISSIONS);
    if (/\b(mutex|lock|goroutine|async|await|thread|concurren)/i.test(patches.join(' '))) {
        out.add(CATEGORIES.CONCURRENCY);
    }

    return [...out];
}

/**
 * @returns {{present: object, missing: string[], total: number}}
 */
export function coverageOf(cases = []) {
    const present = {};
    for (const kase of cases) {
        for (const category of categoriesOf(kase)) {
            present[category] = (present[category] ?? 0) + 1;
        }
    }
    const missing = Object.values(CATEGORIES).filter((c) => !present[c]);
    return { present, missing, total: cases.length };
}

export function formatCoverage(coverage) {
    if (!coverage) return '';
    const lines = ['', 'Corpus coverage by case shape:'];
    for (const category of Object.values(CATEGORIES)) {
        const n = coverage.present[category] ?? 0;
        lines.push(
            `  ${category.padEnd(26)}${n ? String(n).padStart(3) : '  —'}  ${CATEGORY_WHY[category]}`
        );
    }
    if (coverage.missing.length) {
        lines.push(
            '',
            `${coverage.missing.length} shape(s) are ABSENT from this corpus. The figures above say`,
            'nothing about them; an unmeasured shape is not a passing one.',
        );
    }
    return lines.join('\n');
}

export default { CATEGORIES, CATEGORY_WHY, categoriesOf, coverageOf, formatCoverage };
