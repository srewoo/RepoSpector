import { button, el } from './dom.js';
import { hello, installCommand, localModeOn, setLocalMode } from './local-mode.js';

/**
 * Settings section for local mode: the install command for this extension, turning it on (asks for
 * the nativeMessaging permission inside the click), and a check that lists what the program may read.
 */
export async function renderLocalMode(root: HTMLElement, say: (t: string) => void): Promise<void> {
  const rerender = () => void renderLocalMode(root, say);
  const on = await localModeOn();
  const intro = el('p', { className: 'muted', textContent: 'If a repository is cloned on this computer, RepoSpector can ask its local program where code is used instead of downloading the repository. The program reads only the folders you list when installing it. Needs Node.js 22 or later.' });
  const cmd = el('pre', { className: 'command' }, el('code', { textContent: installCommand(chrome.runtime.id) }));
  const status = el('p', { role: 'status' });
  const check = async (): Promise<void> => {
    status.className = 'muted';
    status.textContent = 'Checking…';
    const r = await hello();
    if (!r.ok) {
      status.className = 'error';
      status.textContent = r.message;
      return;
    }
    status.className = '';
    status.textContent = r.repos.length
      ? `Connected to RepoSpector ${r.version}. It may read: ${r.repos.map((x) => `${x.path}${x.remotes.length ? ` (${x.remotes.join(', ')})` : ' (no GitHub or GitLab remote)'}`).join('; ')}.`
      : `Connected to RepoSpector ${r.version}, but no repositories are listed. Run \`repospector-mcp native add-repo <path>\`.`;
  };
  if (!on) {
    const enable = button('Turn on local mode', () => {
      // The permission request must be the first await so it stays inside the click.
      chrome.permissions.request({ permissions: ['nativeMessaging'] }).then(
        async (granted) => {
          if (!granted) return say('Chrome permission to talk to the local program was not granted, so local mode stays off.');
          await setLocalMode(true);
          say('Local mode is on.');
          rerender();
        },
        (e: unknown) => say(`Chrome could not ask for permission: ${(e as Error).message}`),
      );
    });
    root.replaceChildren(intro, el('p', { textContent: 'First, install the program for this extension:' }), cmd, el('div', { className: 'actions' }, enable));
    return;
  }
  const off = button('Turn off local mode', () => {
    void (async () => {
      await setLocalMode(false);
      await chrome.permissions.remove({ permissions: ['nativeMessaging'] }).catch(() => false);
      say('Local mode is off.');
      rerender();
    })();
  });
  root.replaceChildren(intro, status, el('p', { className: 'muted', textContent: 'To add a repository or reinstall:' }), cmd, el('div', { className: 'actions' }, button('Check again', () => void check()), off));
  await check();
}
