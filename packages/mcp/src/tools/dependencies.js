/**
 * The dependency section: which packages this change touches, and what OSV
 * says about them.
 *
 * Two false claims are designed out here.
 *
 * The first was this section's own: it built an `OSVService`, loaded its cache,
 * parsed the manifest, never queried anything, and reported "OSV lookups are
 * cached on disk beside the index" — which reads as "checked". Nothing was.
 *
 * The second is inside `queryBatch`, which catches its own network errors
 * ("Don't fail - results will just not have these entries") and returns a Map
 * missing those packages. An unreachable OSV is therefore indistinguishable
 * from a clean result unless the caller compares what it asked for against what
 * came back — so that comparison is the core of this function, and anything
 * unanswered is reported `unchecked` rather than folded into "no
 * vulnerabilities".
 */

const DEFAULT_TIMEOUT_MS = 15000;

/** Reject rather than hang: this section is the only one that reaches a network. */
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]);
}

/**
 * @param {{manifests: Array<{filename: string}>, files: Array<{path: string, content: string}>,
 *          analyzer: object, osv: object, timeoutMs?: number}} input
 */
export async function buildDependencySection({
    manifests = [], files = [], analyzer, osv, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    if (manifests.length === 0) {
        return {
            applicable: false,
            note: 'not applicable: this change touches no dependency manifest, so no '
                + 'vulnerability lookup was performed',
        };
    }

    // Parse every touched manifest, keeping each package's ecosystem with it —
    // the ecosystem comes from the manifest TYPE, not from the package, so it
    // cannot be recovered later.
    const packages = [];
    const perFile = [];
    let unmappedEcosystem = null;
    for (const file of files) {
        const parsed = analyzer.analyze(file.content, { filePath: file.path });
        const ecosystem = osv.mapEcosystem(parsed?.fileType);
        perFile.push({
            path: file.path,
            fileType: parsed?.fileType ?? null,
            dependencies: (parsed?.dependencies || []).length,
            findings: parsed?.findings ?? [],
        });
        if (!ecosystem) {
            unmappedEcosystem = parsed?.fileType ?? 'unknown';
            continue;
        }
        for (const dep of parsed?.dependencies || []) {
            packages.push({ name: dep.name, version: dep.version, ecosystem });
        }
    }

    const base = {
        applicable: true,
        manifests: manifests.map((m) => m.filename),
        perFile,
        packagesChecked: 0,
    };

    if (packages.length === 0) {
        return {
            ...base,
            vulnerabilities: null,
            lookup: {
                performed: false,
                reason: unmappedEcosystem
                    ? `no OSV ecosystem is mapped for manifest type '${unmappedEcosystem}', `
                        + 'so its packages cannot be queried'
                    : 'no parsable dependencies in the touched manifests, so there was '
                        + 'nothing to query',
            },
            note: 'no package versions could be read from this change, so nothing was checked',
        };
    }

    let results;
    try {
        results = await withTimeout(
            Promise.resolve(osv.queryBatch(packages)),
            timeoutMs,
            'OSV lookup',
        );
    } catch (error) {
        return {
            ...base,
            vulnerabilities: null,
            lookup: { performed: false, reason: `OSV lookup failed: ${error.message}` },
            note: `OSV could not be reached, so these ${packages.length} package(s) are `
                + 'UNCHECKED — this is not a clean result',
        };
    }

    // Ask-versus-answer. A package absent from the Map was not answered for,
    // whatever the reason, and must not count as clean.
    const answered = [];
    const unanswered = [];
    const vulnerabilities = [];
    for (const pkg of packages) {
        const key = osv.getCacheKey(pkg.name, pkg.version, pkg.ecosystem);
        if (!results?.has?.(key)) {
            unanswered.push(`${pkg.name}@${pkg.version ?? 'unknown'}`);
            continue;
        }
        answered.push(pkg);
        const vulns = results.get(key) || [];
        if (vulns.length > 0) {
            vulnerabilities.push({
                package: pkg.name,
                version: pkg.version ?? null,
                ecosystem: pkg.ecosystem,
                vulnerabilities: vulns,
            });
        }
    }

    const notes = [];
    if (vulnerabilities.length > 0) {
        notes.push(`${vulnerabilities.length} package(s) with known advisories`);
    } else if (answered.length > 0) {
        notes.push(`no known advisories for the ${answered.length} package(s) OSV answered for`);
    }
    if (unanswered.length > 0) {
        notes.push(`${unanswered.length} package(s) UNCHECKED — OSV returned no answer for them, `
            + 'which is not the same as clean');
    }

    return {
        ...base,
        packagesChecked: answered.length,
        packagesUnchecked: unanswered.length,
        ...(unanswered.length > 0 ? { uncheckedPackages: unanswered.slice(0, 25) } : {}),
        vulnerabilities,
        lookup: {
            performed: answered.length > 0,
            reason: answered.length > 0
                ? `queried OSV for ${packages.length} package(s); ${answered.length} answered`
                : 'OSV answered for none of the queried packages',
        },
        note: notes.join('; '),
    };
}

export default { buildDependencySection };
