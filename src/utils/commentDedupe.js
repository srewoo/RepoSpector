/**
 * commentDedupe — never say the same thing twice on the same PR.
 *
 * A PR is reviewed many times: every push re-runs the pipeline. Without this
 * module RepoSpector reposts findings the author has already read, already
 * argued with, or already rejected — which is the fastest way to get a review
 * bot muted.
 *
 * pr-agent solves this with TF-IDF cosine similarity against existing comments
 * (`pr_agent/utils/similarity.py` → `max_cosine_sim`). We do the same, minus
 * scikit-learn: a few hundred short strings do not need a real vectorizer, and
 * an MV3 service worker cannot ship one anyway.
 *
 * Matching is deliberately location-anchored: two findings are "the same" only
 * when they sit on the same file within a small line window AND their text
 * agrees. Text agreement alone would collapse the many legitimate instances of
 * "empty catch block" across a file into one comment.
 */

/**
 * Stable marker embedded in every comment RepoSpector posts.
 *
 * HTML comments are invisible in rendered markdown on both GitHub and GitLab,
 * and survive edits, so this is a reliable "did I write this?" test on the next
 * run. Versioned so a future format change can be detected rather than guessed.
 *
 * Hard rule, same as pr-agent's `option_key`s: this string is IMMUTABLE. Change
 * it and every comment posted before the change becomes unrecognisable, so the
 * bot starts duplicating its entire back catalogue.
 */
export const REPOSPECTOR_MARKER = '<!-- repospector-finding-v1 -->';

/** Legacy signature, for comments posted before the marker existed. */
const LEGACY_SIGNATURE = /🛡️\s*RepoSpector/;

/** Known bot authors whose comments we should treat as "already said". */
const DEFAULT_BOT_AUTHORS = /^(repospector|baymax|bito|coderabbit|sonar|snyk|dependabot|renovate|.*-bot|group_\d+_bot_.*)$/i;

/** Is this comment body one of ours? */
export function isRepoSpectorComment(body) {
    if (!body || typeof body !== 'string') return false;
    return body.includes(REPOSPECTOR_MARKER) || LEGACY_SIGNATURE.test(body);
}

/**
 * Attach the marker to a comment body. Idempotent — a body that already carries
 * the marker is returned unchanged, so re-formatting an existing comment cannot
 * stack markers.
 */
export function withMarker(body) {
    const base = String(body ?? '');
    if (base.includes(REPOSPECTOR_MARKER)) return base;
    return `${REPOSPECTOR_MARKER}\n${base}`;
}

// ── text similarity ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be',
    'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'this',
    'that', 'these', 'those', 'it', 'its', 'as', 'can', 'could', 'should',
    'would', 'will', 'may', 'might', 'not', 'no', 'which', 'when', 'then',
    'there', 'here', 'you', 'your', 'we', 'our', 'has', 'have', 'had', 'do',
    'does', 'did', 'so', 'than', 'into', 'out', 'up', 'down', 'over', 'under',
]);

/**
 * Tokenize a comment body for comparison.
 *
 * Markdown chrome (our own severity banner, evidence blocks, suggestion blocks,
 * the feedback footer) is stripped first — otherwise every pair of RepoSpector
 * comments looks ~60% similar just from the shared template, and the threshold
 * becomes meaningless.
 */
export function tokenize(text) {
    let s = String(text ?? '');

    s = s
        .replace(/<!--[\s\S]*?-->/g, ' ')          // html comments (incl. our marker)
        .replace(/```[\s\S]*?```/g, ' ')            // fenced code / suggestion blocks
        .replace(/<details>[\s\S]*?<\/details>/gi, ' ')
        .replace(/<sub>[\s\S]*?<\/sub>/gi, ' ')     // provenance footer
        .replace(/^\s*-\s*\[[ xX]\]\s.*$/gm, ' ')   // feedback checkboxes
        .replace(/[*_`#>|]/g, ' ')                  // remaining markdown punctuation
        .toLowerCase();

    return s
        .split(/[^a-z0-9_]+/)
        .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/** Term-frequency map for a token list. */
function termFreq(tokens) {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
}

/**
 * Cosine similarity between two token lists, IDF-weighted against the supplied
 * document frequencies. Returns 0..1.
 *
 * IDF matters here: without it, boilerplate words shared by every finding
 * ("line", "code", "error") dominate the score.
 */
function cosine(tfA, tfB, idf) {
    let dot = 0, normA = 0, normB = 0;

    for (const [t, n] of tfA) {
        const w = n * (idf.get(t) ?? 1);
        normA += w * w;
        const m = tfB.get(t);
        if (m != null) dot += w * (m * (idf.get(t) ?? 1));
    }
    for (const [t, n] of tfB) {
        const w = n * (idf.get(t) ?? 1);
        normB += w * w;
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Build an IDF table over a corpus of token lists.
 * Smoothed so a term appearing in every document scores near 0 rather than
 * exactly 0 (which would make two identical texts score 0 similarity).
 */
function buildIdf(docs) {
    const df = new Map();
    for (const tokens of docs) {
        for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
    }
    const N = Math.max(docs.length, 1);
    const idf = new Map();
    for (const [t, n] of df) idf.set(t, Math.log((N + 1) / (n + 0.5)) + 1);
    return idf;
}

/**
 * Max cosine similarity between `text` and any string in `corpus`.
 * Mirrors pr-agent's `max_cosine_sim`.
 */
export function maxCosineSimilarity(text, corpus) {
    if (!corpus || corpus.length === 0) return 0;
    const docs = [tokenize(text), ...corpus.map(tokenize)];
    const idf = buildIdf(docs);
    const target = termFreq(docs[0]);
    let best = 0;
    for (let i = 1; i < docs.length; i++) {
        const s = cosine(target, termFreq(docs[i]), idf);
        if (s > best) best = s;
    }
    return best;
}

// ── the actual suppression pass ────────────────────────────────────────────

/** Two paths refer to the same file if either is a suffix of the other. */
function samePath(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.endsWith(b) || b.endsWith(a);
}

/**
 * Extract prior comments this bot posted, from normalized PR data.
 *
 * @param {Object} prData - from PullRequestService.fetchPullRequest
 * @param {Object} [options]
 * @param {boolean} [options.includeOtherBots=false] - also treat other review
 *        bots' comments as "already said". Off by default: another bot saying
 *        it is not a reason for us to stay silent, and their formats differ
 *        enough that the similarity score is unreliable.
 * @returns {Array<{path:string, line:number|null, body:string, author:string}>}
 */
export function collectPriorBotComments(prData, options = {}) {
    const { includeOtherBots = false } = options;
    const out = [];

    for (const c of prData?.comments || []) {
        const body = c?.body || '';
        const author = c?.author || '';
        const mine = isRepoSpectorComment(body);
        const otherBot = includeOtherBots && DEFAULT_BOT_AUTHORS.test(author);
        if (!mine && !otherBot) continue;

        out.push({
            path: c.path || null,
            line: c.line != null ? Number(c.line) : null,
            body,
            author,
            mine,
            resolved: c.resolved === true,
        });
    }

    return out;
}

/**
 * Drop findings we have already commented on.
 *
 * @param {Array<Object>} findings - flat findings, post-policy
 * @param {Array<Object>} priorComments - from collectPriorBotComments
 * @param {Object} [options]
 * @param {number} [options.lineWindow=2] - lines of drift tolerated. A push that
 *        edits the file above the finding shifts its line without changing the
 *        defect, so an exact match is too strict.
 * @param {number} [options.similarityThreshold=0.55] - cosine score above which
 *        two co-located comments are considered the same point.
 * @param {Function} [options.buildBody] - render a finding to the text that will
 *        be posted, for comparison. Defaults to title+message+suggestion.
 * @returns {{ kept: Array, suppressed: Array, stats: Object }}
 */
export function suppressAlreadyPosted(findings, priorComments, options = {}) {
    const {
        lineWindow = 2,
        similarityThreshold = 0.55,
        buildBody = (f) => [f.title, f.message, f.description, f.suggestion].filter(Boolean).join(' '),
    } = options;

    const stats = { checked: findings?.length || 0, suppressed: 0, priorComments: priorComments?.length || 0 };

    if (!Array.isArray(findings) || findings.length === 0) return { kept: [], suppressed: [], stats };
    if (!Array.isArray(priorComments) || priorComments.length === 0) {
        return { kept: [...findings], suppressed: [], stats };
    }

    // One IDF table over the whole corpus (prior comments + candidate bodies) so
    // scores are comparable across findings.
    const priorTokens = priorComments.map(c => tokenize(c.body));
    const findingBodies = findings.map(buildBody);
    const idf = buildIdf([...priorTokens, ...findingBodies.map(tokenize)]);
    const priorTf = priorTokens.map(termFreq);

    const kept = [];
    const suppressed = [];

    findings.forEach((f, i) => {
        const path = f.file || f.filePath || f.path || null;
        const line = f.line != null ? Number(f.line) : null;
        const tf = termFreq(tokenize(findingBodies[i]));

        let match = null;
        for (let j = 0; j < priorComments.length; j++) {
            const c = priorComments[j];
            if (!samePath(path, c.path)) continue;
            if (line != null && c.line != null && Math.abs(line - c.line) > lineWindow) continue;

            // A rule id is an exact identity signal — no need to guess from prose.
            const rule = f.rule || f.ruleId;
            if (rule && c.body.includes(rule)) {
                match = { comment: c, score: 1, reason: 'rule-id' };
                break;
            }

            const score = cosine(tf, priorTf[j], idf);
            if (score >= similarityThreshold && (!match || score > match.score)) {
                match = { comment: c, score, reason: 'similarity' };
            }
        }

        if (match) {
            suppressed.push({ ...f, suppressedBy: match });
            stats.suppressed++;
        } else {
            kept.push(f);
        }
    });

    return { kept, suppressed, stats };
}

export default {
    REPOSPECTOR_MARKER,
    isRepoSpectorComment,
    withMarker,
    tokenize,
    maxCosineSimilarity,
    collectPriorBotComments,
    suppressAlreadyPosted,
};
