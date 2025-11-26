#!/usr/bin/env node

/**
 * Build script for RepoSpector Chrome Extension
 * Creates completely isolated bundles for content and background scripts
 * Prevents any cross-file imports that would break in Chrome extensions
 */

import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { babel } from '@rollup/plugin-babel';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import { build as viteBuild } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    red: '\x1b[31m'
};

function log(message, type = 'info') {
    const prefix = {
        info: `${colors.blue}ℹ${colors.reset}`,
        success: `${colors.green}✓${colors.reset}`,
        warning: `${colors.yellow}⚠${colors.reset}`,
        error: `${colors.red}✗${colors.reset}`
    };
    console.log(`${prefix[type]} ${message}`);
}

async function cleanDist() {
    log('Cleaning dist folder...');
    if (fs.existsSync('dist')) {
        fs.rmSync('dist', { recursive: true });
    }
    fs.mkdirSync('dist/assets/icons', { recursive: true });
    fs.mkdirSync('dist/src/popup', { recursive: true });
}

async function buildContentScript() {
    log('Building content script (isolated bundle)...');

    try {
        const bundle = await rollup({
            input: 'src/content/index.js',
            plugins: [
                replace({
                    'process.env.NODE_ENV': JSON.stringify('production'),
                    preventAssignment: true
                }),
                nodeResolve({
                    browser: true,
                    preferBuiltins: false,
                    // Include all dependencies
                    dedupe: ['react', 'react-dom']
                }),
                commonjs({
                    // Convert CommonJS modules to ES6
                    transformMixedEsModules: true,
                    // Include everything
                    include: ['node_modules/**', 'src/**'],
                    // Needed for proper builds
                    requireReturnsDefault: 'auto'
                }),
                babel({
                    babelHelpers: 'bundled',
                    exclude: 'node_modules/**',
                    presets: [
                        ['@babel/preset-env', {
                            targets: {
                                chrome: '88'
                            }
                        }]
                    ]
                }),
                terser({
                    compress: {
                        drop_console: false, // Keep console logs for debugging
                    }
                })
            ],
            // Don't treat anything as external - bundle everything
            external: [],
            onwarn: (warning) => {
                // Suppress circular dependency warnings
                if (warning.code === 'CIRCULAR_DEPENDENCY') return;
                console.warn(`⚠️  ${warning.message}`);
            }
        });

        await bundle.write({
            file: 'dist/assets/content.js',
            format: 'iife',
            name: 'RepoSpectorContent',
            // Ensure everything is inlined
            inlineDynamicImports: true,
            // Add source maps for debugging
            sourcemap: false
        });

        await bundle.close();
        log('Content script built successfully!', 'success');

        // Verify no imports (check first line for actual import statements, not strings)
        const content = fs.readFileSync('dist/assets/content.js', 'utf8');
        const firstLine = content.split('\n')[0];
        if (firstLine.startsWith('import ') || firstLine.startsWith('import{')) {
            throw new Error('Content script contains import statements!');
        }
        log('Verified: No import statements in content.js', 'success');

    } catch (error) {
        log(`Failed to build content script: ${error.message}`, 'error');
        throw error;
    }
}

async function buildBackgroundScript() {
    log('Building background script (isolated bundle)...');

    try {
        const bundle = await rollup({
            input: 'src/background/index.js',
            plugins: [
                replace({
                    'process.env.NODE_ENV': JSON.stringify('production'),
                    preventAssignment: true
                }),
                nodeResolve({
                    browser: true,
                    preferBuiltins: false,
                    dedupe: ['react', 'react-dom']
                }),
                commonjs({
                    transformMixedEsModules: true,
                    include: ['node_modules/**', 'src/**'],
                    requireReturnsDefault: 'auto'
                }),
                babel({
                    babelHelpers: 'bundled',
                    exclude: 'node_modules/**',
                    presets: [
                        ['@babel/preset-env', {
                            targets: {
                                chrome: '88'
                            }
                        }]
                    ]
                }),
                terser({
                    compress: {
                        drop_console: false,
                    }
                })
            ],
            external: [],
            onwarn: (warning) => {
                if (warning.code === 'CIRCULAR_DEPENDENCY') return;
                console.warn(`⚠️  ${warning.message}`);
            }
        });

        await bundle.write({
            file: 'dist/assets/background.js',
            format: 'iife',
            name: 'RepoSpectorBackground',
            inlineDynamicImports: true,
            sourcemap: false
        });

        await bundle.close();
        log('Background script built successfully!', 'success');

        // Verify no imports (check first line for actual import statements, not strings)
        const content = fs.readFileSync('dist/assets/background.js', 'utf8');
        const firstLine = content.split('\n')[0];
        if (firstLine.startsWith('import ') || firstLine.startsWith('import{')) {
            throw new Error('Background script contains import statements!');
        }
        log('Verified: No import statements in background.js', 'success');

    } catch (error) {
        log(`Failed to build background script: ${error.message}`, 'error');
        throw error;
    }
}

async function buildPopup() {
    log('Building popup (React app)...');

    try {
        // Use Vite for the popup since it can handle React and modules properly
        await viteBuild({
            configFile: false,
            root: __dirname,
            build: {
                outDir: 'dist',
                emptyOutDir: false,
                rollupOptions: {
                    input: {
                        popup: path.resolve(__dirname, 'src/popup/index.html')
                    },
                    output: {
                        entryFileNames: 'assets/[name].js',
                        chunkFileNames: 'assets/[name]-[hash].js',
                        assetFileNames: 'assets/[name].[ext]'
                    }
                }
            },
            resolve: {
                alias: {
                    '@': path.resolve(__dirname, 'src')
                }
            }
        });

        log('Popup built successfully!', 'success');
    } catch (error) {
        log(`Failed to build popup: ${error.message}`, 'error');
        throw error;
    }
}

async function copyAssets() {
    log('Copying manifest and assets...');

    // Copy manifest
    const manifestSrc = fs.readFileSync('src/manifest.json', 'utf8');
    const manifest = JSON.parse(manifestSrc);

    // Ensure no "type": "module" in manifest
    if (manifest.background?.type) {
        delete manifest.background.type;
    }
    if (manifest.content_scripts) {
        manifest.content_scripts.forEach(script => {
            if (script.type) delete script.type;
        });
    }

    fs.writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
    log('Manifest copied and cleaned', 'success');

    // Copy icons
    if (fs.existsSync('src/assets/icons')) {
        fs.cpSync('src/assets/icons', 'dist/assets/icons', { recursive: true });
        log('Icons copied', 'success');
    }

    // Copy other assets
    if (fs.existsSync('src/assets/styles')) {
        fs.cpSync('src/assets/styles', 'dist/assets/styles', { recursive: true });
        log('Styles copied', 'success');
    }
}

async function validateBuild() {
    log('Validating build output...');

    const requiredFiles = [
        'dist/manifest.json',
        'dist/assets/content.js',
        'dist/assets/background.js',
        'dist/src/popup/index.html'
    ];

    for (const file of requiredFiles) {
        if (!fs.existsSync(file)) {
            throw new Error(`Required file missing: ${file}`);
        }
    }

    // Check file sizes
    const contentSize = fs.statSync('dist/assets/content.js').size;
    const backgroundSize = fs.statSync('dist/assets/background.js').size;

    log(`Content script size: ${(contentSize / 1024).toFixed(2)} KB`);
    log(`Background script size: ${(backgroundSize / 1024).toFixed(2)} KB`);

    if (contentSize > 5000000) {
        log('Warning: Content script is larger than 5MB', 'warning');
    }
    if (backgroundSize > 5000000) {
        log('Warning: Background script is larger than 5MB', 'warning');
    }

    log('Build validation passed!', 'success');
}

async function buildExtension() {
    console.log(`${colors.bright}${colors.blue}🚀 Building RepoSpector Chrome Extension${colors.reset}\n`);

    const startTime = Date.now();

    try {
        await cleanDist();

        // Build in parallel where possible
        await Promise.all([
            buildContentScript(),
            buildBackgroundScript()
        ]);

        await buildPopup();
        await copyAssets();
        await validateBuild();

        const buildTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n${colors.bright}${colors.green}✨ Build completed successfully in ${buildTime}s!${colors.reset}`);
        console.log(`${colors.bright}📦 Extension ready in dist/ folder${colors.reset}\n`);

        console.log('Next steps:');
        console.log('1. Open chrome://extensions');
        console.log('2. Enable Developer mode');
        console.log('3. Click "Load unpacked"');
        console.log('4. Select the dist/ folder');
        console.log('5. Test on GitHub/GitLab pages\n');

    } catch (error) {
        console.error(`\n${colors.bright}${colors.red}❌ Build failed!${colors.reset}`);
        console.error(error);
        process.exit(1);
    }
}

// Check if required dependencies are installed
function checkDependencies() {
    const required = [
        'rollup',
        '@rollup/plugin-node-resolve',
        '@rollup/plugin-commonjs',
        '@rollup/plugin-babel',
        '@rollup/plugin-replace',
        'rollup-plugin-terser',
        '@babel/preset-env'
    ];

    const missing = [];
    for (const dep of required) {
        try {
            require.resolve(dep);
        } catch {
            missing.push(dep);
        }
    }

    if (missing.length > 0) {
        console.log(`${colors.yellow}Missing dependencies detected!${colors.reset}`);
        console.log('Please install them with:');
        console.log(`${colors.bright}npm install --save-dev ${missing.join(' ')}${colors.reset}\n`);
        process.exit(1);
    }
}

// Run the build
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    buildExtension();
}