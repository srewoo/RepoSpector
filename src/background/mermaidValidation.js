/**
 * Pure Mermaid diagram helpers, extracted from BackgroundService so they can be
 * unit-tested and reused without instantiating the service worker.
 *
 * - validateMermaidSyntax: cheap structural checks before handing code to the
 *   Mermaid renderer (header, quotes, fences, bracket balance).
 * - sanitizeMermaidCode: fix common LLM-emitted syntax issues in sequence and
 *   flowchart diagrams so they render instead of throwing.
 */

/**
 * Validate Mermaid diagram syntax with basic structural checks.
 * @param {string} code
 * @param {string} expectedType - 'sequence' | 'class' | 'state' | 'er'
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMermaidSyntax(code, expectedType) {
    const errors = [];
    const lines = code.trim().split('\n');
    if (lines.length === 0) {
        return { valid: false, errors: ['Empty diagram'] };
    }

    const firstLine = lines[0].trim().toLowerCase();
    const typeHeaders = {
        sequence: 'sequencediagram',
        class: 'classdiagram',
        state: 'statediagram',
        er: 'erdiagram'
    };

    // Check header matches expected type
    const expectedHeader = typeHeaders[expectedType] || typeHeaders.sequence;
    if (!firstLine.startsWith(expectedHeader) && !firstLine.startsWith('sequencediagram') &&
        !firstLine.startsWith('classdiagram') && !firstLine.startsWith('statediagram') &&
        !firstLine.startsWith('erdiagram') && !firstLine.startsWith('flowchart') &&
        !firstLine.startsWith('graph')) {
        errors.push(`Missing diagram header (expected ${expectedHeader}, got "${lines[0].trim()}")`);
    }

    // Check for minimum content
    if (lines.length < 3) {
        errors.push('Diagram too short — expected at least 3 lines');
    }

    // Check for unmatched quotes
    const quoteCount = (code.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
        errors.push('Unmatched double quotes');
    }

    // Check for markdown fence contamination
    if (code.includes('```')) {
        errors.push('Contains markdown code fences');
    }

    // Check for unbalanced brackets in non-ER diagrams
    if (expectedType !== 'er') {
        const opens = (code.match(/[[({]/g) || []).length;
        const closes = (code.match(/[\])}]/g) || []).length;
        if (Math.abs(opens - closes) > 2) {
            errors.push(`Unbalanced brackets (${opens} opens vs ${closes} closes)`);
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Sanitize LLM-generated Mermaid code to fix common syntax issues.
 * Handles nested brackets, unquoted parentheses/braces in labels, etc.
 * @param {string} code
 * @returns {string}
 */
export function sanitizeMermaidCode(code) {
    // Detect diagram type to apply appropriate sanitization
    const firstLine = code.trim().split('\n')[0].trim().toLowerCase();
    const isSequenceDiagram = firstLine.startsWith('sequencediagram');

    if (isSequenceDiagram) {
        // For sequence diagrams: minimal sanitization, just fix common LLM issues
        return code.split('\n').map(line => {
            const trimmed = line.trim();
            // Skip empty, comments, and keywords
            if (!trimmed || trimmed.startsWith('%%') || trimmed === 'end' ||
                trimmed === 'sequenceDiagram' ||
                /^(participant|actor|activate|deactivate|Note\s|alt|else|opt|loop|par|and|rect|critical|break)\s*/i.test(trimmed)) {
                return line;
            }
            // Fix <br> tags that some LLMs add (Mermaid prefers \\n in sequence diagrams)
            return line.replace(/<br\s*\/?>/gi, '\\n');
        }).join('\n');
    }

    // Flowchart sanitization
    return code.split('\n').map(line => {
        const trimmed = line.trim();
        // Skip non-node lines
        if (!trimmed || trimmed.startsWith('%%') || trimmed === 'end' ||
            trimmed.startsWith('classDef ') ||
            trimmed.startsWith('style ') || trimmed.startsWith('linkStyle ') ||
            /^(flowchart|graph|subgraph)\s/.test(trimmed)) {
            return line;
        }

        // Fix class statements: "class A, B, C hub" → "class A,B,C hub"
        if (trimmed.startsWith('class ')) {
            return line.replace(/class\s+([\w,\s]+)\s+(\w+)\s*$/, (match, ids, className) => {
                const cleanIds = ids.replace(/\s+/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '');
                return `class ${cleanIds} ${className}`;
            });
        }

        // Convert sequence-diagram arrows to flowchart arrows
        line = line.replace(/-->>/, '-->');
        line = line.replace(/->>/, '-->');

        // Remove ::: class shortcuts (e.g. "A:::hub --> B")
        line = line.replace(/:::\w+/g, '');

        // Strip quotes from edge labels: -->|"text"| → -->|text|
        line = line.replace(/(\|)\s*"([^"]*?)"\s*(\|)/g, '$1$2$3');

        // Sanitize edge labels: remove special chars like / < > from inside |...|
        line = line.replace(/\|([^|]*)\|/g, (match, label) => {
            const clean = label.replace(/[/<>\\[\]{}()#&]/g, ' ').replace(/\s+/g, ' ').trim();
            return `|${clean}|`;
        });

        // Fix unmatched pipe in edge labels (e.g. "A -->|label B" missing closing pipe)
        line = line.replace(/(-->|---|-\.->|==>)\|([^|]*?)(\s+\w+\s*$)/, '$1|$2|$3');

        // Skip edge-only lines (e.g. "A --> B")
        if (/^\s*\w+\s*(-->|---|-\.->|==>|-.->|--)\s*\w+/.test(line) && !/[[({"]/.test(line)) {
            return line;
        }

        // Fix node definitions where labels contain Mermaid-special characters.
        return line.replace(
            /(\b[A-Za-z_]\w*)\s*([[({])(\({0,2})(.*?)(\){0,2})([\])}])/g,
            (match, id, open, extraOpen, label, extraClose, close) => {
                if (label.startsWith('"') && label.endsWith('"')) return match;
                const fullLabel = `${extraOpen}${label}${extraClose}`;
                if (/[()[\]{}<>|#&]/.test(fullLabel)) {
                    const cleanLabel = fullLabel.replace(/[()[\]{}<>|]/g, ' ').replace(/\s+/g, ' ').trim();
                    return `${id}${open}"${cleanLabel}"${close}`;
                }
                return match;
            }
        );
    }).join('\n');
}
