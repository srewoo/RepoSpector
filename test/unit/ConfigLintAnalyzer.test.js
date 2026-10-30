/**
 * Each rule gets the line it exists for and its nearest legitimate neighbour,
 * which must stay quiet. Failure cases guarded: a rule firing on the safe form
 * (noise on real PRs), a comment or the wrong file kind triggering it, and a
 * migration on a table created in the same file being flagged.
 */
const { ConfigLintAnalyzer, configKindOf } = require('../../src/services/ConfigLintAnalyzer.js');
const { StaticAnalysisService } = require('../../src/services/StaticAnalysisService.js');

const lint = new ConfigLintAnalyzer();
const ids = (filePath, code) => lint.analyze(code, { filePath }).findings.map((f) => f.ruleId);

describe('file kinds', () => {
    it.each([
        ['Dockerfile', 'dockerfile'], ['api/Dockerfile.prod', 'dockerfile'],
        ['.github/workflows/ci.yml', 'workflow'], ['deploy/app.yaml', 'yaml'],
        ['infra/main.tf', 'terraform'], ['scripts/run.sh', 'shell'],
        ['db/migrations/001.sql', 'sql'], ['schema.sql', null], ['app/page.tsx', 'react'], ['a.js', null],
    ])('%s is %s', (p, kind) => expect(configKindOf(p)).toBe(kind));
});

describe('Dockerfile (hadolint)', () => {
    it.each([
        ['FROM python:latest', 'FROM python:3.12-slim'],
        ['FROM node', 'FROM node@sha256:abc'],
        ['ADD app.py /app/', 'ADD https://example.com/x.tgz /tmp/'],
        ['RUN pip install -r requirements.txt', 'RUN pip install --no-cache-dir -r requirements.txt'],
        ['RUN apt-get install curl', 'RUN apt-get install -y curl'],
    ])('flags `%s`, not `%s`', (bad, good) => {
        expect(ids('Dockerfile', bad)).toHaveLength(1);
        expect(ids('Dockerfile', good)).toHaveLength(0);
    });

    it('does not treat a build stage name as an untagged image', () => {
        expect(ids('Dockerfile', 'FROM golang:1.23 AS build\nFROM build')).toEqual([]);
    });
});

describe('GitHub workflows (zizmor)', () => {
    const wf = '.github/workflows/ci.yml';
    it('flags untrusted event text in a run script, not in an if condition', () => {
        expect(ids(wf, '      - run: echo "${{ github.event.pull_request.title }}"')).toEqual(['zizmor/template-injection']);
        expect(ids(wf, "    if: ${{ github.event.pull_request.title != '' }}")).toEqual([]);
        expect(ids(wf, '      - run: echo "${{ github.sha }}"')).toEqual([]);
    });

    it('flags a PR-head checkout only in a privileged workflow', () => {
        const step = '          ref: ${{ github.event.pull_request.head.sha }}';
        expect(ids(wf, `on:\n  pull_request_target:\n${step}`)).toEqual(['zizmor/dangerous-triggers', 'zizmor/untrusted-checkout']);
        expect(ids(wf, `on:\n  pull_request:\n${step}`)).toEqual([]);
    });

    it('flags write-all permissions, not a scoped write', () => {
        expect(ids(wf, 'permissions: write-all')).toEqual(['zizmor/excessive-permissions']);
        expect(ids(wf, 'permissions:\n  contents: write')).toEqual([]);
    });
});

describe('Kubernetes (kube-linter)', () => {
    it.each([
        ['privileged: true', 'privileged: false'],
        ['allowPrivilegeEscalation: true', 'allowPrivilegeEscalation: false'],
        ['hostNetwork: true', 'hostNetwork: false'],
        ['hostPath:\n  path: /var/run/docker.sock', 'hostPath:\n  path: /data'],
        ['runAsNonRoot: false', 'runAsNonRoot: true'],
    ])('flags `%s`, not `%s`', (bad, good) => {
        expect(ids('k8s/pod.yaml', bad)).toHaveLength(1);
        expect(ids('k8s/pod.yaml', good)).toHaveLength(0);
    });

    it('flags a capability added, not one dropped', () => {
        expect(ids('pod.yaml', 'capabilities:\n  add:\n    - SYS_ADMIN')).toEqual(['kube-linter/dangerous-capabilities']);
        expect(ids('pod.yaml', 'capabilities:\n  drop:\n    - ALL')).toEqual([]);
    });

    it('ignores a commented-out line', () => {
        expect(ids('pod.yaml', '# privileged: true')).toEqual([]);
    });
});

describe('more kube-linter checks', () => {
    const pod = (body) => `spec:\n  containers:\n${body}`;
    it.each([
        ['latest-tag', pod('    - image: nginx:latest'), pod('    - image: nginx:1.27.2')],
        ['latest-tag', pod('    - image: redis'), pod('    - image: "{{ .Values.image }}"')],
        ['no-read-only-root-fs', 'readOnlyRootFilesystem: false', 'readOnlyRootFilesystem: true'],
        ['sensitive-host-mounts', 'hostPath:\n  path: /etc', 'emptyDir: {}\n  path: /etc'],
        ['unsafe-proc-mount', 'procMount: Unmasked', 'procMount: Default'],
        ['cluster-admin-role-binding', 'roleRef:\n  kind: ClusterRole\n  name: cluster-admin', 'roleRef:\n  kind: ClusterRole\n  name: viewer'],
        ['wildcard-in-rules', '  verbs: ["*"]', '  verbs: ["get", "list"]'],
        ['env-var-secret', 'env:\n  - name: DB_PASSWORD\n    value: hunter2', 'env:\n  - name: DB_HOST\n    value: db'],
        ['ssh-port', '  - containerPort: 22', '  - containerPort: 8080'],
    ])('%s fires on the risky form only', (rule, bad, good) => {
        expect(ids('k8s/x.yaml', bad)).toContain(`kube-linter/${rule}`);
        expect(ids('k8s/x.yaml', good)).not.toContain(`kube-linter/${rule}`);
    });

    it('a probe or ingress path is not a host mount', () => {
        expect(ids('k8s/x.yaml', 'livenessProbe:\n  httpGet:\n    path: /')).toEqual([]);
        expect(ids('k8s/x.yaml', 'httpGet:\n  path: /etc')).toEqual([]);
    });

    it('an image line outside a workload is left alone (compose files, values files)', () => {
        expect(ids('values.yaml', 'image: redis')).toEqual([]);
    });

    it('a secret pulled from a secretKeyRef is fine', () => {
        expect(ids('k8s/x.yaml', 'env:\n  - name: API_TOKEN\n    valueFrom:\n      secretKeyRef: {name: t, key: k}')).toEqual([]);
    });
});

describe('more zizmor checks', () => {
    const wf = '.github/workflows/x.yml';
    it.each([
        ['bot-conditions', "    if: github.actor == 'dependabot[bot]'", "    if: github.event.pull_request.user.login == 'dependabot[bot]'"],
        ['secrets-inherit', '    secrets: inherit', '    secrets:\n      token: ${{ secrets.T }}'],
        ['overprovisioned-secrets', '      ALL: ${{ toJSON(secrets) }}', '      T: ${{ secrets.T }}'],
        ['insecure-commands', '      ACTIONS_ALLOW_UNSECURE_COMMANDS: true', '      ACTIONS_ALLOW_UNSECURE_COMMANDS: false'],
        ['unsound-contains', "    if: contains('refs/heads/main refs/heads/dev', github.ref)", "    if: contains(fromJSON('[\"a\"]'), github.ref)"],
        ['hardcoded-container-credentials', '    credentials:\n      username: u\n      password: hunter2', '    credentials:\n      username: u\n      password: ${{ secrets.P }}'],
    ])('%s fires on the risky form only', (rule, bad, good) => {
        expect(ids(wf, bad)).toContain(`zizmor/${rule}`);
        expect(ids(wf, good)).not.toContain(`zizmor/${rule}`);
    });

    it('writing GITHUB_ENV is flagged only in a privileged workflow', () => {
        const step = '      - run: echo "X=$X" >> "$GITHUB_ENV"';
        expect(ids(wf, `on: workflow_run\n${step}`)).toContain('zizmor/github-env');
        expect(ids(wf, `on: push\n${step}`)).toEqual([]);
    });
});

describe('Terraform (tfsec)', () => {
    const sg = (port, cidr, dir = 'ingress') => `${dir} {\n  from_port = ${port}\n  to_port = ${port}\n  cidr_blocks = ["${cidr}"]\n}`;
    it('flags a world-open ingress, not a narrow one, an egress, or a public web listener', () => {
        expect(ids('main.tf', sg(22, '0.0.0.0/0'))).toEqual(['tfsec/aws-ec2-no-public-ingress-sgr']);
        expect(ids('main.tf', sg(22, '10.0.0.0/24'))).toEqual([]);
        expect(ids('main.tf', sg(0, '0.0.0.0/0', 'egress'))).toEqual([]);
        expect(ids('main.tf', sg(443, '0.0.0.0/0'))).toEqual([]);
    });

    it('flags a public database and a public bucket', () => {
        expect(ids('db.tf', '  publicly_accessible = true')).toHaveLength(1);
        expect(ids('db.tf', '  publicly_accessible = false')).toHaveLength(0);
        expect(ids('s3.tf', '  acl = "public-read"')).toHaveLength(1);
    });
});

describe('shell (shellcheck)', () => {
    it.each([
        ['for f in $(ls dist); do', 'for f in dist/*; do'],
        ['rm -rf $BUILD_DIR/', 'rm -rf "${BUILD_DIR:?}/"'],
        ['rm -rf "$HOME_DIR"/lib', 'rm -rf "$TMP_DIR"'],
    ])('flags `%s`, not `%s`', (bad, good) => {
        expect(ids('deploy.sh', bad)).toHaveLength(1);
        expect(ids('deploy.sh', good)).toHaveLength(0);
    });
});

describe('React lists (eslint-plugin-react jsx-key)', () => {
    it('flags a mapped element without a key, on the same line or the next', () => {
        expect(ids('a.tsx', '{items.map((p) => <li>{p.name}</li>)}')).toEqual(['eslint-react/jsx-key']);
        expect(ids('a.tsx', '{items.map((p) => (\n  <li className="x">{p.name}</li>\n))}')).toEqual(['eslint-react/jsx-key']);
    });

    it('ignores markup that encloses the map, and still catches the mapped element', () => {
        expect(ids('a.tsx', '<ul>\n  {items.map((p) => (\n    <li>{p.name}</li>')).toEqual(['eslint-react/jsx-key']);
        expect(ids('a.tsx', '<ul>\n  {items.map((p) => (\n    <li key={p.id}>{p.name}</li>')).toEqual([]);
    });

    it('stays quiet when the key is there or nothing is mapped', () => {
        expect(ids('a.tsx', '{items.map((p) => <li key={p.id}>{p.name}</li>)}')).toEqual([]);
        expect(ids('a.tsx', '<ul><li>one</li></ul>')).toEqual([]);
    });
});

describe('SQL migrations (squawk)', () => {
    const mig = 'db/migrations/002.sql';
    it('flags a blocking index build, not a concurrent one', () => {
        expect(ids(mig, 'CREATE INDEX idx_name ON items (name);')).toEqual(['squawk/require-concurrent-index-creation']);
        expect(ids(mig, 'CREATE INDEX CONCURRENTLY idx_name ON items (name);')).toEqual([]);
    });

    it('flags a required column with no default, not one with a default', () => {
        expect(ids(mig, 'ALTER TABLE orders ADD COLUMN status text NOT NULL;')).toEqual(['squawk/adding-required-field']);
        expect(ids(mig, "ALTER TABLE orders ADD COLUMN status text NOT NULL DEFAULT 'open';")).toEqual([]);
    });

    it('leaves a table created in the same migration alone', () => {
        expect(ids(mig, 'CREATE TABLE items (id int);\nCREATE INDEX idx ON items (id);')).toEqual([]);
    });

    it('reports the line the statement starts on', () => {
        const [f] = lint.analyze('-- add index\n\nCREATE INDEX i ON t (c);', { filePath: mig }).findings;
        expect(f.line).toBe(3);
    });
});

describe('through StaticAnalysisService', () => {
    it('a Dockerfile change in a PR yields a finding at its real file line', async () => {
        const svc = new StaticAnalysisService({ enableDependency: false, enableEOL: false });
        const res = await svc.analyzePullRequest({ files: [{
            filename: 'Dockerfile', status: 'modified',
            patch: '@@ -1,3 +1,3 @@\n-FROM python:3.12-slim\n+FROM python:latest\n WORKDIR /app\n COPY . .',
        }] });
        const f = res.findings.find((x) => x.ruleId === 'hadolint/DL3007');
        expect(f).toMatchObject({ filePath: 'Dockerfile', line: 1, tool: 'config-lint' });
    });
});

describe('extension dependency path: OSV, lockfiles, pinned line', () => {
    const { DependencyAnalyzer } = require('../../src/services/DependencyAnalyzer.js');
    const { locateDependency } = require('../../src/utils/dependencyLocation.js');
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { lodash: '4.17.15' } }, 'node_modules/lodash': { version: '4.17.15' } } }, null, 2);
    const osvService = {
        mapEcosystem: () => 'npm',
        getCacheKey: (n, v, e) => `${e}:${n}@${v}`,
        queryBatch: async () => new Map([['npm:lodash@4.17.15', [{ id: 'GHSA-x', cve: 'CVE-2020-8203', severity: 'high', summary: 'prototype pollution', fixedVersions: ['4.17.19'], references: [] }]]]),
    };

    it('locates a pinned version in the lockfile and the manifest', () => {
        // Both the root dependency list and the resolved node_modules entry pin it.
        expect(locateDependency(lock, 'lodash', '4.17.15')).toHaveLength(2);
        expect(locateDependency('{\n  "dependencies": {\n    "lodash": "4.17.15"\n  }\n}', 'lodash', '4.17.15')).toEqual([3]);
    });

    it('a PR touching only package-lock.json gets an OSV finding on the lockfile line', async () => {
        const svc = new StaticAnalysisService({ enableEOL: false, dependency: { osvService } });
        const lines = lock.split('\n');
        const at = lines.findIndex((l) => l.includes('"version": "4.17.15"')) + 1;
        const res = await svc.analyzePullRequest({ files: [{
            filename: 'package-lock.json', status: 'modified',
            patch: `@@ -${at},1 +${at},1 @@\n-      "version": "4.18.1"\n+${lines[at - 1]}`,
            fullContent: lock,
        }] });
        const lodash = res.findings.filter((x) => x.tool === 'dependency' && x.packageName === 'lodash');
        expect(lodash.map((x) => x.line)).toContain(at);
        expect(lodash.every((x) => x.filePath === 'package-lock.json')).toBe(true);
        // The full-text pass runs the dependency analyzer only.
        expect(res.findings.filter((x) => x.tool !== 'dependency')).toEqual([]);
    });
});
