/**
 * PrecomputedAnalysis — adapts a Map of tree-sitter analyses (produced in the
 * offscreen document) to the same interface SymbolExtractor / CallGraphBuilder
 * expect from TreeSitterParser. This keeps the extractors agnostic about where
 * parsing happened (in-process vs offscreen).
 *
 * Shapes match the regex path exactly:
 *   symbols:  { name, label, startLine, endLine, isExported }
 *   imports:  { source }
 *   calls:    { name, line }
 *   heritage: { childName, parentName, type }
 */
export class PrecomputedAnalysis {
    /** @param {Map<string, {symbols, imports, calls, heritage}>} analyses */
    constructor(analyses) {
        this.analyses = analyses instanceof Map ? analyses : new Map(Object.entries(analyses || {}));
    }

    isReadyForPath(filePath) {
        return this.analyses.has(filePath);
    }

    getSymbols(_content, filePath) { return this.analyses.get(filePath)?.symbols || null; }
    getImports(_content, filePath) { return this.analyses.get(filePath)?.imports || null; }
    getCalls(_content, filePath) { return this.analyses.get(filePath)?.calls || null; }
    getHeritage(_content, filePath) { return this.analyses.get(filePath)?.heritage || null; }

    get size() { return this.analyses.size; }
}

export default PrecomputedAnalysis;
