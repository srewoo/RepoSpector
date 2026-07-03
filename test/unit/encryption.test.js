/**
 * Tests for the REAL EncryptionService (src/utils/encryption.js) — no mocks.
 *
 * Previously this suite was named "SecureEncryption (Mock)" and only asserted
 * on Node built-ins (TextEncoder, btoa, crypto.getRandomValues); it never
 * imported the production module. It now runs the actual AES-GCM / PBKDF2 code
 * against Node's WebCrypto (wired into crypto.subtle in test/setup.js).
 */

const { EncryptionService } = require('../../src/utils/encryption.js');

describe('EncryptionService', () => {
    // startAuditCleanup() registers a 1-hour setInterval; stub it so the test
    // process doesn't keep a live timer open.
    let intervalSpy;
    beforeAll(() => {
        intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(0);
    });
    afterAll(() => {
        intervalSpy.mockRestore();
    });

    describe('isValidApiKey (no init required)', () => {
        it('should accept known provider prefixes within length bounds', () => {
            const svc = new EncryptionService();
            expect(svc.isValidApiKey('sk-' + 'a'.repeat(48))).toBe(true);
            expect(svc.isValidApiKey('glpat-' + 'x'.repeat(20))).toBe(true);
            expect(svc.isValidApiKey('hf_' + 'y'.repeat(20))).toBe(true);
        });

        it('should reject unknown prefixes, short keys, and non-strings', () => {
            const svc = new EncryptionService();
            expect(svc.isValidApiKey('nope-123')).toBe(false);
            expect(svc.isValidApiKey('sk-short')).toBe(false);
            expect(svc.isValidApiKey(null)).toBe(false);
            expect(svc.isValidApiKey(12345)).toBe(false);
        });
    });

    describe('generateSecureRandom', () => {
        it('should return a Uint8Array of the requested length', () => {
            const svc = new EncryptionService();
            const bytes = svc.generateSecureRandom(16);
            expect(bytes).toBeInstanceOf(Uint8Array);
            expect(bytes.length).toBe(16);
        });
    });

    describe('AES-GCM encrypt/decrypt (initialized)', () => {
        let svc;
        beforeEach(async () => {
            svc = new EncryptionService();
            await svc.initialize();
        });

        it('should initialize into AES mode', () => {
            expect(svc.isInitialized).toBe(true);
        });

        it('should round-trip a string with a v2 (AES) ciphertext', async () => {
            const plaintext = 'sk-secret-api-key-1234567890abcdef';
            const ciphertext = await svc.encrypt(plaintext);
            expect(typeof ciphertext).toBe('string');
            expect(ciphertext.startsWith('v2:')).toBe(true);
            expect(ciphertext).not.toContain(plaintext);
            const decrypted = await svc.decrypt(ciphertext);
            expect(decrypted).toBe(plaintext);
        });

        it('should produce different ciphertexts for the same plaintext (random IV)', async () => {
            const a = await svc.encrypt('same-value-here');
            const b = await svc.encrypt('same-value-here');
            expect(a).not.toBe(b);
            expect(await svc.decrypt(a)).toBe('same-value-here');
            expect(await svc.decrypt(b)).toBe('same-value-here');
        });

        it('should return empty string for empty/non-string encrypt input', async () => {
            expect(await svc.encrypt('')).toBe('');
            expect(await svc.encrypt(null)).toBe('');
        });

        it('should return empty string when decrypting empty input', async () => {
            expect(await svc.decrypt('')).toBe('');
        });

        it('should pass a full integrity check', async () => {
            await expect(svc.validateIntegrity()).resolves.toBe(true);
        });
    });

    describe('settings encryption', () => {
        let svc;
        beforeEach(async () => {
            svc = new EncryptionService();
            await svc.initialize();
        });

        it('should flag sensitive keys', () => {
            expect(svc.isSensitiveKey('openaiApiKey')).toBe(true);
            expect(svc.isSensitiveKey('githubToken')).toBe(true);
            expect(svc.isSensitiveKey('theme')).toBe(false);
        });

        it('should encrypt only sensitive fields and round-trip them', async () => {
            const settings = { apiKey: 'sk-mysecretkey1234567890', theme: 'dark' };
            const encrypted = await svc.encryptSettings(settings);
            expect(encrypted.theme).toBe('dark'); // untouched
            expect(encrypted.apiKey).not.toBe(settings.apiKey);
            expect(encrypted.apiKey.startsWith('v2:')).toBe(true);

            const decrypted = await svc.decryptSettings(encrypted);
            expect(decrypted.apiKey).toBe(settings.apiKey);
            expect(decrypted.theme).toBe('dark');
        });
    });

    describe('detectDataType', () => {
        it('should classify api keys, json, empty, and other', () => {
            const svc = new EncryptionService();
            expect(svc.detectDataType('')).toBe('empty');
            expect(svc.detectDataType('sk-' + 'a'.repeat(48))).toBe('api_key');
            expect(svc.detectDataType('{"a":1}')).toBe('json');
            expect(svc.detectDataType('hello world')).toBe('other');
        });
    });
});
