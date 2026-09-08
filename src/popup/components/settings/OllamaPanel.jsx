/**
 * Ollama setup and status. Copy comes from ollamaSetupSteps.js; this file is
 * markup plus the verdict rendering.
 */

import React, { useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, Loader2, Copy } from 'lucide-react';
import { OLLAMA_VERDICT } from '../../../utils/ollamaProbe.js';
import { OLLAMA_SETUP_STEPS } from './ollamaSetupSteps.js';

const VERDICT_ICON = {
    [OLLAMA_VERDICT.OK]: CheckCircle,
    [OLLAMA_VERDICT.CORS_BLOCKED]: AlertTriangle,
    [OLLAMA_VERDICT.MODEL_MISSING]: AlertTriangle,
    [OLLAMA_VERDICT.NOT_RUNNING]: XCircle,
};

function CopyableCommand({ command, label }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    return (
        <div className="space-y-1">
            {label ? <p className="text-[11px] text-textMuted">{label}</p> : null}
            <div className="flex items-center gap-2">
                <code className="flex-1 bg-surfaceHighlight px-2 py-1 rounded text-[11px] break-all">{command}</code>
                <button type="button" onClick={copy} className="text-textMuted hover:text-text" title="Copy">
                    <Copy className="w-3 h-3" />
                </button>
                {copied ? <span className="text-[11px] text-success">Copied</span> : null}
            </div>
        </div>
    );
}

export function OllamaPanel({ model, keyTesting, testApiKey, keyTest }) {
    const verdict = keyTest?.verdict;
    const Icon = VERDICT_ICON[verdict];

    return (
        <div className="space-y-3">
            <div className="flex items-start gap-2 p-3 bg-success/10 border border-success/20 rounded-lg">
                <CheckCircle className="w-4 h-4 text-success mt-0.5" />
                <div className="text-sm text-success">
                    <p className="font-medium">No API key required</p>
                    <p className="text-xs text-success/80 mt-1">Ollama runs on your machine — nothing leaves it.</p>
                </div>
            </div>

            <div className="text-xs text-textMuted space-y-3">
                <p className="font-medium">Setup:</p>
                <ol className="space-y-3 ml-2 list-decimal list-inside">
                    {OLLAMA_SETUP_STEPS.map((step) => (
                        <li key={step.id} className="space-y-1">
                            <span className="text-text font-medium">{step.title}</span>
                            {step.detail ? <p className="text-[11px]">{step.detail}</p> : null}
                            {step.commands.map((c) => (
                                <CopyableCommand key={c.platform} command={c.command} label={c.label} />
                            ))}
                        </li>
                    ))}
                </ol>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-xs text-textMuted">Check the local server</span>
                <button
                    type="button"
                    onClick={() => testApiKey(model)}
                    disabled={keyTesting}
                    className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                >
                    {keyTesting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {keyTesting ? 'Testing…' : 'Test connection'}
                </button>
            </div>

            {verdict ? (
                <div className="flex items-start gap-2 text-xs">
                    {Icon ? <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : null}
                    <div>
                        <p className="text-text">{keyTest.message}</p>
                        {keyTest.fix ? <p className="text-textMuted mt-1">Fix: {keyTest.fix}</p> : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
