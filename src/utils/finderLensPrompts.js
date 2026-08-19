/**
 * Multi-finder diversity lenses.
 *
 * Recall is bounded when a single reviewer pass has to hold every failure mode in
 * mind at once. This runs several INDEPENDENT specialist finders, each blind to the
 * others and focused on one class of defect, then keeps only what the baseline pass
 * missed. Diversity of lens beats one generalist for recall; the verification pass
 * downstream then culls any false positives the extra finders introduce.
 *
 * Each lens runs on the user's own BYOK model.
 */

export const FINDER_LENSES = [
    {
        key: 'security',
        title: 'Security specialist',
        instruction: `Hunt ONLY security defects introduced by this diff:
- Injection into sinks with no escape mechanism (SQL/NoSQL/OS/LDAP, LogQL-style raw strings, template engines). Try to construct the breakout input.
- SSRF: host/URL validation that accepts private/link-local/internal targets, or validates the literal host but chases redirects — guard the RESOLVED target.
- AuthN/AuthZ gaps on new paths; privilege/role assumptions; public ACLs on user data (obscure key ≠ access control).
- Secrets/credentials in code or logs; PII in logs.
- Unsafe deserialization; over-aggressive decoding that re-introduces a sink (html.unescape, etc.).
Attach a CWE where you can.`
    },
    {
        key: 'concurrency-correctness',
        title: 'Concurrency & correctness specialist',
        instruction: `Hunt ONLY correctness/concurrency defects introduced by this diff:
- Race conditions, TOCTOU, unsynchronised shared state, await/ordering bugs.
- Resource/connection lifecycle: a response/client/file/lock not closed on EVERY path including retry/fallback (continue/reassign); client rebuilt per retry attempt.
- Error handling: swallowed errors, wrong log level, non-200 (404) recorded as a health/circuit-breaker failure, missing fail-fast.
- Off-by-one, null/undefined, wrong comparison operators, edge cases (empty/zero/boundary).

For every finding, name the CONCRETE input or interleaving that breaks it — the value,
the ordering, the sequence of calls. "Callers may pass nil" is not a finding;
"line 42 dereferences cfg, which line 38 sets to nil when the flag is off" is.
If you cannot state the trigger from what this diff shows, do not report it.`
    },
    {
        key: 'intent-implementation',
        title: 'Intent-versus-implementation specialist',
        /**
         * The gap no other lens covers.
         *
         * Every lens here hunts a CATEGORY of defect — injection, a race, an N+1.
         * None asks the question a human reviewer asks first: does this code do
         * what it says it does? Measured against 135 real reviewer threads this
         * reviewer matched 23%, and the misses are dominated by exactly that — a
         * function whose name promises one thing and whose body does another, a
         * guard that does not guard what its comment claims.
         *
         * The evidence is unusually good here, which is why this lens can demand
         * it: the diff carries BOTH the claim (name, docstring, comment, test
         * title, PR description) and the implementation. A mismatch between them
         * is checkable from the hunk rather than guessed at — which is what
         * separates this from the speculation that dominates the false positives.
         */
        instruction: `Hunt ONLY places where the code does not do what it CLAIMS to do.
The claim and the implementation are both in this diff, so every finding must quote both.

- A function/method whose NAME promises behaviour its body does not deliver
  (validateX that validates nothing on some path, getOrCreate that never creates,
  isEmpty that returns true for a one-element input).
- A comment or docstring that contradicts the code beneath it — including a comment
  the diff LEFT UNCHANGED while changing the code it describes.
- A guard, early return or validation that does not cover the case its condition or
  comment says it covers (checks the wrong variable, wrong bound, wrong branch).
- A test whose title states one guarantee while its assertions verify a weaker or
  different one; a test that would still pass with the feature deleted.
- The PR description or linked issue states an intent this diff does not implement,
  or implements on only one of several paths that need it.
- A new parameter, option or config key that is accepted and then never read.
- An error path that reports success, or a status/return value inconsistent with what
  actually happened.

Hard rules for this lens:
- Quote the CLAIM (the name, comment, docstring, test title or description line) AND
  the contradicting code line. A finding without both is not reportable.
- "Could be clearer" is not a mismatch. Report only where the stated purpose and the
  actual behaviour genuinely differ.`
    },
    {
        key: 'api-contract',
        title: 'API-contract & behavior-change specialist',
        instruction: `Hunt ONLY interface/behavior-change defects introduced by this diff:
- A changed function signature/return type whose callers (in or out of the diff) were not updated.
- Behavior scope changes: a filter widened/narrowed, a constant/list swapped for a different-scope value, a default changed, an AND that became an OR.
- Falsy-default traps: \`x or default\`/\`x || default\` where only absence should default (replaces "", 0, false).
- Over-broad gates: an \`if x:\` guard that also drops an unrelated sibling assignment.
- Config constants changed by a large factor (TTL/timeout/retry/concurrency) without justification.

Name the caller, the field or the input that breaks. A contract finding that cannot
point at what consumes the contract is speculation.`
    },
    {
        key: 'performance-resource',
        title: 'Performance specialist',
        instruction: `Hunt ONLY performance defects introduced by this diff:
- O(n^2)+ where O(n) is possible; nested loops over the same data; repeated expensive work.
- N+1 queries; unbounded result sets; missing indexes for new queries.
- Blocking I/O in async contexts; missing memoization; duplicate network calls.
- Memory: leaks (uncleared timers/listeners), large allocations in hot paths/loops.`
    },
    {
        key: 'systemic',
        title: 'Distributed-systems & operational-semantics specialist',
        instruction: `Hunt ONLY systemic defects — the failure modes that live in how this
change behaves in a running system, not in how the lines read. These are invisible
inside a single hunk, so reason about the WHOLE change and the code it calls into:
- Idempotency: if this handler/consumer/callback re-runs after a partial failure,
  what gets done twice? Duplicate writes, double-publishes, re-charged operations,
  re-sent notifications.
- Retry semantics: is the retry classifier too broad (a base exception class that
  also captures fatal/serialization errors) or too narrow? Is there a bounded
  retry budget, a DLQ, and a poison-message escape? Do retries multiply a long
  inner wait past a consumer's max-poll/visibility timeout?
- Lock & lease correctness: TTL vs acquisition timeout ordering, lock held across
  a network call, release on every path, behaviour when the lock store is down.
- Ordering & delivery: at-least-once assumptions, out-of-order events, consumer
  rebalance, offset commit before vs after side effects.
- Partial failure: which side effects have already happened when step N throws,
  and is the system left in a recoverable state?
- Cross-service contract: a field/enum/schema this change emits or consumes that a
  downstream service must be updated for; migration ordering.
- Resource budgets: a per-message cost (sleep, sync call, large fetch) multiplied
  by concurrency or retry count.
State the concrete sequence of events that produces the failure. If you cannot
describe the sequence, do not report it.`
    },
    {
        key: 'test-quality',
        title: 'Adversarial test reader',
        instruction: `Hunt ONLY test-quality defects in test files changed by this diff:
- A test that CANNOT fail: identical mocks/inputs so an \`a or b\`/fallback branch is never distinguished; an assertion that passes on an early-return/error path without reaching the target line.
- An autouse fixture or global patch (e.g. patching sleep) that no-ops the behaviour under test.
- Missing assertion on a key side effect; a hardcoded literal duplicating a production constant instead of importing it.
Only emit findings when test files are present in the diff.`,
        // Gate moved here from MultiFinderService, which hardcoded this one
        // lens's file test in the runner. With `appliesTo` there is one gating
        // mechanism for every lens instead of a special case per lens.
        appliesTo: (files) => files.some(f => /(\.test\.|\.spec\.|_test\.|test_|\/tests?\/)/i.test(f.filename || '')),
    },
    {
        key: 'reuse-duplication',
        title: 'Codebase-reuse specialist',
        /**
         * The only lens that requires retrieved context to run at all — see
         * `requiresReuseContext` below and ReviewReuseContextService.
         *
         * Every other reviewer in the market answers this question by guessing,
         * because a diff does not contain the codebase. A wrong duplication
         * claim is uniquely expensive: the author knows their own repo, so being
         * told they reimplemented something they did not costs the reviewer its
         * credibility for every other finding. Hence the hard rule below that
         * the lens may only cite what it was given.
         */
        instruction: `Hunt ONLY reinvention: code this diff ADDS that duplicates behaviour the repository already has.

You have been given retrieved candidates — existing code the repository index found
similar to declarations this PR adds. Work ONLY from those candidates:
- A new function/class/helper that reimplements an existing one. Say what the existing
  one is by PATH and NAME, and what the new code does that it already does.
- A new utility that duplicates a shared helper (formatting, validation, parsing,
  retry/backoff, date handling, error wrapping) already present elsewhere.
- A locally redefined constant, enum, regex, or config value that already exists as a
  shared definition — divergence here is a real bug, not a style point.
- A hand-rolled implementation of something the repo already depends on a library for.

Hard rules for this lens:
- NEVER claim duplication you cannot point at. Cite the exact path from the retrieved
  candidates. No candidate for a claim means no finding.
- Similar SHAPE is not duplication. Two functions taking (id, options) are not
  duplicates. The BEHAVIOUR must overlap enough that one could call the other.
- A deliberate fork can be correct: a copy that diverges for a stated reason, a
  version pinned for compatibility, generated code. If the diff explains itself,
  do not flag it.
- Do not flag a modified existing function as a duplicate of itself.
Severity: usually medium. Use high only when the duplicate will DRIFT — two copies of
a validation rule or a constant that must agree, where updating one and not the other
is a future bug. Set \`type\` to "style" unless divergence causes a defect, then "bug".`,
        requiresReuseContext: true,
    },
    {
        key: 'accessibility',
        title: 'Accessibility & internationalisation specialist',
        /**
         * Gated to files that render UI (`appliesTo`). Running it on a backend
         * PR spends a model call to be told there is no markup, and worse,
         * invites the model to manufacture an a11y finding from a Go handler
         * because it was asked for one.
         */
        instruction: `Hunt ONLY accessibility and internationalisation defects introduced by this diff:
- Interactive behaviour on a non-interactive element: onClick on a div/span with no
  role, tabindex, or key handler — unreachable by keyboard.
- A control with no accessible name: icon-only button, unlabelled input, image with
  no alt, form field with no associated label.
- Focus management: a modal/dialog/menu that does not trap or restore focus, focus
  outlines removed with no replacement, a focus order the DOM order contradicts.
- State conveyed to sighted users only: colour as the sole signal, an error shown
  visually with no aria-invalid / aria-describedby / live region.
- Hardcoded user-facing strings in a codebase that uses a translation function, and
  concatenated sentence fragments that cannot be translated correctly.
- Layout assumptions that break on text scaling or RTL: fixed pixel heights on text
  containers, hardcoded left/right where logical properties are used elsewhere.
Only report what the diff introduces. Follow the file's existing conventions: if this
codebase has no i18n layer, a literal string is not a finding.`,
        appliesTo: (files) => files.some(f => /\.(jsx?|tsx?|vue|svelte|html?|hbs|erb|astro)$/i.test(f.filename || '')),
    },
];

/**
 * Lenses active for this PR.
 *
 * Gating is per-lens rather than hardcoded here so adding a lens does not mean
 * editing the runner. Two independent gates:
 *
 *   `appliesTo(files)`      — does the diff contain the kind of file this lens
 *                             reads? A backend PR should not pay for an a11y
 *                             pass, and asking for one invites an invented
 *                             finding rather than an honest empty result.
 *   `requiresReuseContext`  — the reuse lens is meaningless without retrieved
 *                             candidates; without them it can only speculate,
 *                             which is exactly what it exists not to do.
 *
 * @param {Array} lenses
 * @param {Object} ctx
 * @param {Array} ctx.files - prData.files
 * @param {boolean} [ctx.hasReuseContext=false]
 * @returns {Array} the lenses that should run
 */
export function activeLenses(lenses, { files = [], hasReuseContext = false } = {}) {
    return (lenses || []).filter((lens) => {
        if (lens.requiresReuseContext && !hasReuseContext) return false;
        if (typeof lens.appliesTo === 'function' && !lens.appliesTo(files)) return false;
        return true;
    });
}

/**
 * Build a finder prompt for one lens.
 * @param {Object} lens - one FINDER_LENSES entry
 * @param {Object} ctx - { prTitle, diffText, existingTitles: string[], graphContext }
 * @returns {{ system: string, user: string }}
 */
/**
 * Rule blocks for the two finder modes.
 *
 * `default` optimises for precision. Measured on 50 real MRs it produced 42
 * findings across 26,680 lines of changed code and matched 0 of 66 issues human
 * reviewers raised. Two of its rules are the likely cause:
 *
 *   "would this exist if the PR were reverted? — if yes, skip it"
 *      The highest-value review comments on those MRs were about idempotency,
 *      retry classification and lock ordering: code that PARTLY pre-exists but
 *      that the change now depends on. The revert test discards exactly this
 *      class, and it contradicts the "or worsened" clause in the same sentence.
 *
 *   "returning an empty array is a valid, honest answer — do not pad"
 *      A finder that is rewarded for silence will be silent. Precision is the
 *      VERIFIER's job; this stage should maximise recall and let adversarial
 *      verification cull. Running both stages precision-biased means there is
 *      nothing to verify.
 *
 * `recall` rebalances this. Kept as an explicit mode so the effect is measured
 * rather than assumed.
 */
const RULES = {
    default: `Rules:
- Diff-anchored: only flag issues caused or worsened by the "+" lines. Ask "would this exist if the PR were reverted?" — if yes, skip it.
- Do NOT repeat issues already found (listed below). Only report ADDITIONAL, genuinely new issues in your lens.
- If you find nothing new in your lens, return an empty findings array. That is a valid, honest answer — do not pad.
- Respond with ONLY a JSON object, no markdown fences, no prose.`,

    recall: `Rules:
- Change-anchored, NOT line-anchored. Flag an issue when this change introduces it,
  makes it materially more likely, makes recovery harder, or newly DEPENDS on
  pre-existing code that is unsafe for the way it is now used. Pre-existing code
  the diff now relies on IS in scope — say so explicitly when that is the case.
- Every finding must carry a concrete failure path: the input, sequence of events,
  or state that produces the bad outcome. A finding you cannot ground that way is
  not a finding — drop it.
- Do NOT repeat issues already found (listed below). Report ADDITIONAL issues only.
- Your job at this stage is RECALL. A separate adversarial verification stage will
  remove anything you cannot substantiate, so report every candidate you can ground
  in a failure path — do not self-censor a real concern because you are unsure it
  will survive. Do NOT invent issues to fill space: a grounded finding or nothing.
- Prefer the specific over the generic. "Error swallowed here, so a failed upload
  reports success to the caller" beats "improve error handling".
- Respond with ONLY a JSON object, no markdown fences, no prose.`,
};

export function buildLensFinderPrompt(lens, ctx = {}) {
    const {
        prTitle = 'Unknown',
        diffText = '',
        existingTitles = [],
        graphContext = '',
        reuseContext = '',
        mode = 'default',
    } = ctx;

    const system = `You are a ${lens.title} on RepoSpector's review panel. You are ONE of several independent specialists — stay strictly in your lane and find what a generalist reviewer would miss.

${lens.instruction}

${RULES[mode] || RULES.default}`;

    // Section order is load-bearing for prompt caching, not just readability.
    // Everything a second round re-sends unchanged — PR title, graph context,
    // the diff — comes FIRST, and the only part that grows between rounds
    // (`existingTitles`) comes after it.
    //
    // This used to be the other way round, with the already-reported list above
    // the diff. Because caching is a prefix match, round 2 diverged from round 1
    // at the first new title and the diff below it — by far the largest block in
    // the prompt — was re-read at full price on every round and every lens.
    let stable = `## PR: ${prTitle}\n\n`;
    if (graphContext && String(graphContext).trim()) {
        stable += `## Cross-file context (code graph)\n${String(graphContext).slice(0, 1500)}\n\n`;
    }
    // Retrieved prior-art candidates for the reuse lens. Placed in the cached
    // prefix with the other stable context: it is identical across rounds, and
    // it is large enough that re-reading it every round would be the dominant
    // cost of running the lens at all.
    if (reuseContext && String(reuseContext).trim()) {
        stable += `${String(reuseContext).trim()}\n\n`;
    }
    stable += `## Diff under review\n\`\`\`diff\n${String(diffText).slice(0, 12000)}\n\`\`\`\n\n`;

    let user = `## Already-reported issues (do NOT repeat these)\n`;
    user += existingTitles.length
        ? existingTitles.slice(0, 40).map((t, i) => `${i + 1}. ${t}`).join('\n')
        : '(none yet)';
    user += `\n\n## Required output — JSON ONLY
{
  "findings": [
    {
      "file": "path", "line": 42,
      "severity": "critical | high | medium | low",
      "type": "security | bug | performance | style | deprecated | testing",
      "cwe": "CWE-ID or null",
      "title": "concise (<100 chars)",
      "description": "what is wrong on this line and why",
      "impact": "what breaks in production",
      "suggestion": "specific fix (replace X with Y)",
      "confidence": 0.0-1.0,
      "needsHumanReview": false,
      "expertise": "security | architecture | product | domain | operations | accessibility",
      "escalationReason": "set with needsHumanReview when the diff cannot settle the question and a human must decide"
    }
  ]
}`;

    // `user` is returned as two parts so the transport can place a cache
    // breakpoint at the end of the diff. Providers without a breakpoint format
    // receive the two joined, which is byte-for-byte the single string this
    // used to return.
    return {
        system,
        user: [
            { text: stable, cache: true },
            { text: user },
        ],
    };
}

export default { FINDER_LENSES, buildLensFinderPrompt, activeLenses };
