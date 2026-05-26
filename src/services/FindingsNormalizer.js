/**
 * FindingsNormalizer — hard-filter findings to the MR's changed hunks.
 *
 * Mirrors Bastion's `assigned_hunks` mechanism: the LLM often emits findings
 * for unchanged code (because it can see the file's full context). Those are
 * noise — the reviewer can't act on code outside the diff. We drop them at
 * the boundary so the UI only renders findings the reviewer can engage with.
 *
 * Three behaviours per finding:
 *   - file-level (line == null): keep if file is in the diff
 *   - hunk-line match: keep
 *   - near-miss (within `snapWindow` lines): snap line + keep (LLM off-by-one)
 *   - outside: drop, counted in `droppedOutsideDiff`
 */

import { DiffParser } from '../utils/diffParser.js';

/**
 * Build the assigned-hunks allow-list from parsed diff files.
 * Returns Map<filePath, Set<lineNumber>> on the NEW side.
 */
export function buildAssignedHunks(parsedFiles) {
    const allow = new Map();
    if (!Array.isArray(parsedFiles)) return allow;

    for (const file of parsedFiles) {
        const path = file.newPath ?? file.new_path ?? file.filename ?? file.oldPath;
        if (!path) continue;

        let set = allow.get(path);
        if (!set) {
            set = new Set();
            allow.set(path, set);
        }

        const hunks = file.hunks ?? [];
        for (const hunk of hunks) {
            // Prefer per-line numbers (most accurate — accounts for deleted lines).
            if (Array.isArray(hunk.lines) && hunk.lines.length) {
                for (const ln of hunk.lines) {
                    if (ln.type === 'added' && ln.number?.new != null) {
                        set.add(ln.number.new);
                    }
                }
                continue;
            }
            // Fallback: range from hunk header.
            const start = hunk.newStart ?? hunk.new_start;
            const span = hunk.newLines ?? hunk.new_lines ?? 1;
            if (Number.isFinite(start)) {
                for (let i = 0; i < span; i++) set.add(start + i);
            }
        }
    }
    return allow;
}

/**
 * Parse a raw unified-diff string into the allow-list. Convenience wrapper.
 */
export async function buildAssignedHunksFromDiff(diffText, platform = 'github') {
    const parser = new DiffParser();
    const parsed = await parser.parseDiff(diffText, { platform });
    return buildAssignedHunks(parsed.files);
}

/**
 * Filter a list of canonical Findings down to those that live inside the
 * changed hunks. Returns { kept, dropped, snapped, stats }.
 *
 * opts:
 *   snapWindow: number of lines on either side a finding may snap to the
 *               nearest changed line (default 3). 0 disables snapping.
 *   keepFileLevel: keep findings with line==null when the file is in the
 *                  diff (default true).
 */
export function filterToAssignedHunks(findings, assignedHunks, opts = {}) {
    const snapWindow = Number.isFinite(opts.snapWindow) ? opts.snapWindow : 3;
    const keepFileLevel = opts.keepFileLevel !== false;

    const kept = [];
    const dropped = [];
    let snapped = 0;

    for (const f of findings ?? []) {
        if (!f) continue;

        const file = f.file;
        if (!file || !assignedHunks.has(file)) {
            dropped.push({ ...f, _dropReason: file ? 'file_not_in_diff' : 'no_file' });
            continue;
        }

        const allowSet = assignedHunks.get(file);

        // File-level finding — keep iff allowed.
        if (f.line == null) {
            if (keepFileLevel) {
                kept.push(f);
            } else {
                dropped.push({ ...f, _dropReason: 'file_level_disabled' });
            }
            continue;
        }

        if (allowSet.has(f.line)) {
            kept.push(f);
            continue;
        }

        // Try snapping to nearest allowed line within window.
        if (snapWindow > 0) {
            const snap = nearestWithin(f.line, allowSet, snapWindow);
            if (snap != null) {
                kept.push({ ...f, line: snap, _snappedFrom: f.line });
                snapped++;
                continue;
            }
        }

        dropped.push({ ...f, _dropReason: 'outside_assigned_hunks' });
    }

    return {
        kept,
        dropped,
        stats: {
            input: (findings ?? []).length,
            kept: kept.length,
            dropped: dropped.length,
            snapped,
        },
    };
}

function nearestWithin(line, allowSet, window) {
    let best = null;
    let bestDist = Infinity;
    for (let d = 1; d <= window; d++) {
        if (allowSet.has(line - d) && d < bestDist) { best = line - d; bestDist = d; }
        if (allowSet.has(line + d) && d < bestDist) { best = line + d; bestDist = d; }
    }
    return best;
}
