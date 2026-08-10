/**
 * codeFileFilter — the single answer to "should this repository file be indexed?".
 *
 * Why this module exists
 * ----------------------
 * `GitHubService` and `GitLabService` each carried their own copy of the extension
 * list, the exclusion list and the excluded-directory list. Three problems came
 * out of that:
 *
 *   1. DRIFT. Two lists that must agree, maintained by hand, in two files. A repo
 *      indexed from GitHub and the same repo indexed from GitLab could end up with
 *      different corpora, which silently changes what RAG can retrieve.
 *   2. COVERAGE. The shared list named ~45 extensions and omitted a lot of code
 *      people actually review: Terraform, Elixir, Lua, Perl, R, Objective-C,
 *      Haskell, Clojure, Julia, PowerShell, Solidity, Zig, Nix, Astro, template
 *      languages, and `xml` — which on a Java/Android repo means `pom.xml`,
 *      `build.gradle`'s companion configs and every layout file were invisible.
 *   3. EXTENSIONLESS FILES. `Dockerfile`, `Makefile`, `Jenkinsfile`, `.gitlab-ci`
 *      helpers, `BUILD`/`WORKSPACE` — all real, all reviewed, none matched,
 *      because the check was `path.split('.').pop()` against an extension list.
 *
 * What "all code files" means here
 * --------------------------------
 * An allow-list, not a deny-list, is still the right shape: a repo contains
 * arbitrary binary junk, and embedding a 40 MB fixture wastes the user's time and
 * their index. But the allow-list should name every language a reviewer might
 * plausibly open, and the checks around it (directory exclusion, size ceiling)
 * should carry the "don't index rubbish" job instead of a narrow extension list.
 */

/**
 * Source, config and documentation extensions worth indexing.
 * Lower-case, no leading dot.
 */
export const CODE_EXTENSIONS = Object.freeze([
    // JavaScript / TypeScript
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
    // Python
    'py', 'pyw', 'pyx', 'pyi',
    // JVM
    'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'clj', 'cljs', 'cljc',
    // Go
    'go',
    // Rust
    'rs',
    // Ruby
    'rb', 'rake', 'gemspec', 'erb',
    // PHP
    'php', 'phtml',
    // C / C++ / Objective-C
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx', 'hh', 'ipp', 'm', 'mm',
    // C# / .NET
    'cs', 'vb', 'fs', 'fsx', 'razor', 'cshtml',
    // Apple
    'swift',
    // Dart / Flutter
    'dart',
    // Functional / scientific / other languages
    'ex', 'exs', 'erl', 'hrl',        // Elixir / Erlang
    'hs', 'lhs',                       // Haskell
    'ml', 'mli',                       // OCaml
    'lua',
    'pl', 'pm', 't',                   // Perl
    'r', 'rmd',                        // R
    'jl',                              // Julia
    'zig',
    'nim',
    'sol',                             // Solidity
    'v', 'sv',                         // Verilog / SystemVerilog
    'f90', 'f95',                      // Fortran
    'pas',                             // Pascal
    // Shell / scripting
    'sh', 'bash', 'zsh', 'fish', 'ksh', 'ps1', 'psm1', 'bat', 'cmd',
    // Infrastructure as code
    'tf', 'tfvars', 'hcl', 'nix', 'dhall', 'jsonnet', 'libsonnet',
    // Build systems
    'gradle', 'cmake', 'bzl', 'mk', 'am', 'gemfile', 'podspec',
    // Config / data (these carry real, reviewable behaviour)
    'yaml', 'yml', 'json', 'json5', 'jsonc', 'toml', 'ini', 'cfg', 'conf',
    // NOTE: `env` is NOT here — see EXCLUDE_EXTENSIONS. Template variants
    // (`.env.example` and friends) are allowed by name in CODE_FILENAMES.
    'properties', 'xml', 'xsd', 'plist', 'editorconfig',
    // Query languages / schemas
    'sql', 'psql', 'graphql', 'gql', 'prisma', 'proto', 'thrift', 'avsc', 'avdl',
    // Web frameworks / markup / templating
    'vue', 'svelte', 'astro', 'html', 'htm', 'hbs', 'handlebars',
    'ejs', 'jinja', 'jinja2', 'j2', 'twig', 'liquid', 'mustache', 'tpl', 'jsp',
    // Styles. Reviewed as often as any other source, and a diff in one is
    // reviewable, so repo context for it should exist. Previously DENIED outright.
    'css', 'scss', 'sass', 'less', 'styl',
    // Documentation — high-value RAG context, not an afterthought
    'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'asciidoc', 'org',
]);

/**
 * Well-known files that carry no extension. Compared against the BASENAME,
 * case-insensitively. `Dockerfile.prod` and friends are matched by prefix so
 * variant suffixes work without enumerating them.
 */
export const CODE_FILENAMES = Object.freeze([
    'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'jenkinsfile',
    'vagrantfile', 'brewfile', 'procfile', 'rakefile', 'gemfile', 'podfile',
    'build', 'workspace', 'buck', 'justfile', 'taskfile',
    'cargo.lock',       // dependency graph is genuinely useful context
    'codeowners', 'license', 'notice', 'readme', 'changelog', 'authors',
    '.gitignore', '.dockerignore', '.gitattributes', '.editorconfig',
    '.eslintrc', '.prettierrc', '.babelrc', '.nvmrc', '.tool-versions',
    // Environment TEMPLATES only. These document which variables exist without
    // carrying their values, so they are useful review context and safe to
    // index; every other `.env*` form is denied by EXCLUDE_ENV_RE.
    '.env.example', '.env.sample', '.env.template', '.env.defaults', '.env.dist',
    'env.example', 'env.sample', 'env.template',
]);

/** Prefix matches for extensionless variants, e.g. `Dockerfile.production`. */
const FILENAME_PREFIXES = Object.freeze(['dockerfile', 'makefile', 'jenkinsfile']);

/**
 * Never index these, whatever else matches. A deny-list is still needed because
 * some denied extensions overlap with allowed ones by suffix (`.min.js`).
 */
export const EXCLUDE_EXTENSIONS = Object.freeze([
    // Images / media
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'tiff', 'tif', 'avif',
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'mp3', 'wav', 'ogg', 'webm', 'm4a',
    // Archives
    'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz', 'zst',
    // Databases / binary data
    'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'dat', 'bin', 'pack', 'idx',
    // Compiled artefacts
    'exe', 'dll', 'so', 'dylib', 'o', 'obj', 'a', 'lib', 'class', 'jar', 'war',
    'ear', 'pyc', 'pyo', 'pyd', 'wasm', 'node',
    // Source maps and minified bundles — generated, and they poison retrieval
    // with unreadable one-line chunks.
    'map',
    // Fonts
    'woff', 'woff2', 'ttf', 'eot', 'otf',
    // Documents
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
    // Design assets
    'psd', 'sketch', 'fig', 'xd', 'ai',
    // ML weights / notebooks' checkpoints
    'onnx', 'pt', 'pth', 'ckpt', 'safetensors', 'h5', 'pb', 'tflite',
    // Certificates and keys — must never enter an index
    'pem', 'key', 'crt', 'cer', 'pfx', 'p12', 'keystore', 'jks',
    // Environment files. These were on the ALLOW list, which contradicted the
    // line above them: `.pem` was blocked as a secret while `config/prod.env` —
    // the single most common place a real credential lives — was indexed,
    // embedded, and eligible to be retrieved into a prompt and sent to the
    // user's LLM provider. Committed `.env` files are a mistake, but an indexer
    // must not amplify one. Example/template variants are still allowed by
    // name in CODE_FILENAMES, since they carry the keys without the values.
    'env',
]);

/**
 * Path patterns that are never worth indexing regardless of extension:
 * generated output, minified bundles, vendored trees, lockfiles.
 *
 * `svg` deserves a note: it is text and technically markup, but an SVG is an
 * asset, and a repo of icons would otherwise dominate the index. Excluded here
 * rather than in EXCLUDE_EXTENSIONS so the reason is recorded.
 */
const EXCLUDE_PATH_RE = /(\.min\.(js|css)$|\.d\.ts\.map$|\.svg$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$)/i;

/**
 * Every `.env` form except the documented templates.
 *
 * A bare `.env` was already skipped, but only by accident: a leading-dot name
 * parses as having no extension, so it fell off the end of the allow-list. That
 * is not a policy, it is a coincidence that a later change could silently undo.
 * State it instead, and cover the variants (`.env.local`, `.env.production`)
 * in the same place.
 *
 * The negative lookahead is what keeps `.env.example` indexable — it is checked
 * before the filename allow-list, so a blanket `.env*` pattern would deny the
 * templates too.
 */
const EXCLUDE_ENV_RE = /(^|\/)\.?env(\.(?!example$|sample$|template$|defaults$|dist$)[^/]*)?$/i;

/**
 * Directories whose contents are dependencies or build output, not the repo's code.
 *
 * `.github` and `.gitlab` are deliberately NOT here. They were excluded before,
 * which meant CI workflow definitions — reviewed constantly, and the thing a
 * reviewer most often needs context on when a pipeline changes — were invisible
 * to both the index and the code graph.
 */
export const EXCLUDE_DIRS = Object.freeze([
    'node_modules', 'bower_components', 'jspm_packages',
    'vendor', 'third_party', 'thirdparty',
    'dist', 'build', 'out', 'target', 'obj',
    // NOTE: `bin` is deliberately NOT excluded. It is build output in .NET and
    // Java, but it is equally a SOURCE directory everywhere else (`bin/rails`,
    // `bin/deploy`, `bin/setup`) and those scripts get reviewed. Compiled
    // artefacts landing in `bin/` are already caught by EXCLUDE_EXTENSIONS
    // (`dll`, `exe`, `class`, `so`, …), so excluding the directory outright only
    // cost us the real scripts.
    '.git', '.svn', '.hg',
    'coverage', '.nyc_output',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
    '.venv', 'venv', 'virtualenv',
    '.idea', '.vscode-test',
    '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
    '.gradle', '.terraform',
    'Pods', 'DerivedData',
]);

/**
 * Directories whose extensionless files are scripts, not binaries.
 *
 * The `EXCLUDE_DIRS` note argues at length that `bin` is deliberately kept
 * because `bin/rails`, `bin/deploy` and `bin/setup` get reviewed — but they
 * were still dropped one step later, by the extension gate, because a shell
 * script called `deploy` has no extension. Keeping the directory was necessary
 * and not sufficient; this is the other half.
 *
 * Scoped to these directories rather than allowing extensionless files
 * everywhere, because "no extension" is also what a committed binary looks
 * like, and a repo that vendors one would otherwise get it embedded.
 */
export const SCRIPT_DIRS = Object.freeze([
    'bin', 'scripts', 'script', 'tools', 'hack', '.bin',
]);

/** Is this path an extensionless file inside a script directory? */
export function isScriptDirFile(path, scriptDirs = SCRIPT_DIRS) {
    const segments = String(path).split('/');
    if (segments.length < 2) return false;
    const dirs = segments.slice(0, -1).map(s => s.toLowerCase());
    const allowed = new Set(scriptDirs.map(d => d.toLowerCase()));
    return dirs.some(seg => allowed.has(seg));
}

/** Files larger than this are not indexed. Matches `CONSTANTS.MAX_FILE_SIZE`. */
export const MAX_FILE_SIZE = 1024 * 1024; // 1 MB

/**
 * Lower-cased basename of a path.
 * @param {string} path
 * @returns {string}
 */
function basenameOf(path) {
    const slash = path.lastIndexOf('/');
    return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase();
}

/**
 * Extension of a path, lower-cased, or '' when there is none.
 *
 * `path.split('.').pop()` was the old approach and it lies in two ways: for a
 * path with no dot it returns the whole filename (so `Makefile` "had extension
 * makefile"), and for `src/v1.2/README` it returns `2/readme`. Only look after
 * the last slash, and only when a dot actually appears there.
 *
 * @param {string} path
 * @returns {string}
 */
export function extensionOf(path) {
    const base = basenameOf(path);
    const dot = base.lastIndexOf('.');
    // `dot === 0` is a dotfile (`.gitignore`) — it has no extension, it IS a name.
    if (dot <= 0) return '';
    return base.slice(dot + 1);
}

/** Is any segment of `path` an excluded directory? */
export function isInExcludedDir(path, excludeDirs = EXCLUDE_DIRS) {
    const segments = String(path).split('/');
    // Only directory segments count — the last segment is the file itself, so a
    // file legitimately named `build.gradle` must not be excluded by `build`.
    const dirs = segments.slice(0, -1);
    const denied = new Set(excludeDirs.map(d => d.toLowerCase()));
    return dirs.some(seg => denied.has(seg.toLowerCase()));
}

/**
 * Should this repository path be indexed?
 *
 * @param {string} path - repo-relative path
 * @param {object} [options]
 * @param {string[]} [options.codeExtensions]
 * @param {string[]} [options.excludeExtensions]
 * @param {string[]} [options.excludeDirs]
 * @returns {boolean}
 */
export function isIndexableCodeFile(path, options = {}) {
    if (!path || typeof path !== 'string') return false;

    const {
        codeExtensions = CODE_EXTENSIONS,
        excludeExtensions = EXCLUDE_EXTENSIONS,
        excludeDirs = EXCLUDE_DIRS,
    } = options;

    if (isInExcludedDir(path, excludeDirs)) return false;
    if (EXCLUDE_PATH_RE.test(path)) return false;

    const base = basenameOf(path);

    // Environment files, before the name allow-list can rescue a non-template.
    if (EXCLUDE_ENV_RE.test(path) && !CODE_FILENAMES.includes(base)) return false;

    const ext = extensionOf(path);

    // Deny wins over allow, always.
    if (ext && excludeExtensions.includes(ext)) return false;

    // Well-known names are checked BEFORE the extension allow-list, because the
    // variant forms carry an extension that is not a language: `Dockerfile.prod`
    // parses as extension `prod`, `Makefile.am` as `am`. Keying on the name first
    // is what makes those match.
    if (CODE_FILENAMES.includes(base)) return true;
    if (FILENAME_PREFIXES.some(prefix => base === prefix || base.startsWith(`${prefix}.`))) return true;

    // An extensionless file under bin/, scripts/ etc is a script.
    if (!ext && isScriptDirFile(path)) return true;

    return ext ? codeExtensions.includes(ext) : false;
}

/**
 * Filter a git tree down to indexable code files.
 *
 * Accepts either shape the two hosts return: GitHub's `{type:'blob', path, size}`
 * and GitLab's `{type:'blob', path}`.
 *
 * @param {Array<{type?:string, path?:string, size?:number}>} tree
 * @param {object} [options] - same as `isIndexableCodeFile`, plus `maxFileSize`
 * @returns {Array<object>} the entries worth downloading
 */
export function filterIndexableFiles(tree, options = {}) {
    const maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE;
    return (tree || [])
        .filter(item => item && item.type === 'blob' && item.path)
        // Skip oversized blobs BEFORE download. The size ceiling was documented as
        // "the natural limit" in both services but never actually applied, so a
        // multi-megabyte generated file was fetched and embedded in full.
        .filter(item => !(Number.isFinite(item.size) && item.size > maxFileSize))
        .filter(item => isIndexableCodeFile(item.path, options));
}

export default {
    CODE_EXTENSIONS,
    CODE_FILENAMES,
    EXCLUDE_EXTENSIONS,
    EXCLUDE_DIRS,
    MAX_FILE_SIZE,
    extensionOf,
    isInExcludedDir,
    isIndexableCodeFile,
    filterIndexableFiles,
};
