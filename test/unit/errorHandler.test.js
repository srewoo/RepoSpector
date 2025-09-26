const { ErrorHandler } = require('../../src/utils/errorHandler.js');

describe('ErrorHandler', () => {
    let errorHandler;

    beforeEach(() => {
        errorHandler = new ErrorHandler();
        global.chrome = {
            storage: {
                local: {
                    set: jest.fn(),
                    get: jest.fn(),
                    remove: jest.fn()
                }
            }
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('handleApiError', () => {
        it('should handle 401 authentication errors', () => {
            const error = { status: 401, message: 'Unauthorized' };
            const result = errorHandler.handleApiError(error, 'API call');

            expect(result).toBe('Invalid API key. Please check your OpenAI API key in the settings.');
        });

        it('should handle 429 rate limit errors', () => {
            const error = { status: 429, message: 'Rate limit exceeded' };
            const result = errorHandler.handleApiError(error, 'API call');

            expect(result).toBe('Rate limit exceeded. Please wait a moment and try again.');
        });

        it('should handle timeout errors', () => {
            const error = { message: 'Request timeout' };
            const result = errorHandler.handleApiError(error, 'API call');

            expect(result).toBe('Request timed out. Please check your internet connection and try again.');
        });

        it('should handle network errors', () => {
            const error = { message: 'network error occurred' };
            const result = errorHandler.handleApiError(error, 'API call');

            expect(result).toBe('Network error. Please check your internet connection.');
        });

        it('should handle generic errors', () => {
            const error = { message: 'Something went wrong' };
            const result = errorHandler.handleApiError(error, 'API call');

            expect(result).toBe('An error occurred: Something went wrong');
        });
    });

    describe('handleExtensionError', () => {
        it('should handle property access errors', () => {
            const error = { message: 'Cannot read properties of undefined' };
            const result = errorHandler.handleExtensionError(error, 'Extension');

            expect(result).toBe('Unable to access page content. Please refresh the page and try again.');
        });

        it('should handle tab access errors', () => {
            const error = { message: 'Error accessing tabs API' };
            const result = errorHandler.handleExtensionError(error, 'Extension');

            expect(result).toBe('Unable to access the current tab. Please make sure you\'re on a valid webpage.');
        });
    });

    describe('Error logging', () => {
        it('should add errors to log', () => {
            const error = { message: 'Test error' };
            errorHandler.handleApiError(error, 'Test context');

            expect(errorHandler.errorLog.length).toBe(1);
            expect(errorHandler.errorLog[0]).toMatchObject({
                context: 'Test context',
                error: 'Test error',
                type: 'api'
            });
        });

        it('should maintain max log size', () => {
            // Add more than maxLogSize errors
            for (let i = 0; i < 60; i++) {
                errorHandler.handleApiError({ message: `Error ${i}` }, 'Test');
            }

            expect(errorHandler.errorLog.length).toBe(50);
            expect(errorHandler.errorLog[0].error).toBe('Error 10');
        });

        it('should persist errors to storage', () => {
            const error = { message: 'Test error' };
            errorHandler.handleApiError(error, 'Test context');

            expect(chrome.storage.local.set).toHaveBeenCalledWith({
                errorLog: expect.arrayContaining([
                    expect.objectContaining({
                        error: 'Test error',
                        type: 'api'
                    })
                ])
            });
        });

        it('should clear error log', () => {
            errorHandler.handleApiError({ message: 'Test error' }, 'Test');
            errorHandler.clearErrorLog();

            expect(errorHandler.errorLog.length).toBe(0);
            expect(chrome.storage.local.remove).toHaveBeenCalledWith(['errorLog']);
        });

        it('should load error log from storage', async () => {
            const storedLog = [
                { timestamp: '2023-01-01', error: 'Stored error', type: 'api' }
            ];
            chrome.storage.local.get.mockResolvedValue({ errorLog: storedLog });

            await errorHandler.loadErrorLog();

            expect(errorHandler.errorLog).toEqual(storedLog);
        });
    });
}); 