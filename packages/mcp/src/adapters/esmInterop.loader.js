/**
 * Node module-customization hook: resolve an extensionless relative import
 * the way a bundler would.
 *
 * The extension's own source (built with webpack/babel, which resolve
 * extensionless specifiers) contains a few relative imports with no `.js`
 * suffix — e.g. `import { VectorStore } from './VectorStore'` in
 * src/services/RAGService.js. Node's native ESM resolver has no such
 * fallback and throws ERR_MODULE_NOT_FOUND for exactly those specifiers.
 * This package reuses that source verbatim rather than forking it (see
 * indexer.js), so the interop lives here instead: retry a failed relative
 * resolution once with `.js` appended, and only that one narrow case.
 *
 * Registered from indexer.js via `node:module`'s `register()`, before the
 * dynamic imports of RAGService.js/CodeGraphPipeline.js — nothing outside
 * packages/mcp is modified.
 */
export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        const isRelative = /^\.{1,2}\//.test(specifier);
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);
        if (error?.code === 'ERR_MODULE_NOT_FOUND' && isRelative && !hasExtension) {
            return nextResolve(`${specifier}.js`, context);
        }
        throw error;
    }
}
