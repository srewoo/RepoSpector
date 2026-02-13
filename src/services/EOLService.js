/**
 * End-of-Life Detection Service for RepoSpector
 *
 * Uses the endoflife.date API to detect EOL runtimes and frameworks.
 */

export class EOLService {
    constructor(options = {}) {
        this.baseUrl = 'https://endoflife.date/api';
        this.cacheTTL = options.cacheTTL || 604800000; // 7 days
        this.cache = new Map();

        // Map from package/config names to endoflife.date product names
        this.productMappings = {
            // Runtimes
            'node': 'nodejs',
            'nodejs': 'nodejs',
            'python': 'python',
            'ruby': 'ruby',
            'java': 'java',
            'go': 'go',
            'dotnet': 'dotnet',
            'php': 'php',
            // Frameworks
            'angular': 'angular',
            '@angular/core': 'angular',
            'react': 'react',
            'vue': 'vue',
            'django': 'django',
            'rails': 'ruby-on-rails',
            'spring-boot': 'spring-boot',
            'next': 'nextjs',
            'nuxt': 'nuxt',
            'laravel': 'laravel',
            'symfony': 'symfony',
            'express': 'express',
            'jquery': 'jquery',
            'bootstrap': 'bootstrap',
            'typescript': 'typescript',
            'ember': 'emberjs'
        };

        // Config file to runtime mapping
        this.runtimeFiles = {
            '.nvmrc': 'nodejs',
            '.node-version': 'nodejs',
            '.python-version': 'python',
            '.ruby-version': 'ruby',
            '.java-version': 'java',
            '.go-version': 'go',
            '.tool-versions': null // multi-runtime, parse content
        };
    }

    /**
     * Check EOL status for a product/version
     * @returns {Object|null} EOL data or null if not found/not EOL
     */
    async checkProduct(product, version) {
        if (!product || !version) return null;

        const productName = this.productMappings[product.toLowerCase()] || product.toLowerCase();
        const cycle = this.extractMajorMinor(version);

        if (!cycle) return null;

        const cacheKey = `${productName}:${cycle}`;
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.queriedAt < this.cacheTTL) {
            return cached.data;
        }

        try {
            const response = await fetch(`${this.baseUrl}/${productName}/${cycle}.json`);

            if (!response.ok) {
                if (response.status === 404) {
                    // Try with just major version
                    const major = cycle.split('.')[0];
                    if (major !== cycle) {
                        return this.checkProduct(product, major);
                    }
                }
                return null;
            }

            const data = await response.json();
            this.cache.set(cacheKey, { data, queriedAt: Date.now() });
            return data;
        } catch (error) {
            console.warn(`EOL check failed for ${productName}/${cycle}:`, error.message);
            return null;
        }
    }

    /**
     * Check all dependencies and config files for EOL status
     * @param {Array} dependencies - Parsed dependencies
     * @param {Array} files - PR files with content/filenames
     * @returns {Array} EOL findings
     */
    async checkDependencies(dependencies, files) {
        const findings = [];
        const checked = new Set();

        // Check runtime versions from config files
        for (const file of (files || [])) {
            const runtimeFindings = await this.checkRuntimeFile(file);
            findings.push(...runtimeFindings);
        }

        // Check package.json engines
        for (const file of (files || [])) {
            if (/package\.json$/i.test(file.filename || file.path || '')) {
                const engineFindings = await this.checkPackageJsonEngines(file.content || file.patch);
                findings.push(...engineFindings);
            }
        }

        // Check framework dependencies
        for (const dep of (dependencies || [])) {
            const product = this.productMappings[dep.name?.toLowerCase()];
            if (product && !checked.has(product)) {
                checked.add(product);
                const version = (dep.version || '').replace(/^[~^>=<]+/, '');
                const eolData = await this.checkProduct(dep.name, version);
                if (eolData) {
                    const finding = this.createFinding(dep.name, version, eolData, dep.filePath || 'package.json');
                    if (finding) findings.push(finding);
                }
            }
        }

        return findings;
    }

    /**
     * Check runtime version files (.nvmrc, .python-version, etc.)
     */
    async checkRuntimeFile(file) {
        const filename = file.filename || file.path || '';
        const basename = filename.split('/').pop();
        const findings = [];

        if (this.runtimeFiles[basename] === undefined) return findings;

        const content = file.content || '';
        if (!content.trim()) return findings;

        if (basename === '.tool-versions') {
            // Parse .tool-versions (multiple runtimes)
            const lines = content.split('\n');
            for (const line of lines) {
                const match = line.trim().match(/^(\S+)\s+(\S+)/);
                if (match) {
                    const [, tool, version] = match;
                    const product = this.productMappings[tool];
                    if (product) {
                        const eolData = await this.checkProduct(tool, version);
                        if (eolData) {
                            const finding = this.createFinding(tool, version, eolData, filename);
                            if (finding) findings.push(finding);
                        }
                    }
                }
            }
        } else {
            const runtime = this.runtimeFiles[basename];
            const version = content.trim().replace(/^v/i, '');
            if (runtime && version) {
                const eolData = await this.checkProduct(runtime, version);
                if (eolData) {
                    const finding = this.createFinding(runtime, version, eolData, filename);
                    if (finding) findings.push(finding);
                }
            }
        }

        return findings;
    }

    /**
     * Check package.json engines field
     */
    async checkPackageJsonEngines(content) {
        const findings = [];
        try {
            const pkg = typeof content === 'string' ? JSON.parse(content) : content;
            if (!pkg?.engines) return findings;

            for (const [engine, versionRange] of Object.entries(pkg.engines)) {
                const product = this.productMappings[engine];
                if (!product) continue;

                const version = versionRange.replace(/^[>=<^~\s]+/, '').split(/[|\s]/)[0];
                if (!version) continue;

                const eolData = await this.checkProduct(engine, version);
                if (eolData) {
                    const finding = this.createFinding(engine, version, eolData, 'package.json');
                    if (finding) findings.push(finding);
                }
            }
        } catch (e) {
            // Content might be a patch, not full JSON - skip
        }
        return findings;
    }

    /**
     * Create a finding from EOL data
     */
    createFinding(product, version, eolData, filePath) {
        const now = new Date();
        const eolDate = eolData.eol;

        // eol can be boolean (true/false) or a date string
        let isEOL = false;
        let eolDateStr = null;
        let monthsUntilEOL = null;

        if (typeof eolDate === 'boolean') {
            isEOL = eolDate;
        } else if (typeof eolDate === 'string') {
            const eolParsed = new Date(eolDate);
            isEOL = eolParsed <= now;
            eolDateStr = eolDate;
            monthsUntilEOL = Math.round((eolParsed - now) / (30 * 24 * 60 * 60 * 1000));
        }

        // Determine severity
        let severity;
        if (isEOL) {
            severity = 'high';
        } else if (monthsUntilEOL !== null && monthsUntilEOL <= 6) {
            severity = 'medium';
        } else if (monthsUntilEOL !== null && monthsUntilEOL <= 12) {
            severity = 'low';
        } else {
            return null; // Not EOL and not approaching EOL
        }

        const productLabel = this.productMappings[product.toLowerCase()] || product;
        const latestVersion = eolData.latest || eolData.latestReleaseDate || 'latest';

        let message;
        if (isEOL) {
            message = `${productLabel} ${version} has reached End of Life${eolDateStr ? ` on ${eolDateStr}` : ''}. Upgrade to a supported version.`;
        } else {
            message = `${productLabel} ${version} will reach End of Life on ${eolDateStr} (${monthsUntilEOL} months). Plan an upgrade.`;
        }

        return {
            ruleId: 'eol-runtime',
            severity,
            category: 'A06:2021-Vulnerable Components',
            message,
            filePath,
            tool: 'eol',
            confidence: isEOL ? 0.95 : 0.8,
            remediation: `Upgrade ${productLabel} to ${latestVersion} or a currently supported version. See https://endoflife.date/${productLabel} for details.`,
            product: productLabel,
            version,
            eolDate: eolDateStr,
            isEOL,
            monthsUntilEOL
        };
    }

    /**
     * Extract major.minor from version string
     */
    extractMajorMinor(version) {
        if (!version) return null;
        const cleaned = version.replace(/^[v=\s]+/, '').replace(/[~^>=<]+/g, '');
        const match = cleaned.match(/^(\d+)(?:\.(\d+))?/);
        if (!match) return null;
        return match[2] ? `${match[1]}.${match[2]}` : match[1];
    }

    /**
     * Persist cache to chrome.storage.local
     */
    async persistCache() {
        try {
            const cacheData = {};
            for (const [key, value] of this.cache.entries()) {
                if (Date.now() - value.queriedAt < this.cacheTTL) {
                    cacheData[key] = value;
                }
            }
            await chrome.storage.local.set({ eol_cache: cacheData });
        } catch (e) {
            console.warn('Failed to persist EOL cache:', e.message);
        }
    }

    /**
     * Load cache from chrome.storage.local
     */
    async loadCache() {
        try {
            const result = await chrome.storage.local.get('eol_cache');
            if (result.eol_cache) {
                for (const [key, value] of Object.entries(result.eol_cache)) {
                    if (Date.now() - value.queriedAt < this.cacheTTL) {
                        this.cache.set(key, value);
                    }
                }
                console.log(`EOL cache loaded: ${this.cache.size} entries`);
            }
        } catch (e) {
            console.warn('Failed to load EOL cache:', e.message);
        }
    }
}

export default EOLService;
