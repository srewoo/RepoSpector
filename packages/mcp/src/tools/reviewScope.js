import { parsePatchHunks } from '../../../../src/utils/patchLines.js';
import { isCodeSourcePath } from '../../../../src/utils/codeFileFilter.js';

/**
 * Scope the graph and coverage sections to the change under review.
 *
 * Both sections used to answer a question nobody asked. `graph_context`
 * returned `pipeline.getStats()` — repo-wide counts — under a rubric promising
 * "callers and callees of the touched symbols". `covering_tests` returned a
 * whole-graph aggregate: `coverageRatio: 0.04` across 360 test files, true and
 * useless, and silent about the five test files the change deleted.
 *
 * A deletion-heavy review turns on two questions: who still calls what you
 * removed, and what coverage leaves with it. Neither section could express
 * either, so every caller check on a real review was done by hand with grep.
 */

/** Deleted lines of a patch, joined — where a removed symbol's name still is. */
function deletedText(patch) {
    let text = '';
    for (const hunk of parsePatchHunks(patch || '')) {
        for (const line of hunk.lines) {
            if (line.type === 'deleted') text += `${line.content}\n`;
        }
    }
    return text;
}

/**
 * Added lines with COMMENT bodies removed.
 *
 * A deletion is detected by its name vanishing from the added lines — and a
 * change that documents what it removed names the removed thing in a comment,
 * which made the detector blind to exactly the best-documented deletions. On
 * the review that exposed this, `findSimilar`, `findSimilarBatch`,
 * `addTestCases` and `buildContext` were all deleted, each replaced by a
 * comment naming it, and not one was reported. A mention is not a declaration.
 */
function addedCode(patch) {
    return addedText(patch)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
        .join('\n');
}

/** Added lines of a patch, joined. */
function addedText(patch) {
    let text = '';
    for (const hunk of parsePatchHunks(patch || '')) {
        for (const line of hunk.lines) {
            if (line.type !== 'deleted') text += `${line.content}\n`;
        }
    }
    return text;
}

/**
 * Does this patch delete the file outright — is there nothing left of it?
 *
 * "Deletions and no additions" is not enough: a hunk that removes three lines
 * and keeps a fourth as context is an edit, and counting it as a deletion made
 * every symbol in an edited file look trivially removed. What distinguishes a
 * real deletion is that NO line survives on the new side — no additions and no
 * context either.
 */
export function isFileDeletion(file) {
    if (file?.status === 'removed' || file?.status === 'deleted') return true;
    const hunks = parsePatchHunks(file?.patch || file?.diff || '');
    if (hunks.length === 0) return false;
    let deleted = 0;
    let survives = 0;
    for (const hunk of hunks) {
        for (const line of hunk.lines) {
            if (line.type === 'deleted') deleted += 1;
            else survives += 1;
        }
    }
    return deleted > 0 && survives === 0;
}

/**
 * Code with comments and string bodies removed, for asking "is this DECLARED
 * here" without a mention in prose counting as one.
 */
function codeOnly(text) {
    return String(text || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '""')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
}

/**
 * Does `content` still DECLARE `name`?
 *
 * A declaration is the name in a defining position — followed by `(`, `=`, `:`
 * or `<` — and not reached through a dot, which is a call or a property read.
 * `this.findSimilar(1)` is a surviving CALL to something no longer declared,
 * which is a defect worth reporting, not evidence the symbol is still there.
 */
function declares(content, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The follow set has to include `{`, `extends` and `implements`: a class or
    // interface declaration is `class X {`, and requiring `(`, `=`, `:` or `<`
    // reported a surviving class as removed on a real review, where the change
    // only dropped `implements OnModuleInit` from its declaration line.
    return new RegExp(
        `(^|[^.\\w$])(?:async\\s+|function\\s+|class\\s+|interface\\s+|type\\s+|enum\\s+`
        + `|const\\s+|let\\s+|var\\s+|get\\s+|set\\s+|export\\s+|default\\s+|abstract\\s+)*`
        + `${escaped}\\s*(?:[(=:<{]|extends\\b|implements\\b)`,
        'm',
    )
        .test(codeOnly(content));
}

/** Conventional test-file shapes, matching what TestCoverageBuilder recognises. */
export function isTestFile(filename) {
    return /(^|\/)(test|tests|spec|__tests__)\//i.test(String(filename || ''))
        || /\.(test|spec)\.[jt]sx?$/i.test(String(filename || ''));
}

const namesOf = (graph, ids) => [...new Set(
    ids.map((id) => graph.getNode(id)?.properties?.name).filter(Boolean),
)];

/**
 * Callers and callees of the symbols this diff touches, plus the symbols it
 * removes — the section `graph_context` should have been all along.
 *
 * `getNodesByFile` returns the File node too, which is not a symbol; it is
 * filtered by `label !== 'File'`, the same discriminator
 * `CodeGraphPipeline._rebuildSymbolTable` uses.
 *
 * @param {object} graph KnowledgeGraphService, or anything with its readers.
 * @param {Array<{filename?: string, patch?: string}>} diffFiles
 * @param {{maxSymbols?: number, maxEdges?: number, stats?: object, parser?: string}} [opts]
 */
export function touchedSymbolContext(graph, diffFiles = [], opts = {}) {
    // File contents at the reviewed revision, when the caller has them (the
    // static section already reads them). With these, removal is a fact about
    // the revision rather than a guess from patch text — the guess reported two
    // KEPT symbols as removed on a real review because a doc comment mentioning
    // them was rewritten while their declarations sat outside the hunk.
    const headContent = opts.headContentByPath instanceof Map ? opts.headContentByPath : null;
    const maxSymbols = opts.maxSymbols ?? 60;
    const maxEdges = opts.maxEdges ?? 10;
    const symbols = [];
    const removed = [];
    const filesWithoutSymbols = [];

    if (!graph?.getNodesByFile) {
        return {
            symbols, removed, filesWithoutSymbols, graph: opts.stats ?? null, parser: opts.parser,
            note: 'no graph is available, so no caller or callee could be resolved',
        };
    }

    // Which files get looked at first, and how much of the budget each may
    // take. A first-come cap in git's file order spent all 60 symbols on the
    // first few files of a real review and never reached the two whose
    // deletions the review was about. So: files with the most deleted lines
    // first — a deletion is the risk — and an even per-file allowance, with
    // whatever the small files leave over redistributed.
    const withSymbols = [];
    for (const file of diffFiles) {
        const filename = file?.filename;
        if (!filename) continue;
        const nodes = (graph.getNodesByFile(filename) || []).filter((n) => n.label !== 'File');
        if (nodes.length === 0) {
            filesWithoutSymbols.push(filename);
            continue;
        }
        const gone = deletedText(file.patch || file.diff);
        withSymbols.push({
            file,
            filename,
            nodes,
            gone,
            // Comment bodies stripped: see `addedCode`.
            kept: addedCode(file.patch || file.diff),
            wholeFileDeleted: isFileDeletion(file),
            deletedLines: gone ? gone.split('\n').length : 0,
        });
    }
    withSymbols.sort((a, b) => b.deletedLines - a.deletedLines);

    const perFile = withSymbols.length > 0
        ? Math.max(1, Math.floor(maxSymbols / withSymbols.length))
        : maxSymbols;

    const seen = new Set();

    /**
     * Record one symbol, and judge whether the change removes it.
     *
     * Shared by both budget passes on purpose: the two used to differ, and the
     * pass that ran second recorded symbols without the removal check.
     *
     * @returns {boolean} whether it counted against the file's allowance.
     */
    const take = (entry, node) => {
        const name = node.properties?.name;
        if (!name) return false;
        const key = `${entry.filename} ${name}`;
        if (seen.has(key)) return false;
        seen.add(key);

        const calledBy = edgeNames(graph, node.id, 'to', maxEdges, entry.filename);
        const calls = edgeNames(graph, node.id, 'from', maxEdges, entry.filename);
        symbols.push({
            name, file: entry.filename, label: node.label, calledBy, calls,
        });

        // A name in the deleted lines and not in the added CODE is gone from
        // this file. Callers that remain are the whole risk of a deletion, so
        // they are surfaced separately rather than left for the reader to spot.
        //
        // A wholly deleted file contributes nothing here: every symbol in it is
        // trivially removed, which buried the handful that matter under a
        // deleted test file's own helpers. `filesDeleted` names those files
        // instead, and `covering_tests` details the test ones.
        const mentioned = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (entry.wholeFileDeleted || !mentioned.test(entry.gone)) return true;

        const head = headContent?.get(entry.filename);
        const isGone = head !== undefined
            ? !declares(head, name)
            : !mentioned.test(entry.kept);
        if (isGone) removed.push({ name, file: entry.filename, calledBy });
        return true;
    };

    for (const entry of withSymbols) {
        // Symbols this file's diff deletes come first within the file: under a
        // tight budget a removed symbol matters more than a touched one.
        const declaredIn = (name, text) => new RegExp(
            `\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        ).test(text);
        const nodes = [...entry.nodes].sort((a, b) => {
            const aGone = declaredIn(a.properties?.name ?? '', entry.gone) ? 0 : 1;
            const bGone = declaredIn(b.properties?.name ?? '', entry.gone) ? 0 : 1;
            return aGone - bGone;
        });

        let takenHere = 0;
        for (const node of nodes) {
            if (symbols.length >= maxSymbols) break;
            // Past its allowance, a file yields to the rest — unless nothing
            // else wants the room, which the second pass below picks up.
            if (takenHere >= perFile) break;
            if (take(entry, node)) takenHere += 1;
        }
    }

    // Second pass: hand out what the per-file allowance left unspent, so a
    // budget is never returned unused while a wide file had more to say. It
    // goes through the SAME `take`, because when it had its own copy of the
    // logic it recorded symbols without ever checking them for removal — which
    // put the four deletions the reviewed change is named after in `symbols`
    // and none of them in `removed`.
    for (const entry of withSymbols) {
        if (symbols.length >= maxSymbols) break;
        for (const node of entry.nodes) {
            if (symbols.length >= maxSymbols) break;
            take(entry, node);
        }
    }

    const capped = symbols.length >= maxSymbols;
    return {
        symbols,
        removed,
        filesDeleted: withSymbols.filter((e) => e.wholeFileDeleted).map((e) => e.filename),
        filesWithoutSymbols,
        // Totals are provenance — how big the graph these answers came from is
        // — never the answer itself.
        graph: opts.stats ?? null,
        parser: opts.parser,
        removedBasis: headContent
            ? 'removal decided against the head revision: a symbol is removed when the file no '
                + 'longer DECLARES it there, so a comment naming it does not keep it alive'
            : 'removal decided from the patch alone (no head revision content was supplied), so '
                + 'a symbol named in an added comment can be missed and a doc-only rewrite can '
                + 'read as a removal',
        ...(capped
            ? {
                truncated: true,
                truncatedNote: `symbol list capped at maxSymbols=${maxSymbols}; files with the `
                    + 'most deleted lines were read first, and removed symbols before touched '
                    + 'ones, so what is missing is the least deletion-heavy end of the change',
            }
            : {}),
    };
}

/**
 * Unique names on one end of a node's CALLS edges.
 *
 * A node named after its own file is dropped: the graph carries file-scope
 * nodes whose name IS the filename, so a helper in `dead.test.ts` was reported
 * as "called by dead.test.ts" — true of the graph, useless to a reviewer, and
 * it made every symbol in a deleted file look like it had a live caller.
 */
function edgeNames(graph, nodeId, direction, limit, selfFile) {
    const rels = (direction === 'to'
        ? graph.getRelationshipsTo(nodeId)
        : graph.getRelationshipsFrom(nodeId)) || [];
    const own = selfFile ? String(selfFile).split('/').pop() : null;
    const ids = rels.filter((r) => r.type === 'CALLS')
        .map((r) => (direction === 'to' ? r.sourceId : r.targetId))
        // Documentation is not a call site. The graph indexes prose, so a
        // review reported `findAppKnowledge` as "called by AI-README.md,
        // SETUP.md, ADR-007-….md" — three mentions dressed as consumers, on a
        // change whose entire risk was which call sites survive.
        .filter((id) => {
            const filePath = graph.getNode(id)?.properties?.filePath;
            return !filePath || isCodeSourcePath(filePath);
        });
    return namesOf(graph, ids)
        .filter((name) => name !== own && name !== selfFile)
        .slice(0, limit);
}

/**
 * Coverage of the change, not of the repository.
 *
 * @param {object} graph
 * @param {Array<{filename?: string, patch?: string, status?: string}>} diffFiles
 */
export function coverageForDiff(graph, diffFiles = []) {
    const covered = [];
    const untested = [];
    const testFilesDeleted = [];
    const testFilesChanged = [];

    for (const file of diffFiles) {
        const filename = file?.filename;
        if (!filename || !isTestFile(filename)) continue;
        if (isFileDeletion(file)) testFilesDeleted.push(filename);
        else testFilesChanged.push(filename);
    }

    if (graph?.getNodesByFile) {
        for (const file of diffFiles) {
            const filename = file?.filename;
            if (!filename || isTestFile(filename)) continue;

            const nodes = (graph.getNodesByFile(filename) || [])
                .filter((n) => n.label !== 'File');
            for (const node of nodes) {
                const name = node.properties?.name;
                if (!name) continue;
                const tests = [...new Set(
                    (graph.getRelationshipsFrom(node.id) || [])
                        .filter((r) => r.type === 'TESTED_BY')
                        .map((r) => graph.getNode(r.targetId)?.properties?.filePath)
                        .filter(Boolean),
                )];
                if (tests.length > 0) covered.push({ symbol: name, file: filename, tests });
                else untested.push(name);
            }
        }
    }

    return {
        covered,
        untested,
        testFilesDeleted,
        testFilesChanged,
        // Said plainly, because the absence of a TESTED_BY edge is weaker
        // evidence than it looks: the edge is call-based or filename-based, so
        // an untested symbol here may simply be one the builder could not link.
        note: 'untested means no TESTED_BY edge in the graph, which is evidence of '
            + 'a missing link as much as of missing coverage',
    };
}

/**
 * What to search the repository for, given a change.
 *
 * `similar_code` used to query the RENDERED bundle text — `hunks.slice(0,
 * 2000)`. On a real review those first 2000 characters were a prose file's
 * auto-generated header, so the retrieved chunks scored 0.149–0.165 and not one
 * touched a symbol the change deleted. Retrieval was answering a question about
 * the formatting.
 *
 * Symbol names first, then path stems: a name is what comparable code shares,
 * while a path is what survives when the graph knows nothing about a new file.
 * Bounded, because a query long enough to be a payload retrieves noise.
 */
export function retrievalQueryFor(diffFiles = [], symbolContext = {}, maxChars = 2000) {
    const names = [
        ...(symbolContext.removed || []).map((s) => s.name),
        ...(symbolContext.symbols || []).map((s) => s.name),
    ].filter(Boolean);

    const stems = diffFiles
        .map((f) => f?.filename)
        .filter(Boolean)
        // Prose and lockfiles describe the change; they are not comparable code.
        .filter((name) => reviewPriorityRank(name) === 1)
        .map((name) => name.split('/').pop().replace(/\.[^.]+$/, ''));

    const terms = [...new Set([...names, ...stems])];

    let query = '';
    for (const term of terms) {
        const next = query ? `${query} ${term}` : term;
        if (next.length > maxChars) break;
        query = next;
    }
    return query;
}

/**
 * Local copy of the ordering tiers in `diff.js`, kept here to avoid a cycle
 * between these two modules. Only the "is this source code" question is asked.
 */
function reviewPriorityRank(filename) {
    const name = String(filename || '');
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i.test(name)) return 3;
    if (/(\.min\.(js|css)|\.map|\.snap)$/i.test(name)) return 3;
    if (/\.(md|markdown|mdx|txt|rst|adoc|asciidoc|org)$/i.test(name)) return 2;
    return 1;
}

export default {
    touchedSymbolContext, coverageForDiff, isTestFile, isFileDeletion, retrievalQueryFor,
};
