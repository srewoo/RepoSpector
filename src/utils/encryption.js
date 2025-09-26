// Advanced encryption service with AES-GCM and secure key management
// Addresses security weaknesses: stronger encryption, key derivation, audit logging

import { SECURITY_CONFIG } from './constants.js';

export class EncryptionService {
    constructor() {
        this.isInitialized = false;
        this.masterKey = null;
        this.auditLog = [];
        this.keyCache = new Map();

        // Don't auto-initialize in constructor to avoid race conditions
        // Initialize will be called explicitly by the BackgroundService
    }

    /**
     * Get crypto object that works in both window and service worker contexts
     */
    getCrypto() {
        return typeof window !== 'undefined' ? window.crypto : crypto;
    }

    /**
     * Initialize encryption service with secure key derivation
     */
    async initialize() {
        // Prevent double initialization
        if (this.isInitialized) {
            return;
        }

        try {
            // Generate or retrieve master key
            this.masterKey = await this.getMasterKey();
            this.isInitialized = true;

            // Start audit log cleanup
            this.startAuditCleanup();

            console.log('Advanced encryption service initialized');
        } catch (error) {
            console.error('Failed to initialize encryption service:', error);
            // Fallback to legacy XOR encryption
            this.initializeLegacyMode();
        }
    }

    /**
     * Generate or retrieve master key with PBKDF2 key derivation
     */
    async getMasterKey() {
        try {
            // Check if we have a stored salt
            const stored = await chrome.storage.local.get(['encryptionSalt', 'keyVersion']);
            let salt = stored.encryptionSalt;

            if (!salt) {
                // Generate new salt
                salt = this.generateSecureRandom(32);
                await chrome.storage.local.set({
                    encryptionSalt: Array.from(salt),
                    keyVersion: 2 // New encryption version
                });
            } else {
                salt = new Uint8Array(salt);
            }

            // Derive key from browser fingerprint and salt
            const keyMaterial = await this.deriveKeyMaterial();
            const key = await this.getCrypto().subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: salt,
                    iterations: SECURITY_CONFIG.KEY_DERIVATION_ITERATIONS,
                    hash: 'SHA-256'
                },
                keyMaterial,
                {
                    name: 'AES-GCM',
                    length: 256
                },
                false,
                ['encrypt', 'decrypt']
            );

            return key;
        } catch (error) {
            console.error('Failed to generate master key:', error);
            throw error;
        }
    }

    /**
     * Derive key material from browser characteristics
     */
    async deriveKeyMaterial() {
        const fingerprint = await this.generateBrowserFingerprint();
        const keyString = `repospector-v2-${fingerprint}`;
        const encoder = new TextEncoder();
        const keyData = encoder.encode(keyString);

        return await this.getCrypto().subtle.importKey(
            'raw',
            keyData,
            'PBKDF2',
            false,
            ['deriveKey']
        );
    }

    /**
     * Generate comprehensive browser fingerprint
     */
    async generateBrowserFingerprint() {
        const components = [];

        // Basic browser info
        components.push(navigator.userAgent || 'unknown');
        components.push(navigator.language || 'en');
        components.push(navigator.platform || 'unknown');
        components.push((typeof screen !== 'undefined' ? screen.width + 'x' + screen.height : '1920x1080'));
        components.push(new Date().getTimezoneOffset().toString());

        // Canvas fingerprinting (if available and in DOM context)
        try {
            if (typeof document !== 'undefined') {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                ctx.textBaseline = 'top';
                ctx.font = '14px Arial';
                ctx.fillText('RepoSpector fingerprint', 2, 2);
                components.push(canvas.toDataURL());
            } else {
                components.push('canvas-serviceworker');
            }
        } catch (error) {
            components.push('canvas-unavailable');
        }

        // WebGL fingerprinting (if available and in DOM context)
        try {
            if (typeof document !== 'undefined') {
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (gl) {
                    const renderer = gl.getParameter(gl.RENDERER);
                    const vendor = gl.getParameter(gl.VENDOR);
                    components.push(`${vendor}-${renderer}`);
                } else {
                    components.push('webgl-unavailable');
                }
            } else {
                components.push('webgl-serviceworker');
            }
        } catch (error) {
            components.push('webgl-unavailable');
        }

        const fingerprint = components.join('|');

        // Hash the fingerprint for consistency
        const encoder = new TextEncoder();
        const data = encoder.encode(fingerprint);
        const hashBuffer = await this.getCrypto().subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));

        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Encrypt data using AES-GCM
     */
    async encrypt(data) {
        if (!this.isInitialized) {
            return await this.encryptLegacy(data);
        }

        try {
            if (!data || typeof data !== 'string') {
                return '';
            }

            // Validate data length
            if (data.length > SECURITY_CONFIG.MAX_API_KEY_LENGTH) {
                throw new Error('Data too long for encryption');
            }

            // Generate random IV
            const iv = this.generateSecureRandom(12);

            // Encrypt data
            const encoder = new TextEncoder();
            const encodedData = encoder.encode(data);

            const encryptedBuffer = await this.getCrypto().subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                this.masterKey,
                encodedData
            );

            // Combine IV and encrypted data
            const encryptedData = new Uint8Array(encryptedBuffer);
            const combined = new Uint8Array(iv.length + encryptedData.length);
            combined.set(iv, 0);
            combined.set(encryptedData, iv.length);

            // Convert to base64 with version prefix
            const result = 'v2:' + btoa(String.fromCharCode(...combined));

            // Log encryption event
            this.logAuditEvent('encrypt', { dataType: this.detectDataType(data) });

            return result;

        } catch (error) {
            console.error('AES encryption failed:', error);
            this.logAuditEvent('encrypt_failed', { error: error.message });

            // Fallback to legacy encryption
            return await this.encryptLegacy(data);
        }
    }

    /**
     * Decrypt data using AES-GCM
     */
    async decrypt(encryptedData) {
        if (!encryptedData) {
            return '';
        }

        // Check version and route to appropriate decryption method
        if (encryptedData.startsWith('v2:')) {
            return await this.decryptAES(encryptedData.substring(3));
        } else {
            // Legacy format or unencrypted data
            return await this.decryptLegacy(encryptedData);
        }
    }

    /**
     * Decrypt AES-GCM encrypted data
     */
    async decryptAES(encryptedBase64) {
        if (!this.isInitialized) {
            console.warn('AES decryption attempted before initialization, falling back to legacy');
            return await this.decryptLegacy(encryptedBase64);
        }

        try {
            // Convert from base64
            const combined = new Uint8Array(
                atob(encryptedBase64).split('').map(char => char.charCodeAt(0))
            );

            // Extract IV and encrypted data
            const iv = combined.slice(0, 12);
            const encryptedData = combined.slice(12);

            // Decrypt
            const decryptedBuffer = await this.getCrypto().subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                this.masterKey,
                encryptedData
            );

            // Convert back to string
            const decoder = new TextDecoder();
            const result = decoder.decode(decryptedBuffer);

            // Log decryption event
            this.logAuditEvent('decrypt', { dataType: this.detectDataType(result) });

            return result;

        } catch (error) {
            console.error('AES decryption failed:', error);
            this.logAuditEvent('decrypt_failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Legacy XOR encryption for backward compatibility
     */
    initializeLegacyMode() {
        this.legacyKey = this.generateLegacyBrowserKey();
        this.isInitialized = true;
        console.warn('Using legacy XOR encryption mode');
    }

    generateLegacyBrowserKey() {
        const userAgent = navigator.userAgent || 'default';
        const language = navigator.language || 'en';
        const platform = navigator.platform || 'unknown';

        const keyString = `${userAgent}-${language}-${platform}-repospector-v1`;

        let key = 0;
        for (let i = 0; i < keyString.length; i++) {
            key = (key + keyString.charCodeAt(i)) % 256;
        }

        return key === 0 ? 42 : key;
    }

    async encryptLegacy(data) {
        try {
            if (!data) return '';

            const encrypted = this.xorEncrypt(data, this.legacyKey);
            return 'v1:' + btoa(encrypted);
        } catch (error) {
            console.error('Legacy encryption failed:', error);
            return btoa(data || '');
        }
    }

    async decryptLegacy(encryptedData) {
        try {
            if (!encryptedData) return '';

            // Handle versioned legacy data
            let dataToDecrypt = encryptedData;
            if (encryptedData.startsWith('v1:')) {
                dataToDecrypt = encryptedData.substring(3);
            }

            // Try XOR decryption
            try {
                const encrypted = atob(dataToDecrypt);
                const decrypted = this.xorDecrypt(encrypted, this.legacyKey);

                if (this.isValidApiKey(decrypted)) {
                    return decrypted;
                }
            } catch (xorError) {
                // Continue to fallbacks
            }

            // Try simple base64 decoding
            try {
                const decoded = atob(dataToDecrypt);
                if (this.isValidApiKey(decoded)) {
                    return decoded;
                }
            } catch (base64Error) {
                // Continue to fallbacks
            }

            // Check if already plaintext
            if (this.isValidApiKey(encryptedData)) {
                return encryptedData;
            }

            console.warn('All decryption methods failed');
            return '';

        } catch (error) {
            console.error('Legacy decryption failed:', error);
            return '';
        }
    }

    /**
     * Utility methods
     */
    xorEncrypt(text, key) {
        let result = '';
        for (let i = 0; i < text.length; i++) {
            result += String.fromCharCode(text.charCodeAt(i) ^ key);
        }
        return result;
    }

    xorDecrypt(encryptedText, key) {
        return this.xorEncrypt(encryptedText, key);
    }

    generateSecureRandom(length) {
        return this.getCrypto().getRandomValues(new Uint8Array(length));
    }

    isValidApiKey(key) {
        if (!key || typeof key !== 'string') return false;

        const validPrefixes = [
            'sk-', 'glpat-', 'glp_', // OpenAI, GitLab
            'claude-', 'anthropic-', // Anthropic
            'AIza', // Google
            'co-', // Cohere
            'gsk_', // Groq
            'api-', // Mistral
            'hf_', // HuggingFace
        ];

        return validPrefixes.some(prefix => key.startsWith(prefix)) &&
               key.length >= 20 && key.length <= SECURITY_CONFIG.MAX_API_KEY_LENGTH;
    }

    detectDataType(data) {
        if (!data) return 'empty';
        if (this.isValidApiKey(data)) return 'api_key';
        if (data.startsWith('{') && data.endsWith('}')) return 'json';
        return 'other';
    }

    /**
     * Audit logging for security monitoring
     */
    logAuditEvent(event, details = {}) {
        const logEntry = {
            timestamp: Date.now(),
            event,
            details,
            userAgent: navigator.userAgent,
            url: window.location.href
        };

        this.auditLog.push(logEntry);

        // Keep only recent entries
        if (this.auditLog.length > SECURITY_CONFIG.AUDIT_LOG_SIZE) {
            this.auditLog = this.auditLog.slice(-SECURITY_CONFIG.AUDIT_LOG_SIZE);
        }

        // Store audit log
        this.persistAuditLog();
    }

    async persistAuditLog() {
        try {
            await chrome.storage.local.set({
                encryptionAuditLog: this.auditLog.slice(-100) // Keep last 100 entries
            });
        } catch (error) {
            console.warn('Failed to persist audit log:', error);
        }
    }

    async getAuditLog() {
        try {
            const result = await chrome.storage.local.get(['encryptionAuditLog']);
            return result.encryptionAuditLog || [];
        } catch (error) {
            console.warn('Failed to retrieve audit log:', error);
            return [];
        }
    }

    startAuditCleanup() {
        // Clean up old audit entries periodically
        setInterval(() => {
            const cutoff = Date.now() - SECURITY_CONFIG.TOKEN_EXPIRY;
            this.auditLog = this.auditLog.filter(entry => entry.timestamp > cutoff);
        }, 3600000); // Clean every hour
    }

    /**
     * Security utilities
     */
    async rotateEncryptionKey() {
        try {
            // Generate new salt
            const newSalt = this.generateSecureRandom(32);
            await chrome.storage.local.set({
                encryptionSalt: Array.from(newSalt),
                keyVersion: 2,
                keyRotationDate: Date.now()
            });

            // Reinitialize with new key
            await this.initialize();

            this.logAuditEvent('key_rotation', { success: true });

            return true;
        } catch (error) {
            console.error('Key rotation failed:', error);
            this.logAuditEvent('key_rotation', { success: false, error: error.message });
            return false;
        }
    }

    async validateIntegrity() {
        try {
            // Test encryption/decryption cycle
            const testData = 'sk-test-key-1234567890abcdef';
            const encrypted = await this.encrypt(testData);
            const decrypted = await this.decrypt(encrypted);

            const isValid = decrypted === testData;
            this.logAuditEvent('integrity_check', { success: isValid });

            return isValid;
        } catch (error) {
            console.error('Integrity validation failed:', error);
            this.logAuditEvent('integrity_check', { success: false, error: error.message });
            return false;
        }
    }

    // Legacy compatibility methods
    async encryptApiKey(apiKey) {
        return await this.encrypt(apiKey);
    }

    async decryptApiKey(encryptedKey) {
        return await this.decrypt(encryptedKey);
    }

    // Public API for extension settings
    async encryptSettings(settings) {
        const encrypted = {};
        for (const [key, value] of Object.entries(settings)) {
            if (this.isSensitiveKey(key) && value) {
                encrypted[key] = await this.encrypt(String(value));
            } else {
                encrypted[key] = value;
            }
        }
        return encrypted;
    }

    async decryptSettings(encryptedSettings) {
        const decrypted = {};
        for (const [key, value] of Object.entries(encryptedSettings)) {
            if (this.isSensitiveKey(key) && value) {
                try {
                    decrypted[key] = await this.decrypt(value);
                } catch (error) {
                    console.warn(`Failed to decrypt ${key}:`, error);
                    decrypted[key] = '';
                }
            } else {
                decrypted[key] = value;
            }
        }
        return decrypted;
    }

    isSensitiveKey(key) {
        const sensitiveKeys = [
            'apiKey', 'openaiApiKey', 'anthropicApiKey', 'googleApiKey',
            'cohereApiKey', 'mistralApiKey', 'groqApiKey', 'huggingfaceApiKey',
            'gitlabToken', 'githubToken', 'bitbucketToken'
        ];
        return sensitiveKeys.includes(key) || key.toLowerCase().includes('key') || key.toLowerCase().includes('token');
    }
} 