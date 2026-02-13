/**
 * PR Summary Generation Prompts for RepoSpector
 */

export const PR_SUMMARY_SYSTEM_PROMPT = `You are a concise code change summarizer. Generate a human-readable PR summary that helps reviewers quickly understand what changed and why. Be direct and specific.`;

/**
 * Build prompt for AI-generated PR summary
 */
export function buildPRSummaryGenerationPrompt(prData, staticSummary, options = {}) {
    const fileCategories = categorizeFiles(prData.files || []);
    const commitMessages = (prData.commits || []).map(c => c.message).join('\n- ');

    let prompt = `## Pull Request: ${prData.title || 'Untitled'}

**Author**: ${prData.author?.login || 'Unknown'}
**Branch**: ${prData.branches?.source || '?'} → ${prData.branches?.target || '?'}
**Stats**: +${prData.stats?.additions || 0} / -${prData.stats?.deletions || 0} across ${prData.stats?.changedFiles || prData.files?.length || 0} files

### PR Description
${prData.description || 'No description provided.'}

### Commits
- ${commitMessages || 'No commit messages available.'}

### Files Changed by Category
`;

    for (const [category, files] of Object.entries(fileCategories)) {
        if (files.length > 0) {
            prompt += `\n**${category}** (${files.length} files):\n`;
            for (const f of files.slice(0, 10)) {
                prompt += `- ${f.filename} (+${f.additions || 0}/-${f.deletions || 0})\n`;
            }
            if (files.length > 10) {
                prompt += `- ...and ${files.length - 10} more\n`;
            }
        }
    }

    if (staticSummary) {
        prompt += `\n### Static Analysis Summary
- Critical: ${staticSummary.bySeverity?.critical || 0}
- High: ${staticSummary.bySeverity?.high || 0}
- Medium: ${staticSummary.bySeverity?.medium || 0}
- Low/Info: ${(staticSummary.bySeverity?.low || 0) + (staticSummary.bySeverity?.info || 0)}
`;
    }

    prompt += `
### Instructions
Generate a summary with these sections in markdown:

## What Changed
A 2-3 sentence narrative of the key changes.

## Why
Infer the purpose from commits and description.

## Risk Areas
List 2-4 areas that reviewers should focus on, with file references.

## Key Stats
- Files by category (features, tests, config, etc.)
- Lines added/removed
- Risk level (Low/Medium/High based on change scope and static analysis)

Keep the entire summary under 300 words.`;

    return prompt;
}

export const PR_DESCRIPTION_SYSTEM_PROMPT = `You are an expert at writing clear, professional PR descriptions. Generate a well-structured PR description in GitHub/GitLab markdown that helps reviewers understand the change.`;

/**
 * Build prompt for generating a PR description
 */
export function buildPRDescriptionPrompt(prData) {
    const commitMessages = (prData.commits || []).map(c => `- ${c.message}`).join('\n');
    const fileList = (prData.files || []).map(f =>
        `- ${f.filename} (${f.status}, +${f.additions || 0}/-${f.deletions || 0})`
    ).slice(0, 30).join('\n');

    return `Generate a professional PR description for:

**Title**: ${prData.title || 'Untitled'}
**Branch**: ${prData.branches?.source || '?'} → ${prData.branches?.target || '?'}
**Stats**: +${prData.stats?.additions || 0} / -${prData.stats?.deletions || 0} across ${prData.files?.length || 0} files

### Commits
${commitMessages || 'No commits'}

### Files Changed
${fileList}

### Current Description
${prData.description || 'None'}

Generate a PR description with this structure:
## Summary
A brief 2-3 sentence overview of what this PR does and why.

## Changes
- Bulleted list of key changes grouped logically

## Testing
- How these changes were tested or should be tested

## Checklist
- [ ] Code follows project conventions
- [ ] Tests added/updated
- [ ] Documentation updated (if applicable)

Keep it concise but informative. Do NOT wrap the output in a code block.`;
}

export const CHANGELOG_SYSTEM_PROMPT = `You are a changelog writer. Generate a concise, user-facing changelog entry from PR/commit data. Use Keep a Changelog format.`;

/**
 * Build prompt for changelog generation
 */
export function buildChangelogPrompt(prData) {
    const commitMessages = (prData.commits || []).map(c => `- ${c.message}`).join('\n');

    return `Generate a changelog entry for:

**PR Title**: ${prData.title || 'Untitled'}
**Description**: ${prData.description || 'None'}
**Stats**: +${prData.stats?.additions || 0} / -${prData.stats?.deletions || 0} across ${prData.files?.length || 0} files

### Commits
${commitMessages || 'No commits'}

Generate a changelog entry using this format:
### [Category] - YYYY-MM-DD

#### Added
- New features added

#### Changed
- Changes in existing functionality

#### Fixed
- Bug fixes

#### Security
- Security improvements

Only include relevant sections. Be concise and user-facing (not developer-internal). Use today's date.`;
}

export const MERMAID_SYSTEM_PROMPT = `You are a diagram expert. Generate a Mermaid diagram that visualizes the architecture or flow of changes in a PR. Output ONLY valid Mermaid syntax, no markdown code fences.`;

/**
 * Build prompt for Mermaid diagram generation
 */
export function buildMermaidPrompt(prData) {
    const files = (prData.files || []).map(f => f.filename).slice(0, 30).join('\n- ');

    return `Generate a Mermaid flowchart or graph diagram showing the key architectural changes in this PR:

**Title**: ${prData.title || 'Untitled'}
**Files Changed**:
- ${files}

Rules:
- Use flowchart TD (top-down) or LR (left-right) syntax
- Group related files into subgraphs by directory/module
- Show relationships between changed components
- Highlight new files with a different style
- Keep it readable (max 20 nodes)
- Output ONLY the Mermaid code, starting with "flowchart" or "graph"
- Do NOT wrap in markdown code fences`;
}

/**
 * Categorize PR files by type
 */
export function categorizeFiles(files) {
    const categories = {
        'Features/Source': [],
        'Tests': [],
        'Configuration': [],
        'Documentation': [],
        'Styles': [],
        'Other': []
    };

    const testPatterns = /\.(test|spec|e2e|integration)\.[^.]+$|__tests__|test\//i;
    const configPatterns = /\.(json|ya?ml|toml|ini|cfg|conf|env|lock)$|config|\.rc$|Makefile|Dockerfile|\.github\//i;
    const docPatterns = /\.(md|txt|rst|adoc)$|README|CHANGELOG|LICENSE|docs\//i;
    const stylePatterns = /\.(css|scss|sass|less|styled)\.[^.]+$|\.(css|scss|sass|less)$/i;

    for (const file of files) {
        const name = file.filename || '';
        if (testPatterns.test(name)) {
            categories['Tests'].push(file);
        } else if (docPatterns.test(name)) {
            categories['Documentation'].push(file);
        } else if (configPatterns.test(name)) {
            categories['Configuration'].push(file);
        } else if (stylePatterns.test(name)) {
            categories['Styles'].push(file);
        } else if (/\.(js|jsx|ts|tsx|py|java|go|rb|rs|c|cpp|cs|php|swift|kt)$/i.test(name)) {
            categories['Features/Source'].push(file);
        } else {
            categories['Other'].push(file);
        }
    }

    // Remove empty categories
    for (const key of Object.keys(categories)) {
        if (categories[key].length === 0) delete categories[key];
    }

    return categories;
}
