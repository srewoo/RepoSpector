/**
 * authErrors — recognise a credential failure, and say what to do about it.
 *
 * ## Why this is its own module
 *
 * A credential failure is the one review failure that must NEVER be absorbed.
 * The review pipeline is deliberately tolerant: a unit that fails is recorded in
 * `failedFiles`, a chunk that throws is recorded in `failedChunks`, and the
 * review completes with whatever it has. That is right for a timeout or a
 * malformed response — and catastrophically wrong for a 401, because:
 *
 *   every chunk fails → zero findings → `buildPrecisionAnalysis` renders
 *   "## Clean review — No genuine problems were found in the changed code"
 *
 * i.e. an expired API key produced a green all-clear on an unreviewed PR. The
 * one outcome a review tool must never produce is a confident approval of code
 * it never actually read.
 *
 * So: auth errors are detected here, tagged, and propagated rather than
 * collected. There is also nothing transient to retry — a wrong key is wrong on
 * the second attempt too.
 */

/** Marker set on any error this module classifies, so callers can branch cheaply. */
export const AUTH_ERROR_NAME = 'ProviderAuthError';

/**
 * Message fragments every provider uses for "your credential is bad".
 *
 * Matched against the raw provider text because the errors reaching us are
 * strings like `OpenAI API error (401): {"error":{"message":"Incorrect API key
 * provided: sk-..."}}` — the status code is inside the message, not on the
 * object, for every provider except Bedrock.
 */
const AUTH_PATTERNS = [
    /\bAPI error \((?:401|403)\)/i,
    /\b(?:401|403)\b[^\d]{0,40}(?:unauthorized|forbidden|invalid|denied)/i,
    // A bare trailing status, which is how the model-catalog fetchers report a
    // failure: `google /models 403`. Anchored to the end so "HTTP 400" and a
    // status embedded mid-sentence are not swept up with it.
    /\b(?:401|403)\s*$/,
    /incorrect api key/i,
    /invalid[_ -]?api[_ -]?key/i,
    /invalid[_ -]?x[_ -]?api[_ -]?key/i,
    /\bapi key (?:is )?(?:not valid|invalid|missing|expired)/i,
    /authentication[_ -]?(?:error|failed)/i,
    /\bunauthenticated\b/i,
    /\bunauthorized\b/i,
    /permission[_ -]?denied/i,
    /\bexpired\b.{0,20}\b(?:token|key|credential)/i,
    /\b(?:token|credential)s?\b.{0,20}\bexpired\b/i,
    // AWS SigV4 / Bedrock.
    /signature does not match/i,
    /the security token included in the request is (?:invalid|expired)/i,
    /UnrecognizedClientException/i,
    /InvalidSignatureException/i,
    /ExpiredTokenException/i,
    /AccessDeniedException/i,
    // Raised by this codebase before any request is made.
    /credentials are missing/i,
    /no credentials are configured/i,
    /API key required/i,
    /No API key configured/i,
];

/**
 * True when `error` means "the credential is wrong/missing/expired".
 *
 * Deliberately does NOT match a 429 or a 5xx: those are transient and the
 * pipeline's existing tolerance is correct for them.
 */
export function isAuthError(error) {
    if (!error) return false;
    if (error.name === AUTH_ERROR_NAME || error.isAuthError === true) return true;

    // Bedrock attaches a real status; everything else buries it in the message.
    if (error.status === 401 || error.status === 403) return true;

    const msg = typeof error === 'string' ? error : (error.message || '');
    if (!msg) return false;
    return AUTH_PATTERNS.some(p => p.test(msg));
}

/** Tag an error so downstream layers can recognise it without re-matching. */
export function markAuthError(error) {
    if (error && typeof error === 'object') {
        error.name = AUTH_ERROR_NAME;
        error.isAuthError = true;
    }
    return error;
}

/** Human label for a provider id, for the message below. */
const PROVIDER_LABELS = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google AI',
    groq: 'Groq',
    mistral: 'Mistral AI',
    openrouter: 'OpenRouter',
    nvidia: 'NVIDIA NIM',
    cohere: 'Cohere',
    huggingface: 'HuggingFace',
    bedrock: 'AWS Bedrock',
    local: 'Ollama',
};

/**
 * A message the user can act on, rather than a provider's raw JSON.
 *
 * @param {Error|string} error
 * @param {Object} [opts]
 * @param {string} [opts.provider] - provider id, for naming the right credential
 * @returns {string}
 */
export function describeAuthError(error, { provider } = {}) {
    const label = PROVIDER_LABELS[provider] || 'your AI provider';
    const raw = (typeof error === 'string' ? error : error?.message) || '';

    const credential = provider === 'bedrock'
        ? 'AWS credentials'
        : `${label} API key`;

    // Expired temporary AWS credentials are a distinct, very common case with a
    // different remedy from "your key is wrong".
    if (/expired/i.test(raw) && provider === 'bedrock') {
        return `Your AWS session token has expired. Refresh your temporary credentials `
            + `and update them in Settings, then re-run the review.`;
    }
    if (/credentials are missing|no credentials are configured/i.test(raw)) {
        return `No ${credential} is configured. Add ${provider === 'bedrock'
            ? 'your Access Key ID and Secret Access Key'
            : 'your API key'} in Settings, then re-run the review.`;
    }
    if (/permission[_ -]?denied|AccessDeniedException|\bforbidden\b|API error \(403\)/i.test(raw)) {
        return provider === 'bedrock'
            ? `AWS denied the request. Check that your IAM principal has bedrock:InvokeModel `
              + `and that model access is granted in the Bedrock console.`
            : `${label} rejected the request as forbidden. Your key may lack access to the `
              + `selected model, or its permissions may have changed. Check it in Settings.`;
    }

    return `Your ${credential} was rejected by ${label}. Check it in Settings — a key that `
        + `is wrong, revoked or expired will fail every request, so the review cannot run.`;
}

export default { isAuthError, markAuthError, describeAuthError, AUTH_ERROR_NAME };
