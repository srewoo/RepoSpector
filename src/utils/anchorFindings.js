/**
 * anchorFindings — resolve a finding's line number from the code it quotes,
 * instead of trusting the line number the model reported.
 *
 * A model asked for a line number guesses one. It reads the hunk header, counts
 * forward, and drifts — most often by the number of deleted lines above the
 * defect. Downstream that drift is not visible as drift: `filterToAssignedHunks`
 * either snaps the finding onto whatever changed line happens to sit within ±3,
 * or drops it. A real defect then either points at unrelated code or disappears,
 * and neither outcome says anything went wrong.
 *
 * The fix is to stop asking. A finding that quotes the code it is about carries
 * its own position: the quote is a verbatim excerpt, so locating it is string
 * matching over hunks already parsed, with no model and no ambiguity about what
 * the answer means. `evidence` is the field the prompts have always asked for —
 * this is what finally reads it.
 *
 * Three resolutions, in order:
 *   1. the evidence matches consecutive lines in the finding's own file → anchor
 *   2. it matches in exactly one OTHER changed file → re-file the finding there
 *      (a cross-file claim filed against the wrong path is common and, once
 *      relocated, correct)
 *   3. no match, or several across files → leave the finding untouched and say
 *      so, because guessing between candidates trades one wrong line for another
 *
 * Ported from alibaba/open-code-review's positioning module, which reports this
 * as the single largest source of its precision lead over prompt-only review.
 */

/** Whitespace-insensitive form of one line: indentation and run-length carry no position information. */
export function normalizeLine(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** The quoted evidence as normalized, non-empty lines. */
function targetLines(evidence) {
    return String(evidence ?? '').split('\n').map(normalizeLine).filter(Boolean);
}

/**
 * One side of a parsed patch as (line number, normalized content) pairs, in
 * file order.
 *
 * New side = context + added (numbers are new-file lines); old side = context +
 * deleted. Both are tried because a finding may legitimately quote a line the
 * change removed.
 */
function sideLines(hunks, newSide) {
    const out = [];
    for (const h of hunks ?? []) {
        for (const l of h.lines ?? []) {
            const keep = newSide
                ? (l.type === 'added' || l.type === 'context')
                : (l.type === 'deleted' || l.type === 'context');
            if (!keep) continue;
            const n = newSide ? l.number?.new : l.number?.old;
            if (n == null) continue;
            out.push({ n, t: normalizeLine(l.content) });
        }
    }
    return out;
}

/**
 * Every place `target` appears as a consecutive run in `side`.
 *
 * Blank lines inside the run are skipped rather than matched: a model quoting a
 * multi-line construct reproduces its code faithfully and its blank lines
 * arbitrarily, so requiring them to line up loses correct matches.
 */
function matchRuns(side, target) {
    const hits = [];
    if (!side.length || !target.length) return hits;

    for (let i = 0; i < side.length; i++) {
        let k = i;
        let j = 0;
        let end = -1;
        while (j < target.length && k < side.length) {
            if (!side[k].t) { k++; continue; }   // blank diff line — not a claim
            if (side[k].t !== target[j]) break;
            end = side[k].n;
            k++;
            j++;
        }
        if (j === target.length) hits.push({ start: side[i].n, end });
    }
    return hits;
}

/**
 * Pick the hit nearest `near`, or the first when the finding named no line.
 *
 * A one-line quote can genuinely occur several times in a file. The model's own
 * line number is poor evidence of position but decent evidence of neighbourhood,
 * so it is used to choose between candidates and never to produce one.
 */
function pickHit(hits, near) {
    if (hits.length <= 1) return hits[0] ?? null;
    if (!Number.isFinite(near)) return hits[0];
    return hits.reduce((best, h) =>
        Math.abs(h.start - near) < Math.abs(best.start - near) ? h : best);
}

/** Locate `evidence` within one file's hunks. New side first, then old. */
export function locateInHunks(evidence, hunks, near = null) {
    const target = targetLines(evidence);
    if (!target.length) return null;
    for (const newSide of [true, false]) {
        const hit = pickHit(matchRuns(sideLines(hunks, newSide), target), near);
        if (hit) return hit;
    }
    return null;
}

const pathOf = (f) => String(f?.file ?? f?.filePath ?? f?.path ?? '').trim();
const evidenceOf = (f) => String(f?.evidence ?? f?.codeSnippet ?? f?.existingCode ?? '').trim();

/**
 * Anchor a list of findings against the changed files.
 *
 * @param {Array<Object>} findings
 * @param {Array<{newPath: string, hunks: Array}>} parsedFiles - from `toParsedFiles`/`parsePatchHunks`
 * @returns {{findings: Array<Object>, stats: {anchored:number, relocated:number, unmatched:number, unevidenced:number, moved:number}}}
 *
 * Findings are returned as new objects carrying `line`, `endLine` and an
 * `anchor` field recording which of the three resolutions applied. Nothing is
 * dropped here: an unmatched finding keeps the line it arrived with, and the
 * hunk filter downstream decides its fate as before.
 */
export function anchorFindings(findings, parsedFiles) {
    const stats = { anchored: 0, relocated: 0, unmatched: 0, unevidenced: 0, moved: 0 };
    const list = Array.isArray(findings) ? findings : [];
    const files = Array.isArray(parsedFiles) ? parsedFiles : [];
    if (!list.length || !files.length) return { findings: list, stats };

    const byPath = new Map(files.map((f) => [f.newPath, f]));

    const out = list.map((f) => {
        if (!f || typeof f !== 'object') return f;

        const evidence = evidenceOf(f);
        if (!evidence) {
            stats.unevidenced++;
            return { ...f, anchor: 'unevidenced' };
        }

        const near = Number.isFinite(Number(f.line)) ? Number(f.line) : null;
        const own = byPath.get(pathOf(f));

        const hit = own ? locateInHunks(evidence, own.hunks, near) : null;
        if (hit) {
            stats.anchored++;
            if (near != null && near !== hit.start) stats.moved++;
            return { ...f, line: hit.start, endLine: hit.end, anchor: 'exact' };
        }

        // The finding's own file cannot account for the quote. Exactly one other
        // changed file that can is a mis-filing, not a coincidence; two or more
        // is boilerplate, and choosing between them is guessing.
        const elsewhere = [];
        for (const pf of files) {
            if (pf === own) continue;
            const h = locateInHunks(evidence, pf.hunks, null);
            if (h) elsewhere.push({ path: pf.newPath, ...h });
            if (elsewhere.length > 1) break;
        }
        if (elsewhere.length === 1) {
            stats.relocated++;
            const [e] = elsewhere;
            return {
                ...f,
                file: e.path,
                line: e.start,
                endLine: e.end,
                anchor: 'relocated',
                anchorMovedFrom: pathOf(f) || null,
            };
        }

        stats.unmatched++;
        return { ...f, anchor: 'unmatched' };
    });

    return { findings: out, stats };
}

export default { anchorFindings, locateInHunks, normalizeLine };
