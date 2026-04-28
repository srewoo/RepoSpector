/**
 * Tests for AdaptiveLearningService.getDismissedRulesSummary — the helper
 * that surfaces "rules the user has repeatedly dismissed" so they can be
 * folded into the next PR analysis prompt.
 *
 * Uses a hand-rolled IndexedDB stub. Bringing in fake-indexeddb just for
 * this would be overkill; the service interacts with IDB via a small set
 * of well-defined APIs, so a focused stub is faster to read.
 */

// Stub BEFORE requiring the service (it captures `indexedDB` from the global).
function createIDBStub() {
    const records = [];
    let nextId = 1;

    function makeIndex(extractKey, equalsRange) {
        return {
            openCursor(range) {
                const matched = records.filter((r) => equalsRange(extractKey(r), range));
                let i = 0;
                const req = { result: null, onsuccess: null, onerror: null };
                const advance = () => {
                    if (i >= matched.length) {
                        req.result = null;
                    } else {
                        const value = matched[i];
                        req.result = {
                            value,
                            continue() { i++; setTimeout(advance, 0); },
                        };
                    }
                    if (req.onsuccess) req.onsuccess({ target: req });
                };
                setTimeout(advance, 0);
                return req;
            },
        };
    }

    const store = {
        add(record) {
            records.push({ id: nextId++, ...record });
            return { onsuccess: null, onerror: null };
        },
        index(name) {
            if (name === 'repoId') {
                return makeIndex(
                    (r) => r.repoId,
                    (key, range) => range._only === key
                );
            }
            if (name === 'ruleRepo') {
                return makeIndex(
                    (r) => [r.ruleId, r.repoId],
                    (key, range) => range._only[0] === key[0] && range._only[1] === key[1]
                );
            }
            return makeIndex(() => null, () => false);
        },
    };

    const tx = {
        oncomplete: null,
        onerror: null,
        objectStore: () => store,
    };
    setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);

    return {
        _records: records,
        open() {
            const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
            setTimeout(() => {
                req.result = {
                    objectStoreNames: { contains: () => true },
                    transaction: () => tx,
                    createObjectStore: () => store,
                };
                if (req.onsuccess) req.onsuccess({ target: req });
            }, 0);
            return req;
        },
    };
}

let idb;
beforeEach(() => {
    idb = createIDBStub();
    global.indexedDB = idb;
    global.IDBKeyRange = {
        only: (val) => ({ _only: val }),
        upperBound: (val) => ({ _upperBound: val }),
    };
});

const { AdaptiveLearningService } = require('../../src/services/AdaptiveLearningService.js');

describe('AdaptiveLearningService.getDismissedRulesSummary', () => {
    it('returns empty when no records exist', async () => {
        const svc = new AdaptiveLearningService();
        const out = await svc.getDismissedRulesSummary('owner/repo');
        expect(out).toEqual([]);
    });

    it('only surfaces rules dismissed at least `dismissalThreshold` times', async () => {
        const svc = new AdaptiveLearningService({ dismissalThreshold: 3 });
        // rule-A: 4 dismissals → surfaces
        // rule-B: 2 dismissals → does not surface
        // rule-C: 5 dismissals → surfaces, ranked first
        const seed = (ruleId, count, sample) => {
            for (let i = 0; i < count; i++) {
                idb._records.push({
                    id: idb._records.length + 1,
                    ruleId, repoId: 'owner/repo', action: 'dismissed',
                    findingMessage: sample, timestamp: Date.now() + i,
                });
            }
        };
        seed('rule-A', 4, 'A sample');
        seed('rule-B', 2, 'B sample');
        seed('rule-C', 5, 'C sample');

        const out = await svc.getDismissedRulesSummary('owner/repo', 10);
        expect(out.map((r) => r.ruleId)).toEqual(['rule-C', 'rule-A']);
        expect(out[0].count).toBe(5);
        expect(out[1].count).toBe(4);
        expect(out[0].sample).toBe('C sample');
    });

    it('respects the limit', async () => {
        const svc = new AdaptiveLearningService({ dismissalThreshold: 1 });
        for (let r = 0; r < 5; r++) {
            for (let i = 0; i < 3; i++) {
                idb._records.push({
                    id: idb._records.length + 1,
                    ruleId: `rule-${r}`, repoId: 'owner/repo', action: 'dismissed',
                    findingMessage: null, timestamp: Date.now(),
                });
            }
        }
        const out = await svc.getDismissedRulesSummary('owner/repo', 2);
        expect(out).toHaveLength(2);
    });

    it('ignores resolves and other repos', async () => {
        const svc = new AdaptiveLearningService({ dismissalThreshold: 2 });
        idb._records.push(
            { id: 1, ruleId: 'rule-A', repoId: 'owner/repo', action: 'resolved', timestamp: 1 },
            { id: 2, ruleId: 'rule-A', repoId: 'owner/repo', action: 'resolved', timestamp: 2 },
            { id: 3, ruleId: 'rule-A', repoId: 'other/repo', action: 'dismissed', timestamp: 3 },
            { id: 4, ruleId: 'rule-A', repoId: 'other/repo', action: 'dismissed', timestamp: 4 },
        );
        const out = await svc.getDismissedRulesSummary('owner/repo');
        expect(out).toEqual([]);
    });
});
