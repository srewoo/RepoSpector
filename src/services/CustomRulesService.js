/**
 * Custom Rules Service for RepoSpector
 *
 * Fetches and applies .repospector.yaml configuration from repositories.
 * Supports custom rules, ignore patterns, and severity overrides.
 */

export class CustomRulesService {
    constructor() {
        this.configFileNames = ['.repospector.yaml', '.repospector.yml'];
        this.configCache = new Map();
        this.cacheTTL = 3600000; // 1 hour
    }

    /**
     * Fetch .repospector.yaml from repo root
     * @param {string} platform - 'github' or 'gitlab'
     * @param {string} owner - Repo owner
     * @param {string} repo - Repo name
     * @param {string} token - API token
     * @returns {Object|null} Parsed config or null
     */
    async fetchConfig(platform, owner, repo, token) {
        const cacheKey = `${platform}:${owner}/${repo}`;
        const cached = this.configCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < this.cacheTTL) {
            return cached.config;
        }

        for (const filename of this.configFileNames) {
            try {
                let url, headers;

                if (platform === 'github') {
                    url = `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`;
                    headers = {
                        'Accept': 'application/vnd.github.v3.raw',
                        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                    };
                } else if (platform === 'gitlab') {
                    const projectPath = encodeURIComponent(`${owner}/${repo}`);
                    const filePath = encodeURIComponent(filename);
                    url = `https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${filePath}/raw?ref=main`;
                    headers = token ? { 'PRIVATE-TOKEN': token } : {};
                } else {
                    continue;
                }

                const response = await fetch(url, { headers });
                if (response.ok) {
                    const content = await response.text();
                    const config = this.parseYAML(content);
                    const validated = this.validateConfig(config);

                    this.configCache.set(cacheKey, {
                        config: validated,
                        fetchedAt: Date.now()
                    });

                    return validated;
                }
            } catch (e) {
                // File doesn't exist or can't be fetched - continue
            }
        }

        this.configCache.set(cacheKey, { config: null, fetchedAt: Date.now() });
        return null;
    }

    /**
     * Lightweight YAML parser for simple config files
     * Handles: key-value pairs, arrays (- items), nested objects (2-deep)
     */
    parseYAML(content) {
        if (!content || typeof content !== 'string') return {};

        const result = {};
        const lines = content.split('\n');
        let currentKey = null;
        let currentArray = null;
        let currentObject = null;
        let indent = 0;

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');

            // Skip comments and empty lines
            if (line.trim().startsWith('#') || line.trim() === '') continue;

            const lineIndent = line.search(/\S/);

            // Array item
            if (line.trim().startsWith('- ')) {
                const value = line.trim().substring(2).trim();

                if (currentArray && currentKey) {
                    // Check if value is a key-value pair (for array of objects)
                    const kvMatch = value.match(/^(\w+):\s*(.+)$/);
                    if (kvMatch) {
                        const obj = { [kvMatch[1]]: this.parseValue(kvMatch[2]) };
                        // Look ahead for more keys at same indent
                        currentArray.push(obj);
                    } else {
                        currentArray.push(this.parseValue(value));
                    }
                }
                continue;
            }

            // Key-value pair
            const kvMatch = line.match(/^(\s*)(\w[\w-]*):\s*(.*)$/);
            if (kvMatch) {
                const [, spaces, key, value] = kvMatch;
                const kvIndent = spaces.length;

                if (kvIndent === 0) {
                    // Top-level key
                    currentKey = key;
                    currentObject = null;

                    if (value.trim()) {
                        result[key] = this.parseValue(value.trim());
                        currentArray = null;
                    } else {
                        // Start of nested object or array
                        result[key] = {};
                        currentArray = null;
                    }
                    indent = 0;
                } else if (kvIndent > 0 && currentKey) {
                    // Nested key
                    if (value.trim()) {
                        // Simple nested key-value
                        if (typeof result[currentKey] !== 'object' || Array.isArray(result[currentKey])) {
                            result[currentKey] = {};
                        }
                        result[currentKey][key] = this.parseValue(value.trim());
                        currentArray = null;
                    } else {
                        // Start of nested array
                        if (typeof result[currentKey] !== 'object' || Array.isArray(result[currentKey])) {
                            result[currentKey] = {};
                        }
                        result[currentKey][key] = [];
                        currentArray = result[currentKey][key];
                    }
                }
            }
        }

        return result;
    }

    /**
     * Parse a YAML value to its JS type
     */
    parseValue(value) {
        if (!value || value === '') return '';

        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            return value.slice(1, -1);
        }

        // Boolean
        if (value === 'true') return true;
        if (value === 'false') return false;
        if (value === 'null' || value === '~') return null;

        // Number
        if (/^-?\d+(\.\d+)?$/.test(value)) return parseFloat(value);

        return value;
    }

    /**
     * Validate and normalize config
     */
    validateConfig(config) {
        if (!config || typeof config !== 'object') return null;

        return {
            ignore: {
                files: Array.isArray(config.ignore?.files) ? config.ignore.files : [],
                rules: Array.isArray(config.ignore?.rules) ? config.ignore.rules : []
            },
            severity_overrides: config.severity_overrides || config.severityOverrides || {},
            rules: Array.isArray(config.rules) ? config.rules : [],
            settings: {
                minConfidence: config.settings?.minConfidence || null,
                severityThreshold: config.settings?.severityThreshold || null
            }
        };
    }

    /**
     * Apply ignore patterns to findings
     */
    applyIgnorePatterns(findings, config) {
        if (!config) return findings;

        const ignoreFiles = config.ignore?.files || [];
        const ignoreRules = config.ignore?.rules || [];

        if (ignoreFiles.length === 0 && ignoreRules.length === 0) return findings;

        return findings.filter(finding => {
            // Check rule ignore
            if (ignoreRules.includes(finding.ruleId)) return false;

            // Check file ignore (glob-like matching)
            if (finding.filePath) {
                for (const pattern of ignoreFiles) {
                    if (this.matchGlob(finding.filePath, pattern)) return false;
                }
            }

            return true;
        });
    }

    /**
     * Apply severity overrides
     */
    applySeverityOverrides(findings, config) {
        if (!config?.severity_overrides) return findings;

        const overrides = config.severity_overrides;
        if (Object.keys(overrides).length === 0) return findings;

        return findings.map(finding => {
            const override = overrides[finding.ruleId];
            if (override && ['critical', 'high', 'medium', 'low', 'info'].includes(override)) {
                return { ...finding, severity: override, severityOverridden: true };
            }
            return finding;
        });
    }

    /**
     * Generate findings from custom rules
     */
    getCustomPatternFindings(code, config, context = {}) {
        if (!config?.rules || config.rules.length === 0) return [];

        const findings = [];
        const lines = code.split('\n');

        for (const rule of config.rules) {
            if (!rule.pattern) continue;

            try {
                const regex = new RegExp(rule.pattern, 'gi');
                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        findings.push({
                            ruleId: `custom-${rule.pattern.substring(0, 20)}`,
                            severity: rule.severity || 'info',
                            category: rule.category || 'custom',
                            message: rule.message || `Custom rule match: ${rule.pattern}`,
                            line: i + 1,
                            filePath: context.filePath || 'unknown',
                            tool: 'custom',
                            confidence: 0.7
                        });
                    }
                    regex.lastIndex = 0; // Reset regex state
                }
            } catch (e) {
                // Invalid regex - skip
            }
        }

        return findings;
    }

    /**
     * Apply all custom rules to findings
     * @param {Array} findings - Current findings
     * @param {Object} config - Parsed .repospector.yaml config
     * @returns {Array} Modified findings
     */
    applyAllRules(findings, config) {
        if (!config) return findings;

        let result = findings;

        // Apply ignores
        result = this.applyIgnorePatterns(result, config);

        // Apply severity overrides
        result = this.applySeverityOverrides(result, config);

        // Apply min confidence from config
        if (config.settings?.minConfidence) {
            result = result.filter(f => (f.confidence || 0) >= config.settings.minConfidence);
        }

        return result;
    }

    /**
     * Simple glob matching (supports * and ** patterns)
     */
    matchGlob(filePath, pattern) {
        // Convert glob to regex
        const regexStr = pattern
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '{{GLOBSTAR}}')
            .replace(/\*/g, '[^/]*')
            .replace(/\{\{GLOBSTAR\}\}/g, '.*');

        try {
            return new RegExp(`^${regexStr}$`).test(filePath) ||
                   new RegExp(regexStr).test(filePath);
        } catch {
            return false;
        }
    }
}

export default CustomRulesService;
