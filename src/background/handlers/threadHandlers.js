/**
 * PR-thread message handlers, extracted from BackgroundService.
 *
 * Covers the conversation threads attached to review findings: create, get,
 * send-message, quick-actions (explain/fix/false-positive), status updates,
 * get-or-create, and session retrieval. `processThreadMessage` (used only by
 * these handlers) lives here as an internal helper.
 *
 * Shared state stays on the service instance: prThreadManager, prSessionManager,
 * llmService, getStoredSettings, errorHandler, getErrorMessage.
 */

import {
    THREAD_SYSTEM_PROMPT,
    buildFindingFollowUpPrompt,
    buildExplainPrompt,
    buildHowToFixPrompt,
    buildFalsePositiveCheckPrompt,
    getSuggestedQuestions,
} from '../../utils/prThreadPrompts.js';

/**
 * @param {object} svc - the BackgroundService instance
 * @returns {Record<string, Function>} handler map keyed by message type
 */
export function createThreadHandlers(svc) {
    async function processThreadMessage(threadId, userMessage, finding) {
        try {
            // Get conversation context
            const context = await svc.prThreadManager.getConversationContext(threadId);

            // Build follow-up prompt
            const prompt = buildFindingFollowUpPrompt(
                { finding, messages: context.messages },
                {}, // Additional context (can add RAG context here)
                userMessage
            );

            // Get AI response
            const settings = await svc.getStoredSettings();
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: THREAD_SYSTEM_PROMPT },
                    ...context.messages.map(m => ({ role: m.role, content: m.content })),
                    { role: 'user', content: prompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false
                }
            );

            const aiResponse = response.content || response;

            // Add AI response to thread
            await svc.prThreadManager.addMessage(threadId, {
                role: 'assistant',
                content: aiResponse
            });

            // Generate suggested questions
            const suggestedQuestions = getSuggestedQuestions(finding, 'followup');

            return { response: aiResponse, suggestedQuestions };
        } catch (error) {
            console.error('Error processing thread message:', error);
            throw error;
        }
    }

    async function handleCreatePRThread(message, sendResponse) {
        try {
            const { sessionId, prIdentifier, finding, initialQuestion } = message.data || message.payload || {};

            if (!prIdentifier) {
                sendResponse({ success: false, error: 'PR identifier is required' });
                return;
            }

            console.log('📝 Creating PR thread for finding:', finding?.id || 'general');

            // Get or create session
            let session;
            if (sessionId) {
                session = await svc.prSessionManager.getSession(sessionId);
            }
            if (!session) {
                session = await svc.prSessionManager.createSession(prIdentifier);
            }

            // Create thread
            const thread = await svc.prThreadManager.createThread(prIdentifier, finding);

            // If there's an initial question, process it
            if (initialQuestion) {
                await processThreadMessage(thread.threadId, initialQuestion, finding);
            }

            sendResponse({
                success: true,
                data: await svc.prThreadManager.getThread(thread.threadId)
            });
        } catch (error) {
            svc.errorHandler.logError('Create PR Thread', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGetPRThread(message, sendResponse) {
        try {
            const { threadId } = message.data || message.payload || {};

            if (!threadId) {
                sendResponse({ success: false, error: 'Thread ID is required' });
                return;
            }

            const thread = await svc.prThreadManager.getThread(threadId);

            if (!thread) {
                sendResponse({ success: false, error: 'Thread not found' });
                return;
            }

            sendResponse({ success: true, data: thread });
        } catch (error) {
            svc.errorHandler.logError('Get PR Thread', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleSendThreadMessage(message, sendResponse) {
        try {
            const { threadId, message: userMessage, metadata = {} } = message.data || message.payload || {};

            if (!threadId || !userMessage) {
                sendResponse({ success: false, error: 'Thread ID and message are required' });
                return;
            }

            console.log('💬 Processing thread message:', threadId);

            // Get thread
            const thread = await svc.prThreadManager.getThread(threadId);
            if (!thread) {
                sendResponse({ success: false, error: 'Thread not found' });
                return;
            }

            // Add user message to thread
            await svc.prThreadManager.addMessage(threadId, {
                role: 'user',
                content: userMessage,
                metadata
            });

            // Process message and get AI response
            const result = await processThreadMessage(threadId, userMessage, thread.finding);

            sendResponse({
                success: true,
                data: {
                    thread: await svc.prThreadManager.getThread(threadId),
                    response: result.response,
                    suggestedQuestions: result.suggestedQuestions
                }
            });
        } catch (error) {
            svc.errorHandler.logError('Send Thread Message', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleThreadQuickAction(message, sendResponse) {
        try {
            const { threadId, actionType } = message.data || message.payload || {};

            if (!threadId || !actionType) {
                sendResponse({ success: false, error: 'Thread ID and action type are required' });
                return;
            }

            console.log('⚡ Processing quick action:', actionType, 'for thread:', threadId);

            // Get thread
            const thread = await svc.prThreadManager.getThread(threadId);
            if (!thread) {
                sendResponse({ success: false, error: 'Thread not found' });
                return;
            }

            // Build appropriate prompt based on action type
            let prompt;
            const finding = thread.finding;

            switch (actionType) {
                case 'explain':
                    prompt = buildExplainPrompt(finding);
                    break;
                case 'fix':
                    prompt = buildHowToFixPrompt(finding);
                    break;
                case 'false-positive':
                    prompt = buildFalsePositiveCheckPrompt(finding);
                    break;
                default:
                    prompt = buildFindingFollowUpPrompt(thread, {}, `Tell me more about this issue: ${actionType}`);
            }

            // Add action as user message
            const actionLabels = {
                'explain': 'Explain this issue in detail',
                'fix': 'How do I fix this issue?',
                'false-positive': 'Could this be a false positive?'
            };

            await svc.prThreadManager.addMessage(threadId, {
                role: 'user',
                content: actionLabels[actionType] || actionType,
                metadata: { actionType }
            });

            // Get AI response
            const settings = await svc.getStoredSettings();
            const response = await svc.llmService.streamChat(
                [
                    { role: 'system', content: THREAD_SYSTEM_PROMPT },
                    { role: 'user', content: prompt }
                ],
                {
                    provider: settings.provider,
                    model: settings.model,
                    apiKey: settings.apiKey,
                    stream: false
                }
            );

            const aiResponse = response.content || response;

            // Add AI response to thread
            await svc.prThreadManager.addMessage(threadId, {
                role: 'assistant',
                content: aiResponse,
                metadata: { actionType }
            });

            // Get suggested follow-up questions
            const suggestedQuestions = getSuggestedQuestions(finding, actionType);

            sendResponse({
                success: true,
                data: {
                    thread: await svc.prThreadManager.getThread(threadId),
                    response: aiResponse,
                    suggestedQuestions
                }
            });
        } catch (error) {
            svc.errorHandler.logError('Thread Quick Action', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleUpdateThreadStatus(message, sendResponse) {
        try {
            const { threadId, status } = message.data || message.payload || {};

            if (!threadId || !status) {
                sendResponse({ success: false, error: 'Thread ID and status are required' });
                return;
            }

            const validStatuses = ['active', 'resolved', 'dismissed'];
            if (!validStatuses.includes(status)) {
                sendResponse({ success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
                return;
            }

            console.log('📋 Updating thread status:', threadId, '->', status);

            const updated = await svc.prThreadManager.updateStatus(threadId, status);

            if (!updated) {
                sendResponse({ success: false, error: 'Failed to update thread status' });
                return;
            }

            sendResponse({
                success: true,
                data: await svc.prThreadManager.getThread(threadId)
            });
        } catch (error) {
            svc.errorHandler.logError('Update Thread Status', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGetOrCreateThread(message, sendResponse) {
        try {
            const { _sessionId, prIdentifier, finding } = message.data || message.payload || {};

            if (!prIdentifier || !finding) {
                sendResponse({ success: false, error: 'PR identifier and finding are required' });
                return;
            }

            // Try to find existing thread for this finding
            const existingThreads = await svc.prThreadManager.getThreadsForPR(prIdentifier);
            let thread = existingThreads.find(t =>
                t.finding?.id === finding.id ||
                (t.finding?.file === finding.file &&
                    t.finding?.lineNumber === finding.lineNumber &&
                    t.finding?.message === finding.message)
            );

            if (!thread) {
                // Create new thread
                thread = await svc.prThreadManager.createThread(prIdentifier, finding);
                console.log('📝 Created new thread for finding:', finding.id || finding.message?.substring(0, 50));
            } else {
                console.log('📂 Found existing thread for finding:', thread.threadId);
            }

            sendResponse({ success: true, data: thread });
        } catch (error) {
            svc.errorHandler.logError('Get Or Create Thread', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    async function handleGetPRSession(message, sendResponse) {
        try {
            const { sessionId, prIdentifier } = message.data || message.payload || {};

            let session;

            if (sessionId) {
                session = await svc.prSessionManager.getSession(sessionId);
            } else if (prIdentifier) {
                // Try to find session by PR identifier
                const sessions = await svc.prSessionManager.getRecentSessions(100);
                session = sessions.find(s =>
                    s.prIdentifier?.url === prIdentifier.url ||
                    (s.prIdentifier?.owner === prIdentifier.owner &&
                        s.prIdentifier?.repo === prIdentifier.repo &&
                        s.prIdentifier?.prNumber === prIdentifier.prNumber)
                );
            }

            if (!session) {
                sendResponse({ success: false, error: 'Session not found' });
                return;
            }

            // Get all threads for this PR
            const threads = await svc.prThreadManager.getThreadsForPR(session.prIdentifier);

            sendResponse({
                success: true,
                data: { session, threads }
            });
        } catch (error) {
            svc.errorHandler.logError('Get PR Session', error);
            sendResponse({ success: false, error: svc.getErrorMessage(error) });
        }
    }

    return {
        CREATE_PR_THREAD: handleCreatePRThread,
        GET_PR_THREAD: handleGetPRThread,
        SEND_THREAD_MESSAGE: handleSendThreadMessage,
        THREAD_QUICK_ACTION: handleThreadQuickAction,
        UPDATE_THREAD_STATUS: handleUpdateThreadStatus,
        GET_OR_CREATE_THREAD: handleGetOrCreateThread,
        GET_PR_SESSION: handleGetPRSession,
    };
}
