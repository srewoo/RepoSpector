/**
 * MRChunker — split an MR into chunks with a shared mr_brief.
 *
 * Bastion's docs/Chunking_Design.md teaches: when you split an MR for
 * parallel review, each chunk loses cross-chunk visibility. The fix is a
 * `mr_brief` — a compact summary of cross-cutting changes (removed exports,
 * signature changes, shared contracts, renames) extracted ONCE from the
 * full diff and inlined into every chunk's prompt. Without it, chunked
 * reviews miss coupling bugs that span chunks.
 *
 * This module is a thin layer over the existing FileGroupingStrategy:
 *   buildBrief()   — pure diff analysis, produces the shared brief
 *   chunkMR()      — groups files into review units, returns
 *                    { chunks: [{ index, total, files, loc, reason }],
 *                      brief, fullDiffSummary }
 *
 * Heuristics are deliberately lightweight (regex-based) — good enough to
 * surface most coupling signals without paying for an extra LLM pass.
 */

import { FileGroupingStrategy } from './FileGroupingStrategy.js';

const DEFAULT_OPTS = Object.freeze({
    maxFilesPerChunk: 15,
    maxLocPerChunk: 1500,
    chunkingThresholdFiles: 20,
    chunkingThresholdLoc: 2000,
});

/**
 * Decide whether an MR is large enough to warrant chunking.
 */
export function shouldChunk(files, opts = {}) {
    const o = { ...DEFAULT_OPTS, ...opts };
    if (!Array.isArray(files)) return false;
    const totalLoc = files.reduce(
        (acc, f) => acc + (f.additions ?? 0) + (f.deletions ?? 0),
        0,
    );
    return files.length >= o.chunkingThresholdFiles || totalLoc >= o.chunkingThresholdLoc;
}

/**
 * Build the shared mr_brief from the raw diff. Heuristics:
 *   - removed_exports:    `-export ...` lines on the deleted side
 *   - added_exports:      `+export ...` lines on the new side
 *   - changed_signatures: function/method declarations that appear on
 *                          both - and + (signature flux)
 *   - shared_contracts:   filenames matching well-known contract patterns
 *                          (*.proto, openapi*, *.graphql, schema*.json/yaml)
 *   - rename_pairs:       files with same basename across old/new paths
 *   - coupling_hints:     paths that share a directory prefix with > 1 file
 */
export function buildBrief(prData) {
    const files = prData?.files ?? [];
    const removedExports = new Set();
    const addedExports = new Set();
    const changedSignatures = new Set();
    const sharedContracts = new Set();
    const renamePairs = [];
    const dirCounts = new Map();

    for (const f of files) {
        const newPath = f.filename ?? f.new_path ?? f.path ?? '';
        const oldPath = f.previous_filename ?? f.old_path ?? newPath;

        if (newPath && oldPath && newPath !== oldPath) {
            renamePairs.push({ from: oldPath, to: newPath });
        }

        if (isContractFile(newPath)) sharedContracts.add(newPath);

        const dir = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '.';
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);

        const patch = f.patch ?? f.diff ?? '';
        if (!patch) continue;

        const sigRemoved = new Map();
        const sigAdded = new Map();

        for (const rawLine of patch.split('\n')) {
            if (rawLine.startsWith('+++') || rawLine.startsWith('---') || rawLine.startsWith('@@')) continue;

            const isAdd = rawLine.startsWith('+');
            const isDel = rawLine.startsWith('-');
            if (!isAdd && !isDel) continue;
            const body = rawLine.slice(1);

            // Exports
            const exp = extractExport(body);
            if (exp) {
                (isAdd ? addedExports : removedExports).add(`${newPath}::${exp}`);
            }

            // Function/method signatures
            const sig = extractSignature(body);
            if (sig) {
                const map = isAdd ? sigAdded : sigRemoved;
                map.set(sig.name, sig.signature);
            }
        }

        // Changed signatures = functions present on both sides with
        // different signatures.
        for (const [name, oldSig] of sigRemoved) {
            const newSig = sigAdded.get(name);
            if (newSig && newSig !== oldSig) {
                changedSignatures.add(`${newPath}::${name}`);
            }
        }
    }

    const couplingHints = [...dirCounts.entries()]
        .filter(([, n]) => n > 1)
        .map(([dir, n]) => ({ dir, files: n }))
        .sort((a, b) => b.files - a.files)
        .slice(0, 10);

    return {
        removed_exports: [...removedExports],
        added_exports: [...addedExports],
        changed_signatures: [...changedSignatures],
        shared_contracts: [...sharedContracts],
        rename_pairs: renamePairs,
        coupling_hints: couplingHints,
    };
}

function isContractFile(path) {
    if (!path) return false;
    return /\.(proto|graphql|gql)$/i.test(path)
        || /openapi[^/]*\.(ya?ml|json)$/i.test(path)
        || /(^|\/)schema[^/]*\.(ya?ml|json)$/i.test(path)
        || /\.thrift$/i.test(path);
}

// Captures `export ... <name>` for JS/TS. Doesn't try to be exhaustive —
// false positives here just produce noisier briefs, not wrong reviews.
const EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const RE_EXPORT_CURLY = /^\s*export\s*\{\s*([^}]+)\}/;

function extractExport(body) {
    const m1 = body.match(EXPORT_RE);
    if (m1) return m1[1];
    const m2 = body.match(RE_EXPORT_CURLY);
    if (m2) return m2[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).join('|');
    return null;
}

// JS/TS function-style declarations. Captures name + arg list as the signature.
const FN_RE = /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
const METHOD_RE = /^\s*(?:public|private|protected|static|async)?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*[:{]/;
const ARROW_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(([^)]*)\)\s*=>/;

function extractSignature(body) {
    for (const re of [FN_RE, ARROW_RE, METHOD_RE]) {
        const m = body.match(re);
        if (m) return { name: m[1], signature: `${m[1]}(${m[2].trim()})` };
    }
    return null;
}

/**
 * Chunk an MR. Returns { chunks[], brief, summary }.
 *
 * Each chunk shape:
 *   { index, total, files: [...], loc, reason }
 *
 * `reason` documents the grouping decision (single-file / grouped-by-dir /
 * forced-split-oversized). The mr_brief is the SAME object on every chunk
 * — callers should inline it into each chunk prompt verbatim.
 */
export function chunkMR(prData, opts = {}) {
    const o = { ...DEFAULT_OPTS, ...opts };
    const files = prData?.files ?? [];
    const brief = buildBrief(prData);

    if (!shouldChunk(files, o)) {
        return {
            chunks: [
                {
                    index: 1,
                    total: 1,
                    files,
                    loc: locOf(files),
                    reason: 'single_pass',
                },
            ],
            brief,
            summary: { totalFiles: files.length, totalChunks: 1, chunked: false },
        };
    }

    const strategy = new FileGroupingStrategy();
    const units = strategy.group(files, {});

    // Pack grouping units into chunks bounded by maxFiles/maxLoc.
    const chunks = [];
    let cur = { files: [], loc: 0 };
    const flush = (reason) => {
        if (cur.files.length === 0) return;
        chunks.push({ files: cur.files, loc: cur.loc, reason });
        cur = { files: [], loc: 0 };
    };

    for (const u of units) {
        const uFiles = u.files ?? [];
        const uLoc = locOf(uFiles);
        // Unit too big on its own — split files individually.
        if (uLoc > o.maxLocPerChunk || uFiles.length > o.maxFilesPerChunk) {
            flush('size_packed');
            for (const f of uFiles) {
                chunks.push({
                    files: [f],
                    loc: locOf([f]),
                    reason: 'forced_split_oversized',
                });
            }
            continue;
        }
        // Doesn't fit in current chunk — start a new one.
        if (
            cur.files.length + uFiles.length > o.maxFilesPerChunk
            || cur.loc + uLoc > o.maxLocPerChunk
        ) {
            flush('size_packed');
        }
        cur.files.push(...uFiles);
        cur.loc += uLoc;
    }
    flush('size_packed');

    const total = chunks.length;
    return {
        chunks: chunks.map((c, i) => ({ index: i + 1, total, ...c })),
        brief,
        summary: { totalFiles: files.length, totalChunks: total, chunked: true },
    };
}

function locOf(files) {
    let n = 0;
    for (const f of files) n += (f.additions ?? 0) + (f.deletions ?? 0);
    return n;
}
