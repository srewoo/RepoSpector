// Error handling and logging utilities
// Provides comprehensive error handling, logging, and user-friendly error messages

export class ErrorHandler {
    constructor() {
        this.errorCounts = new Map();
        this.maxRetries = 3;
        this.logHistory = [];
        this.maxLogHistory = 100;
        // Add properties expected by tests
        this.errorLog = [];
        this.maxLogSize = 50;
    }

    /**
     * Safely extract error message from any error type
     * @param {*} error - Error object, string, or any value
     * @returns {string} - Safe error message string
     */
    safeGetMessage(error) {
        if (!error) return 'Unknown error';
        if (typeof error === 'string') return error;
        if (error.message && typeof error.message === 'string') return error.message;
        try {
            const str = error.toString?.();
            if (str && typeof str === 'string' && str !== '[object Object]') {
                return str;
            }
        } catch (e) {
            // ignore toString errors
        }
        try {
            return String(error);
        } catch (e) {
            return 'Unknown error';
        }
    }

    handleExtensionError(error, context = 'Unknown', userFriendly = true) {
        // Safely extract error details
        const safeMessage = this.safeGetMessage(error);
        const errorInfo = {
            timestamp: new Date().toISOString(),
            context,
            message: safeMessage,
            stack: error?.stack || '',
            type: error?.constructor?.name || 'Unknown'
        };

        // Log the error
        this.logError(errorInfo);

        // Return user-friendly message if requested
        if (userFriendly) {
            return this.getUserFriendlyMessage(error, context);
        }

        return error.message || 'An error occurred';
    }

    // Add handleApiError method expected by tests (lowercase 'a')
    handleApiError(error, endpoint = 'API') {
        let message = 'API request failed';
        const errorMsg = this.safeGetMessage(error);

        if (error?.status) {
            switch (error.status) {
                case 401:
                    message = 'Invalid API key. Please check your OpenAI API key in the settings.';
                    break;
                case 403:
                    message = 'API access forbidden. Check your API key permissions.';
                    break;
                case 429:
                    message = 'Rate limit exceeded. Please wait a moment and try again.';
                    break;
                case 500:
                case 502:
                case 503:
                    message = 'OpenAI service temporarily unavailable. Please try again later.';
                    break;
                case 400:
                    message = 'Invalid request. The code might be too long or contain invalid characters.';
                    break;
                default:
                    message = `API error (${error.status}): ${errorMsg}`;
            }
        } else if (errorMsg && errorMsg !== 'Unknown error') {
            if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
                message = 'Network error. Please check your internet connection.';
            } else if (errorMsg.includes('timeout')) {
                message = 'Request timed out. Please check your internet connection and try again.';
            } else {
                message = `An error occurred: ${errorMsg}`;
            }
        }

        // Add to error log as expected by tests
        const logEntry = {
            timestamp: new Date().toISOString(),
            context: endpoint,
            error: errorMsg,
            type: 'api'
        };

        this.errorLog.push(logEntry);

        // Maintain max log size
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog = this.errorLog.slice(-this.maxLogSize);
        }

        // Persist to storage
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ errorLog: this.errorLog });
        }

        return message;
    }

    handleAPIError(error, endpoint = 'API') {
        let message = 'API request failed';
        let code = 'UNKNOWN_ERROR';
        const errorMsg = this.safeGetMessage(error);

        if (error?.status) {
            switch (error.status) {
                case 401:
                    message = 'Invalid API key. Please check your OpenAI API key in settings.';
                    code = 'INVALID_API_KEY';
                    break;
                case 403:
                    message = 'API access forbidden. Check your API key permissions.';
                    code = 'ACCESS_FORBIDDEN';
                    break;
                case 429:
                    message = 'Rate limit exceeded. Please wait a moment and try again.';
                    code = 'RATE_LIMITED';
                    break;
                case 500:
                case 502:
                case 503:
                    message = 'OpenAI service temporarily unavailable. Please try again later.';
                    code = 'SERVICE_UNAVAILABLE';
                    break;
                case 400:
                    message = 'Invalid request. The code might be too long or contain invalid characters.';
                    code = 'BAD_REQUEST';
                    break;
                default:
                    message = `API error (${error.status}): ${errorMsg}`;
                    code = `HTTP_${error.status}`;
            }
        } else if (errorMsg && errorMsg !== 'Unknown error') {
            if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
                message = 'Network connection failed. Check your internet connection.';
                code = 'NETWORK_ERROR';
            } else if (errorMsg.includes('timeout')) {
                message = 'Request timed out. The operation took too long to complete.';
                code = 'TIMEOUT_ERROR';
            } else {
                message = errorMsg;
                code = 'GENERAL_ERROR';
            }
        }

        this.logError({
            timestamp: new Date().toISOString(),
            context: endpoint,
            message,
            code,
            originalError: error
        });

        return { message, code };
    }

    handleCodeExtractionError(error, pageUrl = '') {
        let message = 'Failed to extract code from the page';
        const errorMsg = this.safeGetMessage(error);

        if (errorMsg && errorMsg !== 'Unknown error') {
            if (errorMsg.includes('permission')) {
                message = 'Permission denied. The extension may not have access to this page.';
            } else if (errorMsg.includes('No code found')) {
                message = 'No code was found on this page. Try selecting code manually or navigate to a code page.';
            } else if (errorMsg.includes('selector')) {
                message = 'Unable to locate code on this page. The page structure may have changed.';
            }
        }

        this.logError({
            timestamp: new Date().toISOString(),
            context: 'Code Extraction',
            message: errorMsg,
            pageUrl,
            originalError: error
        });

        return message;
    }

    handleTestGenerationError(error, codeLength = 0) {
        let message = 'Failed to generate test cases';
        const errorMsg = this.safeGetMessage(error);

        if (errorMsg && errorMsg !== 'Unknown error') {
            if (errorMsg.includes('token') || errorMsg.includes('length')) {
                message = 'The code is too long for processing. Try selecting a smaller code section.';
            } else if (errorMsg.includes('API key')) {
                message = 'Invalid API key. Please check your OpenAI API key in settings.';
            } else if (errorMsg.includes('rate limit')) {
                message = 'Rate limit exceeded. Please wait a moment and try again.';
            } else if (errorMsg.includes('model')) {
                message = 'The selected AI model is not available. Try switching to a different model.';
            }
        }

        this.logError({
            timestamp: new Date().toISOString(),
            context: 'Test Generation',
            message: errorMsg,
            codeLength,
            originalError: error
        });

        return message;
    }

    getUserFriendlyMessage(error, context) {
        // Safely extract error message
        const errorMessage = this.safeGetMessage(error);
        const _lowerMessage = errorMessage.toLowerCase();

        // Handle specific error patterns for extension errors
        if (context === 'Extension') {
            if (errorMessage.includes('Cannot read properties') || errorMessage.includes('undefined')) {
                return 'Unable to access page content. Please refresh the page and try again.';
            }
            if (errorMessage.includes('tabs API') || errorMessage.includes('tab')) {
                return 'Unable to access the current tab. Please make sure you\'re on a valid webpage.';
            }
            if (errorMessage.includes('permission') || errorMessage.includes('access')) {
                return 'Access denied. The extension may not have permission to access this page.';
            }
        }

        // Common error patterns and their user-friendly messages
        const errorPatterns = [
            {
                pattern: /network|fetch|connection/i,
                message: 'Network connection failed. Please check your internet connection and try again.'
            },
            {
                pattern: /timeout/i,
                message: 'The operation timed out. Please try again with a smaller code selection.'
            },
            {
                pattern: /api key|unauthorized|401/i,
                message: 'Invalid API key. Please check your OpenAI API key in settings.'
            },
            {
                pattern: /rate limit|429/i,
                message: 'Too many requests. Please wait a moment and try again.'
            },
            {
                pattern: /quota|billing/i,
                message: 'API quota exceeded. Please check your OpenAI account billing and usage.'
            },
            {
                pattern: /model|engine/i,
                message: 'The selected AI model is not available. Try switching to a different model.'
            },
            {
                pattern: /token|length|too long/i,
                message: 'The code is too long for processing. Try selecting a smaller section.'
            },
            {
                pattern: /permission|access|forbidden|403/i,
                message: 'Access denied. The extension may not have permission to access this page.'
            },
            {
                pattern: /storage/i,
                message: 'Failed to save settings. Please check browser storage permissions.'
            },
            {
                pattern: /extension|chrome/i,
                message: 'Extension error. Try reloading the page or restarting your browser.'
            }
        ];

        // Find matching pattern
        for (const { pattern, message } of errorPatterns) {
            if (pattern.test(errorMessage)) {
                return message;
            }
        }

        // Default messages by context
        const contextMessages = {
            'API': 'API request failed. Please try again later.',
            'Code Extraction': 'Failed to extract code from the page. Try selecting code manually.',
            'Test Generation': 'Failed to generate test cases. Please try again.',
            'Settings': 'Failed to save settings. Please try again.',
            'Storage': 'Failed to access browser storage. Check browser permissions.',
            'Network': 'Network error occurred. Check your internet connection.'
        };

        return contextMessages[context] || 'An unexpected error occurred. Please try again.';
    }

    // Add methods expected by tests
    clearErrorLog() {
        this.errorLog = [];
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.remove(['errorLog']);
        }
    }

    async loadErrorLog() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            try {
                const result = await chrome.storage.local.get(['errorLog']);
                if (result.errorLog) {
                    this.errorLog = result.errorLog;
                }
            } catch (error) {
                console.error('Failed to load error log:', error);
            }
        }
    }

    logError(errorInfo) {
        // Add to main log history
        this.logHistory.push(errorInfo);
        
        // Maintain max history size
        if (this.logHistory.length > this.maxLogHistory) {
            this.logHistory = this.logHistory.slice(-this.maxLogHistory);
        }

        // Store critical errors
        if (this.isCriticalError(errorInfo)) {
            this.storeCriticalError(errorInfo);
        }

        // Log to console in development
        if (process.env.NODE_ENV === 'development') {
            console.error(`[${errorInfo.context}]`, errorInfo);
        }
    }

    isCriticalError(errorInfo) {
        const criticalPatterns = [
            /api key/i,
            /unauthorized/i,
            /permission/i,
            /quota/i,
            /billing/i,
            /network/i,
            /timeout/i
        ];

        return criticalPatterns.some(pattern => 
            pattern.test(errorInfo.message) || 
            pattern.test(errorInfo.context)
        );
    }

    async storeCriticalError(errorInfo) {
        try {
            const storageKey = `critical_error_${Date.now()}`;
            const errorData = {
                ...errorInfo,
                severity: 'critical',
                userAgent: navigator.userAgent,
                url: (typeof window !== 'undefined' && window.location?.href) || 'service-worker'
            };

            // Store in Chrome storage
            if (typeof chrome !== 'undefined' && chrome.storage) {
                await chrome.storage.local.set({
                    [storageKey]: errorData
                });
            }
        } catch (error) {
            console.error('Failed to store critical error:', error);
        }
    }

    async getErrorReport() {
        const report = {
            timestamp: new Date().toISOString(),
            totalErrors: this.logHistory.length,
            recentErrors: this.logHistory.slice(-10),
            errorCounts: Object.fromEntries(this.errorCounts),
            systemInfo: {
                userAgent: navigator.userAgent,
                platform: navigator.platform,
                language: navigator.language
            }
        };

        return report;
    }

    clearErrorHistory() {
        this.logHistory = [];
        this.errorCounts.clear();
        
        // Clear from storage
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.clear();
        }
    }

    async retryOperation(operation, maxRetries = this.maxRetries, delay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await operation();
                return result;
            } catch (error) {
                lastError = error;
                
                // Don't retry if it's not a retryable error
                if (!this.isRetryableError(error)) {
                    throw error;
                }
                
                // Don't wait after the last attempt
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delay * attempt));
                }
            }
        }
        
        // All retries failed
        throw lastError;
    }

    isRetryableError(error) {
        // Network errors, timeouts, and temporary server errors are retryable
        const retryablePatterns = [
            /network/i,
            /timeout/i,
            /fetch/i,
            /connection/i
        ];

        const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
        const errorMsg = this.safeGetMessage(error);

        return retryablePatterns.some(pattern => pattern.test(errorMsg)) ||
               retryableStatusCodes.includes(error?.status);
    }

    // Alias for compatibility - some code might call shouldRetry instead of isRetryableError
    shouldRetry(error) {
        return this.isRetryableError(error);
    }

    async safeExecute(operation, context = 'Operation', fallbackValue = null) {
        try {
            return await operation();
        } catch (error) {
            this.handleExtensionError(error, context);
            return fallbackValue;
        }
    }

    createError(message, context = 'Extension Error', details = {}) {
        const error = new Error(message);
        error.context = context;
        error.details = details;
        error.timestamp = new Date().toISOString();
        return error;
    }
}

// Export singleton instance
export const errorHandler = new ErrorHandler(); 