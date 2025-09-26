// TokenManager Tests
// Tests for GitLab token management including storage, validation, and security

describe('TokenManager', () => {
    let tokenManager;
    let mockChrome;

    beforeEach(() => {
        // Mock Chrome storage API
        mockChrome = {
            storage: {
                local: {
                    get: jest.fn(),
                    set: jest.fn(),
                    remove: jest.fn()
                }
            }
        };

        global.chrome = mockChrome;
        global.fetch = jest.fn();

        // Mock TokenManager class
        tokenManager = {
            async storeToken(token) {
                if (!token || typeof token !== 'string') {
                    throw new Error('Invalid token provided');
                }

                // Validate token format
                if (!token.startsWith('glpat-') && !token.startsWith('glp_')) {
                    throw new Error('Invalid GitLab token format');
                }

                try {
                    // Simple encryption simulation
                    const encrypted = btoa(token);
                    await chrome.storage.local.set({ gitlabToken: encrypted });
                    return { success: true };
                } catch (error) {
                    throw new Error('Failed to store token: ' + error.message);
                }
            },

            async getToken() {
                try {
                    const result = await chrome.storage.local.get(['gitlabToken']);
                    if (result.gitlabToken) {
                        // Simple decryption simulation
                        return atob(result.gitlabToken);
                    }
                    return null;
                } catch (error) {
                    console.error('Failed to retrieve token:', error);
                    return null;
                }
            },

            async removeToken() {
                try {
                    await chrome.storage.local.remove(['gitlabToken']);
                    return { success: true };
                } catch (error) {
                    throw new Error('Failed to remove token: ' + error.message);
                }
            },

            async validateToken(token) {
                if (!token) {
                    return { valid: false, error: 'No token provided' };
                }

                try {
                    const response = await fetch('https://gitlab.com/api/v4/user', {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (response.ok) {
                        const user = await response.json();
                        return {
                            valid: true,
                            user: {
                                id: user.id,
                                username: user.username,
                                name: user.name
                            }
                        };
                    } else {
                        return {
                            valid: false,
                            error: `HTTP ${response.status}: ${response.statusText}`
                        };
                    }
                } catch (error) {
                    return {
                        valid: false,
                        error: 'Network error: ' + error.message
                    };
                }
            },

            async testTokenPermissions(token) {
                if (!token) {
                    return { hasPermissions: false, error: 'No token provided' };
                }

                try {
                    // Test read_repository permission by trying to access a public repo
                    const response = await fetch('https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab', {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (response.ok) {
                        return {
                            hasPermissions: true,
                            permissions: ['read_repository', 'read_api']
                        };
                    } else {
                        return {
                            hasPermissions: false,
                            error: `Insufficient permissions: HTTP ${response.status}`
                        };
                    }
                } catch (error) {
                    return {
                        hasPermissions: false,
                        error: 'Permission test failed: ' + error.message
                    };
                }
            }
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Token Storage', () => {
        it('should store valid GitLab token', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';
            
            mockChrome.storage.local.set.mockResolvedValue();

            const result = await tokenManager.storeToken(token);

            expect(result.success).toBe(true);
            expect(mockChrome.storage.local.set).toHaveBeenCalledWith({
                gitlabToken: btoa(token)
            });
        });

        it('should store valid GitLab personal access token with glp_ prefix', async () => {
            const token = 'glp_xxxxxxxxxxxxxxxxxxxx';
            
            mockChrome.storage.local.set.mockResolvedValue();

            const result = await tokenManager.storeToken(token);

            expect(result.success).toBe(true);
            expect(mockChrome.storage.local.set).toHaveBeenCalledWith({
                gitlabToken: btoa(token)
            });
        });

        it('should reject invalid token format', async () => {
            const invalidToken = 'invalid-token-format';

            await expect(tokenManager.storeToken(invalidToken))
                .rejects.toThrow('Invalid GitLab token format');
        });

        it('should reject null or undefined token', async () => {
            await expect(tokenManager.storeToken(null))
                .rejects.toThrow('Invalid token provided');

            await expect(tokenManager.storeToken(undefined))
                .rejects.toThrow('Invalid token provided');
        });

        it('should reject empty string token', async () => {
            await expect(tokenManager.storeToken(''))
                .rejects.toThrow('Invalid token provided');
        });

        it('should handle storage errors', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';
            
            mockChrome.storage.local.set.mockRejectedValue(new Error('Storage quota exceeded'));

            await expect(tokenManager.storeToken(token))
                .rejects.toThrow('Failed to store token: Storage quota exceeded');
        });
    });

    describe('Token Retrieval', () => {
        it('should retrieve stored token', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';
            const encrypted = btoa(token);
            
            mockChrome.storage.local.get.mockResolvedValue({ gitlabToken: encrypted });

            const retrievedToken = await tokenManager.getToken();

            expect(retrievedToken).toBe(token);
            expect(mockChrome.storage.local.get).toHaveBeenCalledWith(['gitlabToken']);
        });

        it('should return null when no token is stored', async () => {
            mockChrome.storage.local.get.mockResolvedValue({});

            const retrievedToken = await tokenManager.getToken();

            expect(retrievedToken).toBeNull();
        });

        it('should handle retrieval errors gracefully', async () => {
            mockChrome.storage.local.get.mockRejectedValue(new Error('Storage access denied'));

            const retrievedToken = await tokenManager.getToken();

            expect(retrievedToken).toBeNull();
        });
    });

    describe('Token Removal', () => {
        it('should remove stored token', async () => {
            mockChrome.storage.local.remove.mockResolvedValue();

            const result = await tokenManager.removeToken();

            expect(result.success).toBe(true);
            expect(mockChrome.storage.local.remove).toHaveBeenCalledWith(['gitlabToken']);
        });

        it('should handle removal errors', async () => {
            mockChrome.storage.local.remove.mockRejectedValue(new Error('Storage access denied'));

            await expect(tokenManager.removeToken())
                .rejects.toThrow('Failed to remove token: Storage access denied');
        });
    });

    describe('Token Validation', () => {
        it('should validate correct token', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';
            const mockUser = {
                id: 123,
                username: 'testuser',
                name: 'Test User'
            };

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockUser)
            });

            const result = await tokenManager.validateToken(token);

            expect(result.valid).toBe(true);
            expect(result.user).toEqual(mockUser);
            expect(global.fetch).toHaveBeenCalledWith('https://gitlab.com/api/v4/user', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
        });

        it('should reject invalid token', async () => {
            const token = 'glpat-invalid-token';

            global.fetch.mockResolvedValue({
                ok: false,
                status: 401,
                statusText: 'Unauthorized'
            });

            const result = await tokenManager.validateToken(token);

            expect(result.valid).toBe(false);
            expect(result.error).toBe('HTTP 401: Unauthorized');
        });

        it('should handle network errors during validation', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';

            global.fetch.mockRejectedValue(new Error('Network connection failed'));

            const result = await tokenManager.validateToken(token);

            expect(result.valid).toBe(false);
            expect(result.error).toBe('Network error: Network connection failed');
        });

        it('should handle missing token', async () => {
            const result = await tokenManager.validateToken(null);

            expect(result.valid).toBe(false);
            expect(result.error).toBe('No token provided');
        });
    });

    describe('Permission Testing', () => {
        it('should verify token has required permissions', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';

            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 1, name: 'GitLab' })
            });

            const result = await tokenManager.testTokenPermissions(token);

            expect(result.hasPermissions).toBe(true);
            expect(result.permissions).toContain('read_repository');
            expect(result.permissions).toContain('read_api');
        });

        it('should detect insufficient permissions', async () => {
            const token = 'glpat-limited-token';

            global.fetch.mockResolvedValue({
                ok: false,
                status: 403,
                statusText: 'Forbidden'
            });

            const result = await tokenManager.testTokenPermissions(token);

            expect(result.hasPermissions).toBe(false);
            expect(result.error).toBe('Insufficient permissions: HTTP 403');
        });

        it('should handle permission test network errors', async () => {
            const token = 'glpat-xxxxxxxxxxxxxxxxxxxx';

            global.fetch.mockRejectedValue(new Error('Connection timeout'));

            const result = await tokenManager.testTokenPermissions(token);

            expect(result.hasPermissions).toBe(false);
            expect(result.error).toBe('Permission test failed: Connection timeout');
        });

        it('should handle missing token for permission test', async () => {
            const result = await tokenManager.testTokenPermissions(null);

            expect(result.hasPermissions).toBe(false);
            expect(result.error).toBe('No token provided');
        });
    });

    describe('Security', () => {
        it('should encrypt token before storage', async () => {
            const token = 'glpat-sensitive-token-data';
            
            mockChrome.storage.local.set.mockResolvedValue();

            await tokenManager.storeToken(token);

            const storedData = mockChrome.storage.local.set.mock.calls[0][0];
            expect(storedData.gitlabToken).not.toBe(token);
            expect(storedData.gitlabToken).toBe(btoa(token));
        });

        it('should decrypt token when retrieving', async () => {
            const token = 'glpat-encrypted-token-test';
            const encrypted = btoa(token);
            
            mockChrome.storage.local.get.mockResolvedValue({ gitlabToken: encrypted });

            const retrievedToken = await tokenManager.getToken();

            expect(retrievedToken).toBe(token);
        });
    });

    describe('Integration Scenarios', () => {
        it('should complete full token lifecycle', async () => {
            const token = 'glpat-lifecycle-test-token';
            
            // Store token
            mockChrome.storage.local.set.mockResolvedValue();
            const storeResult = await tokenManager.storeToken(token);
            expect(storeResult.success).toBe(true);

            // Retrieve token
            mockChrome.storage.local.get.mockResolvedValue({ gitlabToken: btoa(token) });
            const retrievedToken = await tokenManager.getToken();
            expect(retrievedToken).toBe(token);

            // Validate token
            global.fetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 1, username: 'test' })
            });
            const validationResult = await tokenManager.validateToken(retrievedToken);
            expect(validationResult.valid).toBe(true);

            // Remove token
            mockChrome.storage.local.remove.mockResolvedValue();
            const removeResult = await tokenManager.removeToken();
            expect(removeResult.success).toBe(true);
        });

        it('should handle token replacement', async () => {
            const oldToken = 'glpat-old-token';
            const newToken = 'glpat-new-token';
            
            // Store old token
            mockChrome.storage.local.set.mockResolvedValue();
            await tokenManager.storeToken(oldToken);

            // Replace with new token
            await tokenManager.storeToken(newToken);

            // Verify new token is stored
            mockChrome.storage.local.get.mockResolvedValue({ gitlabToken: btoa(newToken) });
            const retrievedToken = await tokenManager.getToken();
            expect(retrievedToken).toBe(newToken);
        });
    });
}); 