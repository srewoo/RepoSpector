/**
 * Lockfile Parser for RepoSpector
 *
 * Parses various lockfile formats to extract transitive dependencies
 * for vulnerability scanning.
 */

export class LockfileParser {
    /**
     * Parse package-lock.json (v2/v3 format)
     */
    parsePackageLockJson(content) {
        try {
            const lockfile = JSON.parse(content);
            const deps = [];

            // v2/v3 format: packages object
            if (lockfile.packages) {
                for (const [path, info] of Object.entries(lockfile.packages)) {
                    if (path === '') continue; // Root package
                    const name = path.replace(/^node_modules\//, '').replace(/.*node_modules\//, '');
                    if (name && info.version) {
                        deps.push({
                            name,
                            version: info.version,
                            type: info.dev ? 'development' : 'production',
                            resolved: info.resolved || null
                        });
                    }
                }
            }
            // v1 format: dependencies object
            else if (lockfile.dependencies) {
                this._parseLockV1Deps(lockfile.dependencies, deps, false);
            }

            return deps;
        } catch (e) {
            console.warn('Failed to parse package-lock.json:', e.message);
            return [];
        }
    }

    _parseLockV1Deps(dependencies, result, isDev) {
        for (const [name, info] of Object.entries(dependencies)) {
            if (info.version) {
                result.push({
                    name,
                    version: info.version,
                    type: isDev || info.dev ? 'development' : 'production',
                    resolved: info.resolved || null
                });
            }
            if (info.dependencies) {
                this._parseLockV1Deps(info.dependencies, result, isDev || info.dev);
            }
        }
    }

    /**
     * Parse yarn.lock (classic format)
     */
    parseYarnLock(content) {
        const deps = [];
        const lines = content.split('\n');
        let currentPkg = null;

        for (const line of lines) {
            if (line.startsWith('#') || line.trim() === '') continue;

            // Package header: "name@version", name@version:
            const headerMatch = line.match(/^"?([^@\s]+)@[^"]*"?:?\s*$/);
            if (headerMatch && !line.startsWith(' ')) {
                currentPkg = { name: headerMatch[1] };
                continue;
            }

            // Version line
            if (currentPkg && line.match(/^\s+version\s+"?([^"\s]+)"?\s*$/)) {
                const versionMatch = line.match(/version\s+"?([^"\s]+)"?/);
                if (versionMatch) {
                    deps.push({
                        name: currentPkg.name,
                        version: versionMatch[1],
                        type: 'production'
                    });
                    currentPkg = null;
                }
            }
        }

        return deps;
    }

    /**
     * Parse Pipfile.lock (JSON format)
     */
    parsePipfileLock(content) {
        try {
            const lockfile = JSON.parse(content);
            const deps = [];

            for (const [section, packages] of Object.entries(lockfile)) {
                if (section === '_meta') continue;
                const isDev = section === 'develop';

                for (const [name, info] of Object.entries(packages || {})) {
                    const version = (info.version || '').replace(/^==/, '');
                    if (version) {
                        deps.push({
                            name,
                            version,
                            type: isDev ? 'development' : 'production'
                        });
                    }
                }
            }

            return deps;
        } catch (e) {
            console.warn('Failed to parse Pipfile.lock:', e.message);
            return [];
        }
    }

    /**
     * Parse Gemfile.lock
     */
    parseGemfileLock(content) {
        const deps = [];
        const lines = content.split('\n');
        let inSpecs = false;

        for (const line of lines) {
            if (line.trim() === 'specs:') {
                inSpecs = true;
                continue;
            }
            if (inSpecs && line.match(/^\s{4}\S/)) {
                const match = line.trim().match(/^(\S+)\s+\(([^)]+)\)/);
                if (match) {
                    deps.push({
                        name: match[1],
                        version: match[2],
                        type: 'production'
                    });
                }
            }
            if (inSpecs && !line.startsWith(' ') && line.trim() !== '') {
                inSpecs = false;
            }
        }

        return deps;
    }

    /**
     * Parse Cargo.lock
     */
    parseCargoLock(content) {
        const deps = [];
        const lines = content.split('\n');
        let currentPkg = {};

        for (const line of lines) {
            if (line.startsWith('[[package]]')) {
                if (currentPkg.name && currentPkg.version) {
                    deps.push({ ...currentPkg, type: 'production' });
                }
                currentPkg = {};
                continue;
            }

            const nameMatch = line.match(/^name\s*=\s*"([^"]+)"/);
            if (nameMatch) currentPkg.name = nameMatch[1];

            const versionMatch = line.match(/^version\s*=\s*"([^"]+)"/);
            if (versionMatch) currentPkg.version = versionMatch[1];
        }

        // Don't forget the last package
        if (currentPkg.name && currentPkg.version) {
            deps.push({ ...currentPkg, type: 'production' });
        }

        return deps;
    }

    /**
     * Detect lockfile type from file path
     */
    detectLockfileType(filePath) {
        if (!filePath) return null;
        if (/package-lock\.json$/.test(filePath)) return 'packageLock';
        if (/yarn\.lock$/.test(filePath)) return 'yarnLock';
        if (/pnpm-lock\.ya?ml$/.test(filePath)) return 'pnpmLock';
        if (/Pipfile\.lock$/.test(filePath)) return 'pipfileLock';
        if (/poetry\.lock$/.test(filePath)) return 'poetryLock';
        if (/Gemfile\.lock$/.test(filePath)) return 'gemfileLock';
        if (/Cargo\.lock$/.test(filePath)) return 'cargoLock';
        return null;
    }

    /**
     * Parse a lockfile based on its type
     */
    parse(content, filePath) {
        const type = this.detectLockfileType(filePath);
        switch (type) {
            case 'packageLock': return this.parsePackageLockJson(content);
            case 'yarnLock': return this.parseYarnLock(content);
            case 'pipfileLock': return this.parsePipfileLock(content);
            case 'gemfileLock': return this.parseGemfileLock(content);
            case 'cargoLock': return this.parseCargoLock(content);
            default: return [];
        }
    }
}

export default LockfileParser;
