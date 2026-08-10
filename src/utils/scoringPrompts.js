/**
 * Self-reflection scoring prompts.
 *
 * Distinct from verification, and the distinction is the point:
 *
 *   VERIFICATION asks "is this REAL?" — a binary refutation against the diff.
 *   REFLECTION asks "is this WORTH SAYING?" — how much a reviewer benefits from
 *   reading it, on a 1-10 scale.
 *
 * A finding can be entirely real and still not worth a notification. Severity
 * alone cannot express that: the model assigns severity while writing the
 * finding, in isolation, with every incentive to inflate. Scoring happens after
 * the fact, over the whole set at once, where "this one matters more than those
 * four" is a judgement the model can actually make.
 *
 * The score is used to ORDER what gets posted and, optionally, to gate it. Both
 * beat the severity-only partition, which treats every `high` as equal and then
 * truncates arbitrarily at the inline cap.
 *
 * Runs on the user's own BYOK model.
 */

export const SCORING_SYSTEM_PROMPT = `You are RepoSpector's finding SCORER. The findings below have already been checked for correctness by a separate pass. Your job is NOT to re-verify them — it is to judge how much each one is WORTH SAYING to the author.

Score each finding 1-10 on the value a competent reviewer would get from reading it:

  10  Critical defect. Data loss, security breach, or a crash that reaches production.
  9   Severe bug on a path that will be exercised. Author would thank you.
  7-8 Real defect producing wrong behaviour, or a genuine security weakness.
      Deprecated API with a known replacement and a real consequence.
  5-6 Legitimate improvement: a missing edge case, a resource not released, an
      error path that swallows context. Worth fixing, not worth blocking.
  3-4 Minor. Naming, a clearer idiom, a defensive check that is probably fine.
  1-2 Noise. Restates what the code says, asserts a preference as a rule, or is
      so generic it would apply to any file in any repository.

Calibration rules — apply these strictly, they are where scores usually go wrong:
- A finding that names a CONCRETE failure path (this input → this bad outcome)
  outranks one that gestures at a category of risk. "exec() with req.query.cmd
  is command injection" beats "consider validating user input".
- Generic advice that would apply unchanged to any codebase scores 1-3, however
  confidently it is written and whatever severity it claims.
- Do not reward length or vocabulary. A one-line finding naming the exact bug
  outranks three paragraphs of hedging.
- Judge each finding on its own merits, but use the full range. If every finding
  in a set scores 8, you have not scored them — you have re-stated their
  severities. A typical set spans at least four points.
- Test coverage gaps are legitimate but rarely urgent: 4-6 unless the untested
  path is the one the diff broke.

Respond with ONLY a JSON object, no markdown fences, no prose.`;

/**
 * Build the scoring prompt for a batch of findings.
 *
 * Deliberately does NOT include the diff. Correctness was settled upstream, and
 * withholding the diff keeps this pass cheap and stops it drifting back into
 * re-verification — which is a different question it would answer worse, having
 * been told not to.
 *
 * @param {Array<Object>} batch - findings tagged with `sid`
 * @param {Object} ctx - { prTitle }
 * @returns {string}
 */
export function buildScoringPrompt(batch, ctx = {}) {
    const { prTitle = 'Unknown' } = ctx;

    const candidates = batch.map(f => ({
        sid: f.sid,
        file: f.file,
        line: f.line,
        claimedSeverity: f.severity,
        type: f.type ?? f.category ?? null,
        title: f.title || String(f.message ?? '').slice(0, 120),
        description: String(f.description ?? f.message ?? '').slice(0, 500),
        suggestion: String(f.suggestion ?? '').slice(0, 300),
    }));

    return `## PR: ${prTitle}

## Findings to score
\`claimedSeverity\` is what the finding asserted about itself. Treat it as a
claim to assess, not as an input to copy — inflated severity is common.

\`\`\`json
${JSON.stringify(candidates, null, 1)}
\`\`\`

## Required output — JSON ONLY
{
  "scores": [
    {
      "sid": "<same sid as input>",
      "score": 1-10,
      "reason": "one short clause: what makes it worth (or not worth) the author's attention"
    }
  ]
}
Return exactly one entry per sid.`;
}

export default { SCORING_SYSTEM_PROMPT, buildScoringPrompt };
