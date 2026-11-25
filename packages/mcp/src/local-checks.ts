import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The repository's own lint, type-check and test commands, found in its config files. RepoSpector
 * never runs them: the agent shows them to the user and runs only the ones the user approves (they
 * execute code from the repository), then hands the output to submit_check_results.
 */
export interface LocalCheck {
  readonly name: string;
  readonly command: string;
  /** Where it came from, and what it runs. */
  readonly why: string;
}

const MAX_CHECKS = 6;
const SCRIPT_NAMES = ['lint', 'typecheck', 'type-check', 'check-types', 'test'] as const;

function read(root: string, file: string): string | undefined {
  const p = join(root, file);
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').slice(0, 200_000) : undefined;
  } catch {
    return undefined;
  }
}

function nodeRunner(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function fromPackageJson(root: string): LocalCheck[] {
  const text = read(root, 'package.json');
  if (!text) return [];
  let scripts: Record<string, unknown> = {};
  try {
    scripts = ((JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}) as Record<string, unknown>;
  } catch {
    return [];
  }
  const runner = nodeRunner(root);
  return SCRIPT_NAMES.flatMap((name) => {
    const body = scripts[name];
    if (typeof body !== 'string') return [];
    const command = name === 'test' && runner === 'npm' ? 'npm test' : `${runner} run ${name}`;
    return [{ name, command, why: `package.json script "${name}": ${body.slice(0, 200)}` }];
  });
}

function fromOtherConfigs(root: string): LocalCheck[] {
  const out: LocalCheck[] = [];
  const pyproject = read(root, 'pyproject.toml') ?? '';
  if (/\[tool\.ruff/.test(pyproject) || existsSync(join(root, 'ruff.toml'))) out.push({ name: 'ruff', command: 'ruff check .', why: 'ruff is configured (pyproject.toml or ruff.toml)' });
  if (/\[tool\.mypy/.test(pyproject) || existsSync(join(root, 'mypy.ini'))) out.push({ name: 'mypy', command: 'mypy .', why: 'mypy is configured' });
  if (/\[tool\.pytest/.test(pyproject) || existsSync(join(root, 'pytest.ini'))) out.push({ name: 'pytest', command: 'python -m pytest -q', why: 'pytest is configured' });
  if (existsSync(join(root, 'go.mod'))) out.push({ name: 'go vet', command: 'go vet ./...', why: 'Go module (go.mod)' }, { name: 'go test', command: 'go test ./...', why: 'Go module (go.mod)' });
  if (existsSync(join(root, 'Cargo.toml'))) out.push({ name: 'clippy', command: 'cargo clippy --all-targets', why: 'Rust crate (Cargo.toml)' }, { name: 'cargo test', command: 'cargo test', why: 'Rust crate (Cargo.toml)' });
  if (/rubocop/.test(read(root, 'Gemfile') ?? '')) out.push({ name: 'rubocop', command: 'bundle exec rubocop', why: 'rubocop is in the Gemfile' });
  const makefile = read(root, 'Makefile') ?? '';
  for (const target of ['lint', 'test']) if (new RegExp(`^${target}:`, 'm').test(makefile)) out.push({ name: `make ${target}`, command: `make ${target}`, why: `Makefile target "${target}"` });
  return out;
}

export function detectLocalChecks(root: string): LocalCheck[] {
  const seen = new Set<string>();
  return [...fromPackageJson(root), ...fromOtherConfigs(root)].filter((c) => !seen.has(c.command) && seen.add(c.command)).slice(0, MAX_CHECKS);
}
