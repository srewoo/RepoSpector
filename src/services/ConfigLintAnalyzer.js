/**
 * ConfigLintAnalyzer — deterministic checks for the files a code linter never
 * reads: Dockerfiles, GitHub workflows, SQL migrations, Kubernetes manifests,
 * Terraform, shell scripts, and React list rendering.
 *
 * Each rule mirrors a rule of a published linter (hadolint, zizmor/actionlint,
 * squawk, kube-linter, tfsec, shellcheck, eslint-plugin-react), named in its id,
 * so the catalogue is the linters' and not a list tuned to any benchmark.
 *
 * Rules are line- or statement-local on purpose. The extension analyses only a
 * patch's ADDED lines, so a rule that needs the whole file ("no USER in the
 * final stage") would fire on every change that does not touch that line.
 */

const COMMENT = {
    dockerfile: /^\s*#/, workflow: /^\s*#/, yaml: /^\s*#/, terraform: /^\s*(#|\/\/)/,
    shell: /^\s*#/, sql: /^\s*--/, react: /^\s*(\/\/|\*)/,
};

/** Which rule set a path belongs to, or null. */
export function configKindOf(filePath = '') {
    const p = String(filePath).replace(/\\/g, '/');
    const base = p.split('/').pop() || '';
    if (/^(Dockerfile|Containerfile)(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base)) return 'dockerfile';
    if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(p)) return 'workflow';
    if (/\.ya?ml$/i.test(base)) return 'yaml';
    if (/\.tf$/i.test(base)) return 'terraform';
    if (/\.(sh|bash)$/i.test(base)) return 'shell';
    if (/\.sql$/i.test(base) && /migrat/i.test(p)) return 'sql';
    if (/\.(jsx|tsx)$/i.test(base)) return 'react';
    return null;
}

const UNTRUSTED_CONTEXT = /\$\{\{\s*(github\.event\.(issue|pull_request|comment|review|review_comment|discussion|discussion_comment|head_commit|commits|pages|workflow_run)\b[\w.[\]*-]*\.(title|body|message|name|label|ref|email|head_ref|head_branch|default_branch)|github\.head_ref)\s*\}\}/;
const PRIVILEGED_TRIGGER = /\b(pull_request_target|workflow_run)\b/;
const SENSITIVE_HOST_PATH = /^\s*path:\s*["']?\/(etc|proc|sys|root|dev|boot|lib|usr|var\/run|run|var\/lib\/docker|var\/lib\/kubelet)(\/[^"'\s]*)?["']?\s*$/;
/** A Kubernetes workload, as far as the visible text says: no `containers:`, no image rule. */
const underHostPath = (ctx) => lookBack(ctx.lines, ctx.i, 3).some((x) => /^\s*hostPath:/.test(x));
const looksLikeWorkload = (ctx) => /^\s*(containers|initContainers|ephemeralContainers):/m.test(ctx.text);
const lookBack = (lines, i, n) => lines.slice(Math.max(0, i - n), i).reverse();

/** rule: { id, severity, category, message, remediation, test(line, ctx) } */
const LINE_RULES = {
    dockerfile: [
        { id: 'hadolint/DL3007', severity: 'medium', category: 'container',
            message: 'Base image is not pinned to a version (untagged or :latest), so a rebuild can pull a different image.',
            remediation: 'Pin the image to a version tag or digest.',
            test: (l, ctx) => {
                const m = l.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i);
                if (!m || /^scratch$/i.test(m[1]) || m[1].includes('$') || ctx.stages.has(m[1].toLowerCase())) return false;
                const ref = m[1].split('/').pop();
                return !m[1].includes('@') && (!ref.includes(':') || /:latest$/i.test(ref));
            } },
        { id: 'hadolint/DL3020', severity: 'medium', category: 'container',
            message: 'ADD used for a local file; ADD also fetches URLs and unpacks archives, so COPY says what happens.',
            remediation: 'Use COPY for local files.',
            test: (l) => /^\s*ADD\s/i.test(l) && !/https?:\/\//i.test(l) && !/\.(tar|tgz|tar\.\w+)\b/i.test(l) },
        { id: 'hadolint/DL3042', severity: 'medium', category: 'container',
            message: 'pip install keeps its download cache in the image layer.',
            remediation: 'Add --no-cache-dir (or set PIP_NO_CACHE_DIR).',
            test: (l, ctx) => /\bpip3?\s+install\b/.test(l) && !/--no-cache-dir/.test(l) && !ctx.text.includes('PIP_NO_CACHE_DIR') },
        { id: 'hadolint/DL3014', severity: 'medium', category: 'container',
            message: 'apt-get install without -y stops at the confirmation prompt in a non-interactive build.',
            remediation: 'Add -y (or --yes).',
            test: (l) => /\bapt-get\s+(\S+\s+)*install\b/.test(l) && !/\s(-\w*y\w*|--yes|--assume-yes)\b/.test(l) },
    ],
    workflow: [
        { id: 'zizmor/template-injection', severity: 'high', category: 'ci-security',
            message: 'Attacker-controlled event text is expanded into the workflow; in a run script that is code injection.',
            remediation: 'Pass the value through an env variable and quote it in the script.',
            test: (l) => UNTRUSTED_CONTEXT.test(l) && !/^\s*if:/.test(l) },
        { id: 'zizmor/dangerous-triggers', severity: 'medium', category: 'ci-security',
            message: 'pull_request_target runs with the base repository\'s secrets and write token on events from forks.',
            remediation: 'Use pull_request, or workflow_run with no checkout of PR code.',
            test: (l) => /^\s*(-\s*)?pull_request_target\s*:?\s*$|^\s*on:\s*\[?.*\bpull_request_target\b/.test(l) },
        { id: 'zizmor/untrusted-checkout', severity: 'high', category: 'ci-security',
            message: 'A privileged workflow checks out the pull request\'s code, so that code runs with the workflow\'s secrets.',
            remediation: 'Do not check out PR head code in pull_request_target or workflow_run workflows.',
            test: (l, ctx) => /(pull_request_target|workflow_run)/.test(ctx.text)
                && /ref:\s*\$\{\{\s*(github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref|github\.event\.workflow_run\.head_(sha|branch))/.test(l) },
        { id: 'zizmor/excessive-permissions', severity: 'medium', category: 'ci-security',
            message: 'permissions: write-all gives every job write access to the whole repository.',
            remediation: 'Grant only the scopes each job needs.',
            test: (l) => /^\s*permissions:\s*write-all\b/.test(l) },
        { id: 'zizmor/bot-conditions', severity: 'high', category: 'ci-security',
            message: 'Trusting a run because github.actor names a bot is spoofable: the actor is whoever last acted, so a person can trigger the run as the bot.',
            remediation: 'Check github.event.pull_request.user.login, or avoid privileged triggers for bot PRs.',
            test: (l) => /\bif:.*github\.(actor|triggering_actor)\s*==\s*['"][^'"]*\[bot\]['"]/.test(l) },
        { id: 'zizmor/secrets-inherit', severity: 'medium', category: 'ci-security',
            message: 'secrets: inherit hands every secret of the caller to the reusable workflow.',
            remediation: 'Pass only the secrets the called workflow needs.',
            test: (l) => /^\s*secrets:\s*inherit\b/.test(l) },
        { id: 'zizmor/overprovisioned-secrets', severity: 'high', category: 'ci-security',
            message: 'toJSON(secrets) exposes every secret of the repository to this step.',
            remediation: 'Reference the specific secrets the step needs.',
            test: (l) => /toJSON\(\s*secrets\s*\)/i.test(l) },
        { id: 'zizmor/insecure-commands', severity: 'high', category: 'ci-security',
            message: 'ACTIONS_ALLOW_UNSECURE_COMMANDS re-enables set-env/add-path, which any log line can trigger.',
            remediation: 'Remove it and write to $GITHUB_ENV / $GITHUB_PATH instead.',
            test: (l) => /ACTIONS_ALLOW_UNSECURE_COMMANDS/.test(l) && !/:\s*["']?false/i.test(l) },
        { id: 'zizmor/github-env', severity: 'high', category: 'ci-security',
            message: 'A privileged workflow writes to GITHUB_ENV or GITHUB_PATH, which lets attacker-influenced values change later steps.',
            remediation: 'Do not write untrusted data to GITHUB_ENV/GITHUB_PATH in pull_request_target or workflow_run workflows.',
            test: (l, ctx) => PRIVILEGED_TRIGGER.test(ctx.text) && />>\s*["']?\$\{?GITHUB_(ENV|PATH)\b/.test(l) },
        { id: 'zizmor/hardcoded-container-credentials', severity: 'high', category: 'ci-security',
            message: 'A container registry password is written into the workflow.',
            remediation: 'Use a secret: password: ${{ secrets.REGISTRY_PASSWORD }}.',
            test: (l, ctx) => /^\s*password:\s*["']?[^\s"'$]/.test(l) && !/\$\{\{/.test(l)
                && lookBack(ctx.lines, ctx.i, 3).some((x) => /^\s*credentials:/.test(x)) },
        { id: 'zizmor/unsound-contains', severity: 'medium', category: 'ci-security',
            message: 'contains() with a string first argument is a substring test, so a crafted ref or name can satisfy it.',
            remediation: "Test against a list: contains(fromJSON('[\"a\",\"b\"]'), github.ref).",
            test: (l) => /\bcontains\(\s*['"][^'"]+['"]\s*,\s*(github|env|inputs)\./.test(l) },
    ],
    yaml: [
        { id: 'kube-linter/privileged-container', severity: 'high', category: 'kubernetes',
            message: 'privileged: true gives the container full access to the node.',
            remediation: 'Remove privileged, grant specific capabilities if needed.',
            test: (l) => /^\s*privileged:\s*true\b/.test(l) },
        { id: 'kube-linter/privilege-escalation-container', severity: 'medium', category: 'kubernetes',
            message: 'allowPrivilegeEscalation: true lets a process gain more privileges than its parent.',
            remediation: 'Set allowPrivilegeEscalation: false.',
            test: (l) => /^\s*allowPrivilegeEscalation:\s*true\b/.test(l) },
        { id: 'kube-linter/host-namespace', severity: 'high', category: 'kubernetes',
            message: 'The pod shares a host namespace (network, PID or IPC), escaping its isolation.',
            remediation: 'Remove hostNetwork / hostPID / hostIPC.',
            test: (l) => /^\s*host(Network|PID|IPC):\s*true\b/.test(l) },
        { id: 'kube-linter/sensitive-host-mounts', severity: 'high', category: 'kubernetes',
            message: 'A sensitive host directory is mounted into the pod, exposing or altering the node.',
            remediation: 'Do not mount host system directories; use a volume type scoped to the pod.',
            test: (l, ctx) => SENSITIVE_HOST_PATH.test(l) && !/docker\.sock|containerd\.sock/.test(l) && underHostPath(ctx) },
        { id: 'kube-linter/latest-tag', severity: 'medium', category: 'kubernetes',
            message: 'The container image is untagged or :latest, so a restart can run a different image.',
            remediation: 'Pin the image to a version tag or digest.',
            test: (l, ctx) => {
                const m = l.match(/^\s*(?:-\s*)?image:\s*["']?([^"'\s#]+)/);
                if (!m || /[{$]/.test(m[1]) || !looksLikeWorkload(ctx)) return false;
                const ref = m[1].split('/').pop();
                return !m[1].includes('@') && (!ref.includes(':') || /:latest$/i.test(ref));
            } },
        { id: 'kube-linter/no-read-only-root-fs', severity: 'medium', category: 'kubernetes',
            message: 'The container root filesystem is writable, so a compromise can persist or plant binaries.',
            remediation: 'Set readOnlyRootFilesystem: true and mount writable paths as volumes.',
            test: (l) => /^\s*readOnlyRootFilesystem:\s*false\b/.test(l) },
        { id: 'kube-linter/unsafe-proc-mount', severity: 'high', category: 'kubernetes',
            message: 'procMount: Unmasked exposes the host /proc to the container.',
            remediation: 'Remove procMount or use Default.',
            test: (l) => /^\s*procMount:\s*["']?Unmasked\b/.test(l) },
        { id: 'kube-linter/cluster-admin-role-binding', severity: 'high', category: 'kubernetes',
            message: 'A role binding grants cluster-admin, full control of the cluster.',
            remediation: 'Bind a role with only the permissions needed.',
            test: (l, ctx) => /^\s*name:\s*["']?cluster-admin["']?\s*$/.test(l)
                && lookBack(ctx.lines, ctx.i, 4).some((x) => /^\s*roleRef:/.test(x)) },
        { id: 'kube-linter/wildcard-in-rules', severity: 'high', category: 'kubernetes',
            message: 'An RBAC rule uses a wildcard, granting every verb or resource including ones added later.',
            remediation: 'List the verbs and resources explicitly.',
            test: (l, ctx) => /^\s*-?\s*(verbs|resources|apiGroups):\s*\[\s*["']\*["']/.test(l)
                || (/^\s*-\s*["']\*["']\s*$/.test(l) && /^\s*-?\s*(verbs|resources):\s*$/.test(lookBack(ctx.lines, ctx.i, 4).find((x) => /:\s*$/.test(x)) || '')) },
        { id: 'kube-linter/env-var-secret', severity: 'high', category: 'kubernetes',
            message: 'A secret is written in plain text into an environment variable of the manifest.',
            remediation: 'Use valueFrom.secretKeyRef.',
            test: (l, ctx) => {
                if (!/^\s*value:\s*["']?\S/.test(l) || /\{\{|\$\(|\$\{/.test(l)) return false;
                const name = lookBack(ctx.lines, ctx.i, 2).find((x) => /^\s*-?\s*name:/.test(x)) || '';
                return /name:\s*["']?[\w-]*(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY)[\w-]*["']?\s*$/i.test(name)
                    && !/value:\s*["']?["']?\s*$/.test(l);
            } },
        { id: 'kube-linter/ssh-port', severity: 'medium', category: 'kubernetes',
            message: 'The container exposes port 22, which usually means an SSH server inside a container.',
            remediation: 'Use kubectl exec instead of running SSH in the pod.',
            test: (l) => /^\s*-?\s*containerPort:\s*22\s*$/.test(l) },
        { id: 'kube-linter/docker-sock', severity: 'high', category: 'kubernetes',
            message: 'Mounting the Docker socket or the host root gives the pod root on the node.',
            remediation: 'Do not mount docker.sock or / from the host.',
            test: (l, ctx) => underHostPath(ctx) && /^\s*path:\s*["']?(\/var\/run\/docker\.sock|\/run\/containerd\/containerd\.sock|\/)["']?\s*$/.test(l) },
        { id: 'kube-linter/run-as-non-root', severity: 'medium', category: 'kubernetes',
            message: 'The container is allowed to run as root.',
            remediation: 'Set runAsNonRoot: true and a non-zero runAsUser.',
            test: (l) => /^\s*runAsNonRoot:\s*false\b|^\s*runAsUser:\s*0\s*$/.test(l) },
        { id: 'kube-linter/dangerous-capabilities', severity: 'high', category: 'kubernetes',
            message: 'The container adds a capability that is close to full root (SYS_ADMIN, NET_ADMIN or ALL).',
            remediation: 'Drop ALL and add only what is needed.',
            test: (l, ctx) => /^\s*-\s*["']?(SYS_ADMIN|NET_ADMIN|ALL)["']?\s*$/.test(l)
                && /^\s*add:/.test(lookBack(ctx.lines, ctx.i, 6).find((x) => /^\s*(add|drop):/.test(x)) || '') },
    ],
    terraform: [
        { id: 'tfsec/aws-ec2-no-public-ingress-sgr', severity: 'high', category: 'infrastructure',
            message: 'An ingress rule is open to the whole internet.',
            remediation: 'Restrict the CIDR to the networks that need access.',
            test: (l, ctx) => {
                if (!/cidr_blocks\s*=.*"(0\.0\.0\.0\/0|::\/0)"/.test(l)) return false;
                const block = ctx.lines.slice(Math.max(0, ctx.i - 10), ctx.i + 6).join('\n');
                const lastEgress = lookBack(ctx.lines, ctx.i, 10).findIndex((x) => /egress|type\s*=\s*"egress"/.test(x));
                const lastIngress = lookBack(ctx.lines, ctx.i, 10).findIndex((x) => /ingress|type\s*=\s*"ingress"/.test(x));
                if (lastIngress < 0 || (lastEgress >= 0 && lastEgress < lastIngress)) return false;
                // A public web listener is the one legitimate world-open ingress.
                return !/from_port\s*=\s*(80|443)\b/.test(block);
            } },
        { id: 'tfsec/aws-rds-no-public-db-access', severity: 'high', category: 'infrastructure',
            message: 'The database is reachable from the internet.',
            remediation: 'Set publicly_accessible = false.',
            test: (l) => /^\s*publicly_accessible\s*=\s*true\b/.test(l) },
        { id: 'tfsec/aws-s3-no-public-access', severity: 'high', category: 'infrastructure',
            message: 'The bucket ACL makes its objects public.',
            remediation: 'Use a private ACL and grant access explicitly.',
            test: (l) => /^\s*acl\s*=\s*"public-read(-write)?"/.test(l) },
        { id: 'tfsec/encryption-disabled', severity: 'medium', category: 'infrastructure',
            message: 'Encryption at rest is switched off.',
            remediation: 'Enable encryption.',
            test: (l) => /^\s*(storage_)?encrypted\s*=\s*false\b/.test(l) },
    ],
    shell: [
        { id: 'shellcheck/SC2045', severity: 'medium', category: 'shell',
            message: 'Looping over ls output splits file names on whitespace.',
            remediation: 'Iterate over a glob instead.',
            test: (l) => /\bfor\s+\w+\s+in\s+(\$\(|`)\s*ls\b/.test(l) },
        { id: 'shellcheck/SC2115', severity: 'high', category: 'shell',
            message: 'rm -r on a variable path with no guard deletes from / when the variable is empty.',
            remediation: 'Use "${VAR:?}/..." so an empty variable stops the script.',
            // Only a variable FOLLOWED BY a path: an empty "$VAR" alone removes nothing.
            test: (l) => /\brm\s+-\w*r\w*\s+(-\S+\s+)*"?\$\{?\w+\}?"?\//.test(l) && !/:\?/.test(l) },
    ],
    react: [
        { id: 'eslint-react/jsx-key', severity: 'medium', category: 'react',
            message: 'Elements rendered from .map() have no key, so React cannot match them between renders.',
            remediation: 'Give each element a stable key, such as its id.',
            test: (l, ctx) => {
                const open = l.match(/<([A-Za-z][\w.]*)\b[^>]*>?/);
                if (!open || /\bkey=/.test(open[0])) return false;
                if (/\.map\(/.test(l.slice(0, open.index))) return true;
                // The element is the first JSX after a `.map(` up to two lines
                // above; markup BEFORE the map (the enclosing <ul>) is irrelevant.
                const before = lookBack(ctx.lines, ctx.i, 2);
                const at = before.findIndex((x) => /\.map\(/.test(x));
                if (at < 0) return false;
                const between = [before[at].slice(before[at].lastIndexOf('.map(')), ...before.slice(0, at)];
                return !between.some((x) => /</.test(x.replace(/=>/g, '')));
            } },
    ],
};

/** Statement rules for SQL migrations (squawk). `table` is the statement's table. */
const SQL_RULES = [
    { id: 'squawk/require-concurrent-index-creation', severity: 'medium', category: 'migration-safety',
        message: 'CREATE INDEX without CONCURRENTLY blocks writes to the table until the index is built.',
        remediation: 'Use CREATE INDEX CONCURRENTLY (outside a transaction).',
        test: (s) => /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s) && !/\bCONCURRENTLY\b/i.test(s) },
    { id: 'squawk/adding-required-field', severity: 'high', category: 'migration-safety',
        message: 'Adding a NOT NULL column with no default fails on a table that already has rows.',
        remediation: 'Add the column nullable or with a default, backfill, then set NOT NULL.',
        test: (s) => /\bADD\s+(COLUMN\s+)?\w+\s+[\s\S]*\bNOT\s+NULL\b/i.test(s) && /\bALTER\s+TABLE\b/i.test(s) && !/\bDEFAULT\b/i.test(s) },
    { id: 'squawk/adding-not-nullable-field', severity: 'medium', category: 'migration-safety',
        message: 'SET NOT NULL scans the whole table under an exclusive lock.',
        remediation: 'Add a NOT VALID check constraint, validate it, then set NOT NULL.',
        test: (s) => /\bALTER\s+COLUMN\s+\w+\s+SET\s+NOT\s+NULL\b/i.test(s) },
    { id: 'squawk/changing-column-type', severity: 'medium', category: 'migration-safety',
        message: 'Changing a column type rewrites the table under an exclusive lock.',
        remediation: 'Add a new column, backfill, and switch over.',
        test: (s) => /\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i.test(s) },
    { id: 'squawk/adding-foreign-key-constraint', severity: 'medium', category: 'migration-safety',
        message: 'Adding a foreign key validates every row while locking both tables.',
        remediation: 'Add it NOT VALID, then VALIDATE CONSTRAINT separately.',
        test: (s) => /\bADD\s+(CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\b/i.test(s) && !/\bNOT\s+VALID\b/i.test(s) },
];

function finding(rule, filePath, line, text) {
    return {
        ruleId: rule.id, severity: rule.severity, category: rule.category,
        message: rule.message, remediation: rule.remediation,
        line, column: 1, codeSnippet: text.trim(), matchedText: text.trim(),
        confidence: 0.9, filePath, tool: 'config-lint', engine: 'config-lint',
    };
}

function analyzeSql(code, filePath) {
    const created = new Set([...code.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w.]+)/gi)].map((m) => m[1].toLowerCase()));
    const out = [];
    let offset = 0;
    for (const stmt of code.split(';')) {
        // Blank comments to equal-length spaces so offsets still map to lines.
        const body = stmt.replace(/--.*$/gm, (c) => ' '.repeat(c.length));
        const lead = body.search(/\S/);
        if (lead >= 0) {
            const line = code.slice(0, offset + lead).split('\n').length;
            const table = (body.match(/\b(?:ON|ALTER\s+TABLE)\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?["`]?([\w.]+)/i) || [])[1];
            // A table created in this migration has no rows and no traffic yet.
            if (!(table && created.has(table.toLowerCase()))) {
                for (const rule of SQL_RULES) if (rule.test(body)) out.push(finding(rule, filePath, line, body.trim().split('\n')[0]));
            }
        }
        offset += stmt.length + 1;
    }
    return out;
}

export class ConfigLintAnalyzer {
    /** @returns {{findings: Array<object>, kind: string|null}} */
    analyze(code, { filePath = '' } = {}) {
        const kind = configKindOf(filePath);
        if (!kind || !code) return { findings: [], kind };
        if (kind === 'sql') return { findings: analyzeSql(String(code), filePath), kind };

        const lines = String(code).split('\n');
        const ctx = {
            lines, text: String(code), i: 0,
            stages: new Set([...String(code).matchAll(/^\s*FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase())),
        };
        const findings = [];
        lines.forEach((line, i) => {
            if (COMMENT[kind]?.test(line)) return;
            ctx.i = i;
            for (const rule of LINE_RULES[kind]) {
                if (rule.test(line, ctx)) findings.push(finding(rule, filePath, i + 1, line));
            }
        });
        return { findings, kind };
    }
}

export default ConfigLintAnalyzer;
