
import { defineConfig } from 'vite';
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

export default defineConfig(({ mode }) => ({
    plugins: [react(), copyAssets()],
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
                content: resolve(__dirname, 'src/content/index.js'),
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
