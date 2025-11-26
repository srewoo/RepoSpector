import { useState, useCallback } from 'react';

// Helper function for mocking responses when not in an extension environment
const mockResponse = async (type, payload) => {
    console.warn(`Mocking response for type: ${type}, payload:`, payload);
    await new Promise(resolve => setTimeout(resolve, 500)); // Simulate network delay

    switch (type) {
        case 'INIT_RAG':
            if (!payload.apiKey) {
                return { success: false, error: 'API Key is required for RAG initialization.' };
            }
            return { success: true, data: 'RAG initialized successfully with mock data.' };
        case 'INDEX_REPO':
            if (!payload.repoId || !payload.files) {
                return { success: false, error: 'Repo ID and files are required for indexing.' };
            }
            return { success: true, data: `Mock indexing complete for repo ${payload.repoId} with ${payload.files.length} files.` };
        case 'RETRIEVE_CONTEXT':
            if (!payload.repoId || !payload.query) {
                return { success: false, error: 'Repo ID and query are required for context retrieval.' };
            }
            return { success: true, data: `Mock context for query "${payload.query}" in repo ${payload.repoId}: This is a mock context relevant to your query.` };
        default:
            return { success: true, data: `Mock response for unknown type: ${type}` };
    }
};

export function useExtension() {
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    // Check if we're in an iframe
    const isInIframe = window.self !== window.top;

    const sendMessage = async (type, payload) => {
        setIsLoading(true);
        setError(null);
        try {
            // If in iframe, use postMessage to parent
            if (isInIframe) {
                console.log('📤 Sending message from iframe:', type);
                return new Promise((resolve) => {
                    const requestId = `${type}_${Date.now()}_${Math.random()}`;

                    const messageHandler = (event) => {
                        if (event.data.responseId === requestId) {
                            window.removeEventListener('message', messageHandler);
                            resolve(event.data.response);
                        }
                    };

                    window.addEventListener('message', messageHandler);

                    // Send to parent window (content script)
                    window.parent.postMessage({ type, payload, requestId }, '*');

                    // Timeout after 2 minutes (120 seconds)
                    setTimeout(() => {
                        window.removeEventListener('message', messageHandler);
                        resolve({ success: false, error: 'Request timeout after 2 minutes' });
                    }, 120000);
                });
            }

            // In a real extension, this uses chrome.runtime.sendMessage
            // For development/mocking, we can simulate responses
            if (!chrome?.runtime?.sendMessage) {
                console.warn('Chrome runtime not available, using mock response');
                return mockResponse(type, payload);
            }

            // Generate requestId for all messages for correlation
            const requestId = `${type}_${Date.now()}_${Math.random()}`;

            // Add requestId to payload options if it has options
            if (payload && payload.options) {
                payload.options.requestId = requestId;
            } else if (payload) {
                payload.requestId = requestId;
            }

            const response = await chrome.runtime.sendMessage({ type, payload, requestId });

            if (!response) {
                throw new Error('No response from extension');
            }

            if (!response.success) {
                throw new Error(response.error || 'Unknown error');
            }

            // Include requestId in response for correlation
            response.requestId = requestId;
            return response;
        } catch (err) {
            setError(err.message);
            return { success: false, error: err.message };
        } finally {
            setIsLoading(false);
        }
    };

    const initRAG = async (apiKey) => {
        return sendMessage('INIT_RAG', { apiKey });
    };

    const indexRepo = async (repoId, files) => {
        return sendMessage('INDEX_REPO', { repoId, files });
    };

    const retrieveContext = async (repoId, query) => {
        return sendMessage('RETRIEVE_CONTEXT', { repoId, query });
    };

    const checkIndexed = async (repoId) => {
        return sendMessage('CHECK_INDEXED', { repoId });
    };

    const autoIndexRepo = async (url, provider, apiKey, token) => {
        return sendMessage('AUTO_INDEX_REPO', { url, provider, apiKey, token });
    };

    return {
        sendMessage,
        initRAG,
        indexRepo,
        retrieveContext,
        checkIndexed,
        autoIndexRepo,
        isLoading,
        error
    };
}
