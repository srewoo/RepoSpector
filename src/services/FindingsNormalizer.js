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
 * Key names LLMs actually emit instead of the schema's. Every entry here was a
 * real drift mode Bastion hit in production (`src/driver/findings_normalizer.py`
 * carries the same table) — a typo'd key is worse than a missing one, because
 * the field silently reads as `undefined` and the finding is dropped or
 * mis-severitied downstream rather than failing loudly.
 */
const KEY_ALIASES = {
    severy: 'severity', severit: 'severity', severtiy: 'severity', Severity: 'severity',
    phse: 'phase', Phase: 'phase',
    categry: 'category', catagory: 'category', Category: 'category',
    rul: 'rule', Rule: 'rule',
    Suggestion: 'suggestion', suggestions: 'suggestion',
    relevantFile: 'file', relevant_file: 'file', filepath: 'file', filePath: 'file',
    lineNumber: 'line', line_number: 'line', startLine: 'line',
    Message: 'message', desc: 'description',
};

/** Categories that indicate a standards-phase finding when `phase` is missing. */
const STANDARDS_CATEGORIES = new Set(['testing', 'lint', 'linter', 'style', 'conventions', 'coverage']);

/** Fields that MUST be strings downstream; a non-string breaks rendering. */
const STRING_FIELDS = {
    category: 'logic',
    suggestion: '',
    rule: '',
    message: '',
    title: '',
};

/**
 * Coerce a model-emitted line value to a positive integer, or null.
 *
 * Handles the forms LLMs actually produce despite being told not to: `"42"`,
 * `"L42"`, `"line 42"`, and ranges like `"42-43"` (first line wins — a range is
 * unpostable, but its start is a usable anchor).
 */
function coerceLine(value) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;

    const m = String(value).match(/\d+/);
    if (!m) return null;
    const n = Number.parseInt(m[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Best-effort scalar → string. Objects/arrays are not representable; use the default. */
function coerceString(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        // A model asked for prose sometimes returns bullet points as an array.
        const flat = value.filter(v => typeof v === 'string' || typeof v === 'number');
        return flat.length ? flat.join(' ') : fallback;
    }
    return fallback;
}

/**
 * Repair schema drift in a list of raw LLM findings BEFORE anything downstream
 * indexes into them.
 *
 * Applied at the orchestrator boundary so both the chunked and single-pass paths
 * get it. Never throws and never drops a finding for being malformed — the worst
 * case is a finding with default values, which a human can still read.
 *
 * @param {Array<Object>} findings
 * @returns {{ findings: Array<Object>, stats: Object }}
 */
export function normalizeFindingKeys(findings) {
    const stats = { input: 0, aliasedKeys: 0, coercedLines: 0, coercedStrings: 0, inferredPhase: 0 };
    const out = [];

    for (const raw of findings ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        stats.input++;

        const f = {};
        for (const [k, v] of Object.entries(raw)) {
            const canonical = KEY_ALIASES[k];
            if (canonical && !(canonical in raw)) {
                // Only rewrite when the canonical key is absent — an explicit
                // correct key always beats a typo'd one in the same object.
                f[canonical] = v;
                stats.aliasedKeys++;
            } else if (canonical) {
                stats.aliasedKeys++;   // drop the duplicate typo'd key
            } else {
                f[k] = v;
            }
        }

        const originalLine = f.line;
        f.line = coerceLine(f.line);
        if (originalLine != null && typeof originalLine !== 'number') stats.coercedLines++;

        for (const [field, fallback] of Object.entries(STRING_FIELDS)) {
            if (!(field in f)) continue;
            const coerced = coerceString(f[field], fallback);
            if (coerced !== f[field]) stats.coercedStrings++;
            f[field] = coerced;
        }

        if (!f.phase) {
            f.phase = STANDARDS_CATEGORIES.has(String(f.category || '').toLowerCase())
                ? 'standards'
                : 'deep';
            stats.inferredPhase++;
        }

        out.push(f);
    }

    return { findings: out, stats };
}

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
