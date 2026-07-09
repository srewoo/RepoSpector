/**
 * Chat-with-code message handler, extracted from BackgroundService.
 *
 * The handler orchestrates code extraction, RAG/graph context retrieval, and the
 * streaming LLM call. It relies on private helpers that REMAIN on the class
 * (buildChatMessages, callOpenAI, getModelId, getStoredSettings, etc.), all
 * accessed via the injected `svc` instance. The factory takes the
 * BackgroundService instance and returns the handler map for the router.
 */

import { ImportGraphService } from '../../services/ImportGraphService.js';
import { generateRepoInfo } from '../../utils/repoInfoGenerator.js';

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createChatHandlers(svc) {
    async function handleChatWithCode(message, sendResponse, sender) {
        const { tabId, question, conversationHistory, useDeepContext } = message.payload || message.data || {};

        // Determine if request came from popup or content script
        // Also check message.isFromPopup flag set by content script relay for iframe popup
        const isFromPopup = !sender || !sender.tab || message.isFromPopup === true;
        console.log('📍 Request origin:', isFromPopup ? 'Popup' : 'Content Script', '| message.isFromPopup:', message.isFromPopup);

        try {
            console.log('💬 Starting code chat session...');
            console.log('📝 User question:', question);
            console.log('📚 Conversation history:', conversationHistory ? `${conversationHistory.length} messages` : 'None');

            // Register active tab
            if (tabId) {
                svc.registerActiveTab(tabId, 'code_chat');
            }

            // Extract code from the current page
            let extractedCode = null;
            let extractedContext = null;

            if (!tabId) {
                throw new Error('No tab ID provided');
            }

            console.log('🔍 Starting code extraction for tab', tabId);

            try {
                // Try with type: 'EXTRACT_CODE' first (new format)
                let extractionResult = await chrome.tabs.sendMessage(tabId, {
                    type: 'EXTRACT_CODE',
                    options: {
                        contextLevel: 'minimal'
                    }
                });

                console.log('📥 Received extraction result from content script:', {
                    success: extractionResult?.success,
                    hasDataObject: !!extractionResult?.data,
                    hasCodeDirectly: !!extractionResult?.code
                });

                // Fallback to action: 'EXTRACT_CODE' (legacy format)
                if (!extractionResult || !extractionResult.success) {
                    console.log('🔄 Trying legacy extraction format...');
                    extractionResult = await chrome.tabs.sendMessage(tabId, {
                        action: 'EXTRACT_CODE'
                    });
                }

                if (extractionResult && extractionResult.success) {
                    if (extractionResult.data) {
                        extractedCode = extractionResult.data.code;
                        extractedContext = extractionResult.data.context;
                        console.log('✅ Code successfully extracted, length:', extractedCode?.length || 0);
                    } else if (extractionResult.code) {
                        extractedCode = extractionResult.code;
                        extractedContext = extractionResult.context;
                        console.log('✅ Code successfully extracted (direct), length:', extractedCode?.length || 0);
                    }
                }
            } catch (error) {
                console.warn('⚠️ Code extraction failed (may be on a non-code page):', error.message);
            }

            // If no code extracted, try to get context from the tab URL for RAG-only mode
            if (!extractedCode || extractedCode.trim().length === 0) {
                console.log('ℹ️ No code on this page — attempting RAG-only mode from tab URL');
                try {
                    const tab = await chrome.tabs.get(tabId);
                    const tabUrl = tab?.url || '';
                    const platform = tabUrl.includes('gitlab') ? 'gitlab' : tabUrl.includes('github') ? 'github' : null;
                    if (platform && tabUrl) {
                        extractedContext = { url: tabUrl, platform, filePath: null };
                        extractedCode = ''; // No code from page — using repository context only
                    }
                } catch (e) {
                    console.warn('Could not get tab URL:', e.message);
                }

                // If still no context at all (not on GitHub/GitLab), then fail
                if (!extractedContext) {
                    throw new Error('No code found on this page. Please navigate to a GitHub or GitLab repository page, or open a specific code file.');
                }
            }

            // Get settings
            const settings = await svc.getStoredSettings();
            if (!settings.apiKey) {
                throw new Error('OpenAI API key not configured. Please add your API key in settings.');
            }

            // Detect language (may be unknown if no code on page)
            const languageDetection = svc.languageDetector.detect({
                url: extractedContext?.url,
                filePath: extractedContext?.filePath,
                code: extractedCode || '',
                platform: extractedContext?.platform
            });

            console.log('🔍 Detected language:', languageDetection.language);

            const isRagOnlyMode = !extractedCode || extractedCode.trim().length === 0;
            if (isRagOnlyMode) {
                console.log('📂 RAG-only mode: no code file open, will use indexed repository context');
            }

            // Retrieve RAG context — auto-enable when in RAG-only mode (no code on page)
            const shouldUseRAG = useDeepContext || isRagOnlyMode;
            let ragContext = null;
            if (shouldUseRAG && svc.ragService && extractedContext?.url) {
                try {
                    const repoId = svc.contextAnalyzer.extractRepoIdFromUrl(
                        extractedContext.url,
                        extractedContext.platform
                    );

                    if (repoId) {
                        console.log('🔍 Retrieving RAG context for repo:', repoId, '(user enabled Deep Context)');

                        // Build query — use code context if available, otherwise just the question
                        let smartQuery;
                        if (isRagOnlyMode) {
                            smartQuery = question;
                        } else {
                            const codeContext = svc.contextAnalyzer.buildSmartRAGQuery(extractedCode, extractedContext);
                            smartQuery = `User Question: ${question}\n\n${codeContext}`;
                        }
                        console.log('🧠 Smart query preview:', smartQuery.substring(0, 150) + '...');

                        // Use lower minScore in RAG-only mode for broad questions
                        const ragOptions = isRagOnlyMode ? { minScore: 0.05 } : {};
                        const relevantChunks = await svc.ragService.retrieveContext(repoId, smartQuery, 20, ragOptions);

                        if (relevantChunks && relevantChunks.length > 0) {
                            ragContext = {
                                chunks: relevantChunks.map(c => c.content).join('\n\n'),
                                sources: relevantChunks.map(c => c.filePath)
                            };
                            console.log(`✅ Retrieved ${relevantChunks.length} relevant chunks from RAG`);
                        } else {
                            console.log('ℹ️ No RAG chunks from search, trying repository documentation...');
                        }

                        // In RAG-only mode, also fetch repo documentation (README, docs) as supplementary context
                        if (isRagOnlyMode) {
                            try {
                                const repoDocs = await svc.ragService.getRepositoryDocumentation(repoId);
                                if (repoDocs && repoDocs.found && repoDocs.content) {
                                    if (ragContext) {
                                        // Append docs to existing RAG context
                                        ragContext.chunks = ragContext.chunks + '\n\n--- Repository Documentation ---\n\n' + repoDocs.content;
                                        ragContext.sources = [...new Set([...ragContext.sources, ...(repoDocs.sources || [])])];
                                    } else {
                                        // Use docs as the sole context
                                        ragContext = {
                                            chunks: repoDocs.content,
                                            sources: repoDocs.sources || []
                                        };
                                    }
                                    console.log(`✅ Added repository documentation from ${(repoDocs.sources || []).length} files`);
                                }
                            } catch (docErr) {
                                console.warn('Repository documentation fetch failed:', docErr.message);
                            }
                        }
                    }
                } catch (error) {
                    console.warn('RAG retrieval failed:', error);
                }
            } else if (!shouldUseRAG) {
                console.log('ℹ️ Deep Context (RAG) disabled by user - using standard context');
            }

            // In RAG-only mode, if no RAG context yet, auto-generate RepoInfo as final fallback
            if (isRagOnlyMode && !ragContext) {
                console.log('ℹ️ No RAG or docs found — generating RepoInfo on the fly...');
                try {
                    const repoId = svc.contextAnalyzer.extractRepoIdFromUrl(
                        extractedContext.url,
                        extractedContext.platform
                    );
                    if (repoId) {
                        await svc.ragService.init();
                        const fileContents = await svc.ragService.vectorStore.getFileContents(repoId);
                        if (fileContents && fileContents.size > 0) {
                            const importGraphService = new ImportGraphService();
                            const files = [];
                            for (const [filePath, content] of fileContents) {
                                files.push({ filename: filePath, content });
                            }
                            const importGraph = importGraphService.buildGraph(files);
                            const repoInfoMarkdown = generateRepoInfo(fileContents, importGraph, repoId);
                            if (repoInfoMarkdown) {
                                ragContext = {
                                    chunks: '--- Auto-Generated Repository Overview ---\n\n' + repoInfoMarkdown,
                                    sources: ['[auto-generated RepoInfo]']
                                };
                                console.log('✅ Auto-generated RepoInfo as fallback context');
                            }
                        }
                    }
                } catch (genErr) {
                    console.warn('RepoInfo auto-generation failed:', genErr.message);
                }

                // If still nothing, give a clear error
                if (!ragContext) {
                    throw new Error('No code found on this page and no indexed repository context available. Please navigate to a code file, or index this repository first.');
                }
            }

            // Inject Knowledge Graph context (impact analysis, execution flows, communities)
            let graphContext = null;
            try {
                const graphRepoId = svc.contextAnalyzer.extractRepoIdFromUrl(
                    extractedContext?.url,
                    extractedContext?.platform
                );

                if (graphRepoId && svc.codeGraphPipeline) {
                    // Load graph if not already loaded for this repo
                    if (svc.codeGraphPipeline.graph.nodeCount === 0) {
                        const hasGraph = await svc.codeGraphPipeline.hasGraph(graphRepoId);
                        if (hasGraph) {
                            await svc.codeGraphPipeline.loadGraph(graphRepoId);
                            console.log('🧠 Knowledge graph loaded for chat context');
                        }
                    }

                    if (svc.codeGraphPipeline.graph.nodeCount > 0) {
                        graphContext = svc.codeGraphPipeline.getContextForQuestion(
                            question,
                            extractedCode || ''
                        );
                        if (graphContext) {
                            console.log('🧠 Knowledge graph context injected into chat');
                        }
                    }
                }
            } catch (graphErr) {
                console.warn('Knowledge graph context retrieval failed (non-fatal):', graphErr.message);
            }

            // Append graph context to RAG context
            if (graphContext && ragContext) {
                ragContext.chunks = ragContext.chunks + '\n\n' + graphContext;
                ragContext.sources = [...(ragContext.sources || []), '[knowledge-graph]'];
            } else if (graphContext && !ragContext) {
                ragContext = {
                    chunks: graphContext,
                    sources: ['[knowledge-graph]']
                };
            }

            // Get model identifier
            const modelId = svc.getModelId(settings.model);

            // Build messages array for OpenAI (including conversation history, RAG context, and token management)
            const messages = svc.buildChatMessages(
                extractedCode,
                question,
                languageDetection,
                extractedContext,
                conversationHistory,
                ragContext,
                modelId  // Pass model for token management
            );

            console.log('📤 Sending chat request to OpenAI...');
            console.log('Messages count:', messages.length);
            console.log('Has conversation history:', conversationHistory && conversationHistory.length > 0);

            // Call LLM with streaming (supports OpenAI, Claude, Gemini, Groq, Mistral, Ollama)
            const result = await svc.callOpenAI({
                model: settings.model || modelId,  // Use full model identifier for provider routing
                messages: messages,
                temperature: 0.3,
                max_tokens: 4096
            }, settings.apiKey, {
                streaming: true,
                tabId: tabId,
                isFromPopup: isFromPopup,  // Pass sender context
                requestId: `chat_${tabId}_${Date.now()}`  // Add request ID for cancellation
            });

            console.log('📥 Received response from OpenAI');

            // Unregister active tab
            if (tabId) {
                svc.unregisterActiveTab(tabId);
            }

            sendResponse({
                success: true,
                response: result,
                languageDetection,
                metadata: {
                    language: languageDetection.language,
                    codeLength: extractedCode?.length || 0,
                    ragOnlyMode: isRagOnlyMode,
                    truncation: svc._lastTruncationInfo || null
                }
            });

        } catch (error) {
            // Unregister active tab on error
            if (tabId) {
                svc.unregisterActiveTab(tabId);
            }

            svc.errorHandler.logError('Code chat', error);
            sendResponse({
                success: false,
                error: svc.getErrorMessage(error)
            });
        }
    }

    return {
        CHAT_WITH_CODE: (m, send, sender) => handleChatWithCode(m, send, sender),
    };
}
