/**
 * findingEvidence — deterministic premise checks run BEFORE the LLM verifier.
 *
 * Measured motivation: on 50 real MRs the LLM verifier passed 42 of 42 findings
 * that independent triple-lens adjudication then rejected. Precision 0%, 95% CI
 * [0, 8.4%]. The verifier prompt already *says* "refute if the cited line does not
 * contain the described construct" — but it is handed a raw diff and asked to
 * eyeball it, and it does not reliably perform that check.
 *
 * The check is mechanical, so a model should never have been asked to do it. Every
 * gate here is deterministic, free, and reliable. What survives goes to the LLM
 * with the ACTUAL cited code resolved and quoted, so the model spends its judgment
 * on "is this a real defect?" rather than "does this line exist?".
 *
 * Real false positives this kills, from the measured run:
 *
 *   "Use of deprecated unittest.makeSuite()"  — the MR REMOVES makeSuite. The
 *       token appears only on `-` lines. Flagging what the PR fixed.
 *   "Deprecated datetime.utcnow()"            — `utcnow` appears nowhere in the diff.
 *   "Error return value ignored (json.Unmarshal)" — cited line is a comment.
 *   "Blocking call in async function"         — cited construct not on that line.
 *   8 exact duplicates                        — same defect, same file, twice.
 *
 * Deliberately conservative: it only refutes when it can PROVE the premise is
 * absent. Anything ambiguous passes through to the LLM. A wrong refutation costs
 * a true positive, which is the expensive direction.
 */

import { parsePatchHunks } from './patchLines.js';

export const EVIDENCE = {
    /** Premise disproved mechanically — drop without spending a token. */
    REFUTED: 'refuted',
    /** Premise confirmed present in added code — send to the LLM. */
    GROUNDED: 'grounded',
    /** Cannot determine — send to the LLM, which must be more skeptical. */
    UNPROVEN: 'unproven',
};

/** Line-comment prefixes across the languages RepoSpector reviews. */
const COMMENT_ONLY = /^\s*(\/\/|#|\*|\/\*|--|<!--)/;

/**
 * Code constructs a finding explicitly claims to be looking at.
 *
 * Only high-confidence forms are extracted, because presence-checking is only
 * safe when the finding names something specific:
 *   - backticked spans:      `ast.literal_eval`, `conumser_linger_ms`
 *   - dotted call chains:    json.Unmarshal, asyncio.get_event_loop, datetime.utcnow
 *
 * Bare English words are never extracted — "error", "logging" and "config" would
 * match everything and refute nothing.
 */
function extractConstructs(text) {
    if (!text) return [];
    const out = new Set();

    // `backticked` spans — strip call parens and arguments.
    for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
        const token = m[1].trim().replace(/\(.*$/, '').trim();
        if (/^[A-Za-z_$][\w$.]*$/.test(token) && token.length >= 4) out.add(token);
    }

    // Dotted identifiers, with or without a call: ast.literal_eval, datetime.utcnow()
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)) {
        const token = m[1];
        // Skip prose that happens to contain a dot ("e.g", "i.e") and file paths.
        if (token.length >= 6 && !/^(e\.g|i\.e)$/i.test(token) && !/\.(js|ts|py|go|json|md)$/i.test(token)) {
            out.add(token);
        }
    }

    // snake_case identifiers — long enough that English prose cannot collide.
    // Catches things like `conumser_linger_ms` quoted without backticks.
    for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
        if (m[1].length >= 8) out.add(m[1]);
    }

    // Drop constructs subsumed by a longer one from the same phrase. "ast.literal_eval"
    // also yields the bare "literal_eval"; treating them as two independent claims
    // made a present construct look half-absent and falsely refuted a real finding.
    const all = [...out];
    return all.filter(tok => !all.some(other => other !== tok && other.endsWith(`.${tok}`)));
}

/**
 * Constructs the finding CLAIMS are present — taken from the title only.
 *
 * The title names the defect; the description usually also names the SUGGESTED
 * FIX ("use datetime.now() instead of utcnow()"). A fix construct is legitimately
 * absent from the code, so mixing the two makes absence unprovable — which is
 * exactly why the `datetime.utcnow` false positive survived the first cut.
 */
export function claimedConstructs(finding) {
    return extractConstructs(finding?.title);
}

/** Wider net, used only for positive grounding — never for refutation. */
export function mentionedConstructs(finding) {
    return extractConstructs(
        [finding?.title, finding?.description, finding?.message].filter(Boolean).join(' ')
    );
}

/** Added / removed / context line text for one file's patch. */
function partitionPatch(patch) {
    const added = [];
    const removed = [];
    const byNewLine = new Map();

    for (const hunk of parsePatchHunks(patch)) {
        for (const l of hunk.lines) {
            if (l.type === 'added') {
                added.push(l.content);
                if (l.number.new != null) byNewLine.set(l.number.new, l.content);
            } else if (l.type === 'deleted') {
                removed.push(l.content);
            } else if (l.type === 'context' && l.number.new != null) {
                byNewLine.set(l.number.new, l.content);
            }
        }
    }
    return { added, removed, byNewLine };
}

/** Does `token` occur in any of these lines? Matched on word-ish boundaries. */
function occursIn(lines, token) {
    // Escape for a literal match; `.` in `json.Unmarshal` must not be a wildcard.
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^\\w$.])${esc}(?![\\w$])`);
    // Also accept a bare tail match (`literal_eval` for `ast.literal_eval`) so a
    // differently-qualified call still counts as present.
    const tail = token.includes('.') ? token.split('.').pop() : null;
    const tailRe = tail && tail.length >= 4
        ? new RegExp(`(^|[^\\w$])${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`)
        : null;

    return lines.some(l => re.test(l) || (tailRe && tailRe.test(l)));
}

/**
 * Assess one finding against the diff it claims to describe.
 *
 * @param {object} finding
 * @param {string} patch - unified diff for finding.file
 * @returns {{verdict:string, reason:string|null, citedLine:string|null, constructs:string[]}}
 */
export function assessFinding(finding, patch) {
    const constructs = claimedConstructs(finding);
    const base = { verdict: EVIDENCE.UNPROVEN, reason: null, citedLine: null, constructs };

    if (!patch) return base;

    const { added, removed, byNewLine } = partitionPatch(patch);
    const line = Number(finding?.line);
    const citedLine = Number.isFinite(line) ? (byNewLine.get(line) ?? null) : null;
    base.citedLine = citedLine;

    // GATE 1 — the cited line is not in the diff at all.
    // Only refute when the file HAS a parsed diff; an unparsed patch must not
    // condemn the finding.
    if (Number.isFinite(line) && byNewLine.size > 0 && !byNewLine.has(line)) {
        return { ...base, verdict: EVIDENCE.REFUTED, reason: `cited line ${line} is not present in the diff for this file` };
    }

    if (constructs.length === 0) return base;

    // NOTE: there is deliberately no separate "cited line is a comment" gate.
    // Comments are excluded from `isCode` below, so a finding whose construct
    // exists only inside a comment is refuted by GATE 4 with a strictly more
    // informative reason. One gate, not two.

    // Comments do not contain constructs. A `# makeSuite` note explaining a
    // removal must not count as the call still being present — that alone let
    // the "deprecated makeSuite" false positive through the first version.
    const isCode = (l) => !COMMENT_ONLY.test(l);
    const addedCode = added.filter(isCode);
    const removedCode = removed.filter(isCode);
    const allCode = [...addedCode, ...removedCode, ...[...byNewLine.values()].filter(isCode)];

    // GATE 3 — the claimed construct appears ONLY on removed lines. The MR is
    // deleting it, so the finding is flagging the thing the PR fixed.
    const onlyRemoved = constructs.filter(c => occursIn(removedCode, c) && !occursIn(addedCode, c));
    if (onlyRemoved.length === constructs.length) {
        return {
            ...base,
            verdict: EVIDENCE.REFUTED,
            reason: `\`${onlyRemoved.join('`, `')}\` appears only on REMOVED lines — this diff deletes it, it is not introduced by it`,
        };
    }

    // GATE 4 — EVERY construct named in the TITLE is absent from the file's code.
    // Requires ALL, not ANY: a title can name both the defect and its replacement,
    // and refuting on a single absent token wrongly killed a grounded finding.
    const missing = constructs.filter(c => !occursIn(allCode, c));
    if (missing.length === constructs.length) {
        return {
            ...base,
            verdict: EVIDENCE.REFUTED,
            reason: `\`${missing.join('`, `')}\` does not appear in this file's code — the finding describes a construct that is not present`,
        };
    }

    if (constructs.some(c => occursIn(addedCode, c))) {
        return { ...base, verdict: EVIDENCE.GROUNDED, reason: 'named construct present on an added line' };
    }

    return base;
}

/**
 * Claims of the form "this error/exception is silently swallowed".
 *
 * 9 of the 27 remaining false positives were this shape, flagging behaviour the
 * author had explicitly documented on the very next line:
 *     catch { /* quota or private-browsing — fail silently *\/ }
 *     except Exception:  # never let the upload hook change the pod's exit code
 * The code states its intent; the reviewer ignored it. Reading the neighbourhood
 * is mechanical, so it belongs here rather than in a prompt.
 */
// Note the \w* suffixes: `\bswallow\b` does not match "Swallowed", which is how
// most of these findings are actually worded.
const SWALLOW_CLAIM = /\b(swallow\w*|silent\w*|empty catch|ignor\w*|suppress\w*|not (handled|logged)|no error handling)\b/i;

/** Comment text on or immediately around a line, within `radius` lines. */
function nearbyComments(byNewLine, line, radius = 3) {
    const out = [];
    for (let l = line - radius; l <= line + radius; l++) {
        const text = byNewLine.get(l);
        if (!text) continue;
        // A trailing comment counts too: `except Exception:  # deliberate`
        const m = text.match(/(?:\/\/|#|\/\*)\s*(.+)$/);
        if (m) out.push(m[1].trim());
    }
    return out;
}

/**
 * Feature-flag cleanup diffs.
 *
 * 6 of the 27 remaining false positives flagged "behaviour change" on code the MR
 * DELETED, where the deleted branch sat under an always-on flag and was already
 * unreachable. Removing dead code is not a behaviour change, and the diff itself
 * carries the evidence: a removed `if <flag>` guard plus a removed body.
 */
const FLAG_GUARD = /\b(if|elif|else if)\b.*\b(feature_?flag|is_?enabled|flag|ff_|use_new|enable[dA-Z_])/i;
const BEHAVIOUR_CLAIM = /\b(behaviou?r|inconsisten|no longer|changed|removed|missing (update|handling)|dead)\b/i;

/**
 * Second-tier deterministic checks. Unlike `assessFinding` these do not prove the
 * premise false — they prove the finding is not ACTIONABLE. Returned separately so
 * a caller can choose to downgrade rather than drop.
 *
 * @returns {{verdict:string, reason:string|null}}
 */
export function assessIntent(finding, patch) {
    if (!patch) return { verdict: EVIDENCE.UNPROVEN, reason: null };

    const { removed, byNewLine } = partitionPatch(patch);
    const claim = [finding?.title, finding?.description].filter(Boolean).join(' ');
    const line = Number(finding?.line);

    // Deliberate, documented error suppression.
    //
    // The test is the PRESENCE of an explanatory comment, not its wording. A
    // keyword list missed the real cases outright — "corrupted or unavailable —
    // fall through to default" and "never change the pod's exit code" share no
    // vocabulary. The claim is that the handler is *silent*; a comment explaining
    // the handler refutes exactly that claim, whatever it says.
    //
    // TODO/FIXME/HACK are excluded: those mark known debt, so a finding about
    // them is legitimate rather than redundant.
    if (SWALLOW_CLAIM.test(claim) && Number.isFinite(line)) {
        const explanatory = nearbyComments(byNewLine, line).find(c =>
            c.length >= 12
            && !/^(TODO|FIXME|HACK|XXX|NOTE:)/i.test(c)
            && !/^(eslint|prettier|@ts-|noqa|pylint|type:)/i.test(c)  // tooling pragmas
        );
        if (explanatory) {
            return {
                verdict: EVIDENCE.REFUTED,
                reason: `the handler is documented, so it is not silent: "${explanatory.slice(0, 90)}"`,
            };
        }
    }

    // Behaviour-change claim against a feature-flag cleanup.
    if (BEHAVIOUR_CLAIM.test(claim)) {
        const removedFlagGuard = removed.some(l => FLAG_GUARD.test(l));
        if (removedFlagGuard) {
            return {
                verdict: EVIDENCE.REFUTED,
                reason: 'this diff removes a feature-flag guard and its branch — deleting an unreachable branch is not a behaviour change',
            };
        }
    }

    return { verdict: EVIDENCE.UNPROVEN, reason: null };
}

/**
 * Collapse findings that describe the same defect in the same place.
 *
 * The measured run contained 8 exact duplicates — the same empty-catch reported
 * twice at adjacent lines, the same SSRF claim on two files, the same `==` nit
 * three times. Each was verified independently and each passed, so the verifier
 * spent tokens confirming the same wrong thing repeatedly.
 *
 * @returns {{ kept: Array, duplicates: Array }}
 */
export function dedupeFindings(findings = []) {
    const kept = [];
    const duplicates = [];
    const seen = new Map();

    // Defect CLASS, not title text. Titles for the same defect vary freely
    // ("Empty catch block swallows the error" / "Empty catch block in
    // readStoredFraction function" / "Use === instead of ==" / "Use strict
    // equality operators"), so text-similarity keying missed most duplicates.
    // Classing collapses the wording and keys on what the finding is about.
    const CLASSES = [
        [/empty catch|swallow|silently|suppress/i, 'swallowed-error'],
        [/===|strict equality|type coercion|== *(null|undefined)/i, 'strict-equality'],
        [/ssrf|unvalidated host|server[- ]side request/i, 'ssrf'],
        [/env(ironment)? var|getenv|os\.environ/i, 'env-var'],
        [/retry|backoff|redeliver/i, 'retry'],
        [/deprecat/i, 'deprecated'],
        [/memory leak|settimeout|setinterval|listener/i, 'leak'],
        [/sensitive|credential|secret|pii|exposure/i, 'sensitive-data'],
        [/error return value ignored|unchecked error/i, 'unchecked-error'],
        [/lock|mutex|race|concurren/i, 'concurrency'],
        [/idempoten/i, 'idempotency'],
    ];

    const classOf = (f) => {
        const text = [f.title, f.message, f.description].filter(Boolean).join(' ');
        for (const [re, cls] of CLASSES) if (re.test(text)) return cls;
        // Unclassified: fall back to normalized title so we still catch verbatim
        // repeats without over-merging unrelated findings.
        return 'text:' + String(f.title || f.message || '')
            .toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
    };

    for (const f of findings) {
        const key = `${f.file || ''}|${classOf(f)}`;
        const prev = seen.get(key);
        if (prev) {
            // Same defect class in the same file. A window of 25 lines keeps
            // genuinely separate instances apart (a second empty catch further
            // down the file) while collapsing the same one reported at 32/33,
            // or a catch reported at both the `if` and the `catch` line.
            const near = Math.abs(Number(f.line ?? 0) - Number(prev.line ?? 0)) <= 25;
            if (near) {
                duplicates.push({ ...f, _duplicateOf: prev.line });
                continue;
            }
        }
        seen.set(key, f);
        kept.push(f);
    }
    return { kept, duplicates };
}

export default { assessFinding, claimedConstructs, dedupeFindings, EVIDENCE };
