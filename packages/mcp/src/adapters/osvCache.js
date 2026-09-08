import fs from 'node:fs';
import path from 'node:path';

/**
 * File-backed replacement for OSVService's `chrome.storage.local` cache.
 *
 * OSVService is the one analysis service with a Chrome dependency, and it is
 * only persistence: `chrome.storage.local.set` (OSVService.js:252) and `.get`
 * (:263). Everything else in it is plain HTTP against api.osv.dev.
 *
 * WIRED. `OSVService` takes `options.cache` and uses it in place of
 * `chrome.storage.local` when given, so `review_pr` hands this over instead of
 * reporting its dependency section as unavailable — which is what it did for
 * as long as this adapter sat unwired. The cache file lives beside the index
 * snapshot; see the `dependencies` section in src/tools/review.js.
 */
export function createFileOsvCache(dir) {
    const file = path.join(dir, 'osv-vuln-cache.json');
    return {
        save(data) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify(data));
                return true;
            } catch {
                return false; // a cache that cannot be written must not fail a review
            }
        },
        load() {
            try {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                return null;
            }
        },
    };
}
