/**
 * Everything the generated-tests panel decides, as a pure function, so it is
 * testable without a DOM harness this repo does not carry.
 */
import { languageForPath } from '../../utils/prTestPrompts.js';

const MODE_LABEL = { append: 'append to existing', create: 'new file' };

export function summarizeGeneratedTests(result) {
    if (!result) return { show: false, headline: '', files: [], skipped: [] };

    const files = (result.files || []).map(f => ({
        ...f,
        modeLabel: MODE_LABEL[f.mode] || f.mode,
        language: languageForPath(f.path),
    }));
    const skipped = (result.skipped || []).map(s => ({
        ...s,
        label: s.file || 'This PR',
    }));

    const generated = files.length
        ? `${files.length} test file${files.length === 1 ? '' : 's'} generated`
        : 'No tests generated';
    const skippedPart = skipped.length
        ? `, ${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped`
        : '';

    return { show: true, headline: `${generated}${skippedPart}`, files, skipped };
}

export default { summarizeGeneratedTests };
