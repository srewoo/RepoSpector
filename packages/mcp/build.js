import esbuild from 'esbuild';

/**
 * Bundle for publishing.
 *
 * The adapters import the extension's services by relative path out of this
 * package, which works in the monorepo and breaks as soon as npm installs
 * packages/mcp alone. Bundling resolves those at build time.
 *
 * Left external on purpose:
 *  - @xenova/transformers  — ships its own wasm/onnx assets and downloads the model
 *  - web-tree-sitter, tree-sitter-wasms — resolved from node_modules at runtime
 *  - fake-indexeddb        — no reason to inline it
 *  - @modelcontextprotocol/sdk — a peer of the host's protocol version
 */
await esbuild.build({
    entryPoints: ['src/index.js'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: [
        '@xenova/transformers',
        'web-tree-sitter',
        'tree-sitter-wasms',
        'fake-indexeddb',
        '@modelcontextprotocol/sdk',
        '@modelcontextprotocol/sdk/*',
    ],
    logLevel: 'info',
});
