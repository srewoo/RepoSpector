/**
 * Pure code-cleaning helpers used by the content-script extractor.
 *
 * These were previously methods on ContentExtractor in content/index.js, which
 * self-instantiates DOM managers at import time and therefore cannot be loaded
 * in a unit test. They are pure string→string transforms, so they live here
 * where they can be exercised directly. ContentExtractor delegates to them.
 */

/**
 * Strip leading line-number gutters like "123  " or "123\t" from each line.
 * @param {string} code
 * @returns {string}
 */
export function cleanLineNumbers(code) {
    if (typeof code !== 'string') return code;
    const lines = code.split('\n');
    const cleanedLines = lines.map((line) =>
        // Remove leading line numbers like "123 " or "123\t"
        line.replace(/^\s*\d+[\s\t]+/, '')
    );
    return cleanedLines.join('\n');
}

/**
 * Clean code extracted from a rendered GitHub/GitLab page: strip line-number
 * gutters, remove UI chrome labels (Copy/Raw/Blame/…), collapse blank runs.
 * @param {string} code
 * @returns {string}
 */
export function cleanupExtractedCode(code) {
    if (!code) return code;

    let cleaned = code;

    // Remove line numbers at the beginning of lines (common in GitLab/GitHub)
    // Matches: "1  some code" or "123  some code"
    cleaned = cleaned.replace(/^\d+\s{2,}/gm, '');

    // Remove line numbers with tabs or multiple spaces
    cleaned = cleaned.replace(/^\d+\t/gm, '');

    // Remove line numbers with single space (more aggressive for GitLab)
    // Only remove if followed by typical code characters
    cleaned = cleaned.replace(/^(\d+)\s+([a-zA-Z_#@"'$])/gm, '$2');

    // Remove GitLab-specific UI elements
    cleaned = cleaned.replace(/^\s*Copy\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*View\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*Raw\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*Blame\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*Edit\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*Open in Web IDE\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*Download\s*$/gm, '');

    // Remove excessive empty lines
    cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');

    // Trim whitespace from start and end
    cleaned = cleaned.trim();

    return cleaned;
}
