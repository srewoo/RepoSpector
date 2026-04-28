/**
 * Findings parser — extracts structured finding objects from LLM analysis text.
 *
 * Supports both the legacy format and the new #22 BLOCKING/SUGGESTION/NITPICK
 * format introduced in Phase 7. The new format also includes a Rule: citation
 * field (#20) which is surfaced on the finding object.
 */

/**
 * Maps a severity string from the LLM to a canonical lowercase severity key.
 */
export function mapSeverity(severityText) {
    const text = (severityText || '').toLowerCase().replace(/\*\*/g, '');
    if (text.includes('critical')) return 'critical';
    if (text.includes('high')) return 'high';
    if (text.includes('medium')) return 'medium';
    if (text.includes('low')) return 'low';
    return 'medium';
}

/**
 * Maps a BLOCKING/SUGGESTION/NITPICK bucket to a canonical severity if no
 * explicit severity was provided.
 */
export function mapBucketToSeverity(bucket) {
    const b = (bucket || '').toUpperCase();
    if (b === 'BLOCKING') return 'high';
    if (b === 'SUGGESTION') return 'medium';
    if (b === 'NITPICK') return 'low';
    return 'medium';
}

/**
 * Extracts the Rule: citation from a code-block section.
 * Returns the citation string or null.
 */
function extractRule(text) {
    const m = text.match(/Rule:\s*([^\n]+)/i);
    return m ? m[1].trim() : null;
}

/**
 * Parse the new structured format (##20/#22):
 *   File: ...
 *   Line: ...
 *   Type: ...
 *   Severity: ...
 *   Bucket: BLOCKING|SUGGESTION|NITPICK
 *   Rule: standards/... → RULE-ID "..."
 *   Issue: ...
 *   Impact: ...
 *   Fix: ...
 */
function parseStructuredFindings(sectionText, defaultSeverity, defaultBucket) {
    const findings = [];
    let match;

    // New format with Rule: field
    const newFormatPattern = /File:\s*([^\n]+)\s*\n(?:[^\n]*\n)*?Line:\s*(\d+)[^\n]*\n(?:[^\n]*\n)*?(?:Type:\s*([^\n]+)\n)?(?:[^\n]*\n)*?(?:Severity:\s*([^\n]+)\n)?(?:[^\n]*\n)*?(?:Bucket:\s*([^\n]+)\n)?(?:[^\n]*\n)*?(?:Rule:\s*([^\n]+)\n)?(?:[^\n]*\n)*?Issue:\s*([^\n]+)/gi;

    while ((match = newFormatPattern.exec(sectionText)) !== null) {
        const bucket = match[5]?.trim() || defaultBucket;
        const severityRaw = match[4]?.trim() || '';
        const severity = severityRaw ? mapSeverity(severityRaw) : mapBucketToSeverity(bucket);
        findings.push({
            id: `llm-${findings.length}-${Date.now()}`,
            file: match[1].replace(/\*\*/g, '').trim(),
            line: parseInt(match[2], 10),
            type: match[3]?.replace(/\*\*/g, '').trim() || 'general',
            severity,
            bucket,
            rule: match[6]?.trim() || null,
            message: match[7].replace(/\*\*/g, '').trim(),
            source: 'ai',
            confidence: 0.85
        });
    }

    if (findings.length > 0) return findings;

    // Legacy structured format (File/Line/Type/Severity/Issue — no Bucket/Rule)
    const legacyPattern = /File:\s*([^\n]+)\s*\n\s*Line:\s*(\d+)[^\n]*\n\s*Type:\s*([^\n]+)\s*\n\s*Severity:\s*([^\n]+)\s*\n\s*(?:CWE:[^\n]*\n\s*)?Issue:\s*([^\n]+)/gi;
    while ((match = legacyPattern.exec(sectionText)) !== null) {
        findings.push({
            id: `llm-${findings.length}-${Date.now()}`,
            file: match[1].replace(/\*\*/g, '').trim(),
            line: parseInt(match[2], 10),
            type: match[3].replace(/\*\*/g, '').trim(),
            severity: mapSeverity(match[4].trim()),
            bucket: defaultBucket,
            rule: extractRule(sectionText.substring(match.index, match.index + 500)),
            message: match[5].replace(/\*\*/g, '').trim(),
            source: 'ai',
            confidence: 0.85
        });
    }

    return findings;
}

/**
 * Parse bullet-point structured format from multi-pass aggregation.
 * - **File**: path\n- **Line**: 42\n...
 */
function parseBulletFindings(sectionText, defaultSeverity, defaultBucket) {
    const findings = [];
    const pattern = /-\s*\*?\*?File\*?\*?:\s*([^\n]+)\s*\n\s*-\s*\*?\*?Line\*?\*?:\s*(\d+)[^\n]*\n\s*-\s*\*?\*?Type\*?\*?:\s*([^\n]+)\s*\n\s*-\s*\*?\*?Severity\*?\*?:\s*([^\n]+)\s*\n(?:\s*-\s*\*?\*?(?:CWE|Bucket)\*?\*?:\s*([^\n]*)\n)?(?:\s*-\s*\*?\*?Rule\*?\*?:\s*([^\n]*)\n)?\s*-\s*\*?\*?Issue\*?\*?:\s*([^\n]+)/gi;
    let match;
    while ((match = pattern.exec(sectionText)) !== null) {
        const bucketOrCWE = match[5]?.trim() || '';
        const bucket = /BLOCKING|SUGGESTION|NITPICK/i.test(bucketOrCWE) ? bucketOrCWE.toUpperCase() : defaultBucket;
        findings.push({
            id: `llm-${findings.length}-${Date.now()}`,
            file: match[1].replace(/\*\*/g, '').trim(),
            line: parseInt(match[2], 10),
            type: match[3].replace(/\*\*/g, '').trim(),
            severity: mapSeverity(match[4].trim()),
            bucket,
            rule: match[6]?.trim() || null,
            message: match[7].replace(/\*\*/g, '').trim(),
            source: 'ai',
            confidence: 0.85
        });
    }
    return findings;
}

/**
 * Extract issues from a single section of LLM output.
 */
function extractIssuesFromSection(sectionText, defaultSeverity, defaultBucket) {
    // Try structured formats first
    let issues = parseStructuredFindings(sectionText, defaultSeverity, defaultBucket);
    if (issues.length > 0) return issues;

    issues = parseBulletFindings(sectionText, defaultSeverity, defaultBucket);
    if (issues.length > 0) return issues;

    // Numbered items (1. **Title**: description)
    const numbered = [];
    const numberedPattern = /^\s*\d+\.\s*\*?\*?([^*\n:]+)\*?\*?:?\s*([^\n]+)/gm;
    let match;
    while ((match = numberedPattern.exec(sectionText)) !== null) {
        const title = match[1].trim();
        const desc = match[2].trim();
        if (title && desc && !title.toLowerCase().includes('no ') && !desc.toLowerCase().includes('no current')) {
            numbered.push({
                id: `llm-${numbered.length}-${Date.now()}`,
                file: 'Unknown', line: 0,
                type: title, severity: defaultSeverity, bucket: defaultBucket,
                rule: null, message: desc, source: 'ai', confidence: 0.75
            });
        }
    }
    if (numbered.length > 0) return numbered;

    // Simple bullet items
    const bullets = [];
    const bulletPattern = /^\s*[-*]\s+\*?\*?([^*\n:]+)\*?\*?:\s*([^\n]+)/gm;
    while ((match = bulletPattern.exec(sectionText)) !== null) {
        const title = match[1].trim();
        const desc = match[2].trim();
        if (/^(file|line|type|severity|issue|impact|fix|cwe|confidence|cross-file|rule|bucket)$/i.test(title)) continue;
        if (title && desc && desc.length > 10) {
            bullets.push({
                id: `llm-${bullets.length}-${Date.now()}`,
                file: 'Unknown', line: 0,
                type: title, severity: defaultSeverity, bucket: defaultBucket,
                rule: null, message: desc, source: 'ai', confidence: 0.7
            });
        }
    }
    return bullets;
}

/**
 * Parse all findings from the full LLM analysis text.
 * Handles both the new BLOCKING/SUGGESTION/NITPICK format and the legacy
 * Critical Issues / Warnings / Suggestions format.
 *
 * @param {string} text - Full analysis text from the LLM
 * @returns {Array} Normalised finding objects
 */
export function parseLLMFindings(text) {
    if (!text) return [];

    const findings = [];

    // New format: ### BLOCKING Issues
    const blockingMatch = text.match(/###?\s*BLOCKING\s+Issues[^\n]*\n([\s\S]*?)(?=###?\s*SUGGESTION|###?\s*NITPICK|###?\s*Security Checklist|$)/i);
    if (blockingMatch?.[1]) findings.push(...extractIssuesFromSection(blockingMatch[1], 'high', 'BLOCKING'));

    // New format: ### SUGGESTION Issues
    const suggestionMatch = text.match(/###?\s*SUGGESTION\s+Issues[^\n]*\n([\s\S]*?)(?=###?\s*BLOCKING|###?\s*NITPICK|###?\s*Security Checklist|$)/i);
    if (suggestionMatch?.[1]) findings.push(...extractIssuesFromSection(suggestionMatch[1], 'medium', 'SUGGESTION'));

    // New format: ### NITPICK Issues
    const nitpickMatch = text.match(/###?\s*NITPICK\s+Issues[^\n]*\n([\s\S]*?)(?=###?\s*BLOCKING|###?\s*SUGGESTION|###?\s*Security Checklist|$)/i);
    if (nitpickMatch?.[1]) findings.push(...extractIssuesFromSection(nitpickMatch[1], 'low', 'NITPICK'));

    // Legacy format: ### Critical Issues
    if (findings.length === 0) {
        const criticalMatch = text.match(/###?\s*Critical Issues[^\n]*\n([\s\S]*?)(?=###?\s*Warnings|###?\s*Suggestions|###?\s*Cross-File|###?\s*Security Checklist|$)/i);
        if (criticalMatch?.[1]) findings.push(...extractIssuesFromSection(criticalMatch[1], 'critical', 'BLOCKING'));

        const warningsMatch = text.match(/###?\s*Warnings[^\n]*\n([\s\S]*?)(?=###?\s*Suggestions|###?\s*Cross-File|###?\s*Security Checklist|###?\s*Critical|$)/i);
        if (warningsMatch?.[1]) findings.push(...extractIssuesFromSection(warningsMatch[1], 'high', 'SUGGESTION'));

        const suggestionsMatch = text.match(/###?\s*Suggestions[^\n]*\n([\s\S]*?)(?=###?\s*Cross-File|###?\s*Security|###?\s*Critical|###?\s*Warnings|###?\s*Test|###?\s*Positive|$)/i);
        if (suggestionsMatch?.[1]) findings.push(...extractIssuesFromSection(suggestionsMatch[1], 'low', 'SUGGESTION'));
    }

    return findings;
}

/**
 * Convert multi-pass per-file findings to the flat UI findings format.
 */
export function convertMultiPassFindings(perFileResults) {
    if (!perFileResults || !Array.isArray(perFileResults)) return [];
    const findings = [];
    for (const result of perFileResults) {
        for (const f of (result.findings || [])) {
            findings.push({
                id: `mp-${f.id || findings.length}-${Date.now()}`,
                file: f.file || result.file || 'Unknown',
                line: f.line || 0,
                type: f.type || f.title || 'general',
                severity: f.severity || 'medium',
                bucket: f.bucket || (f.severity === 'critical' || f.severity === 'high' ? 'BLOCKING' : 'SUGGESTION'),
                rule: f.rule || null,
                message: f.description || f.title || '',
                title: f.title || '',
                impact: f.impact || '',
                suggestion: f.suggestion || '',
                cwe: f.cwe || null,
                source: 'ai',
                confidence: f.confidence || 0.8
            });
        }
    }
    return findings;
}

/**
 * Parse the Standards Checklist from analysis text for display in the UI.
 * Returns array of { ruleId, status ('PASS'|'FAIL'|'SKIPPED'), note }
 */
export function parseStandardsChecklist(text) {
    if (!text) return [];
    const items = [];
    const pattern = /^\s*-\s*\[(PASS|FAIL|SKIPPED)\]\s+([^\n]+)/gm;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        items.push({ status: match[1], note: match[2].trim() });
    }
    return items;
}

/**
 * Extract BLOCKING/SUGGESTION/NITPICK counts from the Summary block.
 * Returns { blocking, suggestion, nitpick, verdict }
 */
export function parseSummaryCounts(text) {
    if (!text) return { blocking: 0, suggestion: 0, nitpick: 0, verdict: null };
    const blockingM = text.match(/BLOCKING:\s*(\d+)/i);
    const suggestionM = text.match(/SUGGESTION:\s*(\d+)/i);
    const nitpickM = text.match(/NITPICK:\s*(\d+)/i);
    const verdictM = text.match(/VERDICT:\s*(APPROVED|CHANGES_REQUESTED|APPROVE|REQUEST_CHANGES)/i);
    const blocking = blockingM ? parseInt(blockingM[1], 10) : 0;
    return {
        blocking,
        suggestion: suggestionM ? parseInt(suggestionM[1], 10) : 0,
        nitpick: nitpickM ? parseInt(nitpickM[1], 10) : 0,
        verdict: verdictM ? verdictM[1].toUpperCase() : (blocking > 0 ? 'CHANGES_REQUESTED' : null)
    };
}
