/**
 * Chrome built-in AI status.
 *
 * The download is the whole reason this panel is not a one-liner: first use
 * pulls a multi-gigabyte model, so `downloadable` must be an explicit user
 * choice (we never start a multi-gigabyte transfer because a settings tab was
 * opened) and `downloading` must show real progress rather than a spinner with
 * no end.
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle, Download, Loader2, XCircle } from 'lucide-react';
import { CHROME_AI_AVAILABILITY, CHROME_AI_EXPECTED_OUTPUTS, probeChromeAI } from '../../../utils/chromeAI.js';
import { LLM_PROVIDERS } from '../../../utils/constants.js';
import { TASKS, taskGateReason } from '../../../utils/taskCapabilities.js';

// Derived rather than a literal, so the copy quotes the model's real quota and
// cannot drift from the gating logic that actually blocks PR review.
const PR_REVIEW_GATE_REASON = taskGateReason(LLM_PROVIDERS.CHROME_AI, TASKS.PR_REVIEW);

export function ChromeAIPanel() {
    const [state, setState] = useState(null);
    const [reason, setReason] = useState('');
    const [progress, setProgress] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        probeChromeAI().then(({ state: s, reason: r }) => {
            if (!cancelled) { setState(s); setReason(r); }
        });
        return () => { cancelled = true; };
    }, []);

    const startDownload = async () => {
        setError(null);
        setState(CHROME_AI_AVAILABILITY.DOWNLOADING);
        try {
            const session = await globalThis.LanguageModel.create({
                expectedOutputs: CHROME_AI_EXPECTED_OUTPUTS,
                monitor(m) {
                    m.addEventListener('downloadprogress', (e) => {
                        setProgress(Math.round((e.loaded || 0) * 100));
                    });
                },
            });
            session?.destroy?.();
            const { state: s, reason: r } = await probeChromeAI();
            setState(s);
            setReason(r);
        } catch (e) {
            setError(e.message);
            setState(CHROME_AI_AVAILABILITY.DOWNLOADABLE);
        }
    };

    if (state === null) {
        return (
            <p className="flex items-center gap-2 text-xs text-textMuted">
                <Loader2 className="w-3 h-3 animate-spin" /> Checking Chrome built-in AI…
            </p>
        );
    }

    if (state === CHROME_AI_AVAILABILITY.AVAILABLE) {
        return (
            <div className="space-y-2">
                <div className="flex items-start gap-2 p-3 bg-success/10 border border-success/20 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-success mt-0.5" />
                    <div className="text-sm text-success">
                        <p className="font-medium">Ready — no API key, nothing to install</p>
                        <p className="text-xs text-success/80 mt-1">Runs on your device. Never leaves it.</p>
                    </div>
                </div>
                <p className="text-xs text-textMuted">
                    Best for summaries, commit messages and single-file questions.
                    {PR_REVIEW_GATE_REASON
                        ? ` Full PR review is blocked here — it ${PR_REVIEW_GATE_REASON} — use Ollama or an API key for that.`
                        : ''}
                </p>
            </div>
        );
    }

    if (state === CHROME_AI_AVAILABILITY.DOWNLOADABLE) {
        return (
            <div className="space-y-2">
                <p className="text-xs text-textMuted">
                    Chrome can run a model on your device with no key. It needs a one-time
                    download of roughly 2 GB.
                </p>
                <button
                    type="button"
                    onClick={startDownload}
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                    <Download className="w-3 h-3" /> Download model (~2 GB)
                </button>
                {error ? <p className="text-xs text-error">{error}</p> : null}
            </div>
        );
    }

    if (state === CHROME_AI_AVAILABILITY.DOWNLOADING) {
        return (
            <div className="space-y-2">
                <p className="flex items-center gap-2 text-xs text-textMuted">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Downloading model{progress === null ? '…' : ` — ${progress}%`}
                </p>
                {progress !== null ? (
                    <div className="h-1 bg-surfaceHighlight rounded overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div className="flex items-start gap-2 text-xs">
            <XCircle className="w-3.5 h-3.5 text-textMuted mt-0.5 shrink-0" />
            <p className="text-textMuted">{reason || 'Chrome built-in AI is not available here.'}</p>
        </div>
    );
}
