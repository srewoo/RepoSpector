
import { defineConfig, build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';

// Custom plugin to copy manifest and assets
const copyAssets = () => {
    return {
        name: 'copy-assets',
        writeBundle() {
            // Copy manifest
            fs.copyFileSync(
                resolve(__dirname, 'src/manifest.json'),
                resolve(__dirname, 'dist/manifest.json')
            );

            // Copy assets directory if it exists
            if (fs.existsSync(resolve(__dirname, 'src/assets'))) {
                fs.cpSync(
                    resolve(__dirname, 'src/assets'),
                    resolve(__dirname, 'dist/assets'),
                    { recursive: true }
                );
            }
        }
    };
};

// Build content script separately as IIFE (content scripts can't use ES modules)
// Build offscreen document separately (needs its own HTML entry + bundled JS)
const buildSecondaryEntries = () => {
    return {
        name: 'build-secondary-entries',
        async closeBundle() {
            // 1. Content script as IIFE (no ES module imports allowed)
            await viteBuild({
                configFile: false,
                resolve: {
                    alias: {
                        '@': resolve(__dirname, 'src'),
                    },
                },
                build: {
                    rollupOptions: {
                        input: resolve(__dirname, 'src/content/index.js'),
                        output: {
                            entryFileNames: 'assets/content.js',
                            format: 'iife',
                        },
                    },
                    outDir: resolve(__dirname, 'dist'),
                    emptyOutDir: false,
                    sourcemap: false,
                    minify: 'terser',
                    terserOptions: {
                        compress: { drop_console: false },
                    },
                },
            });

            // 2. Offscreen document (HTML + ES module for Transformers.js)
            await viteBuild({
                configFile: false,
                resolve: {
                    alias: {
                        '@': resolve(__dirname, 'src'),
                    },
                },
                build: {
                    rollupOptions: {
                        input: resolve(__dirname, 'src/offscreen.html'),
                        output: {
                            entryFileNames: 'offscreen/[name].js',
                            chunkFileNames: 'offscreen/chunk-[name]-[hash].js',
                            assetFileNames: 'offscreen/[name].[ext]',
                            format: 'es',
                        },
                    },
                    outDir: resolve(__dirname, 'dist'),
                    emptyOutDir: false,
                    sourcemap: false,
                    minify: 'terser',
                    terserOptions: {
                        compress: { drop_console: false },
                    },
                },
            });

            // Move offscreen.html from dist/src/ to dist/ root (service expects it at extension root)
            const builtHtml = resolve(__dirname, 'dist/src/offscreen.html');
            const destHtml = resolve(__dirname, 'dist/offscreen.html');
            if (fs.existsSync(builtHtml)) {
                fs.copyFileSync(builtHtml, destHtml);
                fs.rmSync(resolve(__dirname, 'dist/src/offscreen.html'));
                // Clean up empty dist/src if only offscreen.html was there
                try {
                    const remaining = fs.readdirSync(resolve(__dirname, 'dist/src'));
                    if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === 'popup')) {
                        // Keep dist/src/popup but nothing else needed
                    }
                } catch (e) { /* ignore */ }
            }
        }
    };
};

export default defineConfig(({ mode }) => ({
    plugins: [react(), copyAssets(), buildSecondaryEntries()],
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
    build: {
        rollupOptions: {
            input: {
                popup: resolve(__dirname, 'src/popup/index.html'),
                background: resolve(__dirname, 'src/background/index.js'),
            },
            output: {
                entryFileNames: 'assets/[name].js',
                chunkFileNames: 'assets/chunk-[name]-[hash].js',
                assetFileNames: 'assets/[name].[ext]',
                format: 'es',
                // Force inlining by preventing chunk generation
                inlineDynamicImports: false,
                manualChunks(id) {
                    // Never create separate chunks for shared dependencies
                    // This forces duplication but prevents import errors
                    return undefined;
                },
                // Preserve module structure to avoid breaks
                preserveModules: false,
            },
        },
        // Force Rollup to bundle everything inline
        commonjsOptions: {
            transformMixedEsModules: true,
        },
        outDir: 'dist',
        emptyOutDir: true,
        // Disable source maps for production
        sourcemap: false,
        // Use terser for better minification
        minify: 'terser',
        terserOptions: {
            compress: {
                // Keep console logs for debugging
                drop_console: false,
            },
        },
    },
    // Optimize dependencies
    optimizeDeps: {
        include: [
            'react',
            'react-dom',
            'lucide-react',
            'framer-motion',
            'clsx',
            'tailwind-merge',
        ],
    },
}));
