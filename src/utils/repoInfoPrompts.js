/**
 * RepoInfo.md LLM Enrichment Prompts for RepoSpector
 *
 * Used to add AI-generated narrative sections (executive summary, architecture insights,
 * onboarding guide, code health) on top of the pattern-matched RepoInfo output.
 */

export const REPO_INFO_ENRICHMENT_SYSTEM_PROMPT = `You are a senior software architect reviewing a repository. Given extracted repository data, write insightful narrative sections for a RepoInfo document. Be concise, specific, and actionable — no filler or generic statements. Base every observation on the data provided.`;

/**
 * Build the prompt for LLM enrichment of RepoInfo.md
 * @param {string} repoId - Repository identifier (e.g., "owner/repo")
 * @param {string} extractedData - Condensed summary of pattern-matched repo data
 * @returns {string} Prompt for the LLM
 */
export function buildRepoInfoEnrichmentPrompt(repoId, extractedData) {
    return `Analyze this repository and generate enrichment sections in markdown.

## Repository: ${repoId}

### Extracted Data
${extractedData}

---

Generate the following sections in markdown. Use ## headings. Be specific to THIS repository — reference actual file paths, modules, and technologies from the data above.

## Executive Summary
Write 3-5 sentences describing what this repository does, its purpose, and its role. Infer from the tech stack, directory structure, API endpoints, and module names.

## Architecture Insights
- Identify the architectural style (monolith, microservice, modular monolith, event-driven, etc.)
- Note design patterns visible from the structure (MVC, service layer, repository pattern, etc.)
- Comment on coupling — which modules are tightly connected (hub files) vs isolated
- Keep to 4-6 bullet points

## Developer Onboarding Guide
Write a brief "start here" guide for a new developer joining this project:
- Which files/modules to read first
- Key entry points and their roles
- How the main data/request flow works (1-2 sentences)
- Keep to 5-7 bullet points

## Code Health Observations
- Test coverage assessment (based on test file count vs source file count)
- Dependency freshness signals (if version info is available)
- Complexity hotspots (files with many connections)
- Any notable gaps (missing tests for key modules, no CI config, etc.)
- Keep to 4-6 bullet points

Output ONLY the markdown sections above. Do NOT include any preamble or closing remarks.`;
}
