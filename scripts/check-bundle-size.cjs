#!/usr/bin/env node
/**
 * Bundle size budget gate.
 *
 * Run after `npm run build`. Exits non-zero (failing CI) if any tracked asset
 * exceeds its budget. Tightening these limits over time is the only way to
 * keep popup load and SW cold-start fast.
 *
 * Note: the popup budget is intentionally generous TODAY (8 MB) to match
 * current reality. Phase 4 (lazy-load mermaid + framer-motion + transformers)
 * is expected to drive this below 1 MB. Lower the budget as that work lands.
 */

const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist');

// [glob/exact path relative to dist, max bytes, label]
const BUDGETS = [
    ['assets/background.js', 1_500_000, 'Service worker'],
    ['assets/content.js', 250_000, 'Content script'],
    ['assets/popup.js', 8_000_000, 'Popup bundle (TODO: lower to 1MB after Phase 4)'],
];

function fileSize(rel) {
    const full = path.join(DIST, rel);
    if (!fs.existsSync(full)) return null;
    return fs.statSync(full).size;
}

function format(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} MB`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)} KB`;
    return `${n} B`;
}

let failed = false;
console.log('\n📦 Bundle size budget check\n');

for (const [rel, max, label] of BUDGETS) {
    const size = fileSize(rel);
    if (size === null) {
        console.error(`❌ ${label}: missing (${rel})`);
        failed = true;
        continue;
    }
    const pct = ((size / max) * 100).toFixed(0);
    const status = size <= max ? '✅' : '❌';
    console.log(`${status} ${label}: ${format(size)} / ${format(max)} (${pct}%)`);
    if (size > max) failed = true;
}

if (failed) {
    console.error('\n❌ Bundle size budget exceeded. Either reduce the bundle or, if intentional, raise the budget in scripts/check-bundle-size.cjs with a justification comment.');
    process.exit(1);
}
console.log('\n✅ All bundles within budget.');
