/**
 * Where a dependency version is pinned, for both the extension and MCP.
 */

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


/**
 * Lines in one manifest or lockfile that pin `name` at `version`.
 *
 * Format-agnostic on purpose: the name on a line, with the exact version on
 * that line or one of the next three (package-lock's `"node_modules/x": {`
 * then `"version"`, yarn.lock's `x@^1:` then `version`, or `x==1.2` / `"x":
 * "1.2"` on one line). An advisory reported only on the manifest left the
 * lockfile line, where the vulnerable version is actually resolved, unflagged.
 */
export function locateDependency(content, name, version) {
    if (!content || !name || !version) return [];
    const lines = String(content).split('\n');
    const nameRe = new RegExp(`(^|[\\s"'/@])${escapeRe(name)}(["'@:=<>~^\\s]|$)`);
    const versionRe = new RegExp(`(^|[^\\w.])${escapeRe(String(version).replace(/^[\^~=v]+/, ''))}($|[^\\w.])`);
    const out = [];
    lines.forEach((line, i) => {
        if (!nameRe.test(line)) return;
        for (let j = i; j <= Math.min(i + 3, lines.length - 1); j++) {
            if (j > i && nameRe.test(lines[j])) break;
            if (versionRe.test(lines[j])) { out.push(j + 1); return; }
        }
    });
    return [...new Set(out)];
}

/**
 * One finding per line that pins the vulnerable version. A lockfile pins it
 * twice (the root dependency list and the resolved entry); taking only the
 * first put the finding on a line the change may not touch, where the
 * diff-scope filter then dropped it. Downstream scoping keeps the changed ones.
 */
export function withDependencyLines(findings = [], content = '') {
    return findings.flatMap((f) => {
        if (f?.line != null || !f?.packageName) return [f];
        const lines = locateDependency(content, f.packageName, f.installedVersion);
        return lines.length ? lines.map((line) => ({ ...f, line })) : [{ ...f, line: null }];
    });
}
