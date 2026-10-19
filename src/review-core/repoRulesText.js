/**
 * repoRulesText — the one meaning of ".repospector.yaml rules text" (M1).
 *
 * The rubric's quoted-rule cap checks a quote against this text, so every flow
 * (extension, MCP, eval) must render it the same way: the rule entries as
 * bullets, never the settings block — a quote of `minRubricScore: 60` is not
 * a rule. Pure: takes an already-parsed config.
 *
 * @param {{rules?: Array<string|{message?:string, description?:string, pattern?:string}>}|null} config
 * @returns {string} '' when there are no rules
 */
export function renderRepoRulesText(config) {
    const rules = Array.isArray(config?.rules) ? config.rules : [];
    return rules
        .map((r) => (typeof r === 'string' ? r : (r?.message || r?.description || r?.pattern)))
        .filter(Boolean)
        .map((t) => `- ${t}`)
        .join('\n');
}

export default { renderRepoRulesText };
