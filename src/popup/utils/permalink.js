/** https-only permalink href for a finding, or null (same rule as inlineCommentFormatter). */
export function permalinkHref(finding) {
    const p = finding?.permalink;
    return typeof p === 'string' && /^https:\/\//.test(p) ? p : null;
}
