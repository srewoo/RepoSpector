import React from 'react';
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { PROBE_STATE } from '../../../utils/apiKeyProbe.js';

/**
 * The verdict from "Test key".
 *
 * Three tones, not two, because the middle case is real and common: the key
 * authenticated but something else stopped the call (no credits, rate limit, a
 * model the account cannot reach). Painting that red would send the user to
 * regenerate a working key; painting it green would promise a review that will
 * not run. Amber says "key fine, fix this".
 */
export function KeyTestVerdict({ result }) {
    if (!result) return null;

    const ok = result.state === PROBE_STATE.OK;
    const tone = ok
        ? { box: 'bg-success/10 border-success/20', text: 'text-success', Icon: CheckCircle }
        : result.keyProven
            ? { box: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-500', Icon: AlertCircle }
            : { box: 'bg-red-500/10 border-red-500/20', text: 'text-red-400', Icon: XCircle };

    return (
        <div className={`flex items-start gap-2 p-3 border rounded-lg ${tone.box}`}>
            <tone.Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tone.text}`} />
            <div className={`text-xs ${tone.text}`}>
                <p className="font-medium">
                    {ok ? 'Key verified' : result.keyProven ? 'Key is valid, but…' : 'Test failed'}
                </p>
                <p className="mt-0.5 opacity-90">{result.message}</p>
            </div>
        </div>
    );
}
