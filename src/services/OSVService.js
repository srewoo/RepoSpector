/**
 * OSV.dev Service for RepoSpector
 *
 * Queries the Open Source Vulnerability database for real-time
 * vulnerability data. Falls back gracefully when offline.
 */

export class OSVService {
    constructor(options = {}) {
        this.baseUrl = 'https://api.osv.dev/v1';
        this.cacheTTL = options.cacheTTL || 86400000; // 24 hours
        this.cache = new Map();
        this.ecosystemMap = {
            npm: 'npm',
            pip: 'PyPI',
            pipenv: 'PyPI',
            poetry: 'PyPI',
            gemfile: 'RubyGems',
            cargo: 'crates.io',
            go: 'Go',
            maven: 'Maven',
            gradle: 'Maven',
            composer: 'Packagist',
            nuget: 'NuGet'
        };
    }

    /**
     * Map file type to OSV ecosystem
     */
    mapEcosystem(fileType) {
        return this.ecosystemMap[fileType] || null;
    }

    /**
     * Query vulnerabilities for a batch of packages
     * @param {Array} packages - [{name, version, ecosystem}]
     * @returns {Map} packageKey -> vulnerabilities array
     */
    async queryBatch(packages) {
        if (!packages || packages.length === 0) return new Map();

        const results = new Map();
        const uncached = [];

        // Check cache first
        for (const pkg of packages) {
            const key = this.getCacheKey(pkg.name, pkg.version, pkg.ecosystem);
            const cached = this.cache.get(key);
            if (cached && Date.now() - cached.queriedAt < this.cacheTTL) {
                results.set(key, cached.vulns);
            } else {
                uncached.push(pkg);
            }
        }

        if (uncached.length === 0) return results;

        // Batch query uncached packages (OSV supports up to 1000 per batch)
        const batchSize = 100;
        for (let i = 0; i < uncached.length; i += batchSize) {
            const batch = uncached.slice(i, i + batchSize);
            const queries = batch.map(pkg => ({
                package: { name: pkg.name, ecosystem: pkg.ecosystem },
                version: pkg.version
            }));

            try {
                const response = await fetch(`${this.baseUrl}/querybatch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ queries })
                });

                if (!response.ok) {
                    console.warn(`OSV batch query failed: ${response.status}`);
                    continue;
                }

                const data = await response.json();
                const batchResults = data.results || [];

                for (let j = 0; j < batch.length; j++) {
                    const pkg = batch[j];
                    const key = this.getCacheKey(pkg.name, pkg.version, pkg.ecosystem);
                    const vulns = batchResults[j]?.vulns || [];
                    const parsed = this.parseVulnerabilities(vulns, pkg);

                    results.set(key, parsed);
                    this.cache.set(key, { vulns: parsed, queriedAt: Date.now() });
                }
            } catch (error) {
                console.warn('OSV batch query error:', error.message);
                // Don't fail - results will just not have these entries
            }
        }

        return results;
    }

    /**
     * Query vulnerabilities for a single package
     */
    async queryPackage(name, version, ecosystem) {
        const key = this.getCacheKey(name, version, ecosystem);
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.queriedAt < this.cacheTTL) {
            return cached.vulns;
        }

        try {
            const response = await fetch(`${this.baseUrl}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    package: { name, ecosystem },
                    version
                })
            });

            if (!response.ok) {
                console.warn(`OSV query failed for ${name}: ${response.status}`);
                return [];
            }

            const data = await response.json();
            const parsed = this.parseVulnerabilities(data.vulns || [], { name, version, ecosystem });

            this.cache.set(key, { vulns: parsed, queriedAt: Date.now() });
            return parsed;
        } catch (error) {
            console.warn(`OSV query error for ${name}:`, error.message);
            return [];
        }
    }

    /**
     * Parse OSV vulnerability response into finding format
     */
    parseVulnerabilities(vulns, pkg) {
        if (!vulns || vulns.length === 0) return [];

        return vulns.map(vuln => {
            const cve = (vuln.aliases || []).find(a => a.startsWith('CVE-')) || vuln.id;
            const severity = this.extractSeverity(vuln);
            const summary = vuln.summary || vuln.details?.substring(0, 200) || 'No description available';

            return {
                id: vuln.id,
                cve,
                severity,
                summary,
                packageName: pkg.name,
                packageVersion: pkg.version,
                ecosystem: pkg.ecosystem,
                aliases: vuln.aliases || [],
                published: vuln.published,
                modified: vuln.modified,
                references: (vuln.references || []).slice(0, 5).map(r => ({
                    type: r.type,
                    url: r.url
                })),
                affectedRanges: this.extractAffectedRanges(vuln),
                fixedVersions: this.extractFixedVersions(vuln)
            };
        });
    }

    /**
     * Extract severity from OSV vulnerability
     */
    extractSeverity(vuln) {
        // Try CVSS score first
        if (vuln.severity && vuln.severity.length > 0) {
            for (const sev of vuln.severity) {
                if (sev.score) {
                    const score = parseFloat(sev.score);
                    if (score >= 9.0) return 'critical';
                    if (score >= 7.0) return 'high';
                    if (score >= 4.0) return 'medium';
                    return 'low';
                }
                // Try to parse CVSS vector for score
                if (sev.type === 'CVSS_V3' && sev.score) {
                    return this.cvssToSeverity(parseFloat(sev.score));
                }
            }
        }

        // Try database_specific severity
        if (vuln.database_specific?.severity) {
            const sev = vuln.database_specific.severity.toLowerCase();
            if (['critical', 'high', 'medium', 'low'].includes(sev)) return sev;
        }

        // Default to medium for unknown severity
        return 'medium';
    }

    cvssToSeverity(score) {
        if (score >= 9.0) return 'critical';
        if (score >= 7.0) return 'high';
        if (score >= 4.0) return 'medium';
        return 'low';
    }

    /**
     * Extract affected version ranges
     */
    extractAffectedRanges(vuln) {
        if (!vuln.affected) return [];
        return vuln.affected.flatMap(a =>
            (a.ranges || []).map(r => ({
                type: r.type,
                events: r.events || []
            }))
        ).slice(0, 3);
    }

    /**
     * Extract fixed versions
     */
    extractFixedVersions(vuln) {
        if (!vuln.affected) return [];
        const fixed = [];
        for (const affected of vuln.affected) {
            for (const range of (affected.ranges || [])) {
                for (const event of (range.events || [])) {
                    if (event.fixed) fixed.push(event.fixed);
                }
            }
        }
        return [...new Set(fixed)];
    }

    getCacheKey(name, version, ecosystem) {
        return `${ecosystem}:${name}:${version || 'unknown'}`;
    }

    /**
     * Persist cache to chrome.storage.local
     */
    async persistCache() {
        try {
            const cacheData = {};
            for (const [key, value] of this.cache.entries()) {
                // Only persist entries less than TTL old
                if (Date.now() - value.queriedAt < this.cacheTTL) {
                    cacheData[key] = value;
                }
            }
            await chrome.storage.local.set({ osv_vuln_cache: cacheData });
        } catch (e) {
            console.warn('Failed to persist OSV cache:', e.message);
        }
    }

    /**
     * Load cache from chrome.storage.local
     */
    async loadCache() {
        try {
            const result = await chrome.storage.local.get('osv_vuln_cache');
            if (result.osv_vuln_cache) {
                for (const [key, value] of Object.entries(result.osv_vuln_cache)) {
                    if (Date.now() - value.queriedAt < this.cacheTTL) {
                        this.cache.set(key, value);
                    }
                }
                console.log(`OSV cache loaded: ${this.cache.size} entries`);
            }
        } catch (e) {
            console.warn('Failed to load OSV cache:', e.message);
        }
    }
}

export default OSVService;
