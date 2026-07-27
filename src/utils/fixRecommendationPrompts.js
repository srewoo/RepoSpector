/**
 * Fix-recommendation prompts.
 *
 * Produces a concrete, minimal, copy-pasteable fix suggestion for each finding —
 * a RECOMMENDATION only. RepoSpector never applies these automatically; the point
 * is to give the author a ready patch (GitHub "suggestion"-style) plus the reasoning
 * and an honest applicability flag, so acting on a finding is one paste, not a task.
 *
 * Runs on the user's own BYOK model. Nothing is written or pushed anywhere.
 */

export const FIX_RECOMMENDATION_SYSTEM_PROMPT = `You are RepoSpector's fix author. For each verified finding you produce the smallest correct code change that resolves it — a recommendation the human author can accept or reject.

Rules:
- Change ONLY what the finding requires. No drive-by refactors, no reformatting untouched lines.
- Preserve surrounding style, indentation, naming, and language idioms exactly.
- Prefer the standard/idiomatic remedy for the language (e.g. parameterized query, timezone-aware datetime, ?? for nullish default, defer/close on the resource).
- The "replacement" must be valid code that can drop in for the "original" lines.
- Be honest about applicability: "safe" only when the fix is mechanical and self-contained; "review-needed" when it changes behavior, needs a new import, or depends on context you cannot see.
- If you cannot produce a responsible fix for a finding, return it with "replacement": null and explain why in "explanation".

Respond with ONLY a JSON object. No markdown fences, no prose outside the JSON.`;

/**
 * Build a fix prompt for a batch of findings that all belong to one file.
 * @param {string} file
 * @param {string} patch - unified diff for the file
 * @param {Array<Object>} findings - [{ fid, line, severity, type, title, description, suggestion }]
 * @param {string} [fullContent] - optional full file content for better context
 * @returns {string}
 */
export function buildFixRecommendationPrompt(file, patch, findings, fullContent = '') {
    const items = findings.map(f => ({
        fid: f.fid,
        line: f.line,
        severity: f.severity,
        type: f.type,
        title: f.title || (f.message ? String(f.message).slice(0, 120) : ''),
        description: f.description || f.message || '',
        reviewerSuggestion: f.suggestion || ''
    }));

    let ctx = `## File: ${file}\n\n\`\`\`diff\n${String(patch || '(no patch)').slice(0, 7000)}\n\`\`\`\n`;
    if (fullContent) {
        ctx += `\n<details full-file-context>\n\`\`\`\n${String(fullContent).slice(0, 4000)}\n\`\`\`\n`;
    }

    return `${ctx}
## Findings needing a fix
\`\`\`json
${JSON.stringify(items, null, 1)}
\`\`\`

Produce one fix recommendation per fid.

## Required output — JSON ONLY
{
  "fixes": [
    {
      "fid": "<same fid>",
      "original": "the exact current code lines to be replaced (verbatim from the diff), or null if adding new code",
      "replacement": "the corrected code to use instead, or null if no responsible fix is possible",
      "explanation": "one sentence: why this resolves the finding",
      "applicability": "safe | review-needed",
      "confidence": 0.0-1.0
    }
  ]
}
Return exactly one fix per fid.`;
}

export default { FIX_RECOMMENDATION_SYSTEM_PROMPT, buildFixRecommendationPrompt };
