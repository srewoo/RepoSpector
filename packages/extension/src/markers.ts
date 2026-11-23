/**
 * Content script, injected on demand by the side panel into a pull request tab on a host the user
 * granted. It only places markers beside diff lines: it holds no keys, makes no requests and reads
 * nothing from the page except where lines are. Accepts messages from this extension only.
 */
interface MarkerFinding {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly status: string;
  readonly claim: string;
}
interface MarkerMessage {
  readonly type: 'repospector:markers';
  readonly kind: 'github' | 'gitlab';
  readonly findings: readonly MarkerFinding[];
}

const CLASS = 'repospector-marker';
const MAX_FINDINGS = 200;
const COLORS = { verified: '#0B6E63', other: '#656D76' } as const;

/** Narrow, explicit validation: the content script trusts no message shape. */
export function parseMarkerMessage(m: unknown): MarkerMessage | null {
  if (typeof m !== 'object' || m === null) return null;
  const o = m as Record<string, unknown>;
  if (o.type !== 'repospector:markers' || (o.kind !== 'github' && o.kind !== 'gitlab') || !Array.isArray(o.findings) || o.findings.length > MAX_FINDINGS) return null;
  const findings: MarkerFinding[] = [];
  for (const f of o.findings as unknown[]) {
    const x = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>;
    if (typeof x.id !== 'string' || typeof x.file !== 'string' || typeof x.status !== 'string' || typeof x.claim !== 'string' || !Number.isInteger(x.line) || (x.line as number) < 1) return null;
    findings.push({ id: x.id.slice(0, 64), file: x.file.slice(0, 500), line: x.line as number, status: x.status.slice(0, 20), claim: x.claim.slice(0, 500) });
  }
  return { type: 'repospector:markers', kind: o.kind, findings };
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** GitHub names each file's diff `diff-<sha256(path)>` and new-side lines `…R<line>`. */
async function githubCell(f: MarkerFinding): Promise<Element | null> {
  const anchor = `diff-${await sha256Hex(f.file)}`;
  const direct = document.getElementById(`${anchor}R${f.line}`);
  if (direct) return direct;
  const file = document.querySelector(`[data-diff-anchor="${anchor}"]`) ?? document.querySelector(`[data-tagsearch-path="${CSS.escape(f.file)}"]`);
  const cells = [...(file?.querySelectorAll(`[data-line-number="${f.line}"]`) ?? [])];
  // In a unified row the new-side number is the last one; skip old-side ids (…L<line>).
  return cells.find((c) => c.id.endsWith(`R${f.line}`)) ?? cells.filter((c) => !c.id.endsWith(`L${f.line}`)).at(-1) ?? null;
}

function gitlabCell(f: MarkerFinding): Element | null {
  const file = document.querySelector(`.diff-file[data-path="${CSS.escape(f.file)}"]`) ?? document.querySelector(`[data-path="${CSS.escape(f.file)}"]`);
  return file?.querySelector(`.new_line [data-linenumber="${f.line}"], .new_line[data-linenumber="${f.line}"]`) ?? null;
}

function badge(f: MarkerFinding): HTMLElement {
  const label = f.status === 'verified' ? 'verified' : f.status;
  const b = document.createElement('span');
  b.className = CLASS;
  b.dataset.findingId = f.id;
  b.textContent = 'RS';
  b.title = `RepoSpector (${label}): ${f.claim}`;
  b.setAttribute('role', 'img');
  b.setAttribute('aria-label', b.title);
  // Inline style: page CSS cannot be relied on, and this script adds no stylesheet.
  b.style.cssText = `display:inline-block;margin-left:4px;padding:0 4px;border-radius:4px;font:600 11px/16px system-ui,sans-serif;color:#fff;background:${f.status === 'verified' ? COLORS.verified : COLORS.other};vertical-align:middle;cursor:help`;
  return b;
}

let current: MarkerMessage | null = null;

async function apply(): Promise<{ placed: number; total: number }> {
  for (const old of document.querySelectorAll(`.${CLASS}`)) old.remove();
  if (!current) return { placed: 0, total: 0 };
  let placed = 0;
  for (const f of current.findings) {
    const cell = current.kind === 'github' ? await githubCell(f) : gitlabCell(f);
    if (!cell) continue;
    cell.append(badge(f));
    placed++;
  }
  return { placed, total: current.findings.length };
}

function start(): void {
  // Diffs render lazily as the user scrolls; re-place markers when lines appear, at most twice a second.
  let timer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver((records) => {
    if (!current || timer || records.every((r) => [...r.addedNodes].every((n) => n instanceof HTMLElement && n.classList.contains(CLASS)))) return;
    timer = setTimeout(() => {
      timer = undefined;
      void apply();
    }, 500);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return undefined;
    const m = parseMarkerMessage(message);
    if (!m) return undefined;
    current = m;
    void apply().then(reply);
    return true; // reply asynchronously
  });
}

// Injected again on each panel refresh; only the first copy listens.
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  const flag = window as unknown as { __repospectorMarkers?: boolean };
  if (!flag.__repospectorMarkers) {
    flag.__repospectorMarkers = true;
    start();
  }
}
