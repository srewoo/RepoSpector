/**
 * CallGraphBuilder for RepoSpector
 *
 * Resolves function calls across files using a priority resolution strategy:
 *   A. Import-resolved (0.9 confidence) — caller imports the target's file
 *   B. Same-file (0.85 confidence) — call to a function defined in the same file
 *   C. Fuzzy global (0.3–0.5 confidence) — name match across the whole project
 *
 * Also resolves import relationships (file → IMPORTS → file) and
 * heritage relationships (class → EXTENDS/IMPLEMENTS → class).
 *
 * Inspired by GitNexus's call-processor, adapted for regex-based parsing.
 */

import { KnowledgeGraphService } from './KnowledgeGraphService.js';

const BUILT_INS = new Set([
    'console', 'log', 'warn', 'error', 'info', 'debug',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
    'JSON', 'parse', 'stringify',
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    'Map', 'Set', 'WeakMap', 'WeakSet',
    'Promise', 'resolve', 'reject', 'then', 'catch', 'finally',
    'Math', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'require', 'import', 'export', 'module',
    'fetch', 'Response', 'Request', 'Headers', 'URL', 'URLSearchParams',
    'Buffer', 'process', 'global', 'window', 'document', 'navigator',
    'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
    'useReducer', 'useLayoutEffect', 'useImperativeHandle',
    'createElement', 'createContext', 'createRef', 'forwardRef', 'memo', 'lazy',
    'map', 'filter', 'reduce', 'forEach', 'find', 'findIndex', 'some', 'every',
    'includes', 'indexOf', 'slice', 'splice', 'concat', 'join', 'split',
    'push', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'flat', 'flatMap',
    'keys', 'values', 'entries', 'assign', 'freeze', 'seal', 'from',
    'hasOwnProperty', 'toString', 'valueOf', 'toFixed', 'toUpperCase', 'toLowerCase',
    'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll', 'match', 'test', 'search',
    'startsWith', 'endsWith', 'padStart', 'padEnd', 'repeat', 'charAt', 'charCodeAt',
    'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
    'open', 'read', 'write', 'close', 'append', 'extend', 'update',
    'super', 'type', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr',
    'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
    'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
    'jest', 'vi', 'cy', 'assert'
]);

export class CallGraphBuilder {
    /**
     * @param {KnowledgeGraphService} graph
     * @param {import('./SymbolExtractor.js').SymbolExtractor} symbolExtractor
     */
    constructor(graph, symbolExtractor) {
        this.graph = graph;
        this.symbolExtractor = symbolExtractor;
        this.importMap = new Map(); // filePath → Set<importedFilePath>
    }

    /**
     * Build the full call graph: imports + calls + heritage
     * @param {Array<{path: string, content: string}>} files
     */
    build(files) {
        this._buildImportMap(files);
        this._buildCallEdges(files);
        this._buildHeritageEdges(files);
    }

    /**
     * Phase 1: Resolve import statements to build file-to-file import map
     */
    _buildImportMap(files) {
        this.importMap.clear();
        const filePaths = new Set(files.map(f => f.path));

        for (const file of files) {
            if (!file.content) continue;

            const language = this.symbolExtractor.detectLanguage(file.path);
            if (!language || language === 'unknown') continue;

            const imports = this._parseImports(file.content, language);
            const resolvedFiles = new Set();

            for (const imp of imports) {
                const resolved = this._resolveImportToFile(imp.source, file.path, filePaths);
                if (resolved) {
                    resolvedFiles.add(resolved);

                    // Add IMPORTS relationship at file level
                    const sourceFileId = KnowledgeGraphService.generateId('File', file.path);
                    const targetFileId = KnowledgeGraphService.generateId('File', resolved);
                    const relId = KnowledgeGraphService.generateId('IMPORTS', `${sourceFileId}->${targetFileId}`);

                    this.graph.addRelationship({
                        id: relId,
                        sourceId: sourceFileId,
                        targetId: targetFileId,
                        type: 'IMPORTS',
                        confidence: 1.0,
                        reason: 'import-statement'
                    });
                }
            }

            if (resolvedFiles.size > 0) {
                this.importMap.set(file.path, resolvedFiles);
            }
        }
    }

    /**
     * Phase 2: Extract function calls and resolve to targets
     */
    _buildCallEdges(files) {
        for (const file of files) {
            if (!file.content) continue;

            const language = this.symbolExtractor.detectLanguage(file.path);
            if (!language || language === 'unknown') continue;

            const calls = this._extractCalls(file.content, language);

            for (const call of calls) {
                if (BUILT_INS.has(call.name)) continue;

                const resolved = this._resolveCallTarget(call.name, file.path);
                if (!resolved) continue;

                // Determine caller: try to find the enclosing function from line number
                const caller = this._findEnclosingSymbol(file.path, call.line);
                const sourceId = caller || KnowledgeGraphService.generateId('File', file.path);

                const relId = KnowledgeGraphService.generateId(
                    'CALLS', `${sourceId}:${call.name}->${resolved.nodeId}`
                );

                this.graph.addRelationship({
                    id: relId,
                    sourceId,
                    targetId: resolved.nodeId,
                    type: 'CALLS',
                    confidence: resolved.confidence,
                    reason: resolved.reason
                });
            }
        }
    }

    /**
     * Phase 3: Extract class inheritance / implementation edges
     */
    _buildHeritageEdges(files) {
        for (const file of files) {
            if (!file.content) continue;

            const language = this.symbolExtractor.detectLanguage(file.path);
            if (!language || language === 'unknown') continue;

            const heritage = this._extractHeritage(file.content, language);

            for (const { childName, parentName, type } of heritage) {
                const childId = this.symbolExtractor.lookupExact(file.path, childName);
                if (!childId) continue;

                const parentResolved = this._resolveCallTarget(parentName, file.path);
                if (!parentResolved) continue;

                const relType = type === 'implements' ? 'IMPLEMENTS' : 'EXTENDS';
                const relId = KnowledgeGraphService.generateId(
                    relType, `${childId}->${parentResolved.nodeId}`
                );

                this.graph.addRelationship({
                    id: relId,
                    sourceId: childId,
                    targetId: parentResolved.nodeId,
                    type: relType,
                    confidence: parentResolved.confidence,
                    reason: parentResolved.reason
                });
            }
        }
    }

    // --- Call resolution with priority strategy ---

    _resolveCallTarget(calledName, currentFile) {
        // Strategy A: Check imported files (HIGH confidence)
        const importedFiles = this.importMap.get(currentFile);
        if (importedFiles) {
            for (const importedFile of importedFiles) {
                const nodeId = this.symbolExtractor.lookupExact(importedFile, calledName);
                if (nodeId) return { nodeId, confidence: 0.9, reason: 'import-resolved' };
            }
        }

        // Strategy B: Check same file (HIGH confidence)
        const localNodeId = this.symbolExtractor.lookupExact(currentFile, calledName);
        if (localNodeId) return { nodeId: localNodeId, confidence: 0.85, reason: 'same-file' };

        // Strategy C: Fuzzy global search (LOW confidence)
        const fuzzyMatches = this.symbolExtractor.lookupFuzzy(calledName);
        if (fuzzyMatches.length > 0) {
            const confidence = fuzzyMatches.length === 1 ? 0.5 : 0.3;
            return { nodeId: fuzzyMatches[0].nodeId, confidence, reason: 'fuzzy-global' };
        }

        return null;
    }

    _findEnclosingSymbol(filePath, lineNumber) {
        const fileSymbols = this.graph.getNodesByFile(filePath);

        let bestMatch = null;
        let bestRange = Infinity;

        for (const node of fileSymbols) {
            if (node.label === 'File') continue;
            const start = node.properties?.startLine || 0;
            const end = node.properties?.endLine || Infinity;

            if (lineNumber >= start && lineNumber <= end) {
                const range = end - start;
                if (range < bestRange) {
                    bestMatch = node.id;
                    bestRange = range;
                }
            }
        }

        return bestMatch;
    }

    // --- Import parsing ---

    _parseImports(code, language) {
        const imports = [];
        const lines = code.split('\n');

        switch (language) {
            case 'javascript':
            case 'typescript': {
                for (const line of lines) {
                    // import ... from '...'
                    const fromMatch = line.match(/import\s+.+\s+from\s+['"]([^'"]+)['"]/);
                    if (fromMatch) { imports.push({ source: fromMatch[1] }); continue; }

                    // import '...'
                    const sideMatch = line.match(/import\s+['"]([^'"]+)['"]/);
                    if (sideMatch) { imports.push({ source: sideMatch[1] }); continue; }

                    // require('...')
                    const reqMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
                    if (reqMatch) { imports.push({ source: reqMatch[1] }); continue; }

                    // dynamic import('...')
                    const dynMatch = line.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
                    if (dynMatch) { imports.push({ source: dynMatch[1] }); }
                }
                break;
            }
            case 'python': {
                for (const line of lines) {
                    const fromMatch = line.match(/from\s+([\w.]+)\s+import/);
                    if (fromMatch) { imports.push({ source: fromMatch[1] }); continue; }

                    const impMatch = line.match(/^import\s+([\w.]+)/);
                    if (impMatch) { imports.push({ source: impMatch[1] }); }
                }
                break;
            }
            case 'java': {
                for (const line of lines) {
                    const match = line.match(/import\s+(static\s+)?([\w.]+)\s*;/);
                    if (match) imports.push({ source: match[2] });
                }
                break;
            }
            case 'go': {
                const blockMatch = code.match(/import\s*\(([\s\S]*?)\)/);
                if (blockMatch) {
                    const importLines = blockMatch[1].split('\n');
                    for (const il of importLines) {
                        const m = il.match(/["']([^"']+)["']/);
                        if (m) imports.push({ source: m[1] });
                    }
                }
                const singleImports = code.matchAll(/import\s+"([^"]+)"/g);
                for (const match of singleImports) {
                    imports.push({ source: match[1] });
                }
                break;
            }
            default:
                break;
        }

        return imports;
    }

    _resolveImportToFile(importSource, fromFile, filePaths) {
        if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
            return null; // External package
        }

        const dir = fromFile.split('/').slice(0, -1).join('/');
        const parts = [...dir.split('/').filter(Boolean), ...importSource.split('/')];
        const resolved = [];

        for (const part of parts) {
            if (part === '..') resolved.pop();
            else if (part !== '.') resolved.push(part);
        }

        const basePath = resolved.join('/');

        // Try exact match, then with extensions, then as directory index
        const candidates = [
            basePath,
            `${basePath}.js`, `${basePath}.jsx`, `${basePath}.ts`, `${basePath}.tsx`,
            `${basePath}.mjs`, `${basePath}.cjs`,
            `${basePath}/index.js`, `${basePath}/index.ts`,
            `${basePath}/index.jsx`, `${basePath}/index.tsx`,
            `${basePath}.py`, `${basePath}.java`, `${basePath}.go`, `${basePath}.rs`
        ];

        for (const candidate of candidates) {
            if (filePaths.has(candidate)) return candidate;
        }

        return null;
    }

    // --- Call extraction ---

    _extractCalls(code, language) {
        const calls = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let extracted;

            switch (language) {
                case 'javascript':
                case 'typescript':
                    extracted = this._extractJSTSCalls(line);
                    break;
                case 'python':
                    extracted = this._extractPythonCalls(line);
                    break;
                case 'java':
                case 'csharp':
                    extracted = this._extractJavaCalls(line);
                    break;
                case 'go':
                    extracted = this._extractGoCalls(line);
                    break;
                case 'rust':
                    extracted = this._extractRustCalls(line);
                    break;
                default:
                    extracted = this._extractJSTSCalls(line);
            }

            for (const name of extracted) {
                calls.push({ name, line: i + 1 });
            }
        }

        return calls;
    }

    _extractJSTSCalls(line) {
        const names = [];
        // Match: functionName( — but not declarations, keywords, or property access chains
        const pattern = /(?<!\.\s*)(?<!function\s+)(?<!class\s+)(?<!new\s+)(?<!import\s+)\b([a-zA-Z_$]\w*)\s*\(/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            const name = match[1];
            if (!this._isKeyword(name) && !BUILT_INS.has(name)) {
                names.push(name);
            }
        }

        // Also match: this.methodName( or obj.methodName(
        const methodPattern = /\b\w+\.(\w+)\s*\(/g;
        while ((match = methodPattern.exec(line)) !== null) {
            const name = match[1];
            if (!BUILT_INS.has(name) && !this._isKeyword(name)) {
                names.push(name);
            }
        }

        return names;
    }

    _extractPythonCalls(line) {
        const names = [];
        const pattern = /(?<!def\s+)(?<!class\s+)\b([a-zA-Z_]\w*)\s*\(/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            const name = match[1];
            if (!BUILT_INS.has(name) && !this._isPythonKeyword(name)) {
                names.push(name);
            }
        }

        // self.method( or obj.method(
        const methodPattern = /\b\w+\.(\w+)\s*\(/g;
        while ((match = methodPattern.exec(line)) !== null) {
            const name = match[1];
            if (!BUILT_INS.has(name)) names.push(name);
        }

        return names;
    }

    _extractJavaCalls(line) {
        const names = [];
        const pattern = /\b([a-zA-Z_]\w*)\s*\(/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            const name = match[1];
            if (!BUILT_INS.has(name) && !this._isJavaKeyword(name)) {
                names.push(name);
            }
        }
        return names;
    }

    _extractGoCalls(line) {
        const names = [];
        const pattern = /\b([a-zA-Z_]\w*)\s*\(/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            const name = match[1];
            if (!BUILT_INS.has(name) && name !== 'func' && name !== 'if' &&
                name !== 'for' && name !== 'switch' && name !== 'select') {
                names.push(name);
            }
        }
        return names;
    }

    _extractRustCalls(line) {
        const names = [];
        // fn_name( or Type::method(
        const pattern = /\b([a-zA-Z_]\w*)\s*(?:::\s*(\w+)\s*)?\(/g;
        let match;
        while ((match = pattern.exec(line)) !== null) {
            const name = match[2] || match[1];
            if (!BUILT_INS.has(name) && name !== 'fn' && name !== 'if' &&
                name !== 'for' && name !== 'while' && name !== 'match' && name !== 'loop') {
                names.push(name);
            }
        }
        return names;
    }

    // --- Heritage extraction ---

    _extractHeritage(code, language) {
        const results = [];
        const lines = code.split('\n');

        if (language === 'javascript' || language === 'typescript') {
            for (const line of lines) {
                // class Child extends Parent
                const extendsMatch = line.match(/class\s+(\w+)\s+extends\s+(\w+)/);
                if (extendsMatch) {
                    results.push({ childName: extendsMatch[1], parentName: extendsMatch[2], type: 'extends' });
                }
                // class Child implements InterfaceA, InterfaceB (TS)
                const implMatch = line.match(/class\s+(\w+)(?:\s+extends\s+\w+)?\s+implements\s+(.+?)(?:\{|$)/);
                if (implMatch) {
                    const interfaces = implMatch[2].split(',').map(s => s.trim());
                    for (const iface of interfaces) {
                        if (iface) results.push({ childName: implMatch[1], parentName: iface, type: 'implements' });
                    }
                }
            }
        } else if (language === 'python') {
            for (const line of lines) {
                const match = line.match(/^class\s+(\w+)\s*\(([^)]+)\)/);
                if (match) {
                    const parents = match[2].split(',').map(s => s.trim());
                    for (const parent of parents) {
                        if (parent && parent !== 'object') {
                            results.push({ childName: match[1], parentName: parent, type: 'extends' });
                        }
                    }
                }
            }
        } else if (language === 'java' || language === 'csharp') {
            for (const line of lines) {
                const extendsMatch = line.match(/class\s+(\w+).*\s+extends\s+(\w+)/);
                if (extendsMatch) {
                    results.push({ childName: extendsMatch[1], parentName: extendsMatch[2], type: 'extends' });
                }
                const implMatch = line.match(/class\s+(\w+).*\s+implements\s+(.+?)(?:\{|$)/);
                if (implMatch) {
                    const interfaces = implMatch[2].split(',').map(s => s.trim());
                    for (const iface of interfaces) {
                        if (iface) results.push({ childName: implMatch[1], parentName: iface, type: 'implements' });
                    }
                }
            }
        }

        return results;
    }

    // --- Keyword filters ---

    _isKeyword(name) {
        const keywords = new Set([
            'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
            'continue', 'return', 'throw', 'try', 'catch', 'finally',
            'new', 'delete', 'typeof', 'instanceof', 'void', 'in', 'of',
            'function', 'class', 'const', 'let', 'var', 'async', 'await',
            'import', 'export', 'default', 'from', 'as', 'yield',
            'true', 'false', 'null', 'undefined', 'this', 'super',
        ]);
        return keywords.has(name);
    }

    _isPythonKeyword(name) {
        const keywords = new Set([
            'if', 'else', 'elif', 'for', 'while', 'break', 'continue',
            'return', 'def', 'class', 'import', 'from', 'as', 'try',
            'except', 'finally', 'raise', 'with', 'yield', 'lambda',
            'pass', 'assert', 'del', 'global', 'nonlocal', 'and', 'or', 'not',
            'True', 'False', 'None', 'self', 'cls',
        ]);
        return keywords.has(name);
    }

    _isJavaKeyword(name) {
        const keywords = new Set([
            'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
            'continue', 'return', 'throw', 'try', 'catch', 'finally',
            'new', 'class', 'interface', 'enum', 'extends', 'implements',
            'public', 'private', 'protected', 'static', 'final', 'abstract',
            'void', 'true', 'false', 'null', 'this', 'super', 'import',
        ]);
        return keywords.has(name);
    }
}

export default CallGraphBuilder;
