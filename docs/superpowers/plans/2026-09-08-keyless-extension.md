# Keyless Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make RepoSpector usable with no API key — via Chrome's on-device model or a correctly-configured Ollama — and make the first screen say so.

**Architecture:** Three pure utility modules carry all the decision logic (provider capabilities, Ollama probe classification, keyless-route ranking) so it is unit-testable without React or Chrome. `LLMService` gains one provider method that mirrors `callOllama`. `Settings.jsx` is split into per-provider panels because two of the four new panels land inside it.

**Tech Stack:** Chrome MV3, React 18 (popup), Jest 29 + jsdom, Babel (`.babelrc`, root package only), Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-08-keyless-extension-design.md`

## Global Constraints

- **Test files are CommonJS.** `test/package.json` creates a Babel package boundary, so the root `.babelrc` does **not** apply to `test/`. Files under `test/` get no preset and must use `require()`, never `import`. Files under `src/` are transformed and use ESM `export`. This is why every existing test reads `const { x } = require('../../src/...')`.
- **Run a single test with:** `npx jest test/unit/<Name>.test.js` from the repo root. This works today (verified).
- **Tests cannot load `.jsx` files.** Verified empirically: `require()`ing a `.jsx` module from a test fails with `SyntaxError: Cannot use import statement outside a module` — the file arrives untransformed, and `@babel/preset-react` is not installed (only `preset-env` and `preset-modules`). **Consequence:** any UI logic that needs a test must live in a plain `.js` module that the `.jsx` component imports. Never write a test that requires a `.jsx` file, and do not add `preset-react` to make one work — that changes the build for the whole repo.
- **File size ceilings (CLAUDE.md):** no file > 300 lines, no function > 50 lines, one export per file for services.
- **No `any`; validate external input.** The Chrome AI globals are external input — probe them, never assume shape.
- **Commits require explicit user approval.** The user's standing instruction is that no `git commit` / `git push` runs autonomously. Each task's commit step is written out, but **ask before running it**.
- **Provider id is exactly `chrome-ai`.** Used as a storage value; it must not change after release.
- **Ollama origin value is exactly `chrome-extension://*`** in user-facing copy.
- **Do not change behaviour for the eleven existing providers.** Every task below is additive to them.

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `src/utils/providerCapabilities.js` | Per-provider limits + `providerNeedsKey`. Pure. |
| `src/utils/taskCapabilities.js` | Task context requirements + gate reasons. Pure. |
| `src/utils/chromeAI.js` | Availability probe, prompt shaping, token estimate, quota error. Pure except the probe. |
| `src/utils/ollamaProbe.js` | Four-verdict classifier + fix copy. Pure. |
| `src/popup/utils/keylessRoutes.js` | Ranks the keyless routes for onboarding. Pure. |
| `src/popup/components/settings/ApiKeyProviderPanel.jsx` | The nine key-based providers. |
| `src/popup/components/settings/BedrockPanel.jsx` | AWS credential fields. |
| `src/popup/components/settings/OllamaPanel.jsx` | Corrected Ollama setup. |
| `src/popup/components/settings/ChromeAIPanel.jsx` | Chrome AI status + download. |
| `src/popup/components/settings/providerPanelRegistry.js` | provider → panel. |

**Modify:**

| File | Change |
| --- | --- |
| `src/utils/constants.js:3-20` | add `CHROME_AI`; no `API_ENDPOINTS` entry |
| `src/services/LLMService.js:336` | one `case` in `_dispatchToProvider` |
| `src/services/LLMService.js:951` | add `callChromeAI` after `callOllama` |
| `src/services/LLMService.js:1228` | `checkOllamaStatus` returns a verdict |
| `src/popup/components/Settings.jsx` | use `providerNeedsKey`; delegate panels |
| `src/popup/App.jsx:406-440` | welcome panel rewrite |

**Dependency order:** Tasks 1-4 (pure modules + LLMService) have no UI dependency. Task 5 (split) must land before Tasks 6-7 touch panels. Task 8 is last.

---

### Task 1: Provider capabilities and the `providerNeedsKey` predicate

**Files:**
- Create: `src/utils/providerCapabilities.js`
- Test: `test/unit/providerCapabilities.test.js`

**Interfaces:**
- Consumes: `LLM_PROVIDERS` from `src/utils/constants.js`
- Produces: `getCapabilities(provider) → {maxContextTokens, supportsTools, supportsStreaming, needsKey}`, `providerNeedsKey(provider) → boolean`, `effectiveContextTokens(provider, liveQuota) → number|null`, `CHROME_AI_FALLBACK_CONTEXT_TOKENS`

**Behaviour note — preserve today's Bedrock handling.** `Settings.jsx:509-511` requires a non-empty `apiKey` for every provider except `LOCAL`, and that includes Bedrock. `providerNeedsKey` must therefore return `true` for Bedrock so this task changes nothing. Bedrock's separate credential block is selected by the existing `isBedrock` flag and stays. (Whether Bedrock *should* demand an `apiKey` looks like a pre-existing bug; it is out of scope here — do not fix it in this task.)

- [ ] **Step 1: Add the `CHROME_AI` provider id**

In `src/utils/constants.js`, inside `LLM_PROVIDERS` (line 3-20), after `LOCAL: 'local'`:

```js
    LOCAL: 'local',
    // Chrome's built-in on-device model (Gemini Nano), reached through the
    // `LanguageModel` global. Deliberately absent from API_ENDPOINTS: it is an
    // in-process browser API, not an HTTP endpoint, so it has no URL, needs no
    // host_permissions entry and no CSP change. Do not "fix" the omission.
    CHROME_AI: 'chrome-ai'
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/providerCapabilities.test.js`:

```js
/**
 * Nano is the only provider with a real context ceiling, and the ceiling is
 * read from a live session rather than hardcoded — Chrome can change it. These
 * tests pin that the declared number is only ever a pre-session fallback, and
 * that adding the provider changed nothing for the other eleven.
 */
const { LLM_PROVIDERS } = require('../../src/utils/constants.js');
const {
    getCapabilities,
    providerNeedsKey,
    effectiveContextTokens,
    CHROME_AI_FALLBACK_CONTEXT_TOKENS,
} = require('../../src/utils/providerCapabilities.js');

describe('providerCapabilities', () => {
    test('declares an entry for every provider', () => {
        for (const id of Object.values(LLM_PROVIDERS)) {
            expect(getCapabilities(id)).toBeTruthy();
        }
    });

    test('an unknown provider is unconstrained and key-requiring', () => {
        const caps = getCapabilities('not-a-provider');
        expect(caps.maxContextTokens).toBeNull();
        expect(caps.needsKey).toBe(true);
    });

    test('only chrome-ai declares a context ceiling', () => {
        for (const id of Object.values(LLM_PROVIDERS)) {
            const expected = id === LLM_PROVIDERS.CHROME_AI
                ? CHROME_AI_FALLBACK_CONTEXT_TOKENS
                : null;
            expect(getCapabilities(id).maxContextTokens).toBe(expected);
        }
    });

    test('ollama and chrome-ai need no key; the rest do', () => {
        expect(providerNeedsKey(LLM_PROVIDERS.LOCAL)).toBe(false);
        expect(providerNeedsKey(LLM_PROVIDERS.CHROME_AI)).toBe(false);
        for (const id of [
            LLM_PROVIDERS.OPENAI, LLM_PROVIDERS.ANTHROPIC, LLM_PROVIDERS.GOOGLE,
            LLM_PROVIDERS.GROQ, LLM_PROVIDERS.MISTRAL, LLM_PROVIDERS.OPENROUTER,
            LLM_PROVIDERS.NVIDIA, LLM_PROVIDERS.COHERE, LLM_PROVIDERS.PERPLEXITY,
            LLM_PROVIDERS.HUGGINGFACE,
        ]) {
            expect(providerNeedsKey(id)).toBe(true);
        }
    });

    test('bedrock still needs a key, preserving Settings.jsx:509 behaviour', () => {
        expect(providerNeedsKey(LLM_PROVIDERS.BEDROCK)).toBe(true);
    });

    test('a live quota overrides the declared fallback', () => {
        expect(effectiveContextTokens(LLM_PROVIDERS.CHROME_AI, 4096)).toBe(4096);
        expect(effectiveContextTokens(LLM_PROVIDERS.CHROME_AI, null))
            .toBe(CHROME_AI_FALLBACK_CONTEXT_TOKENS);
    });

    test('a live quota is ignored for unconstrained providers', () => {
        expect(effectiveContextTokens(LLM_PROVIDERS.OPENAI, 4096)).toBeNull();
    });

    test('a nonsense live quota falls back rather than trusting it', () => {
        for (const bad of [0, -1, NaN, '8000', undefined]) {
            expect(effectiveContextTokens(LLM_PROVIDERS.CHROME_AI, bad))
                .toBe(CHROME_AI_FALLBACK_CONTEXT_TOKENS);
        }
    });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx jest test/unit/providerCapabilities.test.js`
Expected: FAIL — `Cannot find module '../../src/utils/providerCapabilities.js'`

- [ ] **Step 4: Implement the module**

Create `src/utils/providerCapabilities.js`:

```js
/**
 * Per-provider capability declarations.
 *
 * This module exists for one provider. Chrome's built-in model has an input
 * quota roughly an order of magnitude smaller than any API model's, and offered
 * as a peer it would be picked for a 40-file review, chunked into fragments,
 * and would answer from a truncated prompt without saying so. Declaring the
 * limit is what lets the UI disable a task with a reason instead of failing
 * quietly.
 *
 * Every other provider is `maxContextTokens: null` — unconstrained, exactly as
 * before. This is not a budget system and should not grow into one.
 */

import { LLM_PROVIDERS } from './constants.js';

/**
 * Pre-session fallback for Chrome's built-in model.
 *
 * Only used before a live session exists. A real session reports `inputQuota`,
 * and that always wins — see `effectiveContextTokens`. Hardcoding this as the
 * truth would go silently wrong the first time Chrome changed it.
 */
export const CHROME_AI_FALLBACK_CONTEXT_TOKENS = 6144;

const UNCONSTRAINED = null;

const KEYLESS = { maxContextTokens: UNCONSTRAINED, supportsTools: true, supportsStreaming: true, needsKey: false };
const KEYED = { maxContextTokens: UNCONSTRAINED, supportsTools: true, supportsStreaming: true, needsKey: true };

const CAPABILITIES = Object.freeze({
    [LLM_PROVIDERS.OPENAI]: KEYED,
    [LLM_PROVIDERS.ANTHROPIC]: KEYED,
    [LLM_PROVIDERS.GOOGLE]: KEYED,
    [LLM_PROVIDERS.COHERE]: KEYED,
    [LLM_PROVIDERS.MISTRAL]: KEYED,
    [LLM_PROVIDERS.PERPLEXITY]: KEYED,
    [LLM_PROVIDERS.GROQ]: KEYED,
    [LLM_PROVIDERS.HUGGINGFACE]: KEYED,
    [LLM_PROVIDERS.OPENROUTER]: KEYED,
    [LLM_PROVIDERS.NVIDIA]: KEYED,
    // Bedrock signs with IAM credentials and shows its own credential block,
    // but Settings.jsx:509 requires a non-empty apiKey for everything except
    // Ollama. Keeping `needsKey: true` preserves that exactly.
    [LLM_PROVIDERS.BEDROCK]: KEYED,
    [LLM_PROVIDERS.LOCAL]: KEYLESS,
    [LLM_PROVIDERS.CHROME_AI]: {
        maxContextTokens: CHROME_AI_FALLBACK_CONTEXT_TOKENS,
        // Nano exposes no tool-calling and no structured tool protocol.
        supportsTools: false,
        supportsStreaming: true,
        needsKey: false,
    },
});

/** Unknown providers are treated as unconstrained and key-requiring — the safe pair. */
const DEFAULT_CAPABILITIES = KEYED;

export function getCapabilities(provider) {
    return CAPABILITIES[provider] || DEFAULT_CAPABILITIES;
}

export function providerNeedsKey(provider) {
    return getCapabilities(provider).needsKey;
}

/**
 * The context ceiling to plan against.
 *
 * @param {string} provider
 * @param {number|null} liveQuota - `session.inputQuota` when a session exists.
 * @returns {number|null} null means unconstrained.
 */
export function effectiveContextTokens(provider, liveQuota) {
    const declared = getCapabilities(provider).maxContextTokens;
    if (declared === UNCONSTRAINED) return UNCONSTRAINED;
    const usable = Number.isInteger(liveQuota) && liveQuota > 0;
    return usable ? liveQuota : declared;
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx jest test/unit/providerCapabilities.test.js`
Expected: PASS, 8 tests

- [ ] **Step 6: Replace the three ad-hoc key checks in Settings.jsx**

`Settings.jsx` decides "does this provider need a key" in three places with two
different spellings. Route all three through the predicate so a fourth keyless
provider cannot desynchronise them.

Add the import at the top of `src/popup/components/Settings.jsx`:

```js
import { providerNeedsKey } from '../../utils/providerCapabilities.js';
```

At line ~439, change:

```js
        } else if (provider === LLM_PROVIDERS.LOCAL || apiKey || hasExistingKey) {
```

to:

```js
        } else if (!providerNeedsKey(provider) || apiKey || hasExistingKey) {
```

At line ~509, change:

```js
            const isLocal = provider === LLM_PROVIDERS.LOCAL;
            if (!isLocal && (!apiKey || apiKey.trim() === '')) {
```

to:

```js
            if (providerNeedsKey(provider) && (!apiKey || apiKey.trim() === '')) {
```

At line ~607, change:

```js
    const isLocalProvider = provider === LLM_PROVIDERS.LOCAL;
```

to:

```js
    // Keyless providers (Ollama, Chrome built-in AI) hide the API-key field.
    const isKeylessProvider = !providerNeedsKey(provider);
```

Then replace the two `isLocalProvider` reads (the `!isLocalProvider && !isBedrock` test at line ~888, and any other occurrence) with `isKeylessProvider`. Find them all first:

Run: `grep -n "isLocalProvider" src/popup/components/Settings.jsx`

- [ ] **Step 7: Confirm the whole suite still passes**

Run: `npx jest`
Expected: PASS. This step is the regression gate for Step 6 — it edits a
shipping file, so no new failures are acceptable.

- [ ] **Step 8: Commit** — ask the user first

```bash
git add src/utils/constants.js src/utils/providerCapabilities.js \
        test/unit/providerCapabilities.test.js src/popup/components/Settings.jsx
git commit -m "feat(providers): declare provider capabilities and centralise the needs-key test"
```

---

### Task 2: Task gating

**Files:**
- Create: `src/utils/taskCapabilities.js`
- Test: `test/unit/taskCapabilities.test.js`

**Interfaces:**
- Consumes: `effectiveContextTokens` from Task 1
- Produces: `TASKS`, `TASK_MIN_CONTEXT_TOKENS`, `isTaskSupported(provider, task, liveQuota) → boolean`, `taskGateReason(provider, task, liveQuota) → string|null`

- [ ] **Step 1: Write the failing test**

Create `test/unit/taskCapabilities.test.js`:

```js
/**
 * The gate's job is to stop Nano being handed a 40-file review and answering
 * from a truncated prompt. The reason string is part of the contract: it quotes
 * the live quota, so it stays true when Chrome changes the number.
 */
const { LLM_PROVIDERS } = require('../../src/utils/constants.js');
const {
    TASKS,
    TASK_MIN_CONTEXT_TOKENS,
    isTaskSupported,
    taskGateReason,
} = require('../../src/utils/taskCapabilities.js');

const CHROME = LLM_PROVIDERS.CHROME_AI;

describe('taskCapabilities', () => {
    test('every task declares a minimum context', () => {
        for (const task of Object.values(TASKS)) {
            expect(typeof TASK_MIN_CONTEXT_TOKENS[task]).toBe('number');
        }
    });

    test('unconstrained providers support every task', () => {
        for (const task of Object.values(TASKS)) {
            expect(isTaskSupported(LLM_PROVIDERS.OPENAI, task, null)).toBe(true);
            expect(taskGateReason(LLM_PROVIDERS.OPENAI, task, null)).toBeNull();
        }
    });

    test('chrome-ai supports the cheap tasks', () => {
        for (const task of [
            TASKS.FILE_SUMMARY, TASKS.COMMIT_MESSAGE,
            TASKS.LABEL_GENERATION, TASKS.DOCSTRING, TASKS.SINGLE_FILE_CHAT,
        ]) {
            expect(isTaskSupported(CHROME, task, null)).toBe(true);
        }
    });

    test('chrome-ai is gated out of the expensive tasks', () => {
        for (const task of [TASKS.PR_REVIEW, TASKS.MULTI_PASS_AUDIT, TASKS.REPO_CHAT]) {
            expect(isTaskSupported(CHROME, task, null)).toBe(false);
        }
    });

    test('the reason quotes the live quota, not a hardcoded number', () => {
        const reason = taskGateReason(CHROME, TASKS.PR_REVIEW, 4096);
        expect(reason).toContain('4k');
        expect(reason).not.toContain('6k');
    });

    test('the reason names the requirement as well as the shortfall', () => {
        const reason = taskGateReason(CHROME, TASKS.PR_REVIEW, null);
        const needK = Math.round(TASK_MIN_CONTEXT_TOKENS[TASKS.PR_REVIEW] / 1024);
        expect(reason).toContain(`${needK}k`);
        expect(reason).toContain('6k');
    });

    test('a larger live quota can un-gate a task', () => {
        const need = TASK_MIN_CONTEXT_TOKENS[TASKS.PR_REVIEW];
        expect(isTaskSupported(CHROME, TASKS.PR_REVIEW, need + 1024)).toBe(true);
        expect(taskGateReason(CHROME, TASKS.PR_REVIEW, need + 1024)).toBeNull();
    });

    test('an unknown task is permitted rather than silently blocked', () => {
        expect(isTaskSupported(CHROME, 'brand_new_task', null)).toBe(true);
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest test/unit/taskCapabilities.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the module**

Create `src/utils/taskCapabilities.js`:

```js
/**
 * What each task needs from a model, and why a provider cannot do it.
 *
 * The numbers are context requirements, not quality judgements. A provider
 * fails a task here only because the prompt would not fit — which is the one
 * failure mode that is invisible at the call site, because the API truncates
 * and answers anyway.
 */

import { effectiveContextTokens } from './providerCapabilities.js';

export const TASKS = Object.freeze({
    FILE_SUMMARY: 'file_summary',
    COMMIT_MESSAGE: 'commit_message',
    LABEL_GENERATION: 'label_generation',
    DOCSTRING: 'docstring',
    SINGLE_FILE_CHAT: 'single_file_chat',
    PR_REVIEW: 'pr_review',
    MULTI_PASS_AUDIT: 'multi_pass_audit',
    REPO_CHAT: 'repo_chat',
});

/**
 * Minimum usable input context per task, in tokens.
 *
 * Cheap tasks see one file or one hunk. The expensive three see a diff plus
 * retrieved context plus graph neighbours, which is why they sit an order of
 * magnitude higher.
 */
export const TASK_MIN_CONTEXT_TOKENS = Object.freeze({
    [TASKS.FILE_SUMMARY]: 4096,
    [TASKS.COMMIT_MESSAGE]: 2048,
    [TASKS.LABEL_GENERATION]: 2048,
    [TASKS.DOCSTRING]: 2048,
    [TASKS.SINGLE_FILE_CHAT]: 4096,
    [TASKS.PR_REVIEW]: 40960,
    [TASKS.MULTI_PASS_AUDIT]: 40960,
    [TASKS.REPO_CHAT]: 32768,
});

/** Tokens → "6k", for copy. */
function toK(tokens) {
    return `${Math.round(tokens / 1024)}k`;
}

export function isTaskSupported(provider, task, liveQuota = null) {
    const ceiling = effectiveContextTokens(provider, liveQuota);
    if (ceiling === null) return true;              // unconstrained provider
    const need = TASK_MIN_CONTEXT_TOKENS[task];
    // An unknown task has no declared requirement. Permit it: a new task that
    // silently stops working is worse than one that is merely unmeasured.
    if (typeof need !== 'number') return true;
    return ceiling >= need;
}

/**
 * Why the task is disabled, phrased for a tooltip. Null when it is not.
 *
 * Quotes the live ceiling rather than a literal so the sentence stays true if
 * Chrome changes the quota.
 */
export function taskGateReason(provider, task, liveQuota = null) {
    if (isTaskSupported(provider, task, liveQuota)) return null;
    const ceiling = effectiveContextTokens(provider, liveQuota);
    const need = TASK_MIN_CONTEXT_TOKENS[task];
    return `needs ~${toK(need)} context, this model has ${toK(ceiling)}`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest test/unit/taskCapabilities.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit** — ask the user first

```bash
git add src/utils/taskCapabilities.js test/unit/taskCapabilities.test.js
git commit -m "feat(providers): gate tasks by provider context ceiling with a live-quota reason"
```

---

### Task 3: Chrome AI probe, prompt shaping, quota error

**Files:**
- Create: `src/utils/chromeAI.js`
- Test: `test/unit/chromeAI.test.js`

**Interfaces:**
- Consumes: `effectiveContextTokens` from Task 1
- Produces: `CHROME_AI_AVAILABILITY` (the four states), `probeChromeAI() → {state, reason}`, `shapeChromeAIPrompt(messages) → {system, prompt}`, `estimateTokens(text) → number`, `ChromeAIQuotaError` (class, `.name === 'ChromeAIQuotaError'`), `assertFitsQuota({promptTokens, quota, task})`

**Why this is a separate module from `LLMService`:** all of it is pure or a
single global read, and `LLMService` is already 1270 lines. Keeping the logic
here means it is testable by faking one global instead of constructing the
service.

- [ ] **Step 1: Write the failing test**

Create `test/unit/chromeAI.test.js`:

```js
/**
 * Nano's four availability states matter because two of them are transitional:
 * first use triggers a multi-gigabyte download, and a provider that renders
 * "downloading" as an endless spinner is worse than one that is honestly
 * absent. The quota assertion exists so an over-budget prompt is refused with a
 * typed error rather than silently truncated by the API.
 */
const {
    CHROME_AI_AVAILABILITY,
    probeChromeAI,
    shapeChromeAIPrompt,
    estimateTokens,
    ChromeAIQuotaError,
    assertFitsQuota,
} = require('../../src/utils/chromeAI.js');

describe('probeChromeAI', () => {
    afterEach(() => { delete globalThis.LanguageModel; });

    test('reports unavailable when the global is absent', async () => {
        const { state, reason } = await probeChromeAI();
        expect(state).toBe(CHROME_AI_AVAILABILITY.UNAVAILABLE);
        expect(reason).toMatch(/Chrome 138/);
    });

    test('passes through each state the API reports', async () => {
        for (const state of ['available', 'downloadable', 'downloading', 'unavailable']) {
            globalThis.LanguageModel = { availability: async () => state };
            expect((await probeChromeAI()).state).toBe(state);
        }
    });

    test('a throwing availability() is unavailable, not a crash', async () => {
        globalThis.LanguageModel = { availability: async () => { throw new Error('boom'); } };
        const { state, reason } = await probeChromeAI();
        expect(state).toBe(CHROME_AI_AVAILABILITY.UNAVAILABLE);
        expect(reason).toMatch(/boom/);
    });

    test('an unrecognised state string is treated as unavailable', async () => {
        globalThis.LanguageModel = { availability: async () => 'something-new' };
        expect((await probeChromeAI()).state).toBe(CHROME_AI_AVAILABILITY.UNAVAILABLE);
    });
});

describe('shapeChromeAIPrompt', () => {
    test('system messages become the system prompt', () => {
        const { system, prompt } = shapeChromeAIPrompt([
            { role: 'system', content: 'You review code.' },
            { role: 'user', content: 'Summarise this.' },
        ]);
        expect(system).toBe('You review code.');
        expect(prompt).toContain('Summarise this.');
        expect(prompt).not.toContain('You review code.');
    });

    test('multiple system messages are joined, matching Anthropic handling', () => {
        const { system } = shapeChromeAIPrompt([
            { role: 'system', content: 'A' },
            { role: 'system', content: 'B' },
            { role: 'user', content: 'go' },
        ]);
        expect(system).toBe('A\n\nB');
    });

    test('prior turns are labelled so the model can follow the exchange', () => {
        const { prompt } = shapeChromeAIPrompt([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'second' },
        ]);
        expect(prompt.indexOf('first')).toBeLessThan(prompt.indexOf('reply'));
        expect(prompt.indexOf('reply')).toBeLessThan(prompt.indexOf('second'));
    });

    test('no system message yields an empty system string, never undefined', () => {
        expect(shapeChromeAIPrompt([{ role: 'user', content: 'x' }]).system).toBe('');
    });

    test('an empty message list does not throw', () => {
        expect(shapeChromeAIPrompt([])).toEqual({ system: '', prompt: '' });
    });
});

describe('estimateTokens', () => {
    test('scales with length and never returns zero for real text', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('abcd')).toBeGreaterThan(0);
        expect(estimateTokens('a'.repeat(4000)))
            .toBeGreaterThan(estimateTokens('a'.repeat(400)));
    });
});

describe('assertFitsQuota', () => {
    test('is silent when the prompt fits', () => {
        expect(() => assertFitsQuota({ promptTokens: 100, quota: 6144, task: 'file_summary' }))
            .not.toThrow();
    });

    test('throws a typed error naming the task and the overage', () => {
        let caught;
        try {
            assertFitsQuota({ promptTokens: 9000, quota: 6144, task: 'pr_review' });
        } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(ChromeAIQuotaError);
        expect(caught.name).toBe('ChromeAIQuotaError');
        expect(caught.task).toBe('pr_review');
        expect(caught.promptTokens).toBe(9000);
        expect(caught.quota).toBe(6144);
        expect(caught.message).toMatch(/pr_review/);
    });

    test('an unknown quota does not block the call', () => {
        expect(() => assertFitsQuota({ promptTokens: 9e9, quota: null, task: 't' }))
            .not.toThrow();
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest test/unit/chromeAI.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the module**

Create `src/utils/chromeAI.js`:

```js
/**
 * Chrome built-in AI (Gemini Nano) support logic.
 *
 * Everything here is pure or reads one global, so the provider's decisions are
 * testable by faking `globalThis.LanguageModel` rather than constructing
 * LLMService. The actual call lives in LLMService.callChromeAI.
 */

/** Minimum Chrome version exposing the `LanguageModel` global to extensions. */
export const CHROME_AI_MIN_VERSION = 138;

/**
 * The four states `LanguageModel.availability()` reports. The middle two are
 * the interesting ones: first use pulls a multi-gigabyte model, so a UI that
 * renders them as "loading" hangs forever from the user's point of view.
 */
export const CHROME_AI_AVAILABILITY = Object.freeze({
    AVAILABLE: 'available',
    DOWNLOADABLE: 'downloadable',
    DOWNLOADING: 'downloading',
    UNAVAILABLE: 'unavailable',
});

const KNOWN_STATES = new Set(Object.values(CHROME_AI_AVAILABILITY));

/**
 * @returns {Promise<{state: string, reason: string}>} `reason` is empty unless
 *   the state is UNAVAILABLE, in which case it is displayable copy.
 */
export async function probeChromeAI() {
    const api = globalThis.LanguageModel;
    if (!api || typeof api.availability !== 'function') {
        return {
            state: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            reason: `Chrome built-in AI needs Chrome ${CHROME_AI_MIN_VERSION} or newer on supported hardware.`,
        };
    }
    try {
        const state = await api.availability();
        if (!KNOWN_STATES.has(state)) {
            // Forward-compatibility: an unrecognised state is not assumed usable.
            return {
                state: CHROME_AI_AVAILABILITY.UNAVAILABLE,
                reason: `Chrome reported an unrecognised availability state ("${state}").`,
            };
        }
        return { state, reason: '' };
    } catch (error) {
        return {
            state: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            reason: `Chrome built-in AI could not be probed: ${error.message}`,
        };
    }
}

/**
 * Split an OpenAI-style message array into Nano's two inputs.
 *
 * Nano takes a system prompt via `initialPrompts` and a single prompt string.
 * Multiple system messages are joined, matching how buildAnthropicSystem
 * already treats them, so provider swaps do not change the system text.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{system: string, prompt: string}}
 */
export function shapeChromeAIPrompt(messages = []) {
    const list = Array.isArray(messages) ? messages : [];
    const system = list
        .filter((m) => m && m.role === 'system')
        .map((m) => m.content || '')
        .join('\n\n');

    const turns = list.filter((m) => m && m.role !== 'system');
    // Turns are labelled because Nano gets one flat string, and an unlabelled
    // concatenation of a multi-turn exchange reads as one confused message.
    const prompt = turns
        .map((m) => (turns.length > 1 ? `${m.role}: ${m.content || ''}` : (m.content || '')))
        .join('\n\n');

    return { system, prompt };
}

/**
 * Rough token count for quota checks.
 *
 * Four characters per token is the standard approximation. Only used when the
 * session cannot measure input itself; `measureInputUsage` is preferred and
 * exact where available.
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
}

/** Thrown instead of letting the API truncate a prompt and answer anyway. */
export class ChromeAIQuotaError extends Error {
    constructor({ promptTokens, quota, task }) {
        super(
            `Prompt is too large for Chrome built-in AI: ~${promptTokens} tokens `
            + `against a ${quota}-token quota (task: ${task || 'unknown'}). `
            + `Pick Ollama or an API provider for this task.`
        );
        this.name = 'ChromeAIQuotaError';
        this.promptTokens = promptTokens;
        this.quota = quota;
        this.task = task || null;
    }
}

/**
 * Refuse an over-quota prompt.
 *
 * Silent truncation is the specific failure the capability system exists to
 * prevent, so it must not be reachable by a caller that bypassed the UI gate.
 * An unknown quota is not treated as zero — we let the call proceed and let the
 * API speak for itself.
 */
export function assertFitsQuota({ promptTokens, quota, task }) {
    if (!Number.isInteger(quota) || quota <= 0) return;
    if (promptTokens <= quota) return;
    throw new ChromeAIQuotaError({ promptTokens, quota, task });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest test/unit/chromeAI.test.js`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit** — ask the user first

```bash
git add src/utils/chromeAI.js test/unit/chromeAI.test.js
git commit -m "feat(chrome-ai): add availability probe, prompt shaping and quota guard"
```

---

### Task 4: `callChromeAI` in LLMService

**Files:**
- Modify: `src/services/LLMService.js` (add method after `callOllama`, which ends at line 1015; add one `case` at line ~362)
- Test: `test/unit/callChromeAI.test.js`

**Interfaces:**
- Consumes: everything Task 3 produces; `this.sendChunk(tabId, chunk, fullContent, requestId, isLastChunk, isFromPopup)` (`LLMService.js:1189`)
- Produces: `LLMService.prototype.callChromeAI(requestData, options) → Promise<string>`

**Two constraints that shape the implementation:**

1. **`handleStreamingResponse` cannot be reused.** It reads `response.body` and
   parses SSE framing (`LLMService.js:1021`). `promptStreaming()` returns a
   `ReadableStream` of plain text chunks — no `Response`, no SSE. So this method
   needs its own reader loop, emitting through `sendChunk`, which is the actual
   contract the popup consumes.
2. **Sessions must be per-call.** A `LanguageModel` session accumulates
   conversation state and has a hard input quota, but every RepoSpector caller
   passes a full `messages` array and expects statelessness. Reusing a session
   would leak context between unrelated reviews and exhaust the quota. Create,
   prompt, `destroy()` in a `finally`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/callChromeAI.test.js`:

```js
/**
 * The session lifecycle is the load-bearing part: sessions carry conversation
 * state and a hard quota, while every caller here passes a full message array
 * and expects statelessness. A leaked session would bleed one review into the
 * next. destroy() is therefore asserted on the success path AND on the throw
 * path, because the throw path is the one that gets forgotten.
 */
const { LLMService } = require('../../src/services/LLMService.js');
const { LLM_PROVIDERS } = require('../../src/utils/constants.js');

/** A fake `LanguageModel` global. `captured` records what the session saw. */
function installFakeLanguageModel({ availability = 'available', reply = 'ok', chunks = null, throwOn = null } = {}) {
    const captured = { created: null, prompts: [], destroyed: 0 };
    globalThis.LanguageModel = {
        availability: async () => availability,
        params: async () => ({ defaultTemperature: 1, maxTemperature: 2, defaultTopK: 3, maxTopK: 8 }),
        create: async (opts) => {
            captured.created = opts;
            return {
                inputQuota: 6144,
                measureInputUsage: async (text) => Math.ceil(text.length / 4),
                prompt: async (text) => {
                    captured.prompts.push(text);
                    if (throwOn === 'prompt') throw new Error('prompt exploded');
                    return reply;
                },
                promptStreaming: (text) => {
                    captured.prompts.push(text);
                    const parts = chunks || [reply];
                    let i = 0;
                    return {
                        getReader: () => ({
                            read: async () => (i < parts.length
                                ? { done: false, value: parts[i++] }
                                : { done: true, value: undefined }),
                        }),
                    };
                },
                destroy: () => { captured.destroyed += 1; },
            };
        },
    };
    return captured;
}

describe('LLMService.callChromeAI', () => {
    let svc;
    beforeEach(() => { svc = new LLMService(); });
    afterEach(() => { delete globalThis.LanguageModel; });

    const req = { model: 'chrome-ai:nano', messages: [{ role: 'user', content: 'hi' }] };

    test('returns the model reply', async () => {
        installFakeLanguageModel({ reply: 'a summary' });
        await expect(svc.callChromeAI(req)).resolves.toBe('a summary');
    });

    test('passes the system message as initialPrompts, not in the prompt', async () => {
        const captured = installFakeLanguageModel();
        await svc.callChromeAI({
            model: 'chrome-ai:nano',
            messages: [
                { role: 'system', content: 'You review code.' },
                { role: 'user', content: 'check this' },
            ],
        });
        expect(JSON.stringify(captured.created.initialPrompts)).toContain('You review code.');
        expect(captured.prompts[0]).not.toContain('You review code.');
        expect(captured.prompts[0]).toContain('check this');
    });

    test('destroys the session on success', async () => {
        const captured = installFakeLanguageModel();
        await svc.callChromeAI(req);
        expect(captured.destroyed).toBe(1);
    });

    test('destroys the session when the prompt throws', async () => {
        const captured = installFakeLanguageModel({ throwOn: 'prompt' });
        await expect(svc.callChromeAI(req)).rejects.toThrow('prompt exploded');
        expect(captured.destroyed).toBe(1);
    });

    test('refuses an over-quota prompt with ChromeAIQuotaError', async () => {
        installFakeLanguageModel();
        const huge = { model: 'chrome-ai:nano', messages: [{ role: 'user', content: 'x'.repeat(200000) }], };
        await expect(svc.callChromeAI(huge, { task: 'pr_review' }))
            .rejects.toMatchObject({ name: 'ChromeAIQuotaError', task: 'pr_review' });
    });

    test('fails clearly when the global is absent', async () => {
        await expect(svc.callChromeAI(req)).rejects.toThrow(/Chrome 138|not available/i);
    });

    test('fails clearly when the model still needs downloading', async () => {
        installFakeLanguageModel({ availability: 'downloadable' });
        await expect(svc.callChromeAI(req)).rejects.toThrow(/download/i);
    });

    test('streams every chunk through sendChunk and ends with the last-chunk flag', async () => {
        installFakeLanguageModel({ chunks: ['Hel', 'lo', '!'] });
        const seen = [];
        svc.sendChunk = (tabId, chunk, full, requestId, isLast) => seen.push({ chunk, full, isLast });

        const result = await svc.callChromeAI(req, { streaming: true, tabId: 7, requestId: 'r1' });

        expect(result).toBe('Hello!');
        expect(seen.map((s) => s.chunk)).toEqual(['Hel', 'lo', '!', '']);
        expect(seen.at(-1).isLast).toBe(true);
        expect(seen.at(-1).full).toBe('Hello!');
        expect(seen.slice(0, -1).every((s) => s.isLast === false)).toBe(true);
    });
});

describe('LLMService._dispatchToProvider', () => {
    test('routes chrome-ai to callChromeAI without an apiKey argument', () => {
        const svc = new LLMService();
        const calls = [];
        svc.callChromeAI = (...args) => { calls.push(args); return Promise.resolve('x'); };
        svc._dispatchToProvider(LLM_PROVIDERS.CHROME_AI, { model: 'm' }, 'A-KEY', { task: 't' });
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toEqual({ model: 'm' });
        expect(calls[0][1]).toEqual({ task: 't' });
        expect(calls[0]).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest test/unit/callChromeAI.test.js`
Expected: FAIL — `svc.callChromeAI is not a function`

- [ ] **Step 3: Add the imports**

At the top of `src/services/LLMService.js`, alongside the existing util imports:

```js
import {
    CHROME_AI_AVAILABILITY,
    probeChromeAI,
    shapeChromeAIPrompt,
    estimateTokens,
    assertFitsQuota,
} from '../utils/chromeAI.js';
```

- [ ] **Step 4: Add the dispatch case**

In `_dispatchToProvider` (line ~362), immediately after the `LOCAL` case and
before `default`:

```js
            case LLM_PROVIDERS.CHROME_AI:
                return this.callChromeAI(normalizedRequest, options);
```

Note the missing `apiKey` argument — deliberate, and the same shape as
`callOllama` and `callBedrock`.

- [ ] **Step 5: Implement `callChromeAI`**

Insert after `callOllama` ends (line ~1015), before
`handleStreamingResponse`'s doc comment:

```js
    /**
     * Chrome built-in AI (Gemini Nano) via the `LanguageModel` global.
     *
     * No key, no endpoint, no fetch — an in-process browser API. Sessions are
     * created and destroyed per call: they accumulate conversation state and
     * have a hard input quota, while every caller here passes a full message
     * array and expects statelessness.
     */
    async callChromeAI(requestData, options = {}) {
        const { streaming = false, tabId = null, task = null, isFromPopup = false } = options;

        const { state, reason } = await probeChromeAI();
        if (state !== CHROME_AI_AVAILABILITY.AVAILABLE) {
            throw new Error(this._chromeAIUnavailableMessage(state, reason));
        }

        const { system, prompt } = shapeChromeAIPrompt(requestData.messages);
        const createOpts = system ? { initialPrompts: [{ role: 'system', content: system }] } : {};

        console.log('🧠 Chrome built-in AI call:', { streaming, task });

        let session = null;
        try {
            session = await globalThis.LanguageModel.create(createOpts);

            // Prefer the session's own measurement; fall back to an estimate.
            const promptTokens = typeof session.measureInputUsage === 'function'
                ? await session.measureInputUsage(prompt)
                : estimateTokens(prompt) + estimateTokens(system);
            assertFitsQuota({ promptTokens, quota: session.inputQuota, task });

            if (streaming) {
                return await this._readChromeAIStream(
                    session.promptStreaming(prompt), tabId, options.requestId, isFromPopup
                );
            }
            return await session.prompt(prompt);
        } finally {
            // Not conditional on success: a leaked session bleeds context into
            // the next call and consumes quota that nothing will release.
            try { session?.destroy?.(); } catch { /* already gone */ }
            if (options.requestId) this.activeRequests.delete(options.requestId);
        }
    }

    /** Displayable copy for each non-available state. */
    _chromeAIUnavailableMessage(state, reason) {
        if (state === CHROME_AI_AVAILABILITY.DOWNLOADABLE) {
            return 'Chrome built-in AI needs its model downloaded first. '
                + 'Open Settings → Chrome built-in AI and choose Download model.';
        }
        if (state === CHROME_AI_AVAILABILITY.DOWNLOADING) {
            return 'Chrome built-in AI is still downloading its model. '
                + 'Check progress in Settings → Chrome built-in AI.';
        }
        return reason || 'Chrome built-in AI is not available in this browser.';
    }

    /**
     * Drain a `promptStreaming()` ReadableStream through sendChunk.
     *
     * handleStreamingResponse cannot be reused: it reads `response.body` and
     * parses SSE framing, and this stream is neither a Response nor SSE.
     */
    async _readChromeAIStream(stream, tabId, requestId, isFromPopup) {
        const reader = stream.getReader();
        let full = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value ?? '';
            full += chunk;
            this.sendChunk(tabId, chunk, full, requestId, false, isFromPopup);
        }
        this.sendChunk(tabId, '', full, requestId, true, isFromPopup);
        return full;
    }
```

- [ ] **Step 6: Run the new test and confirm it passes**

Run: `npx jest test/unit/callChromeAI.test.js`
Expected: PASS, 9 tests

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: PASS — `LLMService.js` is shared by many tests, so this is the gate.

- [ ] **Step 8: Commit** — ask the user first

```bash
git add src/services/LLMService.js test/unit/callChromeAI.test.js
git commit -m "feat(chrome-ai): add keyless Chrome built-in AI provider to LLMService"
```

---

### Task 5: Ollama probe with four verdicts

**Files:**
- Create: `src/utils/ollamaProbe.js`
- Modify: `src/services/LLMService.js:1228` (`checkOllamaStatus`)
- Test: `test/unit/ollamaProbe.test.js`

**Interfaces:**
- Produces: `OLLAMA_VERDICT`, `classifyOllamaProbe({tagsResult, opaqueReachable, selectedModel}) → {verdict, message, fix}`, `matchesOllamaModel(installedName, selectedId) → boolean`
- `checkOllamaStatus()` keeps returning `{running, models}` — `getOllamaModels` (`LLMService.js:1249`) reads `status.running` — and **adds** `verdict`, `message`, `fix`. Additive only.

**Why the second probe exists.** A blocked CORS preflight and a closed port are
*indistinguishable* from the error object: CORS deliberately hides detail, so
both surface as an opaque `TypeError: Failed to fetch`. The current code cannot
tell them apart, which is why it reports a running-but-refusing server as "not
running" — blaming a step the user completed. The fix is a second probe of
`/api/tags` with `mode: 'no-cors'`: an opaque response proves the server
answered, so the origin is being refused rather than the port being shut.

- [ ] **Step 1: Write the failing test**

Create `test/unit/ollamaProbe.test.js`:

```js
/**
 * The documented Ollama setup cannot work: a fetch from an extension page
 * carries a chrome-extension:// Origin, Chrome sends a preflight, and Ollama
 * rejects any origin not in OLLAMA_ORIGINS. The old probe reported that as
 * "server not running" — the one diagnosis that is certainly wrong, and the
 * reason users abandon the keyless path. These tests pin the distinction.
 */
const {
    OLLAMA_VERDICT,
    classifyOllamaProbe,
    matchesOllamaModel,
} = require('../../src/utils/ollamaProbe.js');

const tagsOk = (names) => ({ ok: true, models: names.map((name) => ({ name })) });
const tagsFailed = { ok: false, error: 'Failed to fetch' };

describe('classifyOllamaProbe', () => {
    test('tags returned and model present is ok', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsOk(['qwen2.5-coder:latest']),
            opaqueReachable: true,
            selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.OK);
        expect(r.fix).toBe('');
    });

    test('no selected model only checks that the server answered', () => {
        expect(classifyOllamaProbe({
            tagsResult: tagsOk([]), opaqueReachable: true, selectedModel: null,
        }).verdict).toBe(OLLAMA_VERDICT.OK);
    });

    test('fetch failed but the server answered opaquely is cors_blocked', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsFailed, opaqueReachable: true, selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.CORS_BLOCKED);
        expect(r.fix).toContain('OLLAMA_ORIGINS');
        expect(r.message).not.toMatch(/not running/i);
    });

    test('fetch failed and nothing answered is not_running', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsFailed, opaqueReachable: false, selectedModel: null,
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.NOT_RUNNING);
        expect(r.fix).toContain('ollama serve');
    });

    test('an unknown opaque result is not_running, never cors_blocked', () => {
        // Claiming CORS without evidence would send the user to fix a
        // non-problem, which is the failure this whole task is correcting.
        expect(classifyOllamaProbe({
            tagsResult: tagsFailed, opaqueReachable: null, selectedModel: null,
        }).verdict).toBe(OLLAMA_VERDICT.NOT_RUNNING);
    });

    test('tags returned without the selected model is model_missing', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsOk(['llama3.3:latest']),
            opaqueReachable: true,
            selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.verdict).toBe(OLLAMA_VERDICT.MODEL_MISSING);
        expect(r.fix).toContain('ollama pull qwen2.5-coder');
    });

    test('model_missing lists what IS installed, so the user can just pick one', () => {
        const r = classifyOllamaProbe({
            tagsResult: tagsOk(['llama3.3:latest', 'phi4:latest']),
            opaqueReachable: true,
            selectedModel: 'local:qwen2.5-coder',
        });
        expect(r.message).toContain('llama3.3:latest');
        expect(r.message).toContain('phi4:latest');
    });

    test('every verdict carries displayable copy', () => {
        const cases = [
            { tagsResult: tagsOk(['m:latest']), opaqueReachable: true, selectedModel: 'local:m' },
            { tagsResult: tagsFailed, opaqueReachable: true, selectedModel: null },
            { tagsResult: tagsFailed, opaqueReachable: false, selectedModel: null },
            { tagsResult: tagsOk(['other']), opaqueReachable: true, selectedModel: 'local:m' },
        ];
        for (const c of cases) {
            const r = classifyOllamaProbe(c);
            expect(typeof r.message).toBe('string');
            expect(r.message.length).toBeGreaterThan(0);
            expect(Object.values(OLLAMA_VERDICT)).toContain(r.verdict);
        }
    });
});

describe('matchesOllamaModel', () => {
    test('matches across the local: prefix and the :tag suffix', () => {
        expect(matchesOllamaModel('qwen2.5-coder:latest', 'local:qwen2.5-coder')).toBe(true);
        expect(matchesOllamaModel('qwen2.5-coder:32b', 'local:qwen2.5-coder:32b')).toBe(true);
        expect(matchesOllamaModel('qwen2.5-coder:latest', 'qwen2.5-coder')).toBe(true);
    });

    test('does not match a different model', () => {
        expect(matchesOllamaModel('llama3.3:latest', 'local:qwen2.5-coder')).toBe(false);
    });

    test('tolerates missing values', () => {
        expect(matchesOllamaModel(null, 'local:m')).toBe(false);
        expect(matchesOllamaModel('m:latest', null)).toBe(false);
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest test/unit/ollamaProbe.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the classifier**

Create `src/utils/ollamaProbe.js`:

```js
/**
 * Turn Ollama probe outcomes into a verdict the user can act on.
 *
 * The old check collapsed every failure into "not reachable", and the most
 * common failure is not that: a fetch from an extension page carries a
 * chrome-extension:// Origin, so Chrome sends a preflight and Ollama refuses
 * any origin absent from OLLAMA_ORIGINS. Reporting that as a stopped server
 * points the user at a step they already completed.
 */

export const OLLAMA_VERDICT = Object.freeze({
    OK: 'ok',
    CORS_BLOCKED: 'cors_blocked',
    NOT_RUNNING: 'not_running',
    MODEL_MISSING: 'model_missing',
});

/** `chrome-extension://*` — wildcard so it survives reinstalls and unpacked builds. */
export const OLLAMA_ORIGINS_VALUE = 'chrome-extension://*';

/** Strip the `local:` provider prefix and any `:tag` suffix. */
function baseName(id) {
    if (!id) return '';
    const withoutProvider = String(id).startsWith('local:') ? String(id).slice(6) : String(id);
    return withoutProvider.split(':')[0];
}

/**
 * Does an installed Ollama model satisfy a selected model id?
 *
 * Installed names carry a tag (`qwen2.5-coder:latest`); selections carry the
 * provider prefix (`local:qwen2.5-coder`). Compare the base names, and treat an
 * exact tagged match as a match too.
 */
export function matchesOllamaModel(installedName, selectedId) {
    if (!installedName || !selectedId) return false;
    const selected = String(selectedId).startsWith('local:')
        ? String(selectedId).slice(6)
        : String(selectedId);
    if (installedName === selected) return true;
    return baseName(installedName) === baseName(selectedId);
}

/**
 * @param {object} probe
 * @param {{ok: boolean, models?: Array<{name: string}>, error?: string}} probe.tagsResult
 *   Outcome of a normal CORS fetch of /api/tags.
 * @param {boolean|null} probe.opaqueReachable
 *   Outcome of a `mode: 'no-cors'` fetch. True means the server answered even
 *   though the CORS fetch failed — that is the CORS signature. Null means the
 *   second probe was not run or was itself inconclusive.
 * @param {string|null} probe.selectedModel
 * @returns {{verdict: string, message: string, fix: string}}
 */
export function classifyOllamaProbe({ tagsResult, opaqueReachable = null, selectedModel = null }) {
    if (tagsResult && tagsResult.ok) {
        const models = Array.isArray(tagsResult.models) ? tagsResult.models : [];
        if (selectedModel && !models.some((m) => matchesOllamaModel(m.name, selectedModel))) {
            const installed = models.map((m) => m.name).join(', ') || 'none';
            return {
                verdict: OLLAMA_VERDICT.MODEL_MISSING,
                message: `Ollama is running but "${baseName(selectedModel)}" is not installed. Installed: ${installed}.`,
                fix: `ollama pull ${baseName(selectedModel)}`,
            };
        }
        return { verdict: OLLAMA_VERDICT.OK, message: 'Ollama is running and the selected model is installed.', fix: '' };
    }

    // The CORS fetch failed. Only the opaque probe can say why.
    if (opaqueReachable === true) {
        return {
            verdict: OLLAMA_VERDICT.CORS_BLOCKED,
            message: 'Ollama is running but refusing requests from this extension. '
                + 'It needs to allow the extension origin.',
            fix: `Restart Ollama with OLLAMA_ORIGINS set to ${OLLAMA_ORIGINS_VALUE} (see setup step 3)`,
        };
    }

    // No evidence the server answered. Do not claim CORS without evidence —
    // sending the user to fix a non-problem is the bug being corrected here.
    return {
        verdict: OLLAMA_VERDICT.NOT_RUNNING,
        message: 'No Ollama server responded on localhost:11434.',
        fix: 'Start it with: ollama serve',
    };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest test/unit/ollamaProbe.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Rewrite `checkOllamaStatus` to run both probes**

Add the import to `src/services/LLMService.js`:

```js
import { classifyOllamaProbe } from '../utils/ollamaProbe.js';
```

Replace `checkOllamaStatus` (line 1228-1245) entirely:

```js
    /**
     * Probe the local Ollama server.
     *
     * Runs two probes because one cannot answer the question. A blocked CORS
     * preflight and a closed port both surface as an opaque
     * `TypeError: Failed to fetch` — CORS hides the detail by design. A second
     * `mode: 'no-cors'` request distinguishes them: an opaque response proves
     * the server answered, so the origin is being refused rather than the port
     * being shut.
     *
     * `running` and `models` are kept for getOllamaModels and existing callers;
     * `verdict`, `message` and `fix` are additive.
     */
    async checkOllamaStatus(selectedModel = null) {
        const url = API_ENDPOINTS[LLM_PROVIDERS.LOCAL].models;

        let tagsResult;
        try {
            const response = await fetch(url, { method: 'GET' });
            tagsResult = response.ok
                ? { ok: true, models: (await response.json()).models || [] }
                : { ok: false, error: `HTTP ${response.status}` };
        } catch (error) {
            tagsResult = { ok: false, error: error.message };
        }

        let opaqueReachable = null;
        if (!tagsResult.ok) {
            try {
                await fetch(url, { method: 'GET', mode: 'no-cors' });
                // An opaque response resolves without exposing status. Resolving
                // at all means something answered on that port.
                opaqueReachable = true;
            } catch {
                opaqueReachable = false;
            }
        }

        const { verdict, message, fix } = classifyOllamaProbe({
            tagsResult, opaqueReachable, selectedModel,
        });

        return {
            running: Boolean(tagsResult.ok),
            models: tagsResult.ok ? tagsResult.models : [],
            verdict,
            message,
            fix,
            error: tagsResult.ok ? undefined : tagsResult.error,
        };
    }
```

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: PASS. `getOllamaModels` still reads `status.running` and
`status.models`, both preserved. If any existing test asserts the old shape,
that is a real signal — read it before changing it.

- [ ] **Step 7: Commit** — ask the user first

```bash
git add src/utils/ollamaProbe.js src/services/LLMService.js test/unit/ollamaProbe.test.js
git commit -m "fix(ollama): distinguish CORS refusal from a stopped server in the probe"
```

---

### Task 6: Split `Settings.jsx` into per-provider panels

**Files:**
- Create: `src/popup/components/settings/ApiKeyProviderPanel.jsx`, `BedrockPanel.jsx`, `providerPanelRegistry.js`
- Modify: `src/popup/components/Settings.jsx`

**Interfaces:**
- Produces: `panelForProvider(provider) → React component`. Every panel takes the same props object so the registry can be a plain lookup:
  `{ provider, apiKey, setApiKey, hasExistingKey, keyTest, keyTesting, testApiKey, model, bedrock: {...} }`

**This task is a pure move.** No behaviour changes. `Settings.jsx` is 1795 lines
against a 300-line ceiling and Tasks 5 and 7 both add panels to it; without this
split, the two keyless providers make the file worse in exactly the way the
ceiling exists to prevent.

- [ ] **Step 1: Confirm the suite is green before moving anything**

Run: `npx jest`
Expected: PASS. Record the test count — Step 5 must match it exactly.

- [ ] **Step 2: Identify the exact block boundaries**

Run: `grep -n "isKeylessProvider\|isBedrock\|KeyTestVerdict\|API Key (not shown" src/popup/components/Settings.jsx`

The credential region runs from the Bedrock block through the API-key block
(roughly lines 800-1000 after Task 1's edits). Read it in full before cutting —
note every state setter and helper it references, because those become props.

- [ ] **Step 3: Create the registry**

Create `src/popup/components/settings/providerPanelRegistry.js`:

```js
/**
 * provider → credential panel.
 *
 * Settings.jsx keeps layout, persistence and the provider/model selects, and
 * delegates the credential block. Adding a provider means adding a panel and
 * one line here, not another conditional in a 1795-line component.
 */

import { LLM_PROVIDERS } from '../../../utils/constants.js';
import { ApiKeyProviderPanel } from './ApiKeyProviderPanel.jsx';
import { BedrockPanel } from './BedrockPanel.jsx';
import { OllamaPanel } from './OllamaPanel.jsx';
import { ChromeAIPanel } from './ChromeAIPanel.jsx';

const PANELS = {
    [LLM_PROVIDERS.BEDROCK]: BedrockPanel,
    [LLM_PROVIDERS.LOCAL]: OllamaPanel,
    [LLM_PROVIDERS.CHROME_AI]: ChromeAIPanel,
};

/** Every other provider authenticates with a single API key. */
export function panelForProvider(provider) {
    return PANELS[provider] || ApiKeyProviderPanel;
}
```

- [ ] **Step 4: Move the two existing blocks into panels**

Create `ApiKeyProviderPanel.jsx` from the API-key block (the
`{!isKeylessProvider && !isBedrock ? (...)}` branch) and `BedrockPanel.jsx` from
the Bedrock credential block. Move the markup verbatim; convert every closed-over
value into a prop. Include `KeyTestVerdict` where it is used — if it is defined
inside `Settings.jsx`, move it to
`src/popup/components/settings/KeyTestVerdict.jsx` and import it from both panels.

In `Settings.jsx`, replace both blocks with:

```js
                    {(() => {
                        const Panel = panelForProvider(provider);
                        return (
                            <Panel
                                provider={provider}
                                apiKey={apiKey}
                                setApiKey={setApiKey}
                                hasExistingKey={hasExistingKey}
                                keyTest={keyTest}
                                keyTesting={keyTesting}
                                testApiKey={testApiKey}
                                model={model}
                                bedrock={{
                                    accessKeyId: bedrockAccessKeyId,
                                    setAccessKeyId: setBedrockAccessKeyId,
                                    secretKey: bedrockSecretKey,
                                    setSecretKey: setBedrockSecretKey,
                                    sessionToken: bedrockSessionToken,
                                    setSessionToken: setBedrockSessionToken,
                                    region: bedrockRegion,
                                    setRegion: setBedrockRegion,
                                }}
                            />
                        );
                    })()}
```

Check the Bedrock state variable names against the file before using them:

Run: `grep -n "bedrockAccessKeyId\|bedrockSecretKey\|bedrockSessionToken\|bedrockRegion" src/popup/components/Settings.jsx | head`

Task 7 creates `OllamaPanel.jsx` and `ChromeAIPanel.jsx`. To keep this task
independently testable, create both as one-line stubs now — `export function
OllamaPanel() { return null; }` — and fill them in Task 7. A stub keeps the
import graph valid without pretending the panel exists.

- [ ] **Step 5: Verify nothing changed**

Run: `npx jest`
Expected: PASS with **the same test count as Step 1**. Panels were moved, not
rewritten, so no existing test should need editing. If one does, the extraction
was not mechanical — stop and re-read it rather than adjusting the test.

- [ ] **Step 6: Verify the build still produces a working bundle**

Run: `npm run build`
Expected: completes with no unresolved-import errors. The registry adds four new
module edges, and JSX resolution failures do not show up in Jest.

- [ ] **Step 7: Check the ceiling**

Run: `wc -l src/popup/components/Settings.jsx src/popup/components/settings/*.jsx`
Expected: `Settings.jsx` materially smaller. It will still exceed 300 lines —
this task only extracts the credential region, which is what the current work
touches. Do not chase the rest of the file here.

- [ ] **Step 8: Commit** — ask the user first

```bash
git add src/popup/components/Settings.jsx src/popup/components/settings/
git commit -m "refactor(settings): extract per-provider credential panels behind a registry"
```

---

### Task 7: Ollama and Chrome AI panels

**Files:**
- Create: `src/popup/components/settings/ollamaSetupSteps.js` — the setup copy as data
- Modify: `src/popup/components/settings/OllamaPanel.jsx` (replace Task 6's stub)
- Modify: `src/popup/components/settings/ChromeAIPanel.jsx` (replace Task 6's stub)
- Modify: `src/popup/components/Settings.jsx:92-96` (Ollama fallback model list)
- Test: `test/unit/ollamaSetupSteps.test.js`

**Why the steps live in a `.js` file, not in the panel:** tests cannot load
`.jsx` (see Global Constraints). The copy is the part worth testing — the old
instructions were wrong and shipped anyway — so it must be reachable from a
test. The panel imports it and renders it.

**Interfaces:**
- Consumes: `classifyOllamaProbe` / `OLLAMA_ORIGINS_VALUE` (Task 5), `probeChromeAI` / `CHROME_AI_AVAILABILITY` (Task 3), `checkOllamaStatus(selectedModel)` (Task 5)
- Produces: `OLLAMA_SETUP_STEPS` from `src/popup/components/settings/ollamaSetupSteps.js` (a `.js` module, so a test can load it)

- [ ] **Step 1: Change the recommended Ollama model**

In `src/popup/components/Settings.jsx` at lines 92-96, reorder so the
code-specialised model is the recommended default:

```js
    [LLM_PROVIDERS.LOCAL]: [
        // A code model is the right default for a code-review tool, and it is
        // also the smaller download: llama3.3 is a general chat model in the
        // tens of GB at common quantisations.
        { id: 'local:qwen2.5-coder', name: 'Qwen 2.5 Coder', recommended: true },
        { id: 'local:deepseek-coder-v2', name: 'DeepSeek Coder V2' },
        { id: 'local:llama3.3', name: 'Llama 3.3 (general purpose)' }
    ],
```

- [ ] **Step 2: Write the failing test for the setup copy**

Create `test/unit/ollamaSetupSteps.test.js`:

```js
/**
 * The old instructions were a three-step list that could not work: they omitted
 * OLLAMA_ORIGINS, so a user who followed them exactly still could not reach the
 * server. These tests pin the missing step and its per-platform forms, because
 * "set an environment variable" is exactly where a non-shell user stalls.
 */
const { OLLAMA_SETUP_STEPS } = require('../../src/popup/components/settings/ollamaSetupSteps.js');
const { OLLAMA_ORIGINS_VALUE } = require('../../src/utils/ollamaProbe.js');

describe('OLLAMA_SETUP_STEPS', () => {
    test('has four steps, in order', () => {
        expect(OLLAMA_SETUP_STEPS).toHaveLength(4);
        expect(OLLAMA_SETUP_STEPS.map((s) => s.id))
            .toEqual(['install', 'pull', 'origins', 'verify']);
    });

    test('the origins step covers all three platforms', () => {
        const origins = OLLAMA_SETUP_STEPS.find((s) => s.id === 'origins');
        const platforms = origins.commands.map((c) => c.platform);
        expect(platforms).toEqual(expect.arrayContaining(['macos-linux', 'macos-service', 'windows']));
    });

    test('every origins command carries the wildcard origin value', () => {
        const origins = OLLAMA_SETUP_STEPS.find((s) => s.id === 'origins');
        for (const { command } of origins.commands) {
            expect(command).toContain(OLLAMA_ORIGINS_VALUE);
        }
    });

    test('pulls the code model, not the general chat model', () => {
        const pull = OLLAMA_SETUP_STEPS.find((s) => s.id === 'pull');
        expect(pull.commands[0].command).toBe('ollama pull qwen2.5-coder');
    });

    test('every command is copyable — non-empty string, no placeholders', () => {
        for (const step of OLLAMA_SETUP_STEPS) {
            for (const { command } of step.commands || []) {
                expect(command.trim().length).toBeGreaterThan(0);
                expect(command).not.toMatch(/<|TODO|TBD/);
            }
        }
    });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx jest test/unit/ollamaSetupSteps.test.js`
Expected: FAIL — `Cannot find module '.../settings/ollamaSetupSteps.js'`

- [ ] **Step 4a: Create the setup-steps data module**

Create `src/popup/components/settings/ollamaSetupSteps.js`:

```js
/**
 * Ollama setup instructions, as data.
 *
 * The instructions this replaces were missing step 3, which is the step that
 * makes the whole path work: a fetch from an extension page carries a
 * chrome-extension:// Origin, and Ollama refuses any origin absent from
 * OLLAMA_ORIGINS. Wrong copy shipped once already, so it lives in a plain .js
 * module where a test can assert it — tests cannot load .jsx.
 */

import { OLLAMA_ORIGINS_VALUE } from '../../../utils/ollamaProbe.js';

export const OLLAMA_SETUP_STEPS = Object.freeze([
    {
        id: 'install',
        title: 'Install Ollama',
        detail: 'Download it from ollama.ai',
        commands: [],
    },
    {
        id: 'pull',
        title: 'Pull a code model',
        detail: 'Code-specialised and a much smaller download than a general chat model.',
        commands: [{ platform: 'all', command: 'ollama pull qwen2.5-coder' }],
    },
    {
        id: 'origins',
        title: 'Allow this extension to connect',
        detail: 'Without this, Ollama runs but refuses the extension — the requests never reach a model.',
        commands: [
            { platform: 'macos-linux', label: 'macOS / Linux', command: `OLLAMA_ORIGINS=${OLLAMA_ORIGINS_VALUE} ollama serve` },
            { platform: 'macos-service', label: 'macOS (running as a service)', command: `launchctl setenv OLLAMA_ORIGINS "${OLLAMA_ORIGINS_VALUE}"` },
            { platform: 'windows', label: 'Windows (then restart Ollama)', command: `setx OLLAMA_ORIGINS "${OLLAMA_ORIGINS_VALUE}"` },
        ],
    },
    {
        id: 'verify',
        title: 'Test the connection',
        detail: 'Confirms the server is up, allows this extension, and has your model.',
        commands: [],
    },
]);
```

- [ ] **Step 4b: Implement `OllamaPanel.jsx`**

Replace `src/popup/components/settings/OllamaPanel.jsx`:

```jsx
/**
 * Ollama setup and status. Copy comes from ollamaSetupSteps.js; this file is
 * markup plus the verdict rendering.
 */

import React, { useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, Loader2, Copy } from 'lucide-react';
import { OLLAMA_VERDICT } from '../../../utils/ollamaProbe.js';
import { OLLAMA_SETUP_STEPS } from './ollamaSetupSteps.js';

const VERDICT_ICON = {
    [OLLAMA_VERDICT.OK]: CheckCircle,
    [OLLAMA_VERDICT.CORS_BLOCKED]: AlertTriangle,
    [OLLAMA_VERDICT.MODEL_MISSING]: AlertTriangle,
    [OLLAMA_VERDICT.NOT_RUNNING]: XCircle,
};

function CopyableCommand({ command, label }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <div className="space-y-1">
            {label ? <p className="text-[11px] text-textMuted">{label}</p> : null}
            <div className="flex items-center gap-2">
                <code className="flex-1 bg-surfaceHighlight px-2 py-1 rounded text-[11px] break-all">{command}</code>
                <button type="button" onClick={copy} className="text-textMuted hover:text-text" title="Copy">
                    <Copy className="w-3 h-3" />
                </button>
                {copied ? <span className="text-[11px] text-success">Copied</span> : null}
            </div>
        </div>
    );
}

export function OllamaPanel({ model, keyTesting, testApiKey, keyTest }) {
    const verdict = keyTest?.verdict;
    const Icon = VERDICT_ICON[verdict];

    return (
        <div className="space-y-3">
            <div className="flex items-start gap-2 p-3 bg-success/10 border border-success/20 rounded-lg">
                <CheckCircle className="w-4 h-4 text-success mt-0.5" />
                <div className="text-sm text-success">
                    <p className="font-medium">No API key required</p>
                    <p className="text-xs text-success/80 mt-1">Ollama runs on your machine — nothing leaves it.</p>
                </div>
            </div>

            <div className="text-xs text-textMuted space-y-3">
                <p className="font-medium">Setup:</p>
                <ol className="space-y-3 ml-2 list-decimal list-inside">
                    {OLLAMA_SETUP_STEPS.map((step) => (
                        <li key={step.id} className="space-y-1">
                            <span className="text-text font-medium">{step.title}</span>
                            {step.detail ? <p className="text-[11px]">{step.detail}</p> : null}
                            {step.commands.map((c) => (
                                <CopyableCommand key={c.platform} command={c.command} label={c.label} />
                            ))}
                        </li>
                    ))}
                </ol>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-xs text-textMuted">Check the local server</span>
                <button
                    type="button"
                    onClick={() => testApiKey(model)}
                    disabled={keyTesting}
                    className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                >
                    {keyTesting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {keyTesting ? 'Testing…' : 'Test connection'}
                </button>
            </div>

            {verdict ? (
                <div className="flex items-start gap-2 text-xs">
                    {Icon ? <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : null}
                    <div>
                        <p className="text-text">{keyTest.message}</p>
                        {keyTest.fix ? <p className="text-textMuted mt-1">Fix: {keyTest.fix}</p> : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx jest test/unit/ollamaSetupSteps.test.js`
Expected: PASS, 5 tests

- [ ] **Step 6: Wire the probe's verdict into `testApiKey`**

`testApiKey` in `Settings.jsx` must pass the selected model through and keep the
verdict fields, so the panel can render them:

```js
        if (!providerNeedsKey(provider) && provider === LLM_PROVIDERS.LOCAL) {
            const status = await llmService.checkOllamaStatus(model);
            setKeyTest({
                ok: status.verdict === 'ok',
                verdict: status.verdict,
                message: status.message,
                fix: status.fix,
            });
            return;
        }
```

Read the existing `testApiKey` first and place this beside the current Ollama
branch rather than duplicating its setup:

Run: `grep -n "const testApiKey" -A 30 src/popup/components/Settings.jsx`

- [ ] **Step 7: Implement `ChromeAIPanel.jsx`**

Replace `src/popup/components/settings/ChromeAIPanel.jsx`:

```jsx
/**
 * Chrome built-in AI status.
 *
 * The download is the whole reason this panel is not a one-liner: first use
 * pulls a multi-gigabyte model, so `downloadable` must be an explicit user
 * choice (we never start a multi-gigabyte transfer because a settings tab was
 * opened) and `downloading` must show real progress rather than a spinner with
 * no end.
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle, Download, Loader2, XCircle } from 'lucide-react';
import { CHROME_AI_AVAILABILITY, probeChromeAI } from '../../../utils/chromeAI.js';

export function ChromeAIPanel() {
    const [state, setState] = useState(null);
    const [reason, setReason] = useState('');
    const [progress, setProgress] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        probeChromeAI().then(({ state: s, reason: r }) => {
            if (!cancelled) { setState(s); setReason(r); }
        });
        return () => { cancelled = true; };
    }, []);

    const startDownload = async () => {
        setError(null);
        setState(CHROME_AI_AVAILABILITY.DOWNLOADING);
        try {
            const session = await globalThis.LanguageModel.create({
                monitor(m) {
                    m.addEventListener('downloadprogress', (e) => {
                        setProgress(Math.round((e.loaded || 0) * 100));
                    });
                },
            });
            session?.destroy?.();
            const { state: s, reason: r } = await probeChromeAI();
            setState(s);
            setReason(r);
        } catch (e) {
            setError(e.message);
            setState(CHROME_AI_AVAILABILITY.DOWNLOADABLE);
        }
    };

    if (state === null) {
        return (
            <p className="flex items-center gap-2 text-xs text-textMuted">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking Chrome built-in AI…
            </p>
        );
    }

    if (state === CHROME_AI_AVAILABILITY.AVAILABLE) {
        return (
            <div className="space-y-2">
                <div className="flex items-start gap-2 p-3 bg-success/10 border border-success/20 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-success mt-0.5" />
                    <div className="text-sm text-success">
                        <p className="font-medium">Ready — no API key, nothing to install</p>
                        <p className="text-xs text-success/80 mt-1">Runs on your device. Never leaves it.</p>
                    </div>
                </div>
                <p className="text-xs text-textMuted">
                    Best for summaries, commit messages and single-file questions. Full PR review
                    needs a larger context window — use Ollama or an API key for that.
                </p>
            </div>
        );
    }

    if (state === CHROME_AI_AVAILABILITY.DOWNLOADABLE) {
        return (
            <div className="space-y-2">
                <p className="text-xs text-textMuted">
                    Chrome can run a model on your device with no key. It needs a one-time
                    download of roughly 2 GB.
                </p>
                <button
                    type="button"
                    onClick={startDownload}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                    <Download className="w-3 h-3" /> Download model (~2 GB)
                </button>
                {error ? <p className="text-xs text-error">{error}</p> : null}
            </div>
        );
    }

    if (state === CHROME_AI_AVAILABILITY.DOWNLOADING) {
        return (
            <div className="space-y-2">
                <p className="flex items-center gap-2 text-xs text-textMuted">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Downloading model{progress === null ? '…' : ` — ${progress}%`}
                </p>
                {progress !== null ? (
                    <div className="h-1 bg-surfaceHighlight rounded overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div className="flex items-start gap-2 text-xs">
            <XCircle className="w-3.5 h-3.5 text-textMuted mt-0.5 shrink-0" />
            <p className="text-textMuted">{reason || 'Chrome built-in AI is not available here.'}</p>
        </div>
    );
}
```

- [ ] **Step 8: Add `chrome-ai` to the provider select and label map**

In `Settings.jsx`, add to the local `LLM_PROVIDERS` mirror (line ~31) and the
label map (line ~602):

```js
    CHROME_AI: 'chrome-ai'
```

```js
            [LLM_PROVIDERS.CHROME_AI]: 'Chrome built-in AI (no key)'
```

Add a single-entry model list so the model select is not empty:

```js
    [LLM_PROVIDERS.CHROME_AI]: [
        { id: 'chrome-ai:nano', name: 'Gemini Nano (on-device)', recommended: true }
    ],
```

- [ ] **Step 9: Verify**

Run: `npx jest`
Expected: PASS

Run: `npm run build`
Expected: clean

- [ ] **Step 10: Commit** — ask the user first

```bash
git add src/popup/components/settings/ src/popup/components/Settings.jsx \
        test/unit/ollamaSetupSteps.test.js
# (src/popup/components/settings/ covers ollamaSetupSteps.js, OllamaPanel.jsx, ChromeAIPanel.jsx)
git commit -m "feat(settings): correct Ollama setup copy and add a Chrome built-in AI panel"
```

---

### Task 8: Onboarding — rank the keyless routes

**Files:**
- Create: `src/popup/utils/keylessRoutes.js`
- Modify: `src/popup/App.jsx:406-440`
- Test: `test/unit/keylessRoutes.test.js`

**Interfaces:**
- Consumes: `CHROME_AI_AVAILABILITY` (Task 3), `OLLAMA_VERDICT` (Task 5)
- Produces: `ROUTE_IDS`, `rankKeylessRoutes({chromeAI, ollama, hasKey, mcpPublished}) → Array<{id, tier, label, detail, action, enabled}>`

**Ranking rule:** by time-to-first-result, not by quality — the panel's job is
to get the user to one working result. Quality is named in the labels so the
ranking does not mislead. A user who already has Ollama running must not be
steered to the weaker on-device model.

- [ ] **Step 1: Write the failing test**

Create `test/unit/keylessRoutes.test.js`:

```js
/**
 * Step 1 of the old welcome panel was "Add your API key", which is the whole
 * funnel for a user who has no key. These tests pin that the panel ranks by
 * time-to-first-result, that a working Ollama outranks the weaker on-device
 * model, and that an unavailable route explains itself instead of offering a
 * button that cannot work.
 */
const { CHROME_AI_AVAILABILITY } = require('../../src/utils/chromeAI.js');
const { OLLAMA_VERDICT } = require('../../src/utils/ollamaProbe.js');
const { ROUTE_IDS, rankKeylessRoutes } = require('../../src/popup/utils/keylessRoutes.js');

const ids = (rows) => rows.map((r) => r.id);

describe('rankKeylessRoutes', () => {
    test('a working Ollama outranks an available on-device model', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.AVAILABLE,
            ollama: OLLAMA_VERDICT.OK,
            hasKey: false,
        });
        expect(ids(rows).indexOf(ROUTE_IDS.OLLAMA))
            .toBeLessThan(ids(rows).indexOf(ROUTE_IDS.CHROME_AI));
        expect(rows[0].tier).toBe('Ready now');
    });

    test('with no Ollama, an available on-device model leads', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.AVAILABLE,
            ollama: OLLAMA_VERDICT.NOT_RUNNING,
            hasKey: false,
        });
        expect(rows[0].id).toBe(ROUTE_IDS.CHROME_AI);
        expect(rows[0].tier).toBe('Ready now');
    });

    test('the API-key route is always offered', () => {
        for (const chromeAI of Object.values(CHROME_AI_AVAILABILITY)) {
            for (const ollama of Object.values(OLLAMA_VERDICT)) {
                expect(ids(rankKeylessRoutes({ chromeAI, ollama, hasKey: false })))
                    .toContain(ROUTE_IDS.API_KEY);
            }
        }
    });

    test('an unavailable on-device model is disabled and says why', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            ollama: OLLAMA_VERDICT.NOT_RUNNING,
            hasKey: false,
            chromeAIReason: 'Needs Chrome 138 or newer.',
        });
        const row = rows.find((r) => r.id === ROUTE_IDS.CHROME_AI);
        expect(row.enabled).toBe(false);
        expect(row.detail).toContain('Chrome 138');
    });

    test('a CORS-blocked Ollama is offered as a fix, not as ready', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            ollama: OLLAMA_VERDICT.CORS_BLOCKED,
            hasKey: false,
        });
        const row = rows.find((r) => r.id === ROUTE_IDS.OLLAMA);
        expect(row.tier).not.toBe('Ready now');
        expect(row.detail).toMatch(/allow|origin/i);
    });

    test('the MCP row appears only when published', () => {
        const base = { chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE, ollama: OLLAMA_VERDICT.NOT_RUNNING, hasKey: false };
        expect(ids(rankKeylessRoutes({ ...base, mcpPublished: false }))).not.toContain(ROUTE_IDS.MCP);
        expect(ids(rankKeylessRoutes({ ...base, mcpPublished: true }))).toContain(ROUTE_IDS.MCP);
    });

    test('an existing key moves the key row to Ready now', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.UNAVAILABLE,
            ollama: OLLAMA_VERDICT.NOT_RUNNING,
            hasKey: true,
        });
        expect(rows[0].id).toBe(ROUTE_IDS.API_KEY);
        expect(rows[0].tier).toBe('Ready now');
    });

    test('every row is renderable — id, tier, label, action, enabled', () => {
        const rows = rankKeylessRoutes({
            chromeAI: CHROME_AI_AVAILABILITY.DOWNLOADABLE,
            ollama: OLLAMA_VERDICT.MODEL_MISSING,
            hasKey: false,
            mcpPublished: true,
        });
        for (const r of rows) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.tier).toBe('string');
            expect(r.label.length).toBeGreaterThan(0);
            expect(typeof r.action).toBe('string');
            expect(typeof r.enabled).toBe('boolean');
        }
    });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest test/unit/keylessRoutes.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the module**

Create `src/popup/utils/keylessRoutes.js`:

```js
/**
 * Rank the ways this user can get a first result.
 *
 * Ordered by time-to-first-result, not by quality: the welcome panel's one job
 * is to get someone to a working result, and the fastest route is rarely the
 * best one. Quality is stated in the labels so the ordering does not mislead.
 *
 * Pure. The panel renders whatever this returns.
 */

import { CHROME_AI_AVAILABILITY } from '../../utils/chromeAI.js';
import { OLLAMA_VERDICT } from '../../utils/ollamaProbe.js';

export const ROUTE_IDS = Object.freeze({
    OLLAMA: 'ollama',
    CHROME_AI: 'chrome-ai',
    API_KEY: 'api-key',
    MCP: 'mcp',
});

const TIER = Object.freeze({
    READY: 'Ready now',
    SETUP: 'A few minutes',
    UNAVAILABLE: 'Not available here',
});

/** Lower sorts first. Ready routes first, then setup, then unavailable. */
const TIER_RANK = { [TIER.READY]: 0, [TIER.SETUP]: 1, [TIER.UNAVAILABLE]: 2 };

function ollamaRow(verdict) {
    if (verdict === OLLAMA_VERDICT.OK) {
        return { id: ROUTE_IDS.OLLAMA, tier: TIER.READY, label: 'Ollama — running, no key', detail: 'Best quality of the keyless options.', action: 'Use it', enabled: true };
    }
    if (verdict === OLLAMA_VERDICT.CORS_BLOCKED) {
        return { id: ROUTE_IDS.OLLAMA, tier: TIER.SETUP, label: 'Ollama — needs one setting', detail: 'Running, but not yet set to allow this extension’s origin.', action: 'Fix it', enabled: true };
    }
    if (verdict === OLLAMA_VERDICT.MODEL_MISSING) {
        return { id: ROUTE_IDS.OLLAMA, tier: TIER.SETUP, label: 'Ollama — needs a model', detail: 'Running, but the selected model is not pulled yet.', action: 'Fix it', enabled: true };
    }
    return { id: ROUTE_IDS.OLLAMA, tier: TIER.SETUP, label: 'Ollama — no key, best quality', detail: 'Runs on your machine. About five minutes to set up.', action: 'Set up', enabled: true };
}

function chromeAIRow(state, reason) {
    if (state === CHROME_AI_AVAILABILITY.AVAILABLE) {
        return { id: ROUTE_IDS.CHROME_AI, tier: TIER.READY, label: 'Chrome built-in AI — nothing to install', detail: 'On-device. Good for summaries; too small for full PR review.', action: 'Use it', enabled: true };
    }
    if (state === CHROME_AI_AVAILABILITY.DOWNLOADABLE) {
        return { id: ROUTE_IDS.CHROME_AI, tier: TIER.SETUP, label: 'Chrome built-in AI — one download', detail: 'No key needed. One-time model download of about 2 GB.', action: 'Download', enabled: true };
    }
    if (state === CHROME_AI_AVAILABILITY.DOWNLOADING) {
        return { id: ROUTE_IDS.CHROME_AI, tier: TIER.SETUP, label: 'Chrome built-in AI — downloading', detail: 'The model is still downloading.', action: 'View progress', enabled: true };
    }
    return { id: ROUTE_IDS.CHROME_AI, tier: TIER.UNAVAILABLE, label: 'Chrome built-in AI', detail: reason || 'Not available in this browser.', action: '', enabled: false };
}

export function rankKeylessRoutes({
    chromeAI = CHROME_AI_AVAILABILITY.UNAVAILABLE,
    chromeAIReason = '',
    ollama = OLLAMA_VERDICT.NOT_RUNNING,
    hasKey = false,
    mcpPublished = false,
} = {}) {
    const rows = [
        ollamaRow(ollama),
        chromeAIRow(chromeAI, chromeAIReason),
        {
            id: ROUTE_IDS.API_KEY,
            tier: hasKey ? TIER.READY : TIER.SETUP,
            label: hasKey ? 'Your API key — configured' : 'Bring your own API key',
            detail: 'Full power: multi-pass review across large diffs.',
            action: hasKey ? 'Use it' : 'Add key',
            enabled: true,
        },
    ];

    if (mcpPublished) {
        rows.push({
            id: ROUTE_IDS.MCP,
            tier: TIER.SETUP,
            label: 'Use from Claude or Codex',
            detail: 'Your Claude subscription does the reasoning; RepoSpector supplies repo context.',
            action: 'Copy config',
            enabled: true,
        });
    }

    // Stable sort by tier; within a tier, declaration order stands — which is
    // what puts a working Ollama above an available on-device model.
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => (TIER_RANK[a.row.tier] - TIER_RANK[b.row.tier]) || (a.index - b.index))
        .map(({ row }) => row);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest test/unit/keylessRoutes.test.js`
Expected: PASS, 8 tests

- [ ] **Step 5: Rewrite the welcome panel**

In `src/popup/App.jsx`, replace the "How to use" ordered list (lines ~421-440)
with the ranked routes. Probe on mount:

```jsx
    const [routes, setRoutes] = useState(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const [{ state, reason }, ollamaStatus] = await Promise.all([
                probeChromeAI(),
                llmService.checkOllamaStatus(),
            ]);
            if (cancelled) return;
            setRoutes(rankKeylessRoutes({
                chromeAI: state,
                chromeAIReason: reason,
                ollama: ollamaStatus.verdict,
                hasKey: hasExistingKey,
                // Flip to true when @repospector/mcp is published — see
                // docs/superpowers/specs/2026-09-08-repospector-mcp-server-design.md
                mcpPublished: false,
            }));
        })();
        return () => { cancelled = true; };
    }, [hasExistingKey]);
```

Render each row with its tier, label, detail and action button; disabled rows
render the detail as the explanation and no button. Keep the existing heading
and the two steps that follow (Index, Review) — only step 1 changes.

Check how `App.jsx` learns about an existing key before wiring `hasKey`:

Run: `grep -n "hasExistingKey\|apiKey\|hasKey" src/popup/App.jsx | head`

- [ ] **Step 6: Verify**

Run: `npx jest`
Expected: PASS

Run: `npm run build`
Expected: clean

- [ ] **Step 7: Manual verification** — none of this can be faked meaningfully

- Load the unpacked build in Chrome. With no key configured, the welcome panel
  must offer a usable route, never "add your API key" as the only step.
- Start Ollama **without** `OLLAMA_ORIGINS`. Test connection must say the server
  is refusing this extension and name `OLLAMA_ORIGINS` — not "not running".
- Restart Ollama **with** `OLLAMA_ORIGINS=chrome-extension://*`. Test connection
  must go green.
- Select a model that is not pulled. The verdict must be `model_missing` and
  list what is installed.
- On a machine where Nano is unavailable, the row must explain why and offer no
  button.

- [ ] **Step 8: Commit** — ask the user first

```bash
git add src/popup/utils/keylessRoutes.js src/popup/App.jsx test/unit/keylessRoutes.test.js
git commit -m "feat(onboarding): lead with the keyless routes ranked by time-to-first-result"
```

---

## Spec Coverage Check

| Spec section | Task |
| --- | --- |
| Item 1 — `chrome-ai` provider wiring | 1 (constant), 4 (method + dispatch) |
| Item 1 — four-state availability, download progress | 3 (probe), 7 (panel) |
| Item 1 — streaming adapter, per-call sessions | 4 |
| Item 2 — `providerCapabilities`, runtime quota | 1 |
| Item 2 — task gating with live-quota reason | 2 |
| Item 2 — enforcement at the call site | 3 (`assertFitsQuota`), 4 (call site) |
| Item 3 — corrected instructions, three platforms | 7 |
| Item 3 — `qwen2.5-coder` default | 7 |
| Item 3 — four probe verdicts | 5 |
| Item 4 — ranked, probed onboarding | 8 |
| Item 4 — `keylessRoutes.js` extracted and pure | 8 |
| Item 5 — `Settings.jsx` split | 6 |

## Deferred, with reason

- **Wiring the gate into every task call site.** Tasks 2-4 build the gate,
  enforce it in `callChromeAI`, and make it available to the UI. Threading a
  `task` option through every caller (`LabelGeneratorService`,
  `DocstringService`, `MultiPassReviewEngine`, chat) is a separate mechanical
  pass across ~15 sites and does not belong inside a task that must stay
  reviewable. Until it lands, an ungated caller is still refused by
  `assertFitsQuota` — it just reports the overage without naming the task.
- **Bedrock's `apiKey` requirement** (`Settings.jsx:509`) looks like a
  pre-existing bug. Task 1 preserves it deliberately. Worth a separate look.
