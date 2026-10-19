/**
 * `rulesCompliance` lens — does the diff violate a rule in the repository's own
 * rules files (CLAUDE.md, AGENTS.md, `.repospector.yaml` rules)? Every finding
 * must quote the rule verbatim; the rubric scorer later checks the quote
 * against the loaded files and caps unquoted rule claims.
 */
import { CONTEXT_STATUS, ctxNotRun } from '../context/contextPort.js';

export const rulesComplianceLens = Object.freeze({
    key: 'rulesCompliance',
    title: 'Repository-rules compliance specialist',
    needs: ['rules'],
    instruction: `Hunt ONLY violations of the repository's own rules files given below
(CLAUDE.md, AGENTS.md, .repospector.yaml rules).
- The diff does something a rule forbids, or omits something a rule requires, on
  lines this PR changed.
- A rule in a nested directory's file governs only files under that directory.

Hard rules for this lens:
- Every finding MUST carry a "quotedRule" field holding the rule text copied
  VERBATIM from a rules file, and a "rulesFile" field naming that file. A paraphrase
  is not a quote. A finding without "quotedRule" is discarded.
- A rule the code explicitly silences (an inline disable / ignore comment) is not
  violated.
- Do not apply general best practice that no rule states.
Set "type" to "style" unless breaking the rule causes a defect, then "bug".`,
    /** Findings that do not quote a rule are speculation about what a rule says. */
    accepts: (f) => typeof f?.quotedRule === 'string' && f.quotedRule.trim().length > 0,
});

/**
 * @param {{rulesFiles: Array<{path:string, text:string}>}} args
 */
export async function resolveRules({ rulesFiles }) {
    const files = (rulesFiles || []).filter(f => f?.text && String(f.text).trim());
    if (!files.length) {
        return ctxNotRun('no rules files found (CLAUDE.md, AGENTS.md, .repospector.yaml rules)');
    }
    const text = files.map(f => `### ${f.path}\n${String(f.text).trim()}`).join('\n\n');
    return { status: CONTEXT_STATUS.OK, text };
}
