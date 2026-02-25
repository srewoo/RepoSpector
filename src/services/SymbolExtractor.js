/**
 * SymbolExtractor for RepoSpector
 *
 * Regex-based extraction of functions, classes, methods, interfaces, and exports
 * from source code. Supports JS/TS, Python, Java, Go, Rust, C/C++, C#.
 *
 * Returns structured symbol definitions with line numbers, names, types, and
 * export visibility — forming the node layer of the knowledge graph.
 */

import { KnowledgeGraphService } from './KnowledgeGraphService.js';

const LANGUAGE_MAP = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', java: 'java', go: 'go', rb: 'ruby',
    rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
    cs: 'csharp', php: 'php'
};

export class SymbolExtractor {
    constructor() {
        this.symbolTable = new Map(); // filePath → Map(name → nodeId)
        this.globalIndex = new Map(); // symbolName → [{ nodeId, filePath, type }]
    }

    /**
     * Extract all symbols from a set of files and populate the knowledge graph
     * @param {KnowledgeGraphService} graph
     * @param {Array<{path: string, content: string}>} files
     */
    extractAll(graph, files) {
        this.symbolTable.clear();
        this.globalIndex.clear();

        for (const file of files) {
            if (!file.content || !file.content.trim()) continue;

            const language = this.detectLanguage(file.path);
            if (!language || language === 'unknown') continue;

            const fileId = KnowledgeGraphService.generateId('File', file.path);
            graph.addNode({
                id: fileId,
                label: 'File',
                properties: { name: file.path.split('/').pop(), filePath: file.path, language }
            });

            const symbols = this.extractSymbols(file.content, language, file.path);

            for (const sym of symbols) {
                const nodeId = KnowledgeGraphService.generateId(sym.label, `${file.path}:${sym.name}`);

                graph.addNode({
                    id: nodeId,
                    label: sym.label,
                    properties: {
                        name: sym.name,
                        filePath: file.path,
                        startLine: sym.startLine,
                        endLine: sym.endLine,
                        language,
                        isExported: sym.isExported
                    }
                });

                graph.addRelationship({
                    id: KnowledgeGraphService.generateId('DEFINES', `${fileId}->${nodeId}`),
                    sourceId: fileId,
                    targetId: nodeId,
                    type: 'DEFINES',
                    confidence: 1.0,
                    reason: 'definition'
                });

                this._registerSymbol(file.path, sym.name, nodeId, sym.label);
            }
        }
    }

    /**
     * Extract symbols from a single file's content
     */
    extractSymbols(code, language, filePath) {
        switch (language) {
            case 'javascript':
            case 'typescript':
                return this._extractJSTS(code, filePath);
            case 'python':
                return this._extractPython(code, filePath);
            case 'java':
                return this._extractJava(code, filePath);
            case 'go':
                return this._extractGo(code, filePath);
            case 'rust':
                return this._extractRust(code, filePath);
            case 'c':
            case 'cpp':
                return this._extractCCpp(code, filePath);
            case 'csharp':
                return this._extractCSharp(code, filePath);
            default:
                return this._extractJSTS(code, filePath);
        }
    }

    // --- JS/TS extraction ---

    _extractJSTS(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trimStart();

            // export async function name(
            const funcMatch = trimmed.match(
                /^(export\s+)?(export\s+default\s+)?(async\s+)?function\s*\*?\s+(\w+)/
            );
            if (funcMatch) {
                const isExported = !!(funcMatch[1] || funcMatch[2]);
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: funcMatch[4],
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported
                });
                continue;
            }

            // export const name = (async) (...) => | function(
            const arrowMatch = trimmed.match(
                /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?(\([^)]*\)|[\w]+)\s*=>/
            );
            if (arrowMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: arrowMatch[3],
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported: !!arrowMatch[1]
                });
                continue;
            }

            // const name = function(
            const funcExprMatch = trimmed.match(
                /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?function/
            );
            if (funcExprMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: funcExprMatch[3],
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported: !!funcExprMatch[1]
                });
                continue;
            }

            // export class Name (extends|implements)
            const classMatch = trimmed.match(
                /^(export\s+)?(export\s+default\s+)?class\s+(\w+)/
            );
            if (classMatch) {
                const endLine = this._findBlockEnd(lines, i);
                const className = classMatch[3];
                const isExported = !!(classMatch[1] || classMatch[2]);

                symbols.push({
                    name: className,
                    label: 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported
                });

                // Extract methods inside the class
                const methods = this._extractClassMethods(lines, i, endLine);
                symbols.push(...methods);
                continue;
            }

            // export interface Name
            const ifaceMatch = trimmed.match(
                /^(export\s+)?interface\s+(\w+)/
            );
            if (ifaceMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: ifaceMatch[2],
                    label: 'Interface',
                    startLine: i + 1,
                    endLine,
                    isExported: !!ifaceMatch[1]
                });
                continue;
            }

            // export type Name =
            const typeMatch = trimmed.match(
                /^(export\s+)?type\s+(\w+)\s*[=<]/
            );
            if (typeMatch) {
                symbols.push({
                    name: typeMatch[2],
                    label: 'Type',
                    startLine: i + 1,
                    endLine: i + 1,
                    isExported: !!typeMatch[1]
                });
            }

            // export enum Name
            const enumMatch = trimmed.match(
                /^(export\s+)?enum\s+(\w+)/
            );
            if (enumMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: enumMatch[2],
                    label: 'Enum',
                    startLine: i + 1,
                    endLine,
                    isExported: !!enumMatch[1]
                });
            }
        }

        return symbols;
    }

    _extractClassMethods(lines, classStart, classEnd) {
        const methods = [];
        const braceDepth = [];
        let depth = 0;

        for (let i = classStart; i < classEnd && i < lines.length; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') depth++;
                if (ch === '}') depth--;
            }
            braceDepth.push(depth);

            if (depth !== 1) continue;

            const trimmed = lines[i].trimStart();

            // methodName( or async methodName( or static methodName(
            // Also matches: get name(), set name(), constructor(
            const methodMatch = trimmed.match(
                /^(static\s+)?(async\s+)?(get\s+|set\s+)?(\w+)\s*\(/
            );
            if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') &&
                !trimmed.startsWith('while') && !trimmed.startsWith('switch') &&
                !trimmed.startsWith('return') && !trimmed.startsWith('new')) {
                const endLine = this._findBlockEnd(lines, i);
                methods.push({
                    name: methodMatch[4],
                    label: 'Method',
                    startLine: i + 1,
                    endLine,
                    isExported: false
                });
            }
        }

        return methods;
    }

    // --- Python extraction ---

    _extractPython(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // class Name:
            const classMatch = line.match(/^class\s+(\w+)\s*[\(:]?/);
            if (classMatch) {
                const endLine = this._findPythonBlockEnd(lines, i);
                symbols.push({
                    name: classMatch[1],
                    label: 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported: !classMatch[1].startsWith('_')
                });

                // Extract methods
                for (let j = i + 1; j < endLine && j < lines.length; j++) {
                    const methodLine = lines[j];
                    const methodMatch = methodLine.match(/^\s+(async\s+)?def\s+(\w+)\s*\(/);
                    if (methodMatch) {
                        const mEnd = this._findPythonBlockEnd(lines, j);
                        symbols.push({
                            name: methodMatch[2],
                            label: 'Method',
                            startLine: j + 1,
                            endLine: mEnd,
                            isExported: !methodMatch[2].startsWith('__') || methodMatch[2] === '__init__'
                        });
                    }
                }
                continue;
            }

            // def name( or async def name(  (top-level only)
            const funcMatch = line.match(/^(async\s+)?def\s+(\w+)\s*\(/);
            if (funcMatch) {
                const endLine = this._findPythonBlockEnd(lines, i);
                symbols.push({
                    name: funcMatch[2],
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported: !funcMatch[2].startsWith('_')
                });
            }
        }

        return symbols;
    }

    // --- Java extraction ---

    _extractJava(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();

            // public/private/protected class Name
            const classMatch = trimmed.match(
                /^(public\s+|private\s+|protected\s+)?(abstract\s+)?(class|interface|enum)\s+(\w+)/
            );
            if (classMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: classMatch[4],
                    label: classMatch[3] === 'interface' ? 'Interface' : classMatch[3] === 'enum' ? 'Enum' : 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported: trimmed.startsWith('public')
                });
                continue;
            }

            // method declarations: modifiers returnType methodName(
            const methodMatch = trimmed.match(
                /^(public\s+|private\s+|protected\s+)?(static\s+)?(final\s+)?(async\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\([^)]*\)\s*(\{|throws)/
            );
            if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('return') &&
                !trimmed.startsWith('new') && !trimmed.startsWith('for')) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: methodMatch[5],
                    label: 'Method',
                    startLine: i + 1,
                    endLine,
                    isExported: trimmed.startsWith('public')
                });
            }
        }

        return symbols;
    }

    // --- Go extraction ---

    _extractGo(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();

            // func Name( or func (receiver) Name(
            const funcMatch = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
            if (funcMatch) {
                const endLine = this._findBlockEnd(lines, i);
                const name = funcMatch[1];
                symbols.push({
                    name,
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported: name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()
                });
                continue;
            }

            // type Name struct/interface
            const typeMatch = trimmed.match(/^type\s+(\w+)\s+(struct|interface)/);
            if (typeMatch) {
                const endLine = this._findBlockEnd(lines, i);
                const name = typeMatch[1];
                symbols.push({
                    name,
                    label: typeMatch[2] === 'interface' ? 'Interface' : 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported: name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()
                });
            }
        }

        return symbols;
    }

    // --- Rust extraction ---

    _extractRust(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();

            // pub fn name( or fn name(
            const funcMatch = trimmed.match(/^(pub\s+)?(async\s+)?fn\s+(\w+)/);
            if (funcMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: funcMatch[3],
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported: !!funcMatch[1]
                });
                continue;
            }

            // pub struct Name
            const structMatch = trimmed.match(/^(pub\s+)?struct\s+(\w+)/);
            if (structMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: structMatch[2],
                    label: 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported: !!structMatch[1]
                });
                continue;
            }

            // pub trait Name
            const traitMatch = trimmed.match(/^(pub\s+)?trait\s+(\w+)/);
            if (traitMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: traitMatch[2],
                    label: 'Interface',
                    startLine: i + 1,
                    endLine,
                    isExported: !!traitMatch[1]
                });
                continue;
            }

            // pub enum Name
            const enumMatch = trimmed.match(/^(pub\s+)?enum\s+(\w+)/);
            if (enumMatch) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: enumMatch[2],
                    label: 'Enum',
                    startLine: i + 1,
                    endLine,
                    isExported: !!enumMatch[1]
                });
            }
        }

        return symbols;
    }

    // --- C/C++ extraction ---

    _extractCCpp(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();

            // class/struct Name
            const classMatch = trimmed.match(/^(class|struct)\s+(\w+)/);
            if (classMatch && !trimmed.includes(';')) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: classMatch[2],
                    label: 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported: false
                });
                continue;
            }

            // returnType functionName( — top-level functions
            const funcMatch = trimmed.match(
                /^(?:static\s+|inline\s+|extern\s+|virtual\s+)*[\w:*&<>]+\s+(\w+)\s*\([^;]*\)\s*\{/
            );
            if (funcMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') &&
                !trimmed.startsWith('while') && !trimmed.startsWith('return')) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: funcMatch[1],
                    label: 'Function',
                    startLine: i + 1,
                    endLine,
                    isExported: false
                });
            }
        }

        return symbols;
    }

    // --- C# extraction ---

    _extractCSharp(code, _filePath) {
        const symbols = [];
        const lines = code.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trimStart();

            // class/interface/struct/enum declaration
            const classMatch = trimmed.match(
                /^(public\s+|private\s+|protected\s+|internal\s+)?(static\s+)?(abstract\s+|sealed\s+)?(class|interface|struct|enum)\s+(\w+)/
            );
            if (classMatch) {
                const endLine = this._findBlockEnd(lines, i);
                const labelMap = { 'class': 'Class', 'interface': 'Interface', 'struct': 'Class', 'enum': 'Enum' };
                symbols.push({
                    name: classMatch[5],
                    label: labelMap[classMatch[4]] || 'Class',
                    startLine: i + 1,
                    endLine,
                    isExported: trimmed.startsWith('public')
                });
                continue;
            }

            // method: modifiers returnType MethodName(
            const methodMatch = trimmed.match(
                /^(public\s+|private\s+|protected\s+|internal\s+)?(static\s+)?(async\s+)?(override\s+|virtual\s+)?[\w<>\[\],?\s]+\s+(\w+)\s*\([^)]*\)/
            );
            if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('return') &&
                !trimmed.startsWith('var') && !trimmed.startsWith('new') &&
                (trimmed.includes('{') || lines[i + 1]?.trimStart().startsWith('{'))) {
                const endLine = this._findBlockEnd(lines, i);
                symbols.push({
                    name: methodMatch[5],
                    label: 'Method',
                    startLine: i + 1,
                    endLine,
                    isExported: trimmed.startsWith('public')
                });
            }
        }

        return symbols;
    }

    // --- Utility methods ---

    _findBlockEnd(lines, startLine) {
        let depth = 0;
        let foundOpen = false;

        for (let i = startLine; i < lines.length; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') { depth++; foundOpen = true; }
                if (ch === '}') depth--;
            }
            if (foundOpen && depth <= 0) return i + 1;
        }

        return Math.min(startLine + 50, lines.length);
    }

    _findPythonBlockEnd(lines, startLine) {
        if (startLine >= lines.length) return startLine + 1;

        const baseLine = lines[startLine];
        const baseIndent = baseLine.length - baseLine.trimStart().length;

        for (let i = startLine + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') continue;

            const indent = line.length - line.trimStart().length;
            if (indent <= baseIndent) return i;
        }

        return lines.length;
    }

    _registerSymbol(filePath, name, nodeId, type) {
        if (!this.symbolTable.has(filePath)) {
            this.symbolTable.set(filePath, new Map());
        }
        this.symbolTable.get(filePath).set(name, nodeId);

        if (!this.globalIndex.has(name)) {
            this.globalIndex.set(name, []);
        }
        this.globalIndex.get(name).push({ nodeId, filePath, type });
    }

    lookupExact(filePath, name) {
        const fileSymbols = this.symbolTable.get(filePath);
        return fileSymbols ? fileSymbols.get(name) : undefined;
    }

    lookupFuzzy(name) {
        return this.globalIndex.get(name) || [];
    }

    detectLanguage(filename) {
        if (!filename) return 'unknown';
        const ext = filename.split('.').pop()?.toLowerCase();
        return LANGUAGE_MAP[ext] || 'unknown';
    }
}

export default SymbolExtractor;
