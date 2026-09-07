/**
 * Prompts for PR-scoped test generation: "write the tests this PR is missing".
 *
 * Distinct from `buildEnhancedTestPrompt` (single file, whatever the user has
 * open) in three ways that matter for a test a reviewer will actually merge:
 *   - it targets the SYMBOLS the review found untested, not the whole file;
 *   - when a test file already exists it asks for append-only blocks in that
 *     file's style, so the output drops into the PR instead of duplicating it;
 *   - it shows real callers from the code graph, so the tests exercise the
 *     arguments production actually passes.
 */
import { detectFramework } from './testQualityValidator.js';

const MAX_EXISTING_CHARS = 12_000;
const MAX_SOURCE_CHARS = 16_000;

export const PR_TEST_SYSTEM_PROMPT = `You are RepoSpector, generating tests for a pull request.
Output ONLY code — no explanation, no prose before or after the code block.
Never emit TODO, FIXME, placeholder assertions, or tests that only assert the function exists.
Every test must assert a concrete value or a thrown error. Match the existing test file's style exactly when one is given.`;

const EXT_FRAMEWORK = {
    js: 'jest', jsx: 'jest', ts: 'jest', tsx: 'jest', mjs: 'jest', cjs: 'jest',
    py: 'pytest', go: 'go test', java: 'junit', rb: 'rspec', rs: 'cargo test', cs: 'xunit', php: 'phpunit',
};

const EXT_LANGUAGE = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', go: 'go', java: 'java', rb: 'ruby', rs: 'rust', cs: 'csharp', php: 'php',
};

/** JS-family only: these are the extensions where the RUNNER is genuinely ambiguous. */
const JS_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']);

const extOf = (path) => String(path || '').split('.').pop().toLowerCase();

/** Syntax-highlight language for a path. Also used by the results panel. */
export function languageForPath(path) {
    return EXT_LANGUAGE[extOf(path)] || 'javascript';
}

/**
 * The test runner to write for.
 *
 * The extension decides. `detectFramework` is consulted ONLY for JS-family
 * files: it defaults to `'jest'` and never signals "I don't know", so trusting
 * it on a `.py` file would label a pytest suite `jest`.
 */
export function frameworkForPath(path, existingTest = null) {
    const ext = extOf(path);
    if (existingTest && JS_EXTS.has(ext)) {
        const detected = detectFramework(existingTest);
        if (detected) return detected;
    }
    return EXT_FRAMEWORK[ext] || 'auto-detect';
}

function clip(text, max) {
    if (!text || text.length <= max) return text || '';
    return `${text.slice(0, max)}\n// … truncated (${text.length - max} more characters)`;
}

export function buildPRTestPrompt({ filePath, fullContent, symbols, existingTest, callers = [], framework, language }) {
    const syms = symbols.map(s => `\`${s}\``).join(', ');
    const parts = [
        `## Task: Write ${framework} tests for ${syms} in \`${filePath}\``,
        '',
        'These symbols were added or changed in this pull request and no test covers them.',
        '',
        `### Source file (\`${filePath}\`)`,
        `\`\`\`${language || ''}`,
        clip(fullContent, MAX_SOURCE_CHARS),
        '```',
    ];

    if (callers.length) {
        parts.push('', '### How production code calls these symbols',
            'Use these call sites to choose realistic arguments and expectations:',
            ...callers.map(c => `- \`${c.filePath}:${c.line ?? '?'}\` in \`${c.name}\``));
    }

    if (existingTest?.content) {
        parts.push('', `### Existing test file (\`${existingTest.path}\`)`,
            '```', clip(existingTest.content, MAX_EXISTING_CHARS), '```', '',
            '### Output',
            'Output ONLY new test blocks to append to the end of this file. Do not repeat imports, setup, or tests already present. Match its naming, assertion style, and mocking approach.');
    } else {
        parts.push('', '### Output',
            `Create a new test file for ${syms}. Include the imports it needs, relative to the source path above. Cover the happy path, at least one error path, and the edge cases the parameters suggest (empty, null/undefined, boundary values).`);
    }

    return parts.join('\n');
}

export function extractCodeBlock(text) {
    const m = /```[\w+-]*\n([\s\S]*?)```/.exec(text || '');
    return (m ? m[1] : (text || '')).trim();
}

/** First backticked identifier in a finding title, e.g. the missing-test finder's symbol. */
export function symbolFromFinding(finding) {
    const m = /`([A-Za-z_$][\w$]*)`/.exec(finding?.title || '');
    return m ? m[1] : null;
}

/**
 * Whether a finding-level "Write Test" action can plausibly succeed.
 *
 * Only `static/missing-test` qualifies. That finding's file and symbol are
 * themselves the newly-exported, untested thing, which is exactly what
 * PRTestGenerationService can act on. `graph/untested-blast-radius` is
 * deliberately excluded even though it is category 'coverage': its
 * untested symbols are DEPENDENTS living in files this PR does not touch,
 * so ReviewFileContextService cannot fetch their source and generation
 * would always skip.
 */
export function offersTestGeneration(finding) {
    return /^static\/missing-test/.test(finding?.rule || '');
}

export default {
    PR_TEST_SYSTEM_PROMPT,
    frameworkForPath,
    languageForPath,
    buildPRTestPrompt,
    extractCodeBlock,
    symbolFromFinding,
    offersTestGeneration
};
