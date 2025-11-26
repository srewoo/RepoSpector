import { build } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildExtension() {
    console.log('🚀 Building Chrome Extension with separate bundles...\n');

    // Clean dist folder
    console.log('🧹 Cleaning dist folder...');
    if (fs.existsSync('dist')) {
        fs.rmSync('dist', { recursive: true });
    }
    fs.mkdirSync('dist/assets', { recursive: true });

    // Build content script (IIFE - no imports, everything inlined)
    console.log('📦 Building content script...');
    await build({
        configFile: false,
        build: {
            lib: {
                entry: resolve(__dirname, 'src/content/index.js'),
                name: 'ContentScript',
                formats: ['iife'],
                fileName: () => 'content.js',
            },
            outDir: 'dist/assets',
            emptyOutDir: false,
            rollupOptions: {
                output: {
                    inlineDynamicImports: true,
                },
            },
        },
    });

    // Build background script (IIFE - no imports, everything inlined)
    console.log('📦 Building background script...');
    await build({
        configFile: false,
        build: {
            lib: {
                entry: resolve(__dirname, 'src/background/index.js'),
                name: 'BackgroundScript',
                formats: ['iife'],
                fileName: () => 'background.js',
            },
            outDir: 'dist/assets',
            emptyOutDir: false,
            rollupOptions: {
                output: {
                    inlineDynamicImports: true,
                },
            },
        },
    });

    // Build popup (can use ES modules, React works fine)
    console.log('📦 Building popup...');
    await build({
        configFile: 'vite.config.js',
        build: {
            rollupOptions: {
                input: {
                    popup: resolve(__dirname, 'src/popup/index.html'),
                },
            },
        },
    });

    // Copy manifest
    console.log('📋 Copying manifest...');
    fs.copyFileSync(
        resolve(__dirname, 'src/manifest.json'),
        resolve(__dirname, 'dist/manifest.json')
    );

    // Copy assets
    console.log('🎨 Copying assets...');
    if (fs.existsSync(resolve(__dirname, 'src/assets'))) {
        fs.cpSync(
            resolve(__dirname, 'src/assets'),
            resolve(__dirname, 'dist/assets'),
            { recursive: true }
        );
    }

    console.log('\n✅ Build complete! Extension is in dist/ folder');
}

buildExtension().catch(console.error);
