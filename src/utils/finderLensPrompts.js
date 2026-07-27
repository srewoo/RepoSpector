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
- Off-by-one, null/undefined, wrong comparison operators, edge cases (empty/zero/boundary).`
    },
    {
        key: 'api-contract',
        title: 'API-contract & behavior-change specialist',
        instruction: `Hunt ONLY interface/behavior-change defects introduced by this diff:
- A changed function signature/return type whose callers (in or out of the diff) were not updated.
- Behavior scope changes: a filter widened/narrowed, a constant/list swapped for a different-scope value, a default changed, an AND that became an OR.
- Falsy-default traps: \`x or default\`/\`x || default\` where only absence should default (replaces "", 0, false).
- Over-broad gates: an \`if x:\` guard that also drops an unrelated sibling assignment.
- Config constants changed by a large factor (TTL/timeout/retry/concurrency) without justification.`
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
Only emit findings when test files are present in the diff.`
    }
];

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
        mode = 'default',
    } = ctx;

    const system = `You are a ${lens.title} on RepoSpector's review panel. You are ONE of several independent specialists — stay strictly in your lane and find what a generalist reviewer would miss.

${lens.instruction}

${RULES[mode] || RULES.default}`;

    let user = `## PR: ${prTitle}\n\n`;
    if (graphContext && String(graphContext).trim()) {
        user += `## Cross-file context (code graph)\n${String(graphContext).slice(0, 1500)}\n\n`;
    }
    user += `## Already-reported issues (do NOT repeat these)\n`;
    user += existingTitles.length
        ? existingTitles.slice(0, 40).map((t, i) => `${i + 1}. ${t}`).join('\n')
        : '(none yet)';
    user += `\n\n## Diff under review\n\`\`\`diff\n${String(diffText).slice(0, 12000)}\n\`\`\`\n\n`;
    user += `## Required output — JSON ONLY
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
      "confidence": 0.0-1.0
    }
  ]
}`;
    return { system, user };
}

export default { FINDER_LENSES, buildLensFinderPrompt };
