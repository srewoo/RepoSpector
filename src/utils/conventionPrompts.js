/**
 * Prompts for mining team review conventions from a repo's own MR comment history.
 *
 * The bar is deliberately high. A rule that ends up here is injected into every
 * subsequent review of the repo, so a hallucinated or one-off "convention" becomes
 * a recurring false positive on every future MR. Under-mining is cheap;
 * over-mining is expensive and self-reinforcing.
 */

export const CONVENTION_MINING_SYSTEM_PROMPT = `You extract a team's CODE REVIEW CONVENTIONS from their own past merge-request comments.

You are given real comments that reviewers left on merge requests in one repository.
Your job is to find the RECURRING, ACTIONABLE preferences a new engineer would need
to know — the things this team asks for that a generic best-practice list would not
tell you.

What qualifies as a convention:
- A naming, structural or API preference stated more than once, or stated once with
  clear generality ("correct at other places too", "we always...", "follow X here").
- A preference for a specific internal library, helper, component or token over an
  ad-hoc implementation ("use the date formatter from X", "use ErrorPage from DL").
- A repo-specific policy: error-response shape, logging style, config placement,
  test structure, route naming.

What does NOT qualify — exclude these:
- One-off feedback about a specific line with no general rule behind it.
- Generic advice any linter or public style guide already covers ("use const",
  "add a docstring") UNLESS the team states a specific variant of it.
- Questions ("why did we do X?"), discussion, or design debate with no resolution.
- Bug reports. Those are defects, not conventions.
- Anything you are inferring rather than reading. If the comments do not support a
  rule, do not invent one.

Rules you emit will be injected into EVERY future review of this repo. A wrong rule
becomes a recurring false positive. When uncertain, emit fewer rules.

Output ONLY a JSON object, no markdown fences, no prose:
{
  "rules": [
    {
      "rule": "imperative, checkable statement of the convention",
      "rationale": "why the team wants it, in their words where possible",
      "occurrences": <how many distinct comments support this>,
      "example": "a short quote from one supporting comment",
      "category": "naming | structure | library-usage | error-handling | logging | testing | api-design | config"
    }
  ]
}

If the comments contain no genuine recurring convention, return {"rules": []}.`;

/**
 * @param {string} repoId
 * @param {Array<{author?:string, body:string, file?:string}>} requests
 * @param {object} [opts] - { maxRules, maxComments, maxCharsPerComment }
 */
export function buildConventionMiningPrompt(repoId, requests = [], opts = {}) {
    const { maxRules = 12, maxComments = 120, maxCharsPerComment = 500 } = opts;

    const sample = requests.slice(0, maxComments).map((n, i) => {
        const where = n.file ? ` [${n.file}]` : '';
        const body = String(n.body || '').replace(/\s+/g, ' ').slice(0, maxCharsPerComment);
        return `${i + 1}.${where} ${body}`;
    });

    return `## Repository
${repoId}

## Reviewer comments from past merge requests (${sample.length} of ${requests.length})
${sample.join('\n')}

## Task
Extract at most ${maxRules} recurring review conventions for this repository.
Prefer rules supported by MULTIPLE comments. Report the real occurrence count —
do not inflate it. Return the JSON object described in the system prompt.`;
}

export default { CONVENTION_MINING_SYSTEM_PROMPT, buildConventionMiningPrompt };
