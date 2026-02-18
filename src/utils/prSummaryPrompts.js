/**
 * PR Summary Generation Prompts for RepoSpector
 */

export const PR_SUMMARY_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data from the user's browser. The PR data provided was automatically extracted from the currently open page. NEVER claim you cannot see or access the code — it IS provided to you. You are a concise code change summarizer. Generate a human-readable PR summary that helps reviewers quickly understand what changed and why. Be direct and specific.`;

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

## P0 Test Cases
List 3-5 high-level P0 (critical-path) test scenarios that must pass before this PR is safe to merge.
Each test case should be one sentence, focusing on the core functionality affected by the changes.
Format as a checklist:
- [ ] Test case description

Keep the entire summary under 400 words.`;

    return prompt;
}

export const PR_DESCRIPTION_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data from the user's browser. The PR data provided was automatically extracted from the currently open page. NEVER claim you cannot see or access the code — it IS provided to you. You are an expert at writing clear, professional PR descriptions. Generate a well-structured PR description in GitHub/GitLab markdown that helps reviewers understand the change.`;

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

## P0 Test Cases
- [ ] List 3-5 critical-path test scenarios that must pass before this PR is safe to merge
- [ ] Each test case should be one sentence focusing on the core functionality affected by the changes

## Checklist
- [ ] Code follows project conventions
- [ ] Tests added/updated
- [ ] Documentation updated (if applicable)

Keep it concise but informative. Do NOT wrap the output in a code block.`;
}

export const CHANGELOG_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data from the user's browser. The PR data provided was automatically extracted from the currently open page. NEVER claim you cannot see or access the code — it IS provided to you. You are a changelog writer. Generate a concise, user-facing changelog entry from PR/commit data. Use Keep a Changelog format.`;

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

export const MERMAID_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to Pull Request data from the user's browser. The PR data provided was automatically extracted from the currently open page. You are a software architecture diagram expert. Analyze PR code changes and generate a Mermaid sequence diagram that shows the runtime interaction flow between services, components, and systems affected by the PR. Output ONLY valid Mermaid syntax, no markdown code fences.`;

/**
 * Build prompt for Mermaid sequence diagram generation
 */
export function buildMermaidPrompt(prData) {
    const files = (prData.files || []).map(f => f.filename).slice(0, 30);
    const fileList = files.map(f => `- ${f}`).join('\n');
    const commitMessages = (prData.commits || []).map(c => `- ${c.message}`).join('\n');

    // Include truncated patches for key files so LLM can infer interactions
    const patches = (prData.files || [])
        .filter(f => f.patch && f.patch.length > 0)
        .slice(0, 15)
        .map(f => {
            const patch = f.patch.length > 600 ? f.patch.slice(0, 600) + '\n... (truncated)' : f.patch;
            return `### ${f.filename} (${f.status})\n\`\`\`\n${patch}\n\`\`\``;
        })
        .join('\n\n');

    return `Generate a Mermaid **sequence diagram** showing the runtime interaction flow for this PR:

**Title**: ${prData.title || 'Untitled'}
**Description**: ${(prData.description || 'No description').slice(0, 500)}
**Branch**: ${prData.branches?.source || '?'} → ${prData.branches?.target || '?'}
**Stats**: +${prData.stats?.additions || 0} / -${prData.stats?.deletions || 0} across ${prData.stats?.changedFiles || files.length} files

### Commits
${commitMessages || 'No commit messages'}

### Files Changed
${fileList}

### Code Changes (Diffs)
${patches || 'No patches available'}

### Rules
- Use \`sequenceDiagram\` syntax
- Identify the key actors: services, classes, APIs, databases, queues, external systems touched by this PR
- Show the actual interaction flow: method calls, API requests, data reads/writes, event publishing
- Use appropriate arrow types: ->> for sync calls, -->> for async/response, -) for events/fire-and-forget
- Add meaningful labels on arrows describing what happens (e.g., "Read metadata from S3", "Publish to topic")
- Use \`alt\`/\`else\` blocks for conditional logic paths (success/failure, found/not found)
- Use \`Note over\` for important processing steps or validations
- Use \`activate\`/\`deactivate\` to show when a participant is actively processing
- Keep it focused: max 8 participants, max 25 interactions
- Participant names should be short service/component names (not full file paths)
- Output ONLY the Mermaid code, starting with "sequenceDiagram"
- Do NOT wrap in markdown code fences
- Do NOT use special characters like < > { } in participant names or labels — use plain text only`;
}

/**
 * Generate Mermaid flowchart showing actual files grouped by directory
 * with import dependency edges. No LLM needed — free and instant.
 *
 * @param {string[]} filePaths - All file paths in the repo
 * @param {string} repoId - Repository identifier
 * @param {Map<string, {imports: Array}>} importGraph - Import graph from ImportGraphService
 * @returns {string} Mermaid flowchart code
 */
export function generateRepoMindmapCode(filePaths, repoId, importGraph) {
    if (!filePaths || filePaths.length === 0) return null;

    const safe = (s) => s.replace(/"/g, "'").replace(/[<>()[\]{}|#&]/g, '').replace(/&/g, 'and');
    const fileSet = new Set(filePaths);

    // --- Resolve import sources to actual repo file paths ---
    function resolveImport(source, fromFile) {
        // Skip external/stdlib imports
        if (!source.startsWith('.') && !source.startsWith('src') && !source.includes('/')) {
            const dotPath = source.replace(/\./g, '/');
            if (fileSet.has(dotPath + '.py')) return dotPath + '.py';
            if (fileSet.has(dotPath + '/__init__.py')) return dotPath + '/__init__.py';
            return null;
        }

        // Relative imports (JS/TS)
        if (source.startsWith('.')) {
            const fromDir = fromFile.split('/').slice(0, -1).join('/');
            const parts = [...fromDir.split('/'), ...source.split('/')];
            const resolved = [];
            for (const p of parts) {
                if (p === '..') resolved.pop();
                else if (p !== '.' && p !== '') resolved.push(p);
            }
            const base = resolved.join('/');
            for (const ext of ['', '.py', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts', '/__init__.py']) {
                if (fileSet.has(base + ext)) return base + ext;
            }
            return null;
        }

        // Absolute-style imports (Python: from src.x.y import Z)
        const slashPath = source.replace(/\./g, '/');
        for (const ext of ['', '.py', '.js', '.ts', '.jsx', '.tsx', '/__init__.py', '/index.js']) {
            if (fileSet.has(slashPath + ext)) return slashPath + ext;
        }

        return null;
    }

    // --- Build dependency edges ---
    const deps = []; // { from, to }
    const connectionCount = {}; // filePath -> number of connections
    filePaths.forEach(fp => { connectionCount[fp] = 0; });

    if (importGraph) {
        for (const [filePath, data] of importGraph.entries()) {
            if (!data?.imports) continue;
            for (const imp of data.imports) {
                const target = resolveImport(imp.source, filePath);
                if (target && target !== filePath) {
                    deps.push({ from: filePath, to: target });
                    connectionCount[filePath] = (connectionCount[filePath] || 0) + 1;
                    connectionCount[target] = (connectionCount[target] || 0) + 1;
                }
            }
        }
    }

    // --- Adaptive file selection based on repo size ---
    const totalFiles = filePaths.length;
    const sorted = filePaths.slice().sort((a, b) => (connectionCount[b] || 0) - (connectionCount[a] || 0));

    let rankedFiles;
    const collapsedDirs = {}; // dir -> { fileCount, totalConnections }
    const fileToCollapsedDir = {}; // filePath -> dir (for edge routing)

    if (totalFiles <= 80) {
        // Small/medium repo: show ALL files individually
        rankedFiles = sorted;
    } else {
        // Large repo: show top N individually, collapse the rest into directory summary nodes
        const topN = totalFiles <= 200 ? 60 : 40;
        rankedFiles = sorted.slice(0, topN);
        const selectedSet = new Set(rankedFiles);

        for (const fp of sorted.slice(topN)) {
            const parts = fp.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
            if (!collapsedDirs[dir]) {
                collapsedDirs[dir] = { fileCount: 0, totalConnections: 0 };
            }
            collapsedDirs[dir].fileCount++;
            collapsedDirs[dir].totalConnections += (connectionCount[fp] || 0);
            fileToCollapsedDir[fp] = dir;
        }
    }

    const selectedSet = new Set(rankedFiles);

    // --- Group individually-shown files by directory ---
    const dirGroups = {};
    for (const fp of rankedFiles) {
        const parts = fp.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
        if (!dirGroups[dir]) dirGroups[dir] = [];
        dirGroups[dir].push(fp);
    }

    // --- Generate Mermaid flowchart ---
    const repoName = safe(repoId.split('/').pop() || repoId);
    const nodeIds = {}; // filePath -> nodeId
    const collapsedNodeIds = {}; // dir -> nodeId (for collapsed directory nodes)
    let nid = 0;

    const lines = ['flowchart LR'];

    // Create subgraphs for each directory (individual files)
    const sortedDirs = Object.entries(dirGroups)
        .sort((a, b) => b[1].length - a[1].length);

    for (const [dir, files] of sortedDirs) {
        const dirLabel = safe(dir === '(root)' ? repoName : dir);
        const sgId = `sg${nid++}`;
        lines.push(`    subgraph ${sgId}["${dirLabel}"]`);

        for (const fp of files) {
            const id = `f${nid++}`;
            nodeIds[fp] = id;
            const fileName = safe(fp.split('/').pop());
            lines.push(`        ${id}["${fileName}"]`);
        }

        // Add collapsed directory node inside the same subgraph if it has collapsed files
        if (collapsedDirs[dir]) {
            const cid = `c${nid++}`;
            collapsedNodeIds[dir] = cid;
            lines.push(`        ${cid}["... +${collapsedDirs[dir].fileCount} more files"]`);
            delete collapsedDirs[dir]; // handled, remove from remaining
        }

        lines.push('    end');
    }

    // Remaining collapsed directories that had NO individual files shown — create standalone nodes
    for (const [dir, info] of Object.entries(collapsedDirs)) {
        if (info.fileCount === 0) continue;
        const dirLabel = safe(dir === '(root)' ? repoName : dir);
        const sgId = `sg${nid++}`;
        const cid = `c${nid++}`;
        collapsedNodeIds[dir] = cid;
        lines.push(`    subgraph ${sgId}["${dirLabel}"]`);
        lines.push(`        ${cid}["${info.fileCount} files"]`);
        lines.push('    end');
    }

    // Add dependency edges (route through collapsed nodes when needed)
    lines.push('');
    const addedEdges = new Set();
    for (const { from, to } of deps) {
        const fromId = nodeIds[from] || collapsedNodeIds[fileToCollapsedDir[from]];
        const toId = nodeIds[to] || collapsedNodeIds[fileToCollapsedDir[to]];
        if (fromId && toId && fromId !== toId) {
            const key = `${fromId}-${toId}`;
            if (!addedEdges.has(key)) {
                lines.push(`    ${fromId} --> ${toId}`);
                addedEdges.add(key);
            }
        }
    }

    // Styling
    lines.push('');
    lines.push('    classDef hub fill:#6366f1,stroke:#818cf8,color:#fff,font-weight:bold');
    lines.push('    classDef mid fill:#334155,stroke:#475569,color:#e2e8f0');
    lines.push('    classDef leaf fill:#1e293b,stroke:#334155,color:#94a3b8');
    lines.push('    classDef collapsed fill:#0f172a,stroke:#334155,color:#64748b,stroke-dasharray:5 5');

    const hubs = [];
    const mids = [];
    const leaves = [];
    for (const fp of rankedFiles) {
        const id = nodeIds[fp];
        const c = connectionCount[fp] || 0;
        if (c >= 5) hubs.push(id);
        else if (c >= 2) mids.push(id);
        else leaves.push(id);
    }
    // Collapsed directory nodes get their own style
    const collapsedIds = Object.values(collapsedNodeIds);
    if (collapsedIds.length) leaves.push(...collapsedIds);

    if (hubs.length) lines.push(`    class ${hubs.join(',')} hub`);
    if (mids.length) lines.push(`    class ${mids.join(',')} mid`);
    if (leaves.length) lines.push(`    class ${leaves.join(',')} leaf`);
    if (collapsedIds.length) lines.push(`    class ${collapsedIds.join(',')} collapsed`);

    return lines.join('\n');
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

// ── Repo Mindmap LLM Enrichment ─────────────────────────────────────────────

export const REPO_MINDMAP_ENRICHMENT_SYSTEM_PROMPT = `You are **RepoSpector**, an AI-powered code analysis Chrome extension with direct access to indexed repository data from the user's browser. You are a software architecture diagram expert. Generate a Mermaid flowchart that visualizes a repository's architecture with domain-meaningful groupings and annotated relationships. Output ONLY valid Mermaid syntax — no markdown code fences, no explanations.`;

/**
 * Build prompt for LLM-enriched repo mindmap
 */
export function buildRepoMindmapEnrichmentPrompt(repoId, filePaths, importSummary) {
    const repoName = repoId.split('/').pop() || repoId;

    return `Generate a Mermaid flowchart for the repository **${repoName}**.

### File Structure
${filePaths.slice(0, 40).join('\n')}
${filePaths.length > 40 ? `\n...and ${filePaths.length - 40} more files` : ''}

### Import Dependencies
${importSummary}

### Rules
- Use \`flowchart LR\` (left-to-right) syntax
- Group files into subgraphs by **domain concern** (e.g., "Authentication", "Data Layer", "API Routes"), NOT just directory names
- Add edge labels for key relationships (e.g., \`-->|data flow|\`, \`-->|events|\`) — do NOT put quotes inside pipe delimiters
- Highlight entry points and hub files with different node shapes (\`((...))\` for entry, \`[...]\` for standard)
- Use styling: \`classDef hub fill:#6366f1,stroke:#818cf8,color:#fff,font-weight:bold\`
- Max 25 nodes — prioritize the most connected/important files
- Output ONLY the Mermaid code, starting with "flowchart"
- Do NOT wrap in markdown code fences

### CRITICAL Syntax Rules (violations cause parse failures)
- Use ONLY \`-->\` arrows. NEVER use \`-->>\`, \`->>\`, or any double-angle arrows — those are sequence diagram syntax
- In \`class\` statements, do NOT add spaces after commas: \`class A,B,C hub\` (correct) vs \`class A, B, C hub\` (WRONG)
- Edge labels must NOT contain \`/\`, \`<\`, \`>\`, \`\\\`, \`[\`, \`]\`, \`(\`, \`)\`, \`#\`, or \`&\` — use plain words only
- Every \`|\` in an edge label MUST have a matching closing \`|\`: \`-->|label|\` (correct) vs \`-->|label\` (WRONG)
- Do NOT use \`:::\` class shortcuts — use \`class\` statements at the end instead
- Always quote node labels that contain dots or special chars: \`A["file.ts"]\``;
}

/**
 * Build a condensed import graph summary for LLM context.
 * Shows the top connections without sending full file contents.
 */
export function buildImportSummary(importGraph, filePaths) {
    if (!importGraph || importGraph.size === 0) return 'No import data available.';

    const connections = [];
    const connectionCount = {};

    for (const [fp, data] of importGraph) {
        if (!data?.imports) continue;
        connectionCount[fp] = (connectionCount[fp] || 0) + data.imports.length;
        for (const imp of data.imports) {
            if (imp.source && (imp.source.startsWith('.') || imp.source.startsWith('src'))) {
                connections.push(`${fp} --> ${imp.source}`);
            }
        }
    }

    // Top files by connection count
    const topFiles = Object.entries(connectionCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

    let summary = `Top connected files:\n`;
    summary += topFiles.map(([fp, count]) => `- ${fp} (${count} imports)`).join('\n');
    summary += `\n\nKey dependency edges:\n`;
    summary += connections.slice(0, 30).join('\n');
    if (connections.length > 30) summary += `\n...and ${connections.length - 30} more edges`;

    return summary;
}
