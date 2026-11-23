const TAG = 'untrusted-repo-content';

/**
 * Wrap repo content as data for a model. Any delimiter text inside the content is neutralized,
 * so content cannot close the block early and place text outside it.
 */
export function wrapUntrusted(kind: string, content: string): string {
  const safe = content.replace(/<(\/?)(untrusted-repo-content)/gi, '<$1​$2');
  return `<${TAG} kind="${kind}">\n${safe}\n</${TAG}>`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic / OpenAI keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
];

const PRIVATE_KEY = /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g;

/** Redact high-confidence secret formats. Keeps line count so line numbers stay valid. */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY, (_m, begin: string, body: string, end: string) => {
    const lines = body.split('\n').map((l, i, all) => (i === 0 || i === all.length - 1 ? l : '[REDACTED]'));
    return `${begin}${lines.join('\n')}${end}`;
  });
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?)$|\.(pem|key|p12|pfx|keystore|jks)$/i;

/** Files whose whole content is likely secret; never sent to a model. */
export function isSecretPath(path: string): boolean {
  return SECRET_FILE.test(path);
}
