/**
 * PRTestGenerationService — write the tests a pull request is missing.
 *
 * Input is the same fact the review reports (`static/missing-test`: an exported
 * symbol this PR adds that no test names). Output is a test file per source
 * file, either APPENDED to the test file the repo already has for it — found
 * the way the review finds it, through `ReviewFileContextService` — or CREATED
 * at the conventional path. Callers from the code graph, when present, make the
 * arguments realistic. Every result passes the syntax and quality validators
 * or is reported as skipped with the reason; one retry carries the validator's
 * message back to the model.
 */
import { findMissingTests } from '../utils/missingTestFinder.js';
import { listCallers } from '../utils/graphQueries.js';
import { validateSyntax } from '../utils/syntaxValidator.js';
import { validateTestQuality } from '../utils/testQualityValidator.js';
import { testCandidatesForProduction } from './testFileUtils.js';
import {
    PR_TEST_SYSTEM_PROMPT, buildPRTestPrompt, frameworkForPath, languageForPath, extractCodeBlock,
} from '../utils/prTestPrompts.js';

const MAX_SYMBOLS = 40;
const MIN_QUALITY = 40;

// `validateSyntax` now correctly handles TypeScript: the generics-as-JSX
// misread (e.g. `Map<string, number>`) and the regex-based TypeScript
// stripper corrupting annotated declarations before
// `validateWithFunctionConstructor` have both been fixed. So TypeScript now
// gets the same strong check as JavaScript. This set names the languages
// `validateSyntax` can genuinely parse; any other language falls back to the
// `validateTestQuality` SYNTAX_ERROR path below, which uses `quickValidate`
// (brace/paren/bracket counting only) — weaker, but sound, with no false
// positives.
const SYNTAX_CHECKED_LANGUAGES = new Set(['javascript', 'typescript']);

// `validateSyntax` terminates in `new Function()`, which cannot parse
// untranspiled JSX — a pre-existing, separate limitation from the TypeScript
// bugs above. Running the strong check on generated React test code would
// reject valid output, so JSX content always falls back to the weak
// brace-counting check regardless of language. Detection is deliberately
// conservative: only a PascalCase component tag (`<Button`), a member-style
// tag (`<Foo.Bar`), including self-closing (`<Foo />`) — a `<` followed by an
// uppercase letter and component-name characters. A lowercase tag like
// `<div` is intentionally NOT matched, since that also matches an ordinary
// comparison such as `a <div ...` in non-JSX code. Being conservative here
// means the worst case is running the strong check on something we could
// have skipped, which is the safe direction — never the reverse.
const JSX_ELEMENT_RE = /<[A-Z][A-Za-z0-9_.]*[\s/>]/;
function looksLikeJsx(content) {
    return typeof content === 'string' && JSX_ELEMENT_RE.test(content);
}

export class PRTestGenerationService {
    constructor({ llmService, fileContextService, graph = null }) {
        this.llm = llmService;
        this.fileContext = fileContextService;
        this.graph = graph;
    }

    async generate(prUrl, prData, settings, opts = {}) {
        const { maxFiles = 3, onlyFiles = null, onlySymbols = null, onProgress = null } = opts;
        const usage = { input: 0, output: 0 };
        const targets = this._targets(prData, onlyFiles, onlySymbols).slice(0, maxFiles);
        if (!targets.length) {
            return { files: [], skipped: [{ file: null, reason: 'no untested exported symbols in this PR' }], usage };
        }

        // `build` returns { byFile, stats }; the restriction key is `onlyFiles`.
        const { byFile } = await this.fileContext.build(prUrl, prData, {
            onlyFiles: targets.map(t => t.file),
        });
        const changed = new Set((prData.files || []).map(f => f.filename));
        const files = [];
        const skipped = [];

        for (const t of targets) {
            onProgress?.({ phase: 'testgen', message: `Generating tests for ${t.file}` });
            const entry = byFile?.get(t.file);
            if (!entry?.fullContent) { skipped.push({ file: t.file, reason: 'source content unavailable' }); continue; }
            const result = await this._generateOne(t, entry, changed, settings, usage);
            if (result.ok) files.push(result.file); else skipped.push({ file: t.file, reason: result.reason });
        }
        return { files, skipped, usage };
    }

    /** Group missing-test findings into [{file, symbols[]}], honouring filters. */
    _targets(prData, onlyFiles, onlySymbols) {
        const missing = findMissingTests(prData, { requireTestPresence: false, maxFindings: MAX_SYMBOLS });
        const byFile = new Map();
        for (const m of missing) {
            const sym = /`([^`]+)`/.exec(m.title || '')?.[1];
            if (!sym) continue;
            if (onlyFiles && !onlyFiles.includes(m.file)) continue;
            if (onlySymbols && !onlySymbols.includes(sym)) continue;
            if (!byFile.has(m.file)) byFile.set(m.file, []);
            byFile.get(m.file).push(sym);
        }
        return [...byFile.entries()]
            .map(([file, symbols]) => ({ file, symbols }))
            .sort((a, b) => b.symbols.length - a.symbols.length);
    }

    async _generateOne(target, entry, changed, settings, usage) {
        const existingTest = entry.testPath && entry.testContent ? { path: entry.testPath, content: entry.testContent } : null;
        const framework = frameworkForPath(target.file, existingTest?.content);
        const language = languageForPath(target.file);
        const callers = this.graph
            ? target.symbols.flatMap(s => listCallers(this.graph, s, { excludeFiles: changed, limit: 3 }))
            : [];
        const prompt = buildPRTestPrompt({
            filePath: target.file, fullContent: entry.fullContent, symbols: target.symbols,
            existingTest, callers, framework, language,
        });

        const messages = [{ role: 'system', content: PR_TEST_SYSTEM_PROMPT }, { role: 'user', content: prompt }];
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (lastError) messages.push({ role: 'user', content: `Your previous output failed validation:\n${lastError}\nFix it and output ONLY the corrected code.` });
            // A copy, not `messages` itself: `messages` keeps growing after this
            // call (the assistant reply is appended below), and a caller that
            // records its arguments by reference — like a jest mock — would
            // otherwise see every later mutation bleed into an earlier call's
            // recorded snapshot.
            const res = await this.llm.streamChat([...messages], { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false });
            usage.input += res?.usage?.input || 0;
            usage.output += res?.usage?.output || 0;
            const content = extractCodeBlock(res?.content ?? res);
            messages.push({ role: 'assistant', content });

            const verdict = this._validate(content, framework, language);
            if (verdict.ok) {
                return {
                    ok: true,
                    file: {
                        path: existingTest?.path || testCandidatesForProduction(target.file)[0] || `${target.file}.test.js`,
                        targetFile: target.file, mode: existingTest ? 'append' : 'create',
                        symbols: target.symbols, framework, content,
                        quality: { syntaxOk: true, score: verdict.score, attempts: attempt },
                    },
                };
            }
            lastError = verdict.reason;
        }
        return { ok: false, reason: lastError };
    }

    /**
     * Syntax first, then quality. Both validators report their problems as
     * OBJECTS, so messages are mapped rather than joined. A parse failure is
     * reported as a syntax problem even when it reaches us through the quality
     * validator's early return, because "quality score 0" would name the wrong
     * cause for someone reading the skip reason.
     */
    _validate(content, framework, language) {
        if (!content) return { ok: false, reason: 'empty output' };

        const messages = (list) => (list || [])
            .map(e => (typeof e === 'string' ? e : e?.message))
            .filter(Boolean)
            .join('; ');

        if (SYNTAX_CHECKED_LANGUAGES.has(language) && !looksLikeJsx(content)) {
            const syntax = validateSyntax(content, { language });
            if (syntax && syntax.valid === false) {
                return { ok: false, reason: `syntax: ${messages(syntax.errors) || 'invalid'}` };
            }
        }

        const quality = validateTestQuality(content, { framework });
        const parseFailure = (quality?.issues || []).find(i => i?.type === 'SYNTAX_ERROR');
        if (parseFailure) {
            return { ok: false, reason: `syntax: ${parseFailure.message || 'does not parse'}` };
        }
        if (quality && typeof quality.score === 'number' && quality.score < MIN_QUALITY) {
            return { ok: false, reason: `quality score ${quality.score} below ${MIN_QUALITY}: ${messages(quality.issues)}` };
        }
        return { ok: true, score: quality?.score ?? null };
    }
}

export default PRTestGenerationService;
