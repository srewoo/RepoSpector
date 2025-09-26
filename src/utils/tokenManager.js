/**
 * Token Manager for securely handling API tokens
 * Stores tokens in Chrome's secure storage with encryption
 */

export class TokenManager {
    constructor() {
        this.storageKey = 'ai_RepoSpector_tokens';
    }

    /**
     * Store an API token securely
     */
    async storeToken(platform, token) {
        try {
            if (!token || !platform) {
                throw new Error('Platform and token are required');
            }

            // Get existing tokens
            const existingTokens = await this.getAllTokens();
            
            // Update with new token
            existingTokens[platform] = {
                token: this.encryptToken(token),
                timestamp: Date.now(),
                lastUsed: Date.now()
            };

            // Store in Chrome storage
            await chrome.storage.local.set({
                [this.storageKey]: existingTokens
            });

            console.log(`Token stored for platform: ${platform}`);
            return true;

        } catch (error) {
            console.error('Failed to store token:', error);
            return false;
        }
    }

    /**
     * Retrieve a token for a platform
     */
    async getToken(platform) {
        try {
            const tokens = await this.getAllTokens();
            const tokenData = tokens[platform];
            
            if (!tokenData) {
                return null;
            }

            // Update last used timestamp
            tokenData.lastUsed = Date.now();
            await chrome.storage.local.set({
                [this.storageKey]: tokens
            });

            return this.decryptToken(tokenData.token);

        } catch (error) {
            console.error('Failed to retrieve token:', error);
            return null;
        }
    }

    /**
     * Test if a token is valid
     */
    async testToken(platform, token) {
        try {
            let testUrl;
            let headers = {
                'Content-Type': 'application/json'
            };

            switch (platform) {
                case 'gitlab':
                    testUrl = 'https://gitlab.com/api/v4/user';
                    headers['Authorization'] = `Bearer ${token}`;
                    break;
                case 'github':
                    testUrl = 'https://api.github.com/user';
                    headers['Authorization'] = `token ${token}`;
                    break;
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }

            const response = await fetch(testUrl, { headers });
            
            if (response.ok) {
                const userData = await response.json();
                return {
                    valid: true,
                    user: userData.username || userData.login || 'Unknown',
                    message: `Token is valid for ${userData.username || userData.login || 'user'}`
                };
            } else {
                return {
                    valid: false,
                    message: `Token validation failed: ${response.status} ${response.statusText}`
                };
            }

        } catch (error) {
            return {
                valid: false,
                message: `Token test failed: ${error.message}`
            };
        }
    }

    /**
     * Remove a token
     */
    async removeToken(platform) {
        try {
            const tokens = await this.getAllTokens();
            delete tokens[platform];
            
            await chrome.storage.local.set({
                [this.storageKey]: tokens
            });

            console.log(`Token removed for platform: ${platform}`);
            return true;

        } catch (error) {
            console.error('Failed to remove token:', error);
            return false;
        }
    }

    /**
     * Get all stored tokens (without decryption)
     */
    async getAllTokens() {
        try {
            const result = await chrome.storage.local.get([this.storageKey]);
            return result[this.storageKey] || {};
        } catch (error) {
            console.error('Failed to get tokens:', error);
            return {};
        }
    }

    /**
     * Check if a token exists for a platform
     */
    async hasToken(platform) {
        const tokens = await this.getAllTokens();
        return !!tokens[platform];
    }

    /**
     * Simple encryption for token storage
     * Note: This is basic obfuscation, not cryptographically secure
     */
    encryptToken(token) {
        // Simple base64 encoding with rotation
        const rotated = token.split('').map(char => 
            String.fromCharCode(char.charCodeAt(0) + 3)
        ).join('');
        return btoa(rotated);
    }

    /**
     * Decrypt token
     */
    decryptToken(encryptedToken) {
        try {
            const decoded = atob(encryptedToken);
            return decoded.split('').map(char => 
                String.fromCharCode(char.charCodeAt(0) - 3)
            ).join('');
        } catch (error) {
            console.error('Failed to decrypt token:', error);
            return null;
        }
    }

    /**
     * Clear all tokens
     */
    async clearAllTokens() {
        try {
            await chrome.storage.local.remove([this.storageKey]);
            console.log('All tokens cleared');
            return true;
        } catch (error) {
            console.error('Failed to clear tokens:', error);
            return false;
        }
    }

    /**
     * Get token statistics
     */
    async getTokenStats() {
        const tokens = await this.getAllTokens();
        const stats = {};
        
        Object.keys(tokens).forEach(platform => {
            const tokenData = tokens[platform];
            stats[platform] = {
                hasToken: true,
                storedAt: new Date(tokenData.timestamp).toLocaleDateString(),
                lastUsed: new Date(tokenData.lastUsed).toLocaleDateString()
            };
        });

        return stats;
    }
} 