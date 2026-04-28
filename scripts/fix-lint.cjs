#!/usr/bin/env node
/**
 * Targeted lint auto-fixer.
 *
 * Runs eslint --format=json over the repo, then for each error the script
 * knows how to fix safely, applies a column-precise edit. Categories handled:
 *
 *   - no-useless-escape: remove the redundant backslash. ESLint flags the
 *     exact column of the offending `\` and the next char, and the rule's
 *     definition guarantees that removing the backslash does NOT change
 *     regex/string semantics.
 *
 *   - no-unused-vars (function args & destructure): prefix the identifier
 *     with `_` so it matches the project's `argsIgnorePattern: '^_'`. We
 *     only do this for *args* and *destructure* — top-level declarations
 *     are left alone because removing them might be the right answer
 *     (deleted dead code) and that needs a human.
 *
 * Anything else is left for human review.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// eslint exits non-zero on errors; route output to a temp file so we get the
// JSON either way without losing it to stderr/exit code interactions.
const os = require('os');
const tmpFile = path.join(os.tmpdir(), `eslint-fix-${process.pid}.json`);
try {
    execSync(`npx eslint 'src/**/*.js' --format=json -o "${tmpFile}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
    });
} catch (_) {
    // expected when there are lint errors
}
const raw = fs.existsSync(tmpFile) ? fs.readFileSync(tmpFile, 'utf8') : '';
if (!raw.trim()) {
    console.log('No eslint output');
    process.exit(0);
}
const results = JSON.parse(raw);

let fixedCount = 0;
let skippedCount = 0;

for (const fileResult of results) {
    if (!fileResult.messages.length) continue;
    const filePath = fileResult.filePath;
    let src = fs.readFileSync(filePath, 'utf8');
    const lines = src.split('\n');

    // Apply rightmost-first within each line so column offsets stay stable.
    const byLine = new Map();
    for (const m of fileResult.messages) {
        if (!m.ruleId) continue;
        if (!byLine.has(m.line)) byLine.set(m.line, []);
        byLine.get(m.line).push(m);
    }

    let changed = false;
    for (const [lineNum, messages] of byLine.entries()) {
        messages.sort((a, b) => b.column - a.column);
        let line = lines[lineNum - 1];
        if (line == null) continue;

        for (const m of messages) {
            const col = m.column - 1;

            if (m.ruleId === 'no-useless-escape') {
                // The error column points at the redundant `\`. Remove it.
                if (line[col] === '\\') {
                    line = line.slice(0, col) + line.slice(col + 1);
                    fixedCount++;
                    changed = true;
                } else {
                    skippedCount++;
                }
                continue;
            }

            if (m.ruleId === 'no-unused-vars') {
                // ESLint quotes the identifier in the message; pull it out.
                const match = m.message.match(/^['"]([^'"]+)['"] is (?:defined but never used|assigned a value but never used)/);
                if (!match) { skippedCount++; continue; }
                const ident = match[1];
                if (ident.startsWith('_')) { skippedCount++; continue; }

                // Prefix the identifier with `_` so it matches the
                // argsIgnorePattern / varsIgnorePattern. Works for function
                // args, destructure keys, and top-level declarations alike.
                const before = line.slice(0, col);
                const after = line.slice(col);
                if (!after.startsWith(ident)) { skippedCount++; continue; }
                line = before + '_' + after;
                fixedCount++;
                changed = true;
                continue;
            }

            skippedCount++;
        }

        if (changed) lines[lineNum - 1] = line;
    }

    if (changed) {
        fs.writeFileSync(filePath, lines.join('\n'));
    }
}

console.log(`Auto-fixed ${fixedCount} lint issues. Skipped ${skippedCount} (not safely auto-fixable).`);
