/**
 * PR Finding Parser for RepoSpector
 *
 * Parses LLM analysis output into structured findings that can be
 * used for threaded conversations and tracking.
 */

/**
 * Parse LLM analysis text into structured findings
 * @param {string} analysisText - Raw LLM analysis output
 * @param {Object} prData - PR data for context
 * @returns {Array} Parsed findings
 */
export function parseLLMAnalysis(analysisText, prData = {}) {
    if (!analysisText) return [];

    const findings = [];
    const lines = analysisText.split('\n');

    let currentFinding = null;
    let inCodeBlock = false;
    let codeBlockContent = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track code blocks
        if (line.trim().startsWith('```')) {
            if (inCodeBlock) {
                // End of code block
                if (currentFinding) {
                    currentFinding.codeSnippet = codeBlockContent.join('\n');
                }
                codeBlockContent = [];
                inCodeBlock = false;
            } else {
                // Start of code block
                inCodeBlock = true;
            }
            continue;
        }

        if (inCodeBlock) {
            codeBlockContent.push(line);
            continue;
        }

        // Parse severity markers
        const severityMatch = parseSeverityLine(line);
        if (severityMatch) {
            // Save previous finding
            if (currentFinding) {
                findings.push(currentFinding);
            }

            currentFinding = {
                id: generateFindingId(findings.length),
                severity: severityMatch.severity,
                type: severityMatch.type,
                title: severityMatch.title,
                message: '',
                file: null,
                line: null,
                source: 'llm'
            };
            continue;
        }

        // Parse file/line references
        const fileMatch = parseFileReference(line);
        if (fileMatch && currentFinding) {
            currentFinding.file = fileMatch.file;
            currentFinding.line = fileMatch.line;
        }

        // Add to current finding message
        if (currentFinding) {
            currentFinding.message += (currentFinding.message ? '\n' : '') + line;
        }
    }

    // Add last finding
    if (currentFinding) {
        findings.push(currentFinding);
    }

    // Clean up findings
    return findings.map(f => ({
        ...f,
        message: cleanMessage(f.message),
        confidence: estimateConfidence(f)
    }));
}

/**
 * Parse severity from a line
 */
function parseSeverityLine(line) {
    const patterns = [
        // Critical/High/Medium/Low markers
        { regex: /^#+\s*(?:🔴|❌|CRITICAL|Critical)[\s:]+(.+)/i, severity: 'critical' },
        { regex: /^#+\s*(?:🟠|⚠️|HIGH|High)[\s:]+(.+)/i, severity: 'high' },
        { regex: /^#+\s*(?:🟡|MEDIUM|Medium|WARNING|Warning)[\s:]+(.+)/i, severity: 'medium' },
        { regex: /^#+\s*(?:🟢|🔵|LOW|Low|INFO|Info)[\s:]+(.+)/i, severity: 'low' },

        // Numbered issues
        { regex: /^\d+\.\s*\*\*(?:Critical|CRITICAL)\*\*[\s:]+(.+)/i, severity: 'critical' },
        { regex: /^\d+\.\s*\*\*(?:High|HIGH)\*\*[\s:]+(.+)/i, severity: 'high' },
        { regex: /^\d+\.\s*\*\*(?:Medium|MEDIUM)\*\*[\s:]+(.+)/i, severity: 'medium' },
        { regex: /^\d+\.\s*\*\*(?:Low|LOW)\*\*[\s:]+(.+)/i, severity: 'low' },

        // Issue type headers
        { regex: /^#+\s*(Security|SECURITY)[\s:]+(.+)/i, severity: 'high', type: 'security' },
        { regex: /^#+\s*(Bug|BUG|Error|ERROR)[\s:]+(.+)/i, severity: 'medium', type: 'bug' },
        { regex: /^#+\s*(Performance|PERFORMANCE)[\s:]+(.+)/i, severity: 'medium', type: 'performance' },
        { regex: /^#+\s*(Style|STYLE|Code Quality)[\s:]+(.+)/i, severity: 'low', type: 'style' },

        // Bullet points with severity
        { regex: /^[-*]\s*\*\*(Critical|CRITICAL)\*\*[\s:]+(.+)/i, severity: 'critical' },
        { regex: /^[-*]\s*\*\*(High|HIGH)\*\*[\s:]+(.+)/i, severity: 'high' },
        { regex: /^[-*]\s*\*\*(Medium|MEDIUM)\*\*[\s:]+(.+)/i, severity: 'medium' },
        { regex: /^[-*]\s*\*\*(Low|LOW)\*\*[\s:]+(.+)/i, severity: 'low' }
    ];

    for (const { regex, severity, type } of patterns) {
        const match = line.match(regex);
        if (match) {
            return {
                severity,
                type: type || categorizeIssue(match[1] || match[2]),
                title: (match[2] || match[1] || '').trim()
            };
        }
    }

    return null;
}

/**
 * Parse file reference from a line
 */
function parseFileReference(line) {
    const patterns = [
        // File: path/to/file.js:123
        /(?:File|Location|In)[\s:]+`?([^`\s:]+(?:\.[a-z]+))(?::(\d+))?`?/i,
        // path/to/file.js:123
        /`([^`]+(?:\.[a-z]+)):(\d+)`/,
        // Line 123 in file.js
        /Line\s+(\d+)(?:\s+in\s+)?([^\s]+\.[a-z]+)?/i,
        // (file.js:123)
        /\(([^)]+\.[a-z]+):(\d+)\)/
    ];

    for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
            if (pattern === patterns[2]) {
                return { file: match[2], line: parseInt(match[1], 10) };
            }
            return {
                file: match[1],
                line: match[2] ? parseInt(match[2], 10) : null
            };
        }
    }

    return null;
}

/**
 * Categorize issue type from title/description
 */
function categorizeIssue(text) {
    if (!text) return 'general';

    const lower = text.toLowerCase();

    if (/injection|xss|csrf|auth|secret|credential|password|token|vulnerability|security|exploit/i.test(lower)) {
        return 'security';
    }
    if (/bug|error|null|undefined|exception|crash|fail/i.test(lower)) {
        return 'bug';
    }
    if (/performance|slow|memory|leak|optimize|n\+1|complexity/i.test(lower)) {
        return 'performance';
    }
    if (/style|naming|format|lint|convention|readability/i.test(lower)) {
        return 'style';
    }
    if (/test|coverage|assertion|mock/i.test(lower)) {
        return 'testing';
    }

    return 'general';
}

/**
 * Estimate confidence based on finding details
 */
function estimateConfidence(finding) {
    let confidence = 0.5;

    // Higher severity = higher base confidence
    const severityBoost = {
        critical: 0.3,
        high: 0.2,
        medium: 0.1,
        low: 0.0
    };
    confidence += severityBoost[finding.severity] || 0;

    // File reference increases confidence
    if (finding.file) confidence += 0.1;
    if (finding.line) confidence += 0.1;

    // Code snippet increases confidence
    if (finding.codeSnippet) confidence += 0.1;

    // Specific type increases confidence
    if (finding.type !== 'general') confidence += 0.05;

    return Math.min(1.0, confidence);
}

/**
 * Clean up message text
 */
function cleanMessage(message) {
    if (!message) return '';

    return message
        .replace(/^[\s\n]+|[\s\n]+$/g, '') // Trim whitespace
        .replace(/\n{3,}/g, '\n\n') // Reduce multiple newlines
        .replace(/^[-*]\s+/gm, '') // Remove leading bullets
        .trim();
}

/**
 * Generate finding ID
 */
function generateFindingId(index) {
    return `llm_finding_${Date.now()}_${index}`;
}

/**
 * Merge LLM findings with static analysis findings
 * @param {Array} llmFindings - Findings from LLM analysis
 * @param {Array} staticFindings - Findings from static analysis
 * @returns {Array} Merged and deduplicated findings
 */
export function mergeFindings(llmFindings, staticFindings) {
    const merged = [];
    const seen = new Set();

    // Add static findings first (higher confidence)
    for (const finding of staticFindings) {
        const key = `${finding.file}:${finding.line}:${finding.type}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push({
                ...finding,
                source: 'static'
            });
        }
    }

    // Add LLM findings that don't overlap
    for (const finding of llmFindings) {
        const key = `${finding.file}:${finding.line}:${finding.type}`;
        if (!seen.has(key)) {
            // Check for fuzzy match (same file, similar line)
            const hasOverlap = merged.some(m =>
                m.file === finding.file &&
                m.line &&
                finding.line &&
                Math.abs(m.line - finding.line) <= 3
            );

            if (!hasOverlap) {
                seen.add(key);
                merged.push({
                    ...finding,
                    source: 'llm'
                });
            }
        }
    }

    return merged;
}

/**
 * Extract action items from LLM analysis
 * @param {string} analysisText - Raw LLM analysis
 * @returns {Array} Action items
 */
export function extractActionItems(analysisText) {
    if (!analysisText) return [];

    const actionItems = [];
    const lines = analysisText.split('\n');

    for (const line of lines) {
        // Look for checkbox patterns
        const checkboxMatch = line.match(/^[-*]\s*\[[ x]\]\s*(.+)/i);
        if (checkboxMatch) {
            actionItems.push({
                text: checkboxMatch[1].trim(),
                completed: line.includes('[x]') || line.includes('[X]')
            });
            continue;
        }

        // Look for numbered action items
        const numberedMatch = line.match(/^\d+\.\s*(?:TODO|Action|Fix|Update|Remove|Add)[\s:]+(.+)/i);
        if (numberedMatch) {
            actionItems.push({
                text: numberedMatch[1].trim(),
                completed: false
            });
        }
    }

    return actionItems;
}

/**
 * Extract verdict from LLM analysis
 * @param {string} analysisText - Raw LLM analysis
 * @returns {Object} Verdict information
 */
export function extractVerdict(analysisText) {
    if (!analysisText) return null;

    const verdictPatterns = [
        { regex: /(?:🟢|✅|APPROVED|Safe to Merge)/i, verdict: 'approve', confidence: 'high' },
        { regex: /(?:🟡|⚠️|NEEDS? REVIEW|Review Recommended)/i, verdict: 'review', confidence: 'medium' },
        { regex: /(?:🔴|❌|BLOCKED|CHANGES REQUESTED|Do Not Merge)/i, verdict: 'block', confidence: 'high' },
        { regex: /Verdict[\s:]+\*\*(Approved?|Safe|LGTM)\*\*/i, verdict: 'approve', confidence: 'high' },
        { regex: /Verdict[\s:]+\*\*(Block|Reject|Changes)/i, verdict: 'block', confidence: 'high' }
    ];

    for (const { regex, verdict, confidence } of verdictPatterns) {
        if (regex.test(analysisText)) {
            return { verdict, confidence };
        }
    }

    return { verdict: 'review', confidence: 'low' };
}

export default {
    parseLLMAnalysis,
    mergeFindings,
    extractActionItems,
    extractVerdict
};
