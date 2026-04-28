/**
 * diffOverlay — inline per-hunk overlays on GitHub PR and GitLab MR diff pages.
 *
 * Renders a small action bar above each diff hunk:
 *   🔍 Explain    💡 Suggest fix    💬 Comment
 *
 * Plus keyboard navigation:
 *   j / k       — next / previous hunk (focuses + scrolls)
 *   e           — Explain the focused hunk
 *   f           — Suggest fix for the focused hunk
 *   c           — Open inline comment composer for the focused hunk
 *
 * Architecture
 * ------------
 * - DOM-level adapter pattern. Each platform exports a hunk iterator. Adding
 *   a new platform means writing one selector function.
 * - One MutationObserver re-discovers hunks on SPA route changes (GitHub
 *   loads PRs without full reload).
 * - Action requests go via `chrome.runtime.sendMessage` to the new
 *   EXPLAIN_HUNK / SUGGEST_FIX_HUNK / POST_INLINE_COMMENT handlers. Results
 *   render inline below the hunk in a result card.
 *
 * Why not React here?
 * The content-script bundle is already 100KB; mounting a React tree per hunk
 * is overkill and risks style bleed into the host page. Plain DOM with a
 * scoped CSS class prefix (`rs-overlay-`) keeps the surface small and
 * isolated.
 */

const OVERLAY_CLASS = 'rs-overlay';
const HUNK_MARKER = 'data-rs-hunk-id';
const FOCUSED_CLASS = 'rs-overlay-focused';

// Styles inlined here so they ship in the content-script bundle (rollup does
// not pick up `.css` imports for content scripts in this project's build).
const OVERLAY_CSS = `
.rs-overlay-bar { display:flex; align-items:center; gap:8px; padding:6px 12px; margin:4px 0;
    background:linear-gradient(90deg, rgba(99,102,241,0.08), rgba(99,102,241,0.02));
    border:1px solid rgba(99,102,241,0.25); border-radius:6px;
    font:12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:#1f2937; z-index:10; }
@media (prefers-color-scheme: dark) { .rs-overlay-bar {
    background:linear-gradient(90deg, rgba(99,102,241,0.15), rgba(99,102,241,0.05));
    border-color:rgba(99,102,241,0.4); color:#e5e7eb; } }
.rs-overlay-label { font-weight:600; margin-right:4px; }
.rs-overlay-bar button { appearance:none; border:1px solid transparent; background:rgba(255,255,255,0.6);
    color:inherit; padding:3px 10px; border-radius:4px; cursor:pointer; font:inherit;
    transition:background 120ms, border-color 120ms; }
.rs-overlay-bar button:hover { background:rgba(99,102,241,0.15); border-color:rgba(99,102,241,0.5); }
.rs-overlay-bar button:active { background:rgba(99,102,241,0.25); }
@media (prefers-color-scheme: dark) { .rs-overlay-bar button { background:rgba(255,255,255,0.05); } }
.rs-overlay-result { margin:4px 0 8px; padding:10px 12px; border-left:3px solid #6366f1;
    background:#f9fafb; border-radius:0 4px 4px 0;
    font:13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    white-space:pre-wrap; color:#111827; }
@media (prefers-color-scheme: dark) { .rs-overlay-result { background:#111827; color:#e5e7eb; } }
.rs-overlay-result-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
.rs-overlay-result-close { appearance:none; border:none; background:transparent; color:inherit;
    font-size:18px; line-height:1; cursor:pointer; padding:0 6px; opacity:0.6; }
.rs-overlay-result-close:hover { opacity:1; }
.rs-overlay-result-error { border-left-color:#ef4444; }
.rs-overlay-result-warn { border-left-color:#f59e0b; }
.rs-overlay-focused { outline:2px solid rgba(99,102,241,0.5); outline-offset:2px;
    border-radius:4px; transition:outline-color 120ms; }
`;

function injectStylesOnce() {
    if (document.getElementById('rs-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'rs-overlay-styles';
    style.textContent = OVERLAY_CSS;
    document.head.appendChild(style);
}

// ─── Platform adapters ──────────────────────────────────────────────────────

/**
 * Returns an array of `{ root, file, language, getLineRange }` descriptors
 * for each diff hunk visible on the page. `root` is the DOM element above
 * which we inject the action bar; the action bar is a sibling, not a child,
 * to avoid host-page CSS interfering with hit-testing.
 */
function detectGitHubHunks() {
    const out = [];
    // Each .file container can contain multiple hunks (sections separated by
    // `tr.js-expandable-line` or `td.blob-num-expandable`). We treat each
    // file's diff-table tbody as a single hunk for v1 — finer-grained per-
    // section overlays come in v2.
    const fileBlocks = document.querySelectorAll('.file.js-file, .js-file-content .file');
    fileBlocks.forEach((file, idx) => {
        const path = file.querySelector('[data-tagsearch-path], .file-info a')
            ?.textContent?.trim() || file.querySelector('.file-info')?.textContent?.trim();
        const tbody = file.querySelector('table.diff-table tbody');
        if (!tbody) return;
        out.push({
            root: tbody,
            anchor: file.querySelector('.file-header') || file,
            file: path || `file-${idx}`,
            language: detectLanguageFromPath(path),
            platform: 'github',
            getCode: () => extractGitHubHunkCode(tbody),
            getLineRange: () => extractGitHubLineRange(tbody),
        });
    });
    return out;
}

function detectGitLabHunks() {
    const out = [];
    const fileBlocks = document.querySelectorAll('.diff-file, .file-holder');
    fileBlocks.forEach((file, idx) => {
        const path = file.querySelector('.file-title-name')?.textContent?.trim()
            || file.getAttribute('data-path');
        const content = file.querySelector('.diff-content, .diff-viewer');
        if (!content) return;
        out.push({
            root: content,
            anchor: file.querySelector('.file-title') || file,
            file: path || `file-${idx}`,
            language: detectLanguageFromPath(path),
            platform: 'gitlab',
            getCode: () => extractGitLabHunkCode(content),
            getLineRange: () => extractGitLabLineRange(content),
        });
    });
    return out;
}

function detectHunks() {
    const host = window.location.hostname;
    if (host === 'github.com') return detectGitHubHunks();
    if (host === 'gitlab.com') return detectGitLabHunks();
    return [];
}

// ─── Code extraction ────────────────────────────────────────────────────────

function extractGitHubHunkCode(tbody) {
    // GitHub diff lines: `tr` with `td.blob-code` that has classes
    // blob-code-addition / -deletion / -context. We emit unified-diff-ish
    // text so the LLM sees +/- markers.
    const rows = tbody.querySelectorAll('tr');
    const lines = [];
    rows.forEach((row) => {
        const code = row.querySelector('td.blob-code')?.textContent || '';
        if (row.querySelector('.blob-code-addition')) lines.push('+ ' + code);
        else if (row.querySelector('.blob-code-deletion')) lines.push('- ' + code);
        else if (row.querySelector('.blob-code-context')) lines.push('  ' + code);
    });
    return lines.join('\n');
}

function extractGitHubLineRange(tbody) {
    // For posting inline comments we need the right-side line number of the
    // last `+` or context line in this hunk.
    const rows = tbody.querySelectorAll('tr');
    let lastAdded = null;
    rows.forEach((row) => {
        const num = row.querySelector('td.blob-num-addition, td.blob-num-context')
            ?.getAttribute('data-line-number');
        if (num) lastAdded = parseInt(num, 10);
    });
    return { side: 'RIGHT', line: lastAdded };
}

function extractGitLabHunkCode(content) {
    const rows = content.querySelectorAll('.line_holder, tr');
    const lines = [];
    rows.forEach((row) => {
        const code = row.querySelector('.line_content, td.line_content')?.textContent || '';
        if (row.classList.contains('new') || row.classList.contains('line_holder.new')) {
            lines.push('+ ' + code);
        } else if (row.classList.contains('old') || row.classList.contains('line_holder.old')) {
            lines.push('- ' + code);
        } else if (code) {
            lines.push('  ' + code);
        }
    });
    return lines.join('\n');
}

function extractGitLabLineRange(content) {
    // GitLab line numbers live on `.diff-line-num` with `data-linenumber`
    let lastNew = null;
    content.querySelectorAll('.diff-line-num.new').forEach((cell) => {
        const n = parseInt(cell.getAttribute('data-linenumber') || cell.textContent, 10);
        if (!isNaN(n)) lastNew = n;
    });
    return { side: 'new', line: lastNew };
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

function detectLanguageFromPath(path) {
    if (!path) return 'unknown';
    const ext = path.split('.').pop().toLowerCase();
    const map = {
        js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
        py: 'python', go: 'go', rb: 'ruby', java: 'java', kt: 'kotlin',
        rs: 'rust', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
        php: 'php', swift: 'swift', sh: 'bash', yaml: 'yaml', yml: 'yaml',
    };
    return map[ext] || ext;
}

function getPRUrl() {
    return window.location.origin + window.location.pathname;
}

// ─── UI: action bar + result card ───────────────────────────────────────────

function createActionBar(hunkId) {
    const bar = document.createElement('div');
    bar.className = `${OVERLAY_CLASS}-bar`;
    bar.setAttribute(HUNK_MARKER, hunkId);
    bar.innerHTML = `
        <span class="${OVERLAY_CLASS}-label">🛡️ RepoSpector</span>
        <button data-action="explain" title="Explain (e)">🔍 Explain</button>
        <button data-action="suggest" title="Suggest fix (f)">💡 Suggest fix</button>
        <button data-action="comment" title="Comment (c)">💬 Comment</button>
    `;
    return bar;
}

function createResultCard(hunkId) {
    const card = document.createElement('div');
    card.className = `${OVERLAY_CLASS}-result`;
    card.setAttribute(HUNK_MARKER, hunkId);
    card.style.display = 'none';
    return card;
}

function renderResult(card, content, kind = 'info') {
    card.style.display = 'block';
    card.innerHTML = `
        <div class="${OVERLAY_CLASS}-result-header">
            <span class="${OVERLAY_CLASS}-result-kind ${OVERLAY_CLASS}-result-${kind}"></span>
            <button class="${OVERLAY_CLASS}-result-close" aria-label="Close">×</button>
        </div>
        <div class="${OVERLAY_CLASS}-result-body"></div>
    `;
    // textContent (not innerHTML) to neutralize any HTML the LLM emits.
    card.querySelector(`.${OVERLAY_CLASS}-result-body`).textContent = content;
    card.querySelector(`.${OVERLAY_CLASS}-result-close`).addEventListener('click', () => {
        card.style.display = 'none';
    });
}

function renderLoading(card) {
    card.style.display = 'block';
    card.textContent = '⏳ Thinking…';
}

// ─── Action handlers ────────────────────────────────────────────────────────

async function sendBackgroundMessage(type, payload) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response);
        });
    });
}

async function handleAction(action, descriptor, card) {
    renderLoading(card);
    const code = descriptor.getCode();
    if (!code || !code.trim()) {
        renderResult(card, 'No code detected in this hunk.', 'warn');
        return;
    }

    if (action === 'explain') {
        const res = await sendBackgroundMessage('EXPLAIN_HUNK', {
            code,
            language: descriptor.language,
            file: descriptor.file,
        });
        renderResult(card, res?.success ? res.text : `Error: ${res?.error || 'unknown'}`, res?.success ? 'info' : 'error');
        return;
    }
    if (action === 'suggest') {
        const res = await sendBackgroundMessage('SUGGEST_FIX_HUNK', {
            code,
            language: descriptor.language,
            file: descriptor.file,
        });
        renderResult(card, res?.success ? res.text : `Error: ${res?.error || 'unknown'}`, res?.success ? 'info' : 'error');
        return;
    }
    if (action === 'comment') {
        const body = window.prompt('Inline comment for this hunk:');
        if (!body) {
            card.style.display = 'none';
            return;
        }
        const range = descriptor.getLineRange();
        const res = await sendBackgroundMessage('POST_INLINE_COMMENT', {
            prUrl: getPRUrl(),
            path: descriptor.file,
            line: range.line,
            body,
        });
        renderResult(
            card,
            res?.success ? '✅ Posted.' : `Error: ${res?.error || 'unknown'}`,
            res?.success ? 'info' : 'error'
        );
    }
}

// ─── Injection + lifecycle ──────────────────────────────────────────────────

let descriptors = [];
let focusedIdx = 0;

function clearOverlays() {
    document.querySelectorAll(`.${OVERLAY_CLASS}-bar, .${OVERLAY_CLASS}-result`)
        .forEach((el) => el.remove());
    document.querySelectorAll(`.${FOCUSED_CLASS}`)
        .forEach((el) => el.classList.remove(FOCUSED_CLASS));
}

function injectOverlays() {
    clearOverlays();
    descriptors = detectHunks();

    descriptors.forEach((d, idx) => {
        const hunkId = `rs-hunk-${idx}`;
        d.id = hunkId;

        const bar = createActionBar(hunkId);
        const card = createResultCard(hunkId);

        bar.querySelectorAll('button[data-action]').forEach((btn) => {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                focusedIdx = idx;
                handleAction(btn.getAttribute('data-action'), d, card);
            });
        });

        // Insert after the file header so it appears just above the diff body.
        if (d.anchor && d.anchor.parentNode) {
            d.anchor.parentNode.insertBefore(bar, d.anchor.nextSibling);
            d.anchor.parentNode.insertBefore(card, bar.nextSibling);
        }
    });

    if (descriptors.length > 0) {
        focusedIdx = 0;
        focusHunk(0, false);
    }
}

function focusHunk(idx, scroll = true) {
    if (idx < 0 || idx >= descriptors.length) return;
    document.querySelectorAll(`.${FOCUSED_CLASS}`).forEach((el) => el.classList.remove(FOCUSED_CLASS));
    const d = descriptors[idx];
    if (d.anchor) {
        d.anchor.classList.add(FOCUSED_CLASS);
        if (scroll) d.anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    focusedIdx = idx;
}

function isPRPage() {
    const u = window.location.pathname;
    return /\/pull\/\d+/.test(u) || /\/-\/merge_requests\/\d+/.test(u);
}

function setupKeyboardNav() {
    document.addEventListener('keydown', (ev) => {
        // Don't intercept while typing in editable fields
        const t = ev.target;
        if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
        if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

        if (ev.key === 'j') { focusHunk(focusedIdx + 1); ev.preventDefault(); }
        else if (ev.key === 'k') { focusHunk(focusedIdx - 1); ev.preventDefault(); }
        else if (['e', 'f', 'c'].includes(ev.key)) {
            const d = descriptors[focusedIdx];
            if (!d) return;
            const card = document.querySelector(
                `.${OVERLAY_CLASS}-result[${HUNK_MARKER}="${d.id}"]`
            );
            const action = ev.key === 'e' ? 'explain' : ev.key === 'f' ? 'suggest' : 'comment';
            if (card) handleAction(action, d, card);
            ev.preventDefault();
        }
    });
}

let observer = null;
let injectScheduled = null;

function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = setTimeout(() => {
        injectScheduled = null;
        if (isPRPage()) injectOverlays();
    }, 500);
}

export function initDiffOverlay() {
    if (!isPRPage()) return;
    injectStylesOnce();
    injectOverlays();
    setupKeyboardNav();

    // GitHub & GitLab are SPAs: re-inject when the PR view re-renders.
    observer = new MutationObserver(() => scheduleInject());
    observer.observe(document.body, { childList: true, subtree: true });

    // Also re-inject on history navigation.
    window.addEventListener('popstate', scheduleInject);
}

// Test-only export
export const __test = { detectHunks, detectLanguageFromPath };
