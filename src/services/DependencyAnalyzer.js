/**
 * Dependency Analyzer for RepoSpector
 *
 * Parses package.json, requirements.txt, and other dependency files
 * to detect known vulnerable packages.
 */

import {
    VULNERABLE_PACKAGES,
    VULNERABLE_PYTHON_PACKAGES,
    SEVERITY_WEIGHTS
} from '../utils/staticAnalysisPatterns.js';
import { LockfileParser } from '../utils/lockfileParser.js';

export class DependencyAnalyzer {
    constructor(options = {}) {
        this.vulnerablePackages = { ...VULNERABLE_PACKAGES };
        this.vulnerablePythonPackages = { ...VULNERABLE_PYTHON_PACKAGES };

        this.options = {
            checkDevDependencies: options.checkDevDependencies ?? true,
            checkPeerDependencies: options.checkPeerDependencies ?? false,
            strictVersionCheck: options.strictVersionCheck ?? false,
            ...options
        };

        this.osvService = options.osvService || null;
        this.lockfileParser = new LockfileParser();

        // Supported dependency file patterns
        this.dependencyFilePatterns = {
            npm: /package\.json$/,
            pip: /requirements\.txt$/,
            pipenv: /Pipfile$/,
            poetry: /pyproject\.toml$/,
            gemfile: /Gemfile$/,
            composer: /composer\.json$/,
            cargo: /Cargo\.toml$/,
            gradle: /build\.gradle$/,
            maven: /pom\.xml$/,
            packageLock: /package-lock\.json$/,
            yarnLock: /yarn\.lock$/,
            pipfileLock: /Pipfile\.lock$/,
            gemfileLock: /Gemfile\.lock$/,
            cargoLock: /Cargo\.lock$/
        };
    }

    /**
     * Analyze dependencies from a file
     * @param {string} content - File content
     * @param {Object} context - Analysis context { filePath }
     * @returns {Object} Analysis results
     */
    analyze(content, context = {}) {
        const { filePath = 'unknown' } = context;
        const fileType = this.detectFileType(filePath);

        if (!fileType) {
            return this.createEmptyResult(filePath, 'Not a dependency file');
        }

        let dependencies = [];
        let parseError = null;

        try {
            switch (fileType) {
                case 'npm':
                    dependencies = this.parsePackageJson(content);
                    break;
                case 'pip':
                    dependencies = this.parseRequirementsTxt(content);
                    break;
                case 'pipenv':
                    dependencies = this.parsePipfile(content);
                    break;
                case 'poetry':
                    dependencies = this.parsePyprojectToml(content);
                    break;
                default:
                    return this.createEmptyResult(filePath, `Unsupported file type: ${fileType}`);
            }
        } catch (error) {
            parseError = error.message;
            dependencies = [];
        }

        if (parseError) {
            return this.createEmptyResult(filePath, `Parse error: ${parseError}`);
        }

        // Check dependencies for vulnerabilities
        const findings = this.checkVulnerabilities(dependencies, fileType, filePath);

        return {
            tool: 'dependency',
            filePath,
            fileType,
            dependencies: dependencies.map(d => ({
                name: d.name,
                version: d.version,
                type: d.type,
                isVulnerable: findings.some(f => f.packageName === d.name)
            })),
            findings,
            summary: this.generateSummary(findings, dependencies),
            confidence: this.calculateOverallConfidence(findings)
        };
    }

    /**
     * Parse package.json for npm dependencies
     */
    parsePackageJson(content) {
        const pkg = JSON.parse(content);
        const dependencies = [];

        // Production dependencies
        if (pkg.dependencies) {
            for (const [name, version] of Object.entries(pkg.dependencies)) {
                dependencies.push({
                    name,
                    version: this.normalizeVersion(version),
                    rawVersion: version,
                    type: 'production'
                });
            }
        }

        // Dev dependencies
        if (this.options.checkDevDependencies && pkg.devDependencies) {
            for (const [name, version] of Object.entries(pkg.devDependencies)) {
                dependencies.push({
                    name,
                    version: this.normalizeVersion(version),
                    rawVersion: version,
                    type: 'development'
                });
            }
        }

        // Peer dependencies
        if (this.options.checkPeerDependencies && pkg.peerDependencies) {
            for (const [name, version] of Object.entries(pkg.peerDependencies)) {
                dependencies.push({
                    name,
                    version: this.normalizeVersion(version),
                    rawVersion: version,
                    type: 'peer'
                });
            }
        }

        return dependencies;
    }

    /**
     * Parse requirements.txt for Python dependencies
     */
    parseRequirementsTxt(content) {
        const dependencies = [];
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
                continue;
            }

            // Parse package==version, package>=version, etc.
            const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([<>=!~]+)?\s*([\d.]+)?/);
            if (match) {
                dependencies.push({
                    name: match[1].toLowerCase(),
                    version: match[3] || 'any',
                    operator: match[2] || '==',
                    rawVersion: trimmed,
                    type: 'production'
                });
            }
        }

        return dependencies;
    }

    /**
     * Parse Pipfile for Python dependencies
     */
    parsePipfile(content) {
        const dependencies = [];
        let currentSection = null;

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();

            // Detect section headers
            if (trimmed === '[packages]') {
                currentSection = 'production';
                continue;
            } else if (trimmed === '[dev-packages]') {
                currentSection = 'development';
                continue;
            } else if (trimmed.startsWith('[')) {
                currentSection = null;
                continue;
            }

            if (!currentSection) continue;

            // Parse package = "version"
            const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"?([^"]+)"?/);
            if (match) {
                const versionStr = match[2];
                const version = versionStr === '*' ? 'any' : this.normalizeVersion(versionStr);

                dependencies.push({
                    name: match[1].toLowerCase(),
                    version,
                    rawVersion: versionStr,
                    type: currentSection
                });
            }
        }

        return dependencies;
    }

    /**
     * Parse pyproject.toml for Poetry dependencies
     */
    parsePyprojectToml(content) {
        const dependencies = [];

        // Simple TOML parsing for dependencies section
        const depMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\[|$)/);
        if (depMatch) {
            const depSection = depMatch[1];
            const lines = depSection.split('\n');

            for (const line of lines) {
                const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"?([^"]+)"?/);
                if (match && match[1] !== 'python') {
                    dependencies.push({
                        name: match[1].toLowerCase(),
                        version: this.normalizeVersion(match[2]),
                        rawVersion: match[2],
                        type: 'production'
                    });
                }
            }
        }

        // Dev dependencies
        if (this.options.checkDevDependencies) {
            const devMatch = content.match(/\[tool\.poetry\.dev-dependencies\]([\s\S]*?)(?:\[|$)/);
            if (devMatch) {
                const devSection = devMatch[1];
                const lines = devSection.split('\n');

                for (const line of lines) {
                    const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*"?([^"]+)"?/);
                    if (match) {
                        dependencies.push({
                            name: match[1].toLowerCase(),
                            version: this.normalizeVersion(match[2]),
                            rawVersion: match[2],
                            type: 'development'
                        });
                    }
                }
            }
        }

        return dependencies;
    }

    /**
     * Normalize version string
     */
    normalizeVersion(version) {
        if (!version) return 'any';

        // Remove common prefixes
        let normalized = version.replace(/^[~^>=<]+/, '');

        // Handle version ranges
        if (version.includes(' || ')) {
            // Take the first version in a range
            normalized = version.split(' || ')[0].replace(/^[~^>=<]+/, '');
        }

        // Clean up
        normalized = normalized.replace(/['"]/g, '').trim();

        return normalized || 'any';
    }

    /**
     * Check dependencies against known vulnerabilities
     */
    checkVulnerabilities(dependencies, fileType, filePath) {
        const findings = [];
        const vulnDb = fileType === 'npm' ? this.vulnerablePackages : this.vulnerablePythonPackages;

        for (const dep of dependencies) {
            const vulnInfo = vulnDb[dep.name] || vulnDb[dep.name.toLowerCase()];

            if (vulnInfo) {
                const isVulnerable = this.isVersionVulnerable(dep.version, vulnInfo.vulnerableVersions);

                if (isVulnerable) {
                    const confidence = this.calculateVulnerabilityConfidence(dep, vulnInfo);

                    findings.push({
                        ruleId: 'vulnerable-dependency',
                        severity: vulnInfo.severity,
                        category: 'A06:2021-Vulnerable Components',
                        packageName: dep.name,
                        installedVersion: dep.version,
                        rawVersion: dep.rawVersion,
                        vulnerableVersions: vulnInfo.vulnerableVersions,
                        cve: vulnInfo.cve,
                        description: vulnInfo.description,
                        dependencyType: dep.type,
                        message: `Vulnerable package: ${dep.name}@${dep.version} (${vulnInfo.cve}) - ${vulnInfo.description}`,
                        confidence,
                        remediation: `Update ${dep.name} to a version newer than ${vulnInfo.vulnerableVersions.replace('<', '')}`,
                        filePath,
                        tool: 'dependency'
                    });
                }
            }
        }

        return findings;
    }

    /**
     * Check if installed version is vulnerable
     */
    isVersionVulnerable(installedVersion, vulnerableRange) {
        if (installedVersion === 'any' || installedVersion === '*') {
            // Can't determine - assume potentially vulnerable
            return true;
        }

        // Parse vulnerable range
        const rangeMatch = vulnerableRange.match(/^([<>=!]+)?([\d.]+)/);
        if (!rangeMatch) return false;

        const operator = rangeMatch[1] || '<';
        const vulnVersion = rangeMatch[2];

        // Compare versions
        const installed = this.parseVersionNumber(installedVersion);
        const vulnerable = this.parseVersionNumber(vulnVersion);

        switch (operator) {
            case '<':
                return this.compareVersions(installed, vulnerable) < 0;
            case '<=':
                return this.compareVersions(installed, vulnerable) <= 0;
            case '>':
                return this.compareVersions(installed, vulnerable) > 0;
            case '>=':
                return this.compareVersions(installed, vulnerable) >= 0;
            case '=':
            case '==':
                return this.compareVersions(installed, vulnerable) === 0;
            default:
                return this.compareVersions(installed, vulnerable) < 0;
        }
    }

    /**
     * Parse version string into comparable numbers
     */
    parseVersionNumber(version) {
        const parts = version.split(/[.-]/).map(p => {
            const num = parseInt(p, 10);
            return isNaN(num) ? 0 : num;
        });

        // Pad to 4 parts
        while (parts.length < 4) {
            parts.push(0);
        }

        return parts;
    }

    /**
     * Compare two parsed versions
     * Returns: -1 if a < b, 0 if a == b, 1 if a > b
     */
    compareVersions(a, b) {
        for (let i = 0; i < 4; i++) {
            if (a[i] < b[i]) return -1;
            if (a[i] > b[i]) return 1;
        }
        return 0;
    }

    /**
     * Calculate confidence for vulnerability finding
     */
    calculateVulnerabilityConfidence(dep, vulnInfo) {
        let confidence = SEVERITY_WEIGHTS[vulnInfo.severity] || 0.5;

        // Reduce confidence for dev dependencies
        if (dep.type === 'development') {
            confidence *= 0.7;
        }

        // Reduce confidence if version is indeterminate
        if (dep.version === 'any' || dep.version === '*') {
            confidence *= 0.6;
        }

        // Increase confidence if CVE is known
        if (vulnInfo.cve) {
            confidence = Math.min(1.0, confidence + 0.1);
        }

        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Detect dependency file type
     */
    detectFileType(filePath) {
        if (!filePath) return null;

        for (const [type, pattern] of Object.entries(this.dependencyFilePatterns)) {
            if (pattern.test(filePath)) {
                return type;
            }
        }

        return null;
    }

    /**
     * Generate summary
     */
    generateSummary(findings, dependencies) {
        const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
        const byType = { production: 0, development: 0, peer: 0 };

        for (const finding of findings) {
            bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
            byType[finding.dependencyType] = (byType[finding.dependencyType] || 0) + 1;
        }

        return {
            total: findings.length,
            bySeverity,
            byType,
            totalDependencies: dependencies.length,
            vulnerableCount: findings.length,
            vulnerablePercentage: dependencies.length > 0
                ? Math.round((findings.length / dependencies.length) * 100)
                : 0,
            productionVulnerabilities: byType.production,
            hasKnownCVEs: findings.some(f => f.cve)
        };
    }

    /**
     * Calculate overall confidence
     */
    calculateOverallConfidence(findings) {
        if (findings.length === 0) return 1.0;
        const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
        return Math.round(avgConfidence * 100) / 100;
    }

    /**
     * Create empty result
     */
    createEmptyResult(filePath, reason = 'No vulnerabilities found') {
        return {
            tool: 'dependency',
            filePath,
            dependencies: [],
            findings: [],
            summary: {
                total: 0,
                bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
                byType: { production: 0, development: 0 },
                totalDependencies: 0,
                vulnerableCount: 0,
                vulnerablePercentage: 0
            },
            confidence: 1.0,
            skipped: true,
            skipReason: reason
        };
    }

    /**
     * Check vulnerabilities using OSV.dev API with static DB fallback
     */
    async checkVulnerabilitiesWithOSV(dependencies, fileType, filePath) {
        if (!this.osvService) {
            return this.checkVulnerabilities(dependencies, fileType, filePath);
        }

        const ecosystem = this.osvService.mapEcosystem(fileType);
        if (!ecosystem) {
            return this.checkVulnerabilities(dependencies, fileType, filePath);
        }

        try {
            const packages = dependencies
                .filter(d => d.name && d.version)
                .map(d => ({
                    name: d.name,
                    version: d.version.replace(/^[~^>=<]+/, ''),
                    ecosystem
                }));

            const osvResults = await this.osvService.queryBatch(packages);
            const findings = [];

            for (const pkg of packages) {
                const key = this.osvService.getCacheKey(pkg.name, pkg.version, pkg.ecosystem);
                const vulns = osvResults.get(key) || [];

                for (const vuln of vulns) {
                    const dep = dependencies.find(d => d.name === pkg.name);
                    findings.push({
                        ruleId: `vulnerable-dependency-${vuln.cve || vuln.id}`,
                        severity: vuln.severity,
                        category: 'A06:2021-Vulnerable Components',
                        packageName: pkg.name,
                        installedVersion: pkg.version,
                        cve: vuln.cve,
                        description: vuln.summary,
                        dependencyType: dep?.type || 'production',
                        message: `${pkg.name}@${pkg.version} has known vulnerability ${vuln.cve}: ${vuln.summary}`,
                        confidence: vuln.severity === 'critical' ? 0.95 : vuln.severity === 'high' ? 0.9 : 0.8,
                        remediation: vuln.fixedVersions.length > 0
                            ? `Upgrade to ${vuln.fixedVersions[0]} or later`
                            : 'Check the vulnerability details for mitigation steps',
                        filePath,
                        tool: 'dependency',
                        osvId: vuln.id,
                        references: vuln.references
                    });
                }
            }

            return findings;
        } catch (error) {
            console.warn('OSV query failed, falling back to static DB:', error.message);
            return this.checkVulnerabilities(dependencies, fileType, filePath);
        }
    }

    /**
     * Analyze a lockfile for transitive dependency vulnerabilities
     */
    async analyzeLockfile(content, context = {}) {
        const { filePath = 'unknown' } = context;
        const lockfileType = this.lockfileParser.detectLockfileType(filePath);

        if (!lockfileType) {
            return this.createEmptyResult(filePath, 'Not a lockfile');
        }

        const dependencies = this.lockfileParser.parse(content, filePath);

        if (dependencies.length === 0) {
            return this.createEmptyResult(filePath, 'No dependencies found in lockfile');
        }

        // Map lockfile type to ecosystem type
        const ecosystemMap = {
            packageLock: 'npm', yarnLock: 'npm', pnpmLock: 'npm',
            pipfileLock: 'pip', poetryLock: 'poetry',
            gemfileLock: 'gemfile', cargoLock: 'cargo'
        };
        const fileType = ecosystemMap[lockfileType] || 'npm';

        const findings = this.osvService
            ? await this.checkVulnerabilitiesWithOSV(dependencies, fileType, filePath)
            : this.checkVulnerabilities(dependencies, fileType, filePath);

        return {
            tool: 'dependency',
            filePath,
            fileType: lockfileType,
            dependencies,
            findings,
            summary: this.generateSummary(dependencies, findings),
            isLockfile: true,
            totalDependencies: dependencies.length
        };
    }

    /**
     * Analyze multiple files
     */
    analyzeFiles(files) {
        const results = {
            tool: 'dependency',
            files: [],
            totalFindings: 0,
            allDependencies: [],
            summary: {
                bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
                byEcosystem: {}
            }
        };

        for (const file of files) {
            const fileResult = this.analyze(file.content, { filePath: file.path });

            if (!fileResult.skipped) {
                results.files.push(fileResult);
                results.totalFindings += fileResult.findings.length;
                results.allDependencies.push(...fileResult.dependencies);

                // Aggregate summaries
                for (const [severity, count] of Object.entries(fileResult.summary.bySeverity)) {
                    results.summary.bySeverity[severity] += count;
                }

                const ecosystem = fileResult.fileType;
                results.summary.byEcosystem[ecosystem] =
                    (results.summary.byEcosystem[ecosystem] || 0) + fileResult.findings.length;
            }
        }

        results.summary.filesAnalyzed = results.files.length;
        results.summary.totalDependencies = results.allDependencies.length;

        return results;
    }
}

export default DependencyAnalyzer;
