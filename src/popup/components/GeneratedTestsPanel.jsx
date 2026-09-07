import React, { useState } from 'react';
import { CodePreview } from './CodePreview';
import { summarizeGeneratedTests } from './generatedTestsPanelLogic.js';

/**
 * Results of GENERATE_PR_TESTS: one card per generated file, with what it
 * targets, whether it is a new file or an append, the quality score, and a
 * copy button. Skipped files show WHY, because a silent skip reads as "nothing
 * to test" — the opposite of what happened.
 *
 * All decisions live in `generatedTestsPanelLogic.js`; this file is markup.
 */
export function GeneratedTestsPanel({ result, loading = false, error = null, onClose = null }) {
    if (loading) return <div className="p-3 text-sm text-textMuted">Generating tests for this PR's untested changes…</div>;
    if (error) return <div className="p-3 text-sm text-red-500">Test generation failed: {error}</div>;

    const summary = summarizeGeneratedTests(result);
    if (!summary.show) return null;

    return (
        <div className="space-y-3 p-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{summary.headline}</h3>
                {onClose && <button type="button" className="text-xs text-textMuted" onClick={onClose}>Close</button>}
            </div>
            {summary.files.map(f => <GeneratedFile key={f.path} file={f} />)}
            {summary.skipped.length > 0 && (
                <ul className="text-xs text-textMuted space-y-1">
                    {summary.skipped.map((s, i) => (
                        <li key={i}>⚠️ {s.label}: {s.reason}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function GeneratedFile({ file }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(file.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard denied — the code is on screen and selectable */
        }
    };
    return (
        <div className="rounded border border-border">
            <div className="flex items-center justify-between px-2 py-1 text-xs">
                <div className="flex items-center gap-2">
                    <code>{file.path}</code>
                    <span className="rounded bg-muted px-1">{file.modeLabel}</span>
                    <span className="text-textMuted">for {file.targetFile}</span>
                </div>
                <div className="flex items-center gap-2">
                    {file.quality?.score != null && <span title="quality score">quality {file.quality.score}</span>}
                    <button type="button" onClick={copy} className="rounded border px-2 py-0.5">{copied ? 'Copied' : 'Copy'}</button>
                </div>
            </div>
            <CodePreview code={file.content} language={file.language} />
        </div>
    );
}

export default GeneratedTestsPanel;
