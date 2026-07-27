/**
 * Adversarial finding-verification prompts.
 *
 * Second pass over generated findings whose ONLY goal is to cut false positives
 * without dropping true positives. The verifier is told to actively try to REFUTE
 * each finding against the actual diff, and to keep it only if it survives.
 *
 * Runs on the user's own BYOK model (same provider/key as review) — nothing leaves
 * the machine beyond the review call the user already opted into.
 */

export const VERIFICATION_SYSTEM_PROMPT = `You are RepoSpector's finding VERIFIER. You are NOT the reviewer — you are the skeptic who decides which findings are real enough to show the author.

Your job: for each candidate finding, try HARD to REFUTE it against the actual diff. A finding should only survive if it is genuinely caused or worsened by THIS diff and would matter in production.

FIRST, for every finding, answer the PREMISE question before anything else:
does the code actually do what the finding says it does, at the place it says?
Findings are frequently confident about code that is not there, or misdescribe a
construct that is. Verified failures of exactly this kind, all of which a careful
reader would catch in seconds:
  - "ast.literal_eval can execute arbitrary code" — it cannot; it parses literals only.
  - "run_in_executor blocks the event loop" — it is the non-blocking idiom.
  - "int(os.getenv('X', 300)) has no default" — the default is right there.
  - "deprecated makeSuite" on a diff whose only makeSuite lines are DELETIONS.
  - a Kafka bootstrap host from an operator-set env var called "SSRF".
If the premise is false, the finding is refuted no matter how plausible it sounds.
Judge the LANGUAGE SEMANTICS as they actually are, not as the finding asserts.

Refute (set keep=false) when ANY of these is true:
- The premise is factually wrong about what the named API/construct does.
- The finding restates a change the MR intentionally makes (its own title/description
  describes it), or flags code the diff DELETES.
- The issue is NOT on a changed ("+") line and is not directly broken by an adjacent "+" change (pre-existing / out-of-diff → not this PR's problem).
- The cited line does not actually contain the described construct (hallucinated location).
- The "bug" only triggers on a code path or caller combination that cannot occur.
- It is a pure style/formatting/line-length/naming nit dressed up as a defect.
- It asserts a project rule (line length, a required suppression) that the diff does not evidence.
- It duplicates another finding on the same line.
- You cannot construct a concrete input/state that makes it fail (for a claimed bug/security issue).

Keep (set keep=true) only findings you can defend with a concrete trigger or a clear, in-diff mechanism.

Calibrate severity honestly — downgrade an over-rated finding rather than dropping it if it is real but minor. Never invent NEW findings here.

Respond with ONLY a JSON object, no markdown fences, no prose.`;

/**
 * Build a verification prompt for a batch of findings.
 * @param {Array<Object>} batch - findings [{ vid, file, line, severity, type, title, description, suggestion, codeSnippet }]
 * @param {Object} ctx - { prTitle, diffsByFile: { [file]: patchString } }
 * @returns {string}
 */
export function buildVerificationPrompt(batch, ctx = {}) {
    const { prTitle = 'Unknown', diffsByFile = {} } = ctx;

    // Only include diffs for the files referenced by this batch (keeps tokens low).
    const referenced = [...new Set(batch.map(f => f.file).filter(Boolean))];
    let diffSection = '';
    for (const file of referenced) {
        const patch = diffsByFile[file];
        if (patch) {
            diffSection += `### ${file}\n\`\`\`diff\n${String(patch).slice(0, 6000)}\n\`\`\`\n\n`;
        }
    }
    if (!diffSection) diffSection = '(No diff text available for the referenced files — verify from the finding description alone and be MORE skeptical.)\n';

    const candidates = batch.map(f => ({
        vid: f.vid,
        file: f.file,
        line: f.line,
        // The exact source at the cited line, resolved from the diff. Without this
        // the verifier has to locate the line inside a raw patch by eye, which it
        // does unreliably — the single biggest reason hallucinated locations
        // survived verification.
        codeAtCitedLine: f._evidence?.citedLine ?? null,
        premiseCheck: f._evidence?.verdict ?? 'unproven',
        severity: f.severity,
        type: f.type,
        title: f.title || (f.message ? String(f.message).slice(0, 120) : ''),
        description: f.description || f.message || '',
        suggestion: f.suggestion || ''
    }));

    return `## PR: ${prTitle}

## Diffs under review
${diffSection}

## Candidate findings to verify
Each carries \`codeAtCitedLine\` (the ACTUAL source at the line it cites, or null
if that line is not in the diff) and \`premiseCheck\` from a deterministic pre-pass.
A premiseCheck of "unproven" means the pre-pass could not confirm the finding names
anything real — treat those with extra suspicion.
\`\`\`json
${JSON.stringify(candidates, null, 1)}
\`\`\`

For EACH candidate above, decide whether it survives adversarial verification.

## Required output — JSON ONLY
{
  "verdicts": [
    {
      "vid": "<same vid as input>",
      "keep": true | false,
      "confidence": 0.0-1.0,        // how sure you are of the keep/drop decision
      "correctedSeverity": "critical | high | medium | low",  // your calibrated severity (only meaningful if keep=true)
      "reason": "one concise sentence: the concrete trigger that keeps it, or why it is refuted"
    }
  ]
}
Return exactly one verdict per candidate vid.`;
}

export default { VERIFICATION_SYSTEM_PROMPT, buildVerificationPrompt };
