/**
 * Webhook signature verification.
 *
 * GitHub: HMAC-SHA256 over the raw body, hex-encoded in the
 *         X-Hub-Signature-256 header as "sha256=<hex>".
 * GitLab: X-Gitlab-Token header equals the configured shared secret.
 */
import crypto from 'node:crypto';

export function verifyGithubSignature(rawBody, header, secret) {
    if (!header || !secret) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');
    return timingSafeStringEqual(header, expected);
}

export function verifyGitlabToken(header, secret) {
    if (!header || !secret) return false;
    return timingSafeStringEqual(header, secret);
}

function timingSafeStringEqual(a, b) {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}
