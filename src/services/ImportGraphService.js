/**
 * Import Graph Service for RepoSpector
 *
 * Builds a lightweight dependency graph from import/require/from statements
 * in changed files to detect cross-file impact and potential breaking changes.
 */

export class ImportGraphService {
    constructor() {
        this.graph = new Map(); // filePath → { imports: [], exports: [] }
    }

    /**
     * Build import/export graph from PR files
     * @param {Array} files - [{filename, patch, content, language}]
     * @returns {Map} Graph map
     */
    buildGraph(files) {
        this.graph.clear();

        for (const file of (files || [])) {
            const code = file.content || file.patch || '';
            const language = file.language || this.detectLanguage(file.filename);

            if (!code.trim()) continue;

            const imports = this.parseImports(code, language);
            const exports = this.parseExports(code, language);

            this.graph.set(file.filename, { imports, exports, language });
        }

        return this.graph;
    }

    /**
     * Parse import statements from code
     */
    parseImports(code, language) {
        const imports = [];

        switch (language) {
            case 'javascript':
            case 'typescript':
            case 'jsx':
            case 'tsx':
                imports.push(...this.parseJSImports(code));
                break;
            case 'python':
                imports.push(...this.parsePythonImports(code));
                break;
            case 'java':
                imports.push(...this.parseJavaImports(code));
                break;
            case 'go':
                imports.push(...this.parseGoImports(code));
                break;
            default:
                // Try JS-style imports as default
                imports.push(...this.parseJSImports(code));
        }

        return imports;
    }

    /**
     * Parse JS/TS import statements
     */
    parseJSImports(code) {
        const imports = [];
        const lines = code.split('\n');

        for (const line of lines) {
            // import X from 'Y'
            const importFrom = line.match(/import\s+(?:{[^}]*}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/);
            if (importFrom) {
                const specifiers = this.extractJSSpecifiers(line);
                imports.push({ source: importFrom[1], specifiers, type: 'static' });
                continue;
            }

            // import 'Y' (side-effect)
            const importSideEffect = line.match(/import\s+['"]([^'"]+)['"]/);
            if (importSideEffect) {
                imports.push({ source: importSideEffect[1], specifiers: [], type: 'side-effect' });
                continue;
            }

            // const X = require('Y')
            const requireMatch = line.match(/(?:const|let|var)\s+(?:{[^}]*}|\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (requireMatch) {
                imports.push({ source: requireMatch[1], specifiers: [], type: 'require' });
                continue;
            }

            // Dynamic import('Y')
            const dynamicImport = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
            if (dynamicImport) {
                imports.push({ source: dynamicImport[1], specifiers: [], type: 'dynamic' });
            }
        }

        return imports;
    }

    /**
     * Extract named specifiers from JS import
     */
    extractJSSpecifiers(line) {
        // import { a, b, c as d } from '...'
        const namedMatch = line.match(/import\s+\{([^}]+)\}/);
        if (namedMatch) {
            return namedMatch[1].split(',').map(s => {
                const parts = s.trim().split(/\s+as\s+/);
                return parts[0].trim();
            }).filter(Boolean);
        }

        // import X from '...' (default import)
        const defaultMatch = line.match(/import\s+(\w+)\s+from/);
        if (defaultMatch) {
            return ['default'];
        }

        // import * as X from '...'
        const namespaceMatch = line.match(/import\s+\*\s+as\s+(\w+)/);
        if (namespaceMatch) {
            return ['*'];
        }

        return [];
    }

    /**
     * Parse Python import statements
     */
    parsePythonImports(code) {
        const imports = [];
        const lines = code.split('\n');

        for (const line of lines) {
            // from X import Y, Z
            const fromImport = line.match(/from\s+([\w.]+)\s+import\s+(.+)/);
            if (fromImport) {
                const specifiers = fromImport[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
                imports.push({ source: fromImport[1], specifiers, type: 'from' });
                continue;
            }

            // import X, Y
            const importMatch = line.match(/^import\s+([\w.,\s]+)/);
            if (importMatch) {
                const modules = importMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
                for (const mod of modules) {
                    imports.push({ source: mod, specifiers: [], type: 'import' });
                }
            }
        }

        return imports;
    }

    /**
     * Parse Java import statements
     */
    parseJavaImports(code) {
        const imports = [];
        const lines = code.split('\n');

        for (const line of lines) {
            const match = line.match(/import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/);
            if (match) {
                const parts = match[2].split('.');
                const className = parts.pop();
                imports.push({
                    source: parts.join('.'),
                    specifiers: [className],
                    type: match[1] ? 'static' : 'import'
                });
            }
        }

        return imports;
    }

    /**
     * Parse Go import statements
     */
    parseGoImports(code) {
        const imports = [];

        // Single import
        const singleImports = code.matchAll(/import\s+"([^"]+)"/g);
        for (const match of singleImports) {
            imports.push({ source: match[1], specifiers: [], type: 'import' });
        }

        // Block import
        const blockMatch = code.match(/import\s*\(([\s\S]*?)\)/);
        if (blockMatch) {
            const lines = blockMatch[1].split('\n');
            for (const line of lines) {
                const match = line.match(/(?:\w+\s+)?"([^"]+)"/);
                if (match) {
                    imports.push({ source: match[1], specifiers: [], type: 'import' });
                }
            }
        }

        return imports;
    }

    /**
     * Parse export statements from code
     */
    parseExports(code, language) {
        const exports = [];

        if (['javascript', 'typescript', 'jsx', 'tsx'].includes(language)) {
            const lines = code.split('\n');
            for (const line of lines) {
                // export function X
                const funcMatch = line.match(/export\s+(?:async\s+)?function\s+(\w+)/);
                if (funcMatch) {
                    exports.push({ name: funcMatch[1], type: 'function' });
                    continue;
                }

                // export class X
                const classMatch = line.match(/export\s+class\s+(\w+)/);
                if (classMatch) {
                    exports.push({ name: classMatch[1], type: 'class' });
                    continue;
                }

                // export const/let/var X
                const varMatch = line.match(/export\s+(?:const|let|var)\s+(\w+)/);
                if (varMatch) {
                    exports.push({ name: varMatch[1], type: 'variable' });
                    continue;
                }

                // export default
                if (line.match(/export\s+default/)) {
                    exports.push({ name: 'default', type: 'default' });
                    continue;
                }

                // export { X, Y, Z }
                const namedExport = line.match(/export\s+\{([^}]+)\}/);
                if (namedExport) {
                    const names = namedExport[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim());
                    for (const name of names) {
                        if (name) exports.push({ name, type: 'named' });
                    }
                }

                // module.exports
                if (line.match(/module\.exports/)) {
                    exports.push({ name: 'default', type: 'commonjs' });
                }
            }
        } else if (language === 'python') {
            // Python: detect top-level function/class definitions
            const lines = code.split('\n');
            for (const line of lines) {
                const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
                if (funcMatch && !funcMatch[1].startsWith('_')) {
                    exports.push({ name: funcMatch[1], type: 'function' });
                }
                const classMatch = line.match(/^class\s+(\w+)/);
                if (classMatch) {
                    exports.push({ name: classMatch[1], type: 'class' });
                }
            }
        }

        return exports;
    }

    /**
     * Find files that import from a changed file
     * @param {string} changedFile - The file that was modified
     * @returns {Array} Files that depend on the changed file
     */
    findAffectedFiles(changedFile) {
        const affected = [];
        const changedBase = this.normalizeImportPath(changedFile);

        for (const [filePath, data] of this.graph.entries()) {
            if (filePath === changedFile) continue;

            for (const imp of data.imports) {
                const importPath = this.resolveImportPath(imp.source, filePath);
                if (importPath === changedBase || imp.source.includes(changedBase)) {
                    affected.push({
                        file: filePath,
                        importSource: imp.source,
                        specifiers: imp.specifiers,
                        type: imp.type
                    });
                    break;
                }
            }
        }

        return affected;
    }

    /**
     * Detect potential breaking changes in modified files
     * @param {Array} changedFiles - Files with modifications
     * @returns {Array} Breaking change findings
     */
    detectBreakingChanges(changedFiles) {
        const findings = [];

        for (const file of changedFiles) {
            const fileData = this.graph.get(file.filename);
            if (!fileData) continue;

            // Find files that import from this changed file
            const affected = this.findAffectedFiles(file.filename);

            if (affected.length > 0) {
                // Check if exports were removed (by analyzing the patch)
                const removedExports = this.findRemovedExports(file.patch || '');

                if (removedExports.length > 0) {
                    for (const removed of removedExports) {
                        const impactedFiles = affected.filter(a =>
                            a.specifiers.includes(removed.name) ||
                            a.specifiers.includes('*') ||
                            a.specifiers.includes('default')
                        );

                        if (impactedFiles.length > 0) {
                            findings.push({
                                ruleId: 'breaking-change-removed-export',
                                severity: 'high',
                                category: 'breaking-change',
                                message: `Removed export '${removed.name}' is imported by ${impactedFiles.length} file(s): ${impactedFiles.map(f => f.file).join(', ')}`,
                                filePath: file.filename,
                                tool: 'import-graph',
                                confidence: 0.85,
                                remediation: `Check that removing '${removed.name}' doesn't break consumers. Update imports in: ${impactedFiles.map(f => f.file).join(', ')}`
                            });
                        }
                    }
                }

                // General cross-file impact warning
                if (affected.length >= 3) {
                    findings.push({
                        ruleId: 'high-impact-change',
                        severity: 'medium',
                        category: 'breaking-change',
                        message: `Changes to ${file.filename} may impact ${affected.length} dependent files`,
                        filePath: file.filename,
                        tool: 'import-graph',
                        confidence: 0.7,
                        remediation: `Review dependent files for compatibility: ${affected.map(f => f.file).slice(0, 5).join(', ')}${affected.length > 5 ? ` and ${affected.length - 5} more` : ''}`
                    });
                }
            }
        }

        return findings;
    }

    /**
     * Find exports that were removed in a patch
     */
    findRemovedExports(patch) {
        const removed = [];
        const lines = (patch || '').split('\n');

        for (const line of lines) {
            if (!line.startsWith('-') || line.startsWith('---')) continue;
            const content = line.substring(1);

            // export function X (removed)
            const funcMatch = content.match(/export\s+(?:async\s+)?function\s+(\w+)/);
            if (funcMatch) removed.push({ name: funcMatch[1], type: 'function' });

            // export class X (removed)
            const classMatch = content.match(/export\s+class\s+(\w+)/);
            if (classMatch) removed.push({ name: classMatch[1], type: 'class' });

            // export const/let/var X (removed)
            const varMatch = content.match(/export\s+(?:const|let|var)\s+(\w+)/);
            if (varMatch) removed.push({ name: varMatch[1], type: 'variable' });
        }

        return removed;
    }

    /**
     * Format import graph analysis for LLM prompt injection
     */
    formatForPrompt(changedFiles) {
        const breakingChanges = this.detectBreakingChanges(changedFiles);
        if (breakingChanges.length === 0 && this.graph.size < 2) return null;

        let prompt = '## Cross-File Impact Analysis\n\n';

        // Show dependency relationships
        for (const file of changedFiles) {
            const affected = this.findAffectedFiles(file.filename);
            if (affected.length > 0) {
                prompt += `**${file.filename}** is imported by:\n`;
                for (const dep of affected.slice(0, 10)) {
                    prompt += `- ${dep.file} (uses: ${dep.specifiers.join(', ') || 'default'})\n`;
                }
                if (affected.length > 10) {
                    prompt += `- ...and ${affected.length - 10} more files\n`;
                }
                prompt += '\n';
            }
        }

        if (breakingChanges.length > 0) {
            prompt += '### Potential Breaking Changes\n';
            for (const bc of breakingChanges) {
                prompt += `- **${bc.severity.toUpperCase()}**: ${bc.message}\n`;
            }
            prompt += '\n';
        }

        prompt += 'Consider these cross-file dependencies when reviewing the PR.\n';

        return prompt;
    }

    /**
     * Normalize file path for import matching
     */
    normalizeImportPath(filePath) {
        return filePath
            .replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '')
            .replace(/\/index$/, '');
    }

    /**
     * Resolve relative import path
     */
    resolveImportPath(importSource, fromFile) {
        if (!importSource.startsWith('.')) return importSource;

        const dir = fromFile.split('/').slice(0, -1).join('/');
        const parts = [...dir.split('/'), ...importSource.split('/')];
        const resolved = [];

        for (const part of parts) {
            if (part === '..') {
                resolved.pop();
            } else if (part !== '.') {
                resolved.push(part);
            }
        }

        return this.normalizeImportPath(resolved.join('/'));
    }

    /**
     * Detect language from filename
     */
    detectLanguage(filename) {
        if (!filename) return 'unknown';
        const ext = filename.split('.').pop()?.toLowerCase();
        const map = {
            js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
            ts: 'typescript', tsx: 'tsx',
            py: 'python', java: 'java', go: 'go', rb: 'ruby',
            rs: 'rust', cs: 'csharp', php: 'php'
        };
        return map[ext] || 'unknown';
    }
}

export default ImportGraphService;
