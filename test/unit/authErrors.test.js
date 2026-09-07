/**
 * The failure this file exists to prevent:
 *
 *   expired key → every review unit 401s → zero findings → the verdict gate
 *   renders "## Clean review — No genuine problems were found in the changed
 *   code" → the user merges on a green badge produced by a review that never
 *   read a line of their code.
 *
 * The pipeline is deliberately tolerant of failures (failedFiles, failedChunks,
 * partial reviews) and that tolerance is correct everywhere except here.
 */

const {
    isAuthError,
    markAuthError,
    describeAuthError,
    AUTH_ERROR_NAME,
} = require('../../src/utils/authErrors.js');

const { BatchProcessor } = require('../../src/utils/batchProcessor.js');

describe('recognising a credential failure', () => {
    // The real strings each provider produces. They reach us already flattened
    // into a message, with the status code inside the text rather than on the
    // object — which is why message matching is not optional here.
    const REAL_AUTH_ERRORS = [
        'OpenAI API error (401): {"error":{"message":"Incorrect API key provided: sk-abc***"}}',
        'Anthropic API error (401): {"type":"error","error":{"type":"authentication_error"}}',
        'google /models 403',
        'Bedrock returned HTTP 403 — access denied. Check that your IAM principal has bedrock:InvokeModel',
        'The security token included in the request is expired',
        'UnrecognizedClientException: The security token included in the request is invalid',
        'InvalidSignatureException: Signature does not match',
        'AWS credentials are missing. Add your Access Key ID and Secret Access Key in Settings to use Bedrock.',
        'AWS Bedrock is selected but no credentials are configured.',
        'API key required to list models',
    ];

    it.each(REAL_AUTH_ERRORS)('recognises: %s', (msg) => {
        expect(isAuthError(new Error(msg))).toBe(true);
    });

    it('reads a status code when the provider attaches one', () => {
        const e = new Error('Forbidden');
        e.status = 403;
        expect(isAuthError(e)).toBe(true);
    });

    it('recognises a tagged error without re-matching text', () => {
        const e = markAuthError(new Error('anything at all'));
        expect(e.name).toBe(AUTH_ERROR_NAME);
        expect(isAuthError(e)).toBe(true);
    });

    it('works on a bare string, because the batch layer flattens errors', () => {
        expect(isAuthError('OpenAI API error (401): bad key')).toBe(true);
    });

    // The other half of the contract: over-matching would abort reviews that
    // should have degraded gracefully.
    const NOT_AUTH = [
        'OpenAI API error (429): rate limit exceeded',
        'OpenAI API error (500): internal server error',
        'Bedrock returned HTTP 400 — Invalid model identifier',
        'network timeout',
        'Failed to parse per-file response',
        'LLM call budget exhausted (60/60) — refused stage "per-file".',
    ];

    it.each(NOT_AUTH)('does NOT treat as auth: %s', (msg) => {
        expect(isAuthError(new Error(msg))).toBe(false);
    });

    it('is safe on null and undefined', () => {
        expect(isAuthError(null)).toBe(false);
        expect(isAuthError(undefined)).toBe(false);
    });
});

describe('what the user is told', () => {
    it('names the provider whose key failed', () => {
        const msg = describeAuthError(new Error('OpenAI API error (401): bad key'), { provider: 'openai' });
        expect(msg).toContain('OpenAI API key');
        expect(msg).toMatch(/Settings/);
    });

    it('tells a Bedrock user to refresh an expired session token', () => {
        const msg = describeAuthError(
            new Error('The security token included in the request is expired'),
            { provider: 'bedrock' }
        );
        expect(msg).toMatch(/session token has expired/i);
        expect(msg).toMatch(/refresh/i);
    });

    it('points a missing-credential case at the fields to fill in', () => {
        const msg = describeAuthError(
            new Error('AWS credentials are missing.'),
            { provider: 'bedrock' }
        );
        expect(msg).toMatch(/Access Key ID/);
    });

    it('names the IAM action for a Bedrock 403 rather than saying "denied"', () => {
        const msg = describeAuthError(new Error('AccessDeniedException'), { provider: 'bedrock' });
        expect(msg).toContain('bedrock:InvokeModel');
    });

    it('still produces something actionable with no provider known', () => {
        const msg = describeAuthError(new Error('API error (401)'));
        expect(msg).toMatch(/Settings/);
    });
});

describe('a credential failure is never retried', () => {
    it('is non-retryable at the batch layer', () => {
        const bp = new BatchProcessor();
        // The pre-existing patterns caught "API key" but not a bare 401, and not
        // any of Bedrock's exception names.
        expect(bp.isNonRetryableError(new Error('OpenAI API error (401): Incorrect API key'))).toBe(true);
        expect(bp.isNonRetryableError(new Error('UnrecognizedClientException'))).toBe(true);
        // Transient failures must still retry.
        expect(bp.isNonRetryableError(new Error('OpenAI API error (429): rate limit'))).toBe(false);
    });
});
