// Generator message handlers extracted from BackgroundService (src/background/index.js).
// These handle LLM-backed generation flows: PR descriptions, changelogs, Mermaid
// diagrams, repo mindmaps, RepoInfo, and repo docs. They operate against the
// BackgroundService instance (`svc`) for shared services and helpers.

import { ImportGraphService } from '../../services/ImportGraphService.js';
import {
    PR_DESCRIPTION_SYSTEM_PROMPT,
    buildPRDescriptionPrompt,
    CHANGELOG_SYSTEM_PROMPT,
    buildChangelogPrompt,
    MERMAID_SYSTEM_PROMPT,
    buildMermaidPrompt,
    generateRepoMindmapCode,
    REPO_MINDMAP_ENRICHMENT_SYSTEM_PROMPT,
    buildRepoMindmapEnrichmentPrompt,
    buildImportSummary
} from '../../utils/prSummaryPrompts.js';
import { generateRepoInfo, buildExtractedDataSummary, insertAfterHeader } from '../../utils/repoInfoGenerator.js';
import { REPO_INFO_ENRICHMENT_SYSTEM_PROMPT, buildRepoInfoEnrichmentPrompt } from '../../utils/repoInfoPrompts.js';
import { validateMermaidSyntax, sanitizeMermaidCode } from '../mermaidValidation.js';

/**
 * Build the generator message handlers bound to a BackgroundService instance.
 * @param {object} svc - The BackgroundService instance.
 * @returns {object} Map of message type -> handler.
 */
export function createGeneratorHandlers(svc) {
    async function handleGeneratePRDescription(message, sendResponse) {
        try {
            const { prUrl, applyToGit = false } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            await svc.updatePRServiceTokens();
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            const settings = await svc.getStoredSettings();

            const prompt = buildPRDescriptionPrompt(prData);
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: PR_DESCRIPTION_SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ],
                { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
            );

            const description = response.content || response;

            // Optionally write to GitHub/GitLab
            let applied = false;
            if (applyToGit) {
                await svc.pullRequestService.updatePRDescription(prUrl, description);
                applied = true;
            }

            sendResponse({ success: true, data: { description, applied } });
        } catch (error) {
            svc.errorHandler.logError('Generate PR Description', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGenerateMermaidDiagram(message, sendResponse) {
        try {
            const { prUrl, diagramType } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            await svc.updatePRServiceTokens();
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            if (diagramType) prData.diagramType = diagramType;
            const settings = await svc.getStoredSettings();

            const MAX_RETRIES = 2;
            let lastError = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                const prompt = attempt === 1
                    ? buildMermaidPrompt(prData)
                    : `${buildMermaidPrompt(prData)}\n\nIMPORTANT: Your previous output had syntax errors:\n${lastError}\nFix these issues and output ONLY valid Mermaid syntax.`;

                const response = await svc.llmService.streamChat(
                    [
                        { role: 'system', content: MERMAID_SYSTEM_PROMPT },
                        { role: 'user', content: prompt }
                    ],
                    { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
                );

                let mermaidCode = (response.content || response).trim();
                mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '').trim();
                mermaidCode = sanitizeMermaidCode(mermaidCode);

                // Validate diagram syntax
                const validation = validateMermaidSyntax(mermaidCode, diagramType || 'sequence');
                if (validation.valid) {
                    console.log(`✅ Mermaid diagram generated successfully (attempt ${attempt})`);
                    sendResponse({ success: true, data: { mermaidCode } });
                    return;
                }

                console.warn(`⚠️ Mermaid validation failed (attempt ${attempt}/${MAX_RETRIES}):`, validation.errors);
                lastError = validation.errors.join('; ');
            }

            // Return best-effort result after retries exhausted
            console.warn('⚠️ Returning diagram despite validation issues after retries');
            const finalPrompt = buildMermaidPrompt(prData);
            const finalResponse = await svc.llmService.streamChat(
                [
                    { role: 'system', content: MERMAID_SYSTEM_PROMPT },
                    { role: 'user', content: finalPrompt }
                ],
                { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
            );
            let finalCode = (finalResponse.content || finalResponse).trim();
            finalCode = finalCode.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '').trim();
            finalCode = sanitizeMermaidCode(finalCode);
            sendResponse({ success: true, data: { mermaidCode: finalCode, warning: 'Diagram may contain syntax issues' } });
        } catch (error) {
            svc.errorHandler.logError('Generate Mermaid Diagram', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    /**
     * Generate a Mermaid diagram from indexed repo code (not tied to a PR)
     */
    async function handleGenerateRepoDiagram(message, sendResponse) {
        try {
            const { repoId: providedRepoId, url: providedUrl, diagramType, query } = message.data || message.payload || {};

            // Resolve repoId
            let repoId = providedRepoId;
            if (!repoId && providedUrl) {
                repoId = svc.getRepoIdFromUrl(providedUrl);
            }
            if (!repoId) {
                sendResponse({ success: false, error: 'Repository ID or URL required' });
                return;
            }

            // Retrieve relevant code via RAG
            const smartQuery = query || `architecture components services classes interactions ${diagramType || 'sequence'} diagram`;
            const ragChunks = await svc.ragService.retrieveContext(repoId, smartQuery, 20);

            if (!ragChunks || ragChunks.length === 0) {
                sendResponse({ success: false, error: 'No indexed code found. Please index the repository first.' });
                return;
            }

            // Build code context from RAG chunks
            const codeContext = ragChunks.map(chunk => {
                const filePath = chunk.filePath || 'unknown';
                const content = (chunk.content || chunk.text || '').substring(0, 1500);
                return `// File: ${filePath}\n${content}`;
            }).join('\n\n---\n\n');

            const settings = await svc.getStoredSettings();
            const type = diagramType || 'sequence';
            const typeLabel = { sequence: 'sequence diagram', class: 'class diagram', state: 'state diagram', er: 'entity-relationship diagram' }[type] || 'sequence diagram';

            const systemPrompt = `You are a software architecture diagram expert. Analyze repository code and generate a Mermaid ${typeLabel}. Output ONLY valid Mermaid syntax, no markdown code fences.`;

            const typeInstructions = {
                sequence: `- Use \`sequenceDiagram\` syntax\n- Show runtime interaction flow between services, classes, and components\n- Use ->> for sync calls, -->> for responses, -) for events\n- Max 12 participants, max 40 interactions`,
                class: `- Use \`classDiagram\` syntax\n- Show classes with key attributes and methods\n- Show inheritance (--|>), composition (*--), association (-->)\n- Max 15 classes`,
                state: `- Use \`stateDiagram-v2\` syntax\n- Show state transitions for the primary entity\n- Use [*] for start/end states\n- Max 20 states`,
                er: `- Use \`erDiagram\` syntax\n- Show entities with attributes and relationships\n- Use proper cardinality: ||--o{ (one-to-many), ||--|| (one-to-one)\n- Max 15 entities`
            };

            const prompt = `Generate a Mermaid **${typeLabel}** for this repository's code:

### Repository Code Context
${codeContext}

### Rules
${typeInstructions[type] || typeInstructions.sequence}
- Focus on the most important architectural interactions
- Use short, descriptive names for participants/entities
- Output ONLY the Mermaid code
- Do NOT wrap in markdown code fences
- Do NOT use special characters like < > { } in labels`;

            const MAX_RETRIES = 2;
            let lastError = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                const retryPrompt = attempt === 1
                    ? prompt
                    : `${prompt}\n\nIMPORTANT: Your previous output had syntax errors:\n${lastError}\nFix these issues.`;

                const response = await svc.llmService.streamChat(
                    [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: retryPrompt }
                    ],
                    { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
                );

                let mermaidCode = (response.content || response).trim();
                mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '').trim();
                mermaidCode = sanitizeMermaidCode(mermaidCode);

                const validation = validateMermaidSyntax(mermaidCode, type);
                if (validation.valid) {
                    console.log(`✅ Repo diagram generated successfully (attempt ${attempt})`);
                    sendResponse({ success: true, data: { mermaidCode, diagramType: type } });
                    return;
                }

                console.warn(`⚠️ Repo diagram validation failed (attempt ${attempt}):`, validation.errors);
                lastError = validation.errors.join('; ');
            }

            sendResponse({ success: false, error: 'Failed to generate valid diagram after retries' });
        } catch (error) {
            svc.errorHandler.logError('Generate Repo Diagram', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGenerateChangelog(message, sendResponse) {
        try {
            const { prUrl } = message.data || message.payload || {};
            if (!prUrl) { sendResponse({ success: false, error: 'PR URL required' }); return; }

            await svc.updatePRServiceTokens();
            const prData = await svc.pullRequestService.fetchPullRequest(prUrl);
            const settings = await svc.getStoredSettings();

            const prompt = buildChangelogPrompt(prData);
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: CHANGELOG_SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ],
                { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
            );

            sendResponse({ success: true, data: { changelog: response.content || response } });
        } catch (error) {
            svc.errorHandler.logError('Generate Changelog', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGenerateRepoMindmap(message, sendResponse) {
        try {
            const { repoId: providedRepoId, url: providedUrl, tabId } = message.data || message.payload || {};

            // Get URL from tab if not provided (popup iframe can't access tab.url without tabs permission)
            let url = providedUrl;
            if (!url && tabId) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    url = tab?.url;
                } catch (e) {
                    console.warn('Could not get tab URL:', e);
                }
            }

            // Always derive repoId from URL when available (matches indexing format)
            let repoId = null;
            if (url) {
                if (url.includes('github.com')) {
                    repoId = svc.githubService.getRepoId(url);
                } else if (url.includes('gitlab.com')) {
                    repoId = svc.gitlabService.getRepoId(url);
                }
            }
            if (!repoId) {
                repoId = providedRepoId;
            }

            if (!repoId) {
                sendResponse({ success: false, error: 'Repository ID or URL required' });
                return;
            }

            // Get file contents from VectorStore (indexed chunks)
            await svc.ragService.init();
            const fileContents = await svc.ragService.vectorStore.getFileContents(repoId);

            if (!fileContents || fileContents.size === 0) {
                sendResponse({ success: false, error: 'No indexed files found for this repository. Please index the repo first.' });
                return;
            }

            const filePaths = [...fileContents.keys()].sort();

            // Build import dependency graph from file contents
            const importGraphService = new ImportGraphService();
            const files = [];
            for (const [filePath, content] of fileContents) {
                files.push({ filename: filePath, content });
            }
            const importGraph = importGraphService.buildGraph(files);

            // Generate dependency flowchart — free & instant, no LLM
            const mermaidCode = generateRepoMindmapCode(filePaths, repoId, importGraph);

            if (!mermaidCode) {
                sendResponse({ success: false, error: 'Failed to generate dependency map.' });
                return;
            }

            // LLM enrichment pass (optional — only if API key is configured)
            let finalMermaidCode = mermaidCode;
            let fallbackCode = null; // code-generated version as fallback
            try {
                const settings = await svc.getStoredSettings();
                if (settings.apiKey) {
                    const importSummary = buildImportSummary(importGraph, filePaths);
                    const response = await svc.llmService.streamChat(
                        [
                            { role: 'system', content: REPO_MINDMAP_ENRICHMENT_SYSTEM_PROMPT },
                            { role: 'user', content: buildRepoMindmapEnrichmentPrompt(repoId, filePaths, importSummary) }
                        ],
                        { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
                    );
                    let llmMermaid = (response.content || response).trim();
                    llmMermaid = llmMermaid.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '').trim();
                    llmMermaid = sanitizeMermaidCode(llmMermaid);
                    // Validate: must start with 'flowchart' or 'graph' and have reasonable content
                    if (/^(flowchart|graph)\s/i.test(llmMermaid) && llmMermaid.split('\n').length >= 3) {
                        finalMermaidCode = llmMermaid;
                        // Keep code-generated version as fallback in case LLM output fails to render
                        fallbackCode = sanitizeMermaidCode(mermaidCode);
                    } else {
                        console.warn('LLM mindmap output invalid, using code-based output');
                    }
                }
            } catch (e) {
                console.warn('LLM mindmap enrichment failed, using code-based output:', e.message);
            }

            // Always sanitize the final output regardless of source
            finalMermaidCode = sanitizeMermaidCode(finalMermaidCode);

            const responseData = { mermaidCode: finalMermaidCode };
            if (fallbackCode) responseData.fallbackCode = fallbackCode;
            sendResponse({ success: true, data: responseData });
        } catch (error) {
            svc.errorHandler.logError('Generate Repo Mindmap', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGenerateRepoInfo(message, sendResponse) {
        try {
            const { repoId: providedRepoId, url: providedUrl, tabId } = message.data || message.payload || {};

            // Get URL from tab if not provided (popup iframe can't access tab.url without tabs permission)
            let url = providedUrl;
            if (!url && tabId) {
                try {
                    const tab = await chrome.tabs.get(tabId);
                    url = tab?.url;
                } catch (e) {
                    console.warn('Could not get tab URL:', e);
                }
            }

            // Always derive repoId from URL when available (matches indexing format)
            let repoId = null;
            if (url) {
                if (url.includes('github.com')) {
                    repoId = svc.githubService.getRepoId(url);
                } else if (url.includes('gitlab.com')) {
                    repoId = svc.gitlabService.getRepoId(url);
                }
            }
            if (!repoId) {
                repoId = providedRepoId;
            }

            if (!repoId) {
                sendResponse({ success: false, error: 'Repository ID or URL required' });
                return;
            }

            // Get file contents from VectorStore (indexed chunks)
            await svc.ragService.init();
            const fileContents = await svc.ragService.vectorStore.getFileContents(repoId);

            if (!fileContents || fileContents.size === 0) {
                sendResponse({ success: false, error: 'No indexed files found for this repository. Please index the repo first.' });
                return;
            }

            // Build import dependency graph from file contents
            const importGraphService = new ImportGraphService();
            const files = [];
            for (const [filePath, content] of fileContents) {
                files.push({ filename: filePath, content });
            }
            const importGraph = importGraphService.buildGraph(files);

            // Generate RepoInfo markdown — free & instant, no LLM
            const repoInfoMarkdown = generateRepoInfo(fileContents, importGraph, repoId);

            if (!repoInfoMarkdown) {
                sendResponse({ success: false, error: 'Failed to generate RepoInfo.' });
                return;
            }

            // LLM enrichment pass (optional — only if API key is configured)
            let finalMarkdown = repoInfoMarkdown;
            try {
                const settings = await svc.getStoredSettings();
                if (settings.apiKey) {
                    const extractedSummary = buildExtractedDataSummary(fileContents, importGraph, repoId);
                    const response = await svc.llmService.streamChat(
                        [
                            { role: 'system', content: REPO_INFO_ENRICHMENT_SYSTEM_PROMPT },
                            { role: 'user', content: buildRepoInfoEnrichmentPrompt(repoId, extractedSummary) }
                        ],
                        { provider: settings.provider, model: settings.model, apiKey: settings.apiKey, stream: false }
                    );
                    const enrichedSections = (response.content || response).trim();
                    if (enrichedSections) {
                        finalMarkdown = insertAfterHeader(repoInfoMarkdown, enrichedSections);
                    }
                }
            } catch (e) {
                console.warn('LLM RepoInfo enrichment failed, using pattern-matched output only:', e.message);
            }

            sendResponse({ success: true, data: { repoInfoMarkdown: finalMarkdown, repoId } });
        } catch (error) {
            svc.errorHandler.logError('Generate RepoInfo', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGenerateRepoDocs(message, sendResponse) {
        const { repoId, _url, docType = 'overview' } = message.payload || message.data || {};

        try {
            if (!repoId) throw new Error('Repository ID is required');

            // Get repo documentation from RAG
            const repoDoc = await svc.ragService.getRepositoryDocumentation(repoId);

            // Get knowledge graph data if available
            let graphSummary = '';
            const graph = svc.codeGraphPipeline?.graph;
            if (graph) {
                try {
                    await graph.load(repoId);
                    const nodes = graph.getAllNodes();
                    const stats = {
                        functions: nodes.filter(n => n.label === 'Function').length,
                        classes: nodes.filter(n => n.label === 'Class').length,
                        modules: nodes.filter(n => n.label === 'Module').length
                    };
                    graphSummary = `Code Graph: ${stats.functions} functions, ${stats.classes} classes, ${stats.modules} modules`;
                } catch (_e) { /* graph not available */ }
            }

            // Get RAG chunks for architecture understanding
            const chunks = await svc.ragService.retrieveContext(repoId,
                'project architecture main components entry points configuration', 20);

            const settings = await svc.getStoredSettings();
            const modelName = svc.getModelId(settings.model);

            // Build prompt based on docType
            let systemPrompt = `You are RepoSpector, generating ${docType} documentation for a repository.`;
            let userPrompt = `Generate ${docType} documentation for repository "${repoId}".\n\n`;

            if (repoDoc.found) {
                userPrompt += `## Existing Documentation\n${repoDoc.content.substring(0, 3000)}\n\n`;
            }
            if (graphSummary) {
                userPrompt += `## ${graphSummary}\n\n`;
            }
            if (chunks.length > 0) {
                userPrompt += `## Code Samples\n`;
                for (const chunk of chunks.slice(0, 10)) {
                    userPrompt += `### ${chunk.filePath || 'unknown'}\n\`\`\`\n${(chunk.content || '').substring(0, 500)}\n\`\`\`\n\n`;
                }
            }

            if (docType === 'overview') {
                userPrompt += `\nGenerate a comprehensive project overview including:\n- Project purpose and goals\n- Architecture overview\n- Key components and their responsibilities\n- Technology stack\n- Getting started guide\n\nOutput as clean Markdown.`;
            } else if (docType === 'api') {
                userPrompt += `\nGenerate API documentation including:\n- Available endpoints/functions\n- Parameters and return types\n- Usage examples\n\nOutput as clean Markdown.`;
            } else if (docType === 'architecture') {
                userPrompt += `\nGenerate architecture documentation including:\n- System architecture diagram (as Mermaid code block)\n- Component responsibilities\n- Data flow\n- Dependencies between components\n\nOutput as clean Markdown with Mermaid diagrams.`;
            }

            const response = await svc.llmService.callLLM({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                model: modelName,
                max_tokens: 4000
            }, settings.apiKey);

            sendResponse({
                success: true,
                data: {
                    repoInfoMarkdown: response,
                    repoId,
                    docType
                }
            });
        } catch (error) {
            console.error('Repo docs generation error:', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        GENERATE_PR_DESCRIPTION: (m, send) => handleGeneratePRDescription(m, send),
        GENERATE_MERMAID_DIAGRAM: (m, send) => handleGenerateMermaidDiagram(m, send),
        GENERATE_CHANGELOG: (m, send) => handleGenerateChangelog(m, send),
        GENERATE_REPO_MINDMAP: (m, send) => handleGenerateRepoMindmap(m, send),
        GENERATE_REPO_DIAGRAM: (m, send) => handleGenerateRepoDiagram(m, send),
        GENERATE_REPO_INFO: (m, send) => handleGenerateRepoInfo(m, send),
        GENERATE_REPO_DOCS: (m, send) => handleGenerateRepoDocs(m, send),
    };
}
