import fs from 'node:fs';
import path from 'node:path';

/**
 * File-backed replacement for OSVService's `chrome.storage.local` cache.
 *
 * OSVService is the one analysis service with a Chrome dependency, and it is
 * only persistence: `chrome.storage.local.set` (OSVService.js:252) and `.get`
 * (:263). Everything else in it is plain HTTP against api.osv.dev.
 *
 * NOTE (Task 8): OSVService.persistCache()/loadCache() call `chrome.storage
 * .local` directly with no injectable seam — there is no options hook to hand
 * this cache to. Adding one would mean editing src/services/OSVService.js,
 * which is outside this plan's src/ budget (Task 4's single RAGService change
 * is the only src/ edit this plan makes). So this adapter exists and is ready
 * to be wired in the moment OSVService grows a seam, but `review_pr` does not
 * call OSVService today; it names the dependency section as unavailable
 * instead. See src/tools/review.js and the Task 8 report for the decision.
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
