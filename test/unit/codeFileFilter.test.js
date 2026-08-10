const {
    isIndexableCodeFile,
    filterIndexableFiles,
    extensionOf,
    isInExcludedDir,
    MAX_FILE_SIZE,
} = require('../../src/utils/codeFileFilter.js');
const { GitHubService } = require('../../src/services/GitHubService.js');
const { GitLabService } = require('../../src/services/GitLabService.js');

describe('extensionOf', () => {
    it('returns the extension after the last dot in the basename', () => {
        expect(extensionOf('src/app.ts')).toBe('ts');
        expect(extensionOf('src/app.d.ts')).toBe('ts');
    });

    it('returns empty for an extensionless file', () => {
        // The old `path.split('.').pop()` returned the whole filename here, so
        // `Makefile` was tested against the extension list as "makefile".
        expect(extensionOf('Makefile')).toBe('');
        expect(extensionOf('deploy/Dockerfile')).toBe('');
    });

    it('is not confused by dots in directory names', () => {
        // `split('.').pop()` returned "2/readme" for this path.
        expect(extensionOf('src/v1.2/README')).toBe('');
        expect(extensionOf('src/v1.2/main.go')).toBe('go');
    });

    it('treats a dotfile as a name, not an extension', () => {
        expect(extensionOf('.gitignore')).toBe('');
    });
});

describe('isInExcludedDir', () => {
    it('excludes files under a dependency or output directory', () => {
        expect(isInExcludedDir('node_modules/lodash/index.js')).toBe(true);
        expect(isInExcludedDir('web/dist/bundle.js')).toBe(true);
    });

    it('does not match the filename itself against directory names', () => {
        // `build.gradle` must survive the `build` directory rule.
        expect(isInExcludedDir('build.gradle')).toBe(false);
        expect(isInExcludedDir('app/build.gradle.kts')).toBe(false);
    });

    it('does not exclude bin/, which is a source directory outside .NET and Java', () => {
        expect(isInExcludedDir('bin/deploy.ps1')).toBe(false);
    });
});

describe('isIndexableCodeFile — languages that used to be invisible', () => {
    const shouldIndex = [
        // XML: pom.xml, Android manifests and layouts — whole Java/Android ecosystems
        'pom.xml', 'app/src/main/AndroidManifest.xml',
        // Infrastructure as code
        'infra/main.tf', 'infra/prod.tfvars', 'deploy/config.hcl', 'shell.nix',
        // Languages absent from the original list
        'lib/app_web/router.ex', 'test/user_test.exs',
        'scripts/build.lua', 'bin/deploy.ps1', 'tools/migrate.bat',
        'analysis/model.R', 'src/Main.hs', 'src/core.clj', 'src/Bench.jl',
        'ios/AppDelegate.m', 'ios/View.mm', 'contracts/Token.sol', 'src/main.zig',
        'lib/Util.pm', 'src/parser.ml',
        // Extensionless build and meta files
        'Dockerfile', 'Dockerfile.production', 'Makefile', 'Jenkinsfile',
        'BUILD', 'WORKSPACE', 'CODEOWNERS', 'Procfile',
        // CI definitions — previously excluded wholesale via the `.github` dir
        '.github/workflows/ci.yml', '.github/actions/setup/action.yml',
        // Styles — previously in the deny list
        'web/styles/app.scss', 'web/app.css',
        // Templates and newer frontend frameworks
        'templates/index.html.j2', 'views/show.html.erb', 'src/index.astro',
        'schema.prisma', 'api/service.graphql',
        // TS module variants
        'src/loader.mts', 'src/config.cts',
    ];

    it.each(shouldIndex)('indexes %s', (path) => {
        expect(isIndexableCodeFile(path)).toBe(true);
    });
});

describe('isIndexableCodeFile — still excluded', () => {
    const shouldSkip = [
        'node_modules/lodash/index.js',
        'vendor/github.com/pkg/errors/errors.go',
        'dist/bundle.js',
        'web/app.min.js',
        'web/app.min.css',
        'static/logo.svg',          // asset, not reviewable source
        'package-lock.json',
        'go.sum',
        'assets/hero.png',
        'certs/server.key',         // must never enter an index
        'certs/chain.pem',
        'model/weights.safetensors',
        'build/out.map',
        'target/classes/App.class',
        '__pycache__/mod.cpython-311.pyc',
    ];

    it.each(shouldSkip)('skips %s', (path) => {
        expect(isIndexableCodeFile(path)).toBe(false);
    });

    it('rejects a non-string path instead of throwing', () => {
        expect(isIndexableCodeFile(null)).toBe(false);
        expect(isIndexableCodeFile(undefined)).toBe(false);
        expect(isIndexableCodeFile(42)).toBe(false);
    });
});

describe('filterIndexableFiles', () => {
    it('keeps only blobs', () => {
        const out = filterIndexableFiles([
            { type: 'tree', path: 'src' },
            { type: 'blob', path: 'src/a.js' },
        ]);
        expect(out.map(f => f.path)).toEqual(['src/a.js']);
    });

    it('drops blobs over the size ceiling before download', () => {
        // The ceiling was documented in both services as "the natural limit" but
        // never actually applied, so a multi-megabyte file was fetched and embedded.
        const out = filterIndexableFiles([
            { type: 'blob', path: 'src/small.js', size: 100 },
            { type: 'blob', path: 'src/huge.js', size: MAX_FILE_SIZE + 1 },
        ]);
        expect(out.map(f => f.path)).toEqual(['src/small.js']);
    });

    it('keeps blobs with no reported size (GitLab trees omit it)', () => {
        const out = filterIndexableFiles([{ type: 'blob', path: 'src/a.js' }]);
        expect(out).toHaveLength(1);
    });

    it('tolerates a null tree', () => {
        expect(filterIndexableFiles(null)).toEqual([]);
        expect(filterIndexableFiles(undefined)).toEqual([]);
    });
});

describe('GitHub and GitLab index the same corpus', () => {
    // Two hand-maintained copies of these lists had already diverged. A repo
    // indexed from one host must not retrieve different context than the same
    // repo indexed from the other.
    const gh = new GitHubService();
    const gl = new GitLabService();

    it('share identical extension and directory rules', () => {
        expect(gl.codeExtensions).toEqual(gh.codeExtensions);
        expect(gl.excludeExtensions).toEqual(gh.excludeExtensions);
        expect(gl.excludeDirs).toEqual(gh.excludeDirs);
    });

    it('select the same files from the same tree', () => {
        const tree = [
            { type: 'blob', path: 'pom.xml' },
            { type: 'blob', path: '.github/workflows/ci.yml' },
            { type: 'blob', path: 'infra/main.tf' },
            { type: 'blob', path: 'Dockerfile' },
            { type: 'blob', path: 'web/app.scss' },
            { type: 'blob', path: 'node_modules/x/index.js' },
            { type: 'blob', path: 'dist/bundle.min.js' },
            { type: 'tree', path: 'src' },
        ];
        const ghPaths = gh.filterCodeFiles(tree).map(f => f.path);
        const glPaths = gl.filterCodeFiles(tree).map(f => f.path);

        expect(ghPaths).toEqual(glPaths);
        expect(ghPaths).toEqual([
            'pom.xml',
            '.github/workflows/ci.yml',
            'infra/main.tf',
            'Dockerfile',
            'web/app.scss',
        ]);
    });
});

describe('repo identity is stable between indexing and reviewing', () => {
    // Indexing keys the vector store / code graph by `service.getRepoId(repoUrl)`;
    // reviewing looks context up by `getRepoId(prUrl)`. If those disagree, a repo
    // the user explicitly indexed still contributes ZERO context to its own review
    // — and nothing errors, so it looks like retrieval simply found nothing.
    const gh = new GitHubService();
    const gl = new GitLabService();

    it.each([
        ['github', 'https://github.com/acme/widgets/pull/42', 'https://github.com/acme/widgets', 'acme/widgets'],
        ['gitlab', 'https://gitlab.com/acme/widgets/-/merge_requests/7', 'https://gitlab.com/acme/widgets', 'acme/widgets'],
        ['gitlab subgroup', 'https://gitlab.com/eng/platform/core/-/merge_requests/7', 'https://gitlab.com/eng/platform/core', 'eng/platform/core'],
        ['self-hosted gitlab', 'https://git.acme.io/eng/core/-/merge_requests/1', 'https://git.acme.io/eng/core', 'eng/core'],
    ])('%s: MR URL and repo URL resolve to the same repoId', (label, mrUrl, repoUrl, expected) => {
        const service = label === 'github' ? gh : gl;
        expect(service.getRepoId(mrUrl)).toBe(expected);
        expect(service.getRepoId(repoUrl)).toBe(expected);
    });
});
