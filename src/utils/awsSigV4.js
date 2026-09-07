/**
 * awsSigV4 — AWS Signature Version 4 request signing, on WebCrypto only.
 *
 * Bedrock is the one provider that does not authenticate with a bearer token.
 * Every request must be signed with the caller's IAM credentials, and the
 * signature covers the method, the exact canonical path, the query string, a
 * sorted set of headers and a hash of the body. Get any one of those wrong and
 * AWS returns a 403 that says only "signature does not match" — so the encoding
 * rules below are load-bearing, not stylistic.
 *
 * No AWS SDK: `@aws-sdk/signature-v4` and its transitive deps are ~2 MB, and this
 * extension already ships 72 MB. `crypto.subtle` is available in the MV3 service
 * worker and does the whole job in ~60 lines.
 *
 * Credentials never leave this module's arguments — nothing is logged, and the
 * derived signing key is discarded with the call.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

function utf8(data) {
    return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

function toHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function sha256(data) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(data)));
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        'raw', utf8(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, utf8(data)));
}

/**
 * SigV4 percent-encoding: everything outside the unreserved set `A-Za-z0-9-._~`.
 *
 * Stricter than `encodeURIComponent`, which leaves `!'()*` alone. It also encodes
 * `%` itself, so an already-encoded `%3A` in a path becomes `%253A` — which is
 * exactly what AWS expects in the canonical URI, and exactly the case that bites
 * here: every Bedrock model id contains a colon (`...-v1:0`).
 */
export function sigV4UriEncode(str) {
    return String(str).replace(
        /[^A-Za-z0-9\-._~]/g,
        c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
    );
}

/**
 * Canonical URI: each path segment encoded independently, `/` separators kept.
 */
export function buildCanonicalUri(pathname) {
    return String(pathname).split('/').map(sigV4UriEncode).join('/');
}

/**
 * Sign a request in place, returning the same headers object.
 *
 * @param {Object} req
 * @param {string} req.method
 * @param {string} req.url - absolute URL, already percent-encoded as it will be fetched
 * @param {Object} req.headers - mutated: gains x-amz-date, host, Authorization, …
 * @param {string} [req.body] - exact bytes that will be sent ('' for GET)
 * @param {string} req.region
 * @param {string} req.accessKeyId
 * @param {string} req.secretAccessKey
 * @param {string} [req.sessionToken] - required for temporary (ASIA…) credentials
 * @param {string} [req.service='bedrock']
 * @returns {Promise<Object>} the signed headers
 */
export async function awsSignRequest({
    method,
    url,
    headers = {},
    body = '',
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken = null,
    service = 'bedrock',
}) {
    if (!accessKeyId || !secretAccessKey) {
        throw new Error(
            'AWS credentials are missing. Add your Access Key ID and Secret Access Key '
            + 'in Settings to use Bedrock.'
        );
    }
    if (!region) {
        throw new Error('An AWS region is required to sign a Bedrock request.');
    }

    const parsed = new URL(url);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);

    headers['x-amz-date'] = amzDate;
    headers['host'] = parsed.host;
    if (sessionToken && sessionToken.trim()) {
        headers['x-amz-security-token'] = sessionToken.trim();
    }

    const payloadHash = toHex(await sha256(body || ''));
    headers['x-amz-content-sha256'] = payloadHash;

    // Canonical headers are sorted by LOWERCASED name, and the value printed is
    // the original header's, trimmed. Built from one pass over the entries so a
    // header differing only in case cannot resolve to the wrong value.
    const entries = Object.entries(headers)
        .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}`).join('\n') + '\n';
    const signedHeaders = entries.map(([k]) => k).join(';');

    const canonicalRequest = [
        method,
        buildCanonicalUri(parsed.pathname),
        parsed.search ? parsed.search.substring(1) : '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        ALGORITHM,
        amzDate,
        credentialScope,
        toHex(await sha256(canonicalRequest)),
    ].join('\n');

    const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');
    const signature = toHex(await hmacSha256(kSigning, stringToSign));

    headers['Authorization'] =
        `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
}

export default { awsSignRequest, sigV4UriEncode, buildCanonicalUri };
