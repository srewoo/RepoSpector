// Error boundary implementation for Chrome extension
export class ErrorBoundary {
    constructor() {
        this.errorHandlers = new Map();
        this.errorLog = [];
        this.maxLogSize = 50;
        this.setupGlobalHandlers();
    }

    /**
     * Setup global error handlers
     */
    setupGlobalHandlers() {
        // Handle uncaught errors
        window.addEventListener('error', (event) => {
            this.handleError({
                message: event.message,
                source: event.filename,
                line: event.lineno,
                column: event.colno,
                error: event.error,
                type: 'uncaught'
            });
            event.preventDefault();
        });

        // Handle unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            this.handleError({
                message: event.reason?.message || 'Unhandled promise rejection',
                error: event.reason,
                type: 'unhandledRejection'
            });
            event.preventDefault();
        });
    }

    /**
     * Wrap a function with error boundary
     */
    wrap(fn, context = 'unknown') {
        return (...args) => {
            try {
                const result = fn.apply(this, args);
                
                // Handle promises
                if (result && typeof result.then === 'function') {
                    return result.catch(error => {
                        this.handleError({
                            error,
                            context,
                            type: 'async'
                        });
                        throw error;
                    });
                }
                
                return result;
            } catch (error) {
                this.handleError({
                    error,
                    context,
                    type: 'sync'
                });
                throw error;
            }
        };
    }

    /**
     * Wrap async functions with error boundary
     */
    wrapAsync(fn, context = 'unknown') {
        return async (...args) => {
            try {
                return await fn.apply(this, args);
            } catch (error) {
                this.handleError({
                    error,
                    context,
                    type: 'async'
                });
                throw error;
            }
        };
    }

    /**
     * Handle errors with recovery strategies
     */
    handleError(errorInfo) {
        const error = this.normalizeError(errorInfo);
        
        // Log the error
        this.logError(error);
        
        // Execute recovery strategy
        const recovery = this.getRecoveryStrategy(error);
        if (recovery) {
            recovery(error);
        }
        
        // Show user-friendly error message
        this.showErrorNotification(error);
        
        // Report to error tracking service (if configured)
        this.reportError(error);
    }

    /**
     * Normalize error information
     */
    normalizeError(errorInfo) {
        const error = {
            timestamp: new Date().toISOString(),
            message: '',
            stack: '',
            context: errorInfo.context || 'unknown',
            type: errorInfo.type || 'unknown',
            userAgent: navigator.userAgent,
            url: window.location.href
        };

        if (errorInfo.error instanceof Error) {
            error.message = errorInfo.error.message;
            error.stack = errorInfo.error.stack;
            error.name = errorInfo.error.name;
        } else if (errorInfo.message) {
            error.message = errorInfo.message;
        } else {
            error.message = 'Unknown error occurred';
        }

        // Add additional context
        if (errorInfo.source) error.source = errorInfo.source;
        if (errorInfo.line) error.line = errorInfo.line;
        if (errorInfo.column) error.column = errorInfo.column;

        return error;
    }

    /**
     * Log error to storage
     */
    logError(error) {
        this.errorLog.unshift(error);
        
        // Maintain log size
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog = this.errorLog.slice(0, this.maxLogSize);
        }
        
        // Save to storage
        chrome.storage.local.set({ errorLog: this.errorLog });
    }

    /**
     * Get recovery strategy for specific error types
     */
    getRecoveryStrategy(error) {
        // API key errors
        if (error.message.includes('API key') || error.message.includes('401')) {
            return () => {
                // Clear invalid API key
                chrome.storage.sync.remove(['openai_api_key']);
                // Show settings modal
                if (window.openSettingsModal) {
                    window.openSettingsModal();
                }
            };
        }

        // Rate limit errors
        if (error.message.includes('429') || error.message.includes('rate limit')) {
            return () => {
                // Implement backoff strategy
                const backoffTime = 60000; // 1 minute
                chrome.storage.local.set({ 
                    rateLimitedUntil: Date.now() + backoffTime 
                });
            };
        }

        // Network errors
        if (error.message.includes('network') || error.message.includes('fetch')) {
            return () => {
                // Enable offline mode or retry
                chrome.storage.local.set({ offlineMode: true });
            };
        }

        // Storage errors
        if (error.message.includes('storage') || error.message.includes('quota')) {
            return () => {
                // Clear old cache
                chrome.storage.local.clear();
            };
        }

        return null;
    }

    /**
     * Show user-friendly error notification
     */
    showErrorNotification(error) {
        const messages = {
            'API key': 'Please check your API key in settings.',
            'rate limit': 'Rate limit exceeded. Please try again in a minute.',
            'network': 'Network error. Please check your connection.',
            'storage': 'Storage quota exceeded. Clearing cache...',
            'syntax': 'Code syntax error detected.',
            'timeout': 'Request timed out. Please try again.'
        };

        let userMessage = 'An error occurred. Please try again.';
        
        // Find appropriate message
        for (const [key, message] of Object.entries(messages)) {
            if (error.message.toLowerCase().includes(key)) {
                userMessage = message;
                break;
            }
        }

        // Create notification element
        const notification = document.createElement('div');
        notification.className = 'error-notification';
        notification.innerHTML = `
            <div class="error-icon">⚠️</div>
            <div class="error-content">
                <div class="error-title">Error</div>
                <div class="error-message">${this.escapeHtml(userMessage)}</div>
            </div>
            <button class="error-close" onclick="this.parentElement.remove()">✕</button>
        `;

        // Add styles
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #fee;
            border: 1px solid #fcc;
            border-radius: 8px;
            padding: 16px;
            display: flex;
            align-items: center;
            gap: 12px;
            max-width: 400px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            z-index: 10000;
            animation: slideIn 0.3s ease;
        `;

        document.body.appendChild(notification);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    /**
     * Escape HTML for safe display
     */
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Report error to tracking service
     */
    reportError(error) {
        // In production, this would send to Sentry, LogRocket, etc.
        if (chrome.runtime.lastError) {
            console.error('Chrome runtime error:', chrome.runtime.lastError);
        }
        
        console.error('Error boundary caught:', error);
    }

    /**
     * Register custom error handler
     */
    registerHandler(errorType, handler) {
        this.errorHandlers.set(errorType, handler);
    }

    /**
     * Get error logs
     */
    async getErrorLogs() {
        const result = await chrome.storage.local.get(['errorLog']);
        return result.errorLog || [];
    }

    /**
     * Clear error logs
     */
    async clearErrorLogs() {
        this.errorLog = [];
        await chrome.storage.local.remove(['errorLog']);
    }
}

// Export singleton instance
export const errorBoundary = new ErrorBoundary(); 