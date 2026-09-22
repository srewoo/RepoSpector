import { parsePatchHunks } from '../../../../src/utils/patchLines.js';

/**
 * Diff files as the shape `anchorFindings` reads: one entry per changed file,
 * its patch parsed into numbered hunks.
 *
 * The extension's orchestrator derives the same shape from its own file list;
 * this is the MCP server's copy of that step, kept here so both the sampling
 * path and the delegated-submission path build it identically.
 */
export function parsedFilesFrom(diffFiles) {
    const out = [];
    for (const f of diffFiles ?? []) {
        const newPath = f?.filename ?? f?.new_path ?? f?.path;
        if (!newPath) continue;
        out.push({ newPath, hunks: parsePatchHunks(f?.patch ?? f?.diff ?? '') });
    }
    return out;
}

export default { parsedFilesFrom };
