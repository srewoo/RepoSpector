/**
 * languageMap — the single canonical file-extension → language-name mapping.
 *
 * Before this module the same extension→language table was hand-rolled in at
 * least five services (ImportGraphService, IndexManifest, PullRequestService,
 * DiffParser, SymbolExtractor), each with subtly different coverage and
 * fallback values. They now all delegate here.
 *
 * Two caller-specific behaviours are preserved via options rather than by
 * forking the table:
 *   - `fallback`: the string returned when an extension is unknown. Historically
 *     callers disagreed ('unknown' vs 'text' vs 'javascript'); each passes its
 *     own so its downstream logic is unaffected.
 *   - `distinguishJsx`: ImportGraphService's import/export parser branches on
 *     'jsx'/'tsx' as distinct languages. Every other caller collapses them to
 *     javascript/typescript. Off by default; ImportGraphService opts in.
 *
 * Content-based detectors (ContextAnalyzer.detectLanguage, LanguageDetector
 * .detectFromCode) and non-string shapes (repoInfoGenerator display names,
 * standardsLoader language families, treeSitterLangConfig grammar objects) are
 * intentionally NOT folded in here — they answer a different question.
 */

// Bare extension (no leading dot), lowercased → canonical language name.
// Superset of every previous inline table.
export const EXTENSION_TO_LANGUAGE = Object.freeze({
    // JavaScript / TypeScript family (jsx/tsx collapse unless distinguishJsx)
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    // Systems / compiled
    py: 'python', pyw: 'python',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    swift: 'swift',
    kt: 'kotlin', kts: 'kotlin',
    scala: 'scala',
    rb: 'ruby',
    php: 'php',
    dart: 'dart',
    // Functional / other languages
    clj: 'clojure', cljs: 'clojure',
    hs: 'haskell',
    ml: 'ocaml',
    fs: 'fsharp',
    elm: 'elm',
    ex: 'elixir', exs: 'elixir',
    lua: 'lua',
    r: 'r',
    pl: 'perl',
    // Shells
    sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish', ps1: 'powershell',
    // Markup / styles / data / config
    html: 'html', htm: 'html',
    vue: 'vue', svelte: 'svelte',
    css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini',
    sql: 'sql',
    graphql: 'graphql', gql: 'graphql',
    md: 'markdown', markdown: 'markdown',
    tex: 'latex',
    prisma: 'prisma',
    dockerfile: 'dockerfile',
});

/**
 * Extract the lowercased bare extension from a file path or name.
 * "src/foo/Bar.TSX" → "tsx"; "Dockerfile" → "dockerfile"; "" → "".
 */
export function extensionOf(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    const base = filePath.split(/[\\/]/).pop() || '';
    // Files with no dot (e.g. "Dockerfile", "Makefile") map by their own name.
    if (!base.includes('.')) return base.toLowerCase();
    return base.split('.').pop().toLowerCase();
}

/**
 * Detect a language name from a file path.
 *
 * @param {string} filePath
 * @param {{ fallback?: string, distinguishJsx?: boolean }} [opts]
 * @returns {string} canonical language name, or `opts.fallback` (default 'unknown').
 */
export function detectLanguageFromPath(filePath, opts = {}) {
    const { fallback = 'unknown', distinguishJsx = false } = opts;
    const ext = extensionOf(filePath);
    if (!ext) return fallback;

    if (distinguishJsx) {
        if (ext === 'jsx') return 'jsx';
        if (ext === 'tsx') return 'tsx';
    }
    return EXTENSION_TO_LANGUAGE[ext] || fallback;
}
