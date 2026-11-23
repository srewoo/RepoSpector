import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** Host name Chrome uses to find the program; also the manifest file name. */
export const HOST_NAME = 'com.repospector.local';

/** The only repositories the local program will read. Written by `native install` / `native add-repo`. */
const ConfigSchema = z.object({ repos: z.array(z.string().refine(isAbsolute, 'repo paths must be absolute')).max(200) }).strict();
export type NativeConfig = z.infer<typeof ConfigSchema>;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'), 'repospector');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'native.json');
}

export function loadConfig(path = configPath()): NativeConfig {
  if (!existsSync(path)) return { repos: [] };
  return ConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveConfig(config: NativeConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const clean: NativeConfig = { repos: [...new Set(config.repos.map((r) => resolve(r)))].sort() };
  writeFileSync(path, `${JSON.stringify(ConfigSchema.parse(clean), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * `github.com/owner/repo` from a git remote URL (https, ssh, scp-like), lower-cased, without `.git`
 * or credentials. Undefined for local paths and anything else.
 */
export function remoteKey(url: string): string | undefined {
  const u = url.trim();
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(u);
  if (scp) [, host, path] = scp;
  else {
    try {
      const parsed = new URL(u);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return undefined;
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const clean = (path ?? '').replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
  return host && clean.includes('/') ? `${host}/${clean}`.toLowerCase() : undefined;
}
