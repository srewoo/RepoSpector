/**
 * Parse a finder lens's reply into a findings array.
 *
 * Moved verbatim from `MultiFinderService._parseFindings` so the service stays
 * under the 300-line cap. Tolerates markdown fences and prose around the JSON;
 * an unparseable reply is `[]`.
 *
 * @param {unknown} text
 * @returns {Array<Object>}
 */
export function parseFinderFindings(text) {
    if (!text || typeof text !== 'string') return [];
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
    const tryParse = (s) => {
        try {
            const o = JSON.parse(s);
            if (Array.isArray(o?.findings)) return o.findings;
            if (Array.isArray(o)) return o;
        } catch { /* ignore */ }
        return null;
    };
    return tryParse(cleaned) || tryParse((cleaned.match(/\{[\s\S]*\}/) || [])[0] || '') || [];
}

export default { parseFinderFindings };
