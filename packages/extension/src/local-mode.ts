import type { FindingContext } from '@repospector/core';
import { MCP_VERSION } from './versions.js';

/** Must match the host name `repospector-mcp native install` registers. */
export const NATIVE_HOST = 'com.repospector.local';
const KEY = 'localMode';

export async function localModeOn(): Promise<boolean> {
  const v = await chrome.storage.local.get(KEY);
  return v[KEY] === true && (await chrome.permissions.contains({ permissions: ['nativeMessaging'] }));
}

export async function setLocalMode(on: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEY]: on });
}

export type LocalHello = { ok: true; version: string; repos: { path: string; remotes: string[] }[] } | { ok: false; message: string };
export type LocalContext = { ok: true; files: number; ms: number; context: Record<string, FindingContext> } | { ok: false; reason: string; message: string };

/** Chrome's errors when the program is missing are terse; say what to do instead. */
function explain(e: unknown): string {
  const m = (e as Error).message ?? String(e);
  if (/not found/i.test(m)) return 'The RepoSpector program is not installed for this browser. Run the command below, then restart Chrome.';
  if (/forbidden/i.test(m)) return 'The installed program does not allow this extension. Run the command below again: it includes this extension\'s id.';
  if (/exited|native host has exited/i.test(m)) return 'The RepoSpector program stopped. Check that Node.js 22 or later is installed, then run the command below again.';
  return `Could not reach the RepoSpector program: ${m}`;
}

async function send<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendNativeMessage<T>(NATIVE_HOST, message);
}

export async function hello(): Promise<LocalHello> {
  try {
    const r = await send<LocalHello | undefined>({ type: 'hello' });
    return r ?? { ok: false, message: 'The RepoSpector program gave no answer.' };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

/** Reader context from the user's clone; the program reads only repositories they listed. */
export async function localContext(repo: string, sha: string, findings: readonly { id: string; file: string; line: number }[]): Promise<LocalContext> {
  try {
    const r = await send<LocalContext | undefined>({ type: 'context', repo, sha, findings });
    return r ?? { ok: false, reason: 'error', message: 'The RepoSpector program gave no answer.' };
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: explain(e) };
  }
}

/** Global install, not npx: Chrome starts the program by a fixed path, and npx's cache can be cleaned. */
export { MCP_VERSION };
export const installCommand = (extensionId: string): string => `npm install -g repospector-mcp@${MCP_VERSION}\nrepospector-mcp native install --extension-id ${extensionId} --repo /path/to/your/clone`;
