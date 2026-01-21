/**
 * usePRThread Hook for RepoSpector
 *
 * React hook for managing PR thread conversations.
 */

import { useState, useCallback, useEffect } from 'react';

/**
 * Hook for managing a single PR thread conversation
 */
export function usePRThread(initialThreadId = null) {
    const [thread, setThread] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [sending, setSending] = useState(false);

    // Load thread on mount or when threadId changes
    useEffect(() => {
        if (initialThreadId) {
            loadThread(initialThreadId);
        }
    }, [initialThreadId]);

    /**
     * Load thread from background service
     */
    const loadThread = useCallback(async (threadId) => {
        setLoading(true);
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_PR_THREAD',
                data: { threadId }
            });

            if (response.success) {
                setThread(response.data);
            } else {
                setError(response.error || 'Failed to load thread');
            }
        } catch (err) {
            setError(err.message || 'Failed to load thread');
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Create a new thread for a finding
     */
    const createThread = useCallback(async (sessionId, prIdentifier, finding, initialQuestion = null) => {
        setLoading(true);
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'CREATE_PR_THREAD',
                data: {
                    sessionId,
                    prIdentifier,
                    finding,
                    initialQuestion
                }
            });

            if (response.success) {
                setThread(response.data);
                return response.data;
            } else {
                setError(response.error || 'Failed to create thread');
                return null;
            }
        } catch (err) {
            setError(err.message || 'Failed to create thread');
            return null;
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Send a message in the thread
     */
    const sendMessage = useCallback(async (content, metadata = {}) => {
        if (!thread?.threadId) {
            setError('No active thread');
            return null;
        }

        setSending(true);
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'SEND_THREAD_MESSAGE',
                data: {
                    threadId: thread.threadId,
                    message: content,
                    metadata
                }
            });

            if (response.success) {
                setThread(response.data.thread);
                return response.data;
            } else {
                setError(response.error || 'Failed to send message');
                return null;
            }
        } catch (err) {
            setError(err.message || 'Failed to send message');
            return null;
        } finally {
            setSending(false);
        }
    }, [thread]);

    /**
     * Send a quick action (explain, fix, false positive check)
     */
    const sendQuickAction = useCallback(async (actionType) => {
        if (!thread?.threadId) {
            setError('No active thread');
            return null;
        }

        setSending(true);
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'THREAD_QUICK_ACTION',
                data: {
                    threadId: thread.threadId,
                    actionType
                }
            });

            if (response.success) {
                setThread(response.data.thread);
                return response.data;
            } else {
                setError(response.error || 'Failed to execute action');
                return null;
            }
        } catch (err) {
            setError(err.message || 'Failed to execute action');
            return null;
        } finally {
            setSending(false);
        }
    }, [thread]);

    /**
     * Update thread status
     */
    const updateStatus = useCallback(async (status) => {
        if (!thread?.threadId) return;

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'UPDATE_THREAD_STATUS',
                data: {
                    threadId: thread.threadId,
                    status
                }
            });

            if (response.success) {
                setThread(prev => ({ ...prev, status }));
            }
        } catch (err) {
            console.error('Failed to update thread status:', err);
        }
    }, [thread]);

    /**
     * Mark thread as resolved
     */
    const markResolved = useCallback(() => {
        return updateStatus('resolved');
    }, [updateStatus]);

    /**
     * Dismiss thread
     */
    const dismiss = useCallback(() => {
        return updateStatus('dismissed');
    }, [updateStatus]);

    /**
     * Clear error
     */
    const clearError = useCallback(() => {
        setError(null);
    }, []);

    return {
        thread,
        loading,
        error,
        sending,
        loadThread,
        createThread,
        sendMessage,
        sendQuickAction,
        markResolved,
        dismiss,
        clearError
    };
}

/**
 * Hook for managing multiple threads in a session
 */
export function usePRSession(sessionId) {
    const [session, setSession] = useState(null);
    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // Load session on mount
    useEffect(() => {
        if (sessionId) {
            loadSession(sessionId);
        }
    }, [sessionId]);

    /**
     * Load session and its threads
     */
    const loadSession = useCallback(async (id) => {
        setLoading(true);
        setError(null);

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_PR_SESSION',
                data: { sessionId: id }
            });

            if (response.success) {
                setSession(response.data.session);
                setThreads(response.data.threads || []);
            } else {
                setError(response.error || 'Failed to load session');
            }
        } catch (err) {
            setError(err.message || 'Failed to load session');
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Refresh session data
     */
    const refresh = useCallback(() => {
        if (sessionId) {
            loadSession(sessionId);
        }
    }, [sessionId, loadSession]);

    /**
     * Get thread for a specific finding
     */
    const getThreadForFinding = useCallback((findingId) => {
        return threads.find(t => t.finding?.id === findingId);
    }, [threads]);

    return {
        session,
        threads,
        loading,
        error,
        refresh,
        getThreadForFinding
    };
}

export default usePRThread;
