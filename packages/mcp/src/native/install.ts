import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GitRepo } from '../git.js';
import { configDir, configPath, HOST_NAME, loadConfig, saveConfig } from './config.js';

/** Per-user manifest folders Chrome reads (Chrome docs: native messaging, "Native messaging host location"). */
export function manifestDirs(os = platform(), home = homedir()): Record<string, string> {
  if (os === 'darwin') {
    const base = join(home, 'Library', 'Application Support');
    return { chrome: join(base, 'Google', 'Chrome', 'NativeMessagingHosts'), chromium: join(base, 'Chromium', 'NativeMessagingHosts') };
  }
  if (os === 'linux') return { chrome: join(home, '.config', 'google-chrome', 'NativeMessagingHosts'), chromium: join(home, '.config', 'chromium', 'NativeMessagingHosts') };
  return {};
}

export function hostManifest(launcher: string, extensionId: string): Record<string, unknown> {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('the extension id is 32 letters a–p; copy it from RepoSpector settings (Local mode)');
  // allowed_origins: only this extension may start the program.
  return { name: HOST_NAME, description: 'RepoSpector local code index', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
}

/** Chrome starts `path` directly, with no shell and no PATH guarantees: pin this Node and this host file. */
export function launcherScript(nodePath: string, hostJs: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# RepoSpector local mode, written by \`repospector-mcp native install\`.\nexec ${q(nodePath)} ${q(hostJs)} "$@"\n`;
}

async function checkRepo(path: string): Promise<string> {
  const repo = await GitRepo.open(resolve(path));
  return repo.root;
}

export interface InstallResult {
  readonly launcher: string;
  readonly manifests: string[];
  readonly repos: string[];
}

export async function install(opts: { extensionId: string; repos: readonly string[]; manifestDirs?: readonly string[] | undefined; env?: NodeJS.ProcessEnv }): Promise<InstallResult> {
  if (platform() === 'win32') throw new Error('Windows is not supported by this command yet: register the host manifest under HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.repospector.local by hand (see Chrome docs)');
  const env = opts.env ?? process.env;
  const hostJs = join(dirname(fileURLToPath(import.meta.url)), 'host.js');
  const launcher = join(configDir(env), 'native-host.sh');
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  writeFileSync(launcher, launcherScript(process.execPath, hostJs), { mode: 0o755 });
  chmodSync(launcher, 0o755);
  const manifest = `${JSON.stringify(hostManifest(launcher, opts.extensionId), null, 2)}\n`;
  const dirs = opts.manifestDirs?.length ? [...opts.manifestDirs] : Object.values(manifestDirs());
  const written: string[] = [];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
    const file = join(d, `${HOST_NAME}.json`);
    writeFileSync(file, manifest);
    written.push(file);
  }
  const added = await Promise.all(opts.repos.map(checkRepo));
  const cfg = loadConfig(configPath(env));
  saveConfig({ repos: [...cfg.repos, ...added] }, configPath(env));
  return { launcher, manifests: written, repos: loadConfig(configPath(env)).repos };
}

export function uninstall(dirs: readonly string[] = Object.values(manifestDirs())): string[] {
  const removed: string[] = [];
  for (const d of dirs) {
    const f = join(d, `${HOST_NAME}.json`);
    if (existsSync(f)) {
      rmSync(f);
      removed.push(f);
    }
  }
  return removed;
}

const USAGE = `usage:
  repospector-mcp native install --extension-id <id> [--repo <path>]... [--manifest-dir <dir>]...
  repospector-mcp native add-repo <path>...
  repospector-mcp native remove-repo <path>...
  repospector-mcp native status
  repospector-mcp native uninstall`;

/** `repospector-mcp native …` */
export async function nativeCli(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: [...rest], options: { 'extension-id': { type: 'string' }, repo: { type: 'string', multiple: true }, 'manifest-dir': { type: 'string', multiple: true } }, allowPositionals: true, strict: true });
  if (cmd === 'install' && values['extension-id']) {
    const r = await install({ extensionId: values['extension-id'], repos: values.repo ?? [], manifestDirs: values['manifest-dir'] });
    console.log(`Registered RepoSpector local mode with Chrome:\n  ${r.manifests.join('\n  ')}\nProgram: ${r.launcher}\nRepositories it may read (${r.repos.length}):\n  ${r.repos.join('\n  ') || '(none yet: add one with `repospector-mcp native add-repo <path>`)'}\nRestart Chrome if it was open, then turn on Local mode in RepoSpector settings.`);
    return 0;
  }
  if ((cmd === 'add-repo' || cmd === 'remove-repo') && positionals.length) {
    const cfg = loadConfig();
    const paths = await Promise.all(positionals.map((p) => (cmd === 'add-repo' ? checkRepo(p) : Promise.resolve(resolve(p)))));
    saveConfig({ repos: cmd === 'add-repo' ? [...cfg.repos, ...paths] : cfg.repos.filter((r) => !paths.includes(r)) });
    console.log(`Repositories local mode may read:\n  ${loadConfig().repos.join('\n  ') || '(none)'}`);
    return 0;
  }
  if (cmd === 'status') {
    const found = Object.values(manifestDirs()).map((d) => join(d, `${HOST_NAME}.json`)).filter((f) => existsSync(f));
    console.log(`Registered: ${found.length ? found.join(', ') : 'no'}\nConfig: ${configPath()}\nRepositories:\n  ${loadConfig().repos.join('\n  ') || '(none)'}`);
    return 0;
  }
  if (cmd === 'uninstall') {
    const removed = uninstall();
    console.log(removed.length ? `Removed:\n  ${removed.join('\n  ')}` : 'Nothing was registered.');
    return 0;
  }
  console.error(USAGE);
  return 2;
}
