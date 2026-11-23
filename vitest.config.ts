import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@repospector/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // 60 s, not 20: git-heavy tests spawn many processes, and endpoint antivirus scanning on the
    // dev machine made them exceed 20 s under load (6 timeouts in one run, no logic failures).
    testTimeout: 60_000,
  },
});
