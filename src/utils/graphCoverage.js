/**
 * graphCoverage — say out loud when a repo's language has no code graph.
 *
 * RepoSpector maintains two indexes with very different reach:
 *
 *   RAG / embeddings   ~190 extensions plus extensionless names
 *   Code graph          11 languages — js/ts, python, java, go, rust, c, c++,
 *                       c#, ruby, php (see treeSitterLangConfig)
 *
 * Everything that answers "who calls this, and does the change break them?"
 * reads the GRAPH: caller-source inlining, the `find_callers` tool, cross-repo
 * impact. On a Kotlin, Swift, Scala, Elixir, Dart or Terraform repo, retrieval
 * works normally and every one of those returns nothing at all.
 *
 * Nothing about that is wrong — no grammar is bundled, so there is nothing to
 * parse. What is wrong is that it is SILENT. "No callers found" and "this
 * language has no parser" are the same empty result, and a user watching a
 * review skip the cross-file findings has no way to tell which they got. This
 * module turns the second case into a sentence.
 *
 * Pure and synchronous: it reads paths, not files.
 */

import { EXT_TO_LANG } from '../services/treeSitterLangConfig.js';
import { extensionOf } from './codeFileFilter.js';

/**
 * Extensions whose absence from the graph is not worth mentioning: they carry
 * no call graph in the first place, so a user is not missing a capability they
 * would otherwise have had.
 */
const NON_CODE_EXT = new Set([
    'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'asciidoc', 'org',
    'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
    'properties', 'xml', 'xsd', 'plist', 'editorconfig', 'lock',
    'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm',
]);

/** Extension → a name worth showing a user. */
const DISPLAY_NAME = {
    kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift', scala: 'Scala', sc: 'Scala',
    ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', dart: 'Dart', lua: 'Lua',
    tf: 'Terraform', tfvars: 'Terraform', hcl: 'HCL', sh: 'Shell',
    bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', pl: 'Perl', r: 'R',
    jl: 'Julia', hs: 'Haskell', ml: 'OCaml', clj: 'Clojure', cljs: 'Clojure',
    groovy: 'Groovy', vb: 'Visual Basic', zig: 'Zig', nim: 'Nim',
    sol: 'Solidity', vue: 'Vue', svelte: 'Svelte', sql: 'SQL', proto: 'Protobuf',
};

/**
 * How much of an indexed corpus the code graph can actually parse.
 *
 * @param {Array<{path?: string, filename?: string}>} files
 * @returns {{parsed: number, unparsed: number, total: number, ratio: number,
 *            topUnparsed: Array<{language: string, count: number}>}}
 */
export function assessGraphCoverage(files) {
    let parsed = 0;
    let unparsed = 0;
    const byLanguage = new Map();

    for (const file of files || []) {
        const path = file?.path || file?.filename;
        if (!path) continue;
        const ext = extensionOf(path);
        if (!ext || NON_CODE_EXT.has(ext)) continue;

        if (EXT_TO_LANG[ext]) {
            parsed++;
        } else {
            unparsed++;
            const name = DISPLAY_NAME[ext] || `.${ext}`;
            byLanguage.set(name, (byLanguage.get(name) || 0) + 1);
        }
    }

    const total = parsed + unparsed;
    return {
        parsed,
        unparsed,
        total,
        ratio: total === 0 ? 1 : parsed / total,
        topUnparsed: [...byLanguage.entries()]
            .map(([language, count]) => ({ language, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 4),
    };
}

/**
 * A user-facing sentence, or null when there is nothing worth saying.
 *
 * Only fires when a MAJORITY of the code has no grammar. A repo that is mostly
 * TypeScript with a handful of shell scripts gets full cross-file analysis on
 * the part that matters, and warning about the scripts would be noise — the
 * warning has to mean "expect the cross-file findings to be missing", not
 * "something was skipped somewhere".
 *
 * @param {Object} coverage - from `assessGraphCoverage`
 * @param {number} [threshold=0.5] - parsed ratio below which we warn
 * @returns {string|null}
 */
export function graphCoverageWarning(coverage, threshold = 0.5) {
    if (!coverage || coverage.total === 0) return null;
    if (coverage.ratio >= threshold) return null;

    const langs = coverage.topUnparsed.map(u => u.language).join(', ');
    const pct = Math.round(coverage.ratio * 100);
    return `Code graph covers ${pct}% of this repo's source (${coverage.parsed}/${coverage.total} files). `
        + `${langs} ${coverage.topUnparsed.length === 1 ? 'has' : 'have'} no parser, so caller lookups, `
        + 'cross-file impact and cross-repo checks will find nothing in those files. '
        + 'Search and retrieval are unaffected.';
}

export default { assessGraphCoverage, graphCoverageWarning };
