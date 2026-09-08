import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * "Test" affordance for one git-platform credential.
 *
 * Its own component rather than the same markup written three times: the three
 * credentials differ only by which platform they name, and a shared button is
 * what keeps a copy or behaviour change from landing on GitHub and being
 * forgotten on Jira.
 *
 * `testing` is the platform currently in flight (or null) rather than a
 * boolean, so only the button that was pressed shows a spinner while the other
 * two stay pressable.
 */
export function GitTokenTestButton({ platform, testing, onTest }) {
    const busy = testing === platform;
    return (
        <button
            type="button"
            onClick={() => onTest(platform)}
            disabled={busy}
            className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline"
        >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {busy ? 'Testing…' : 'Test'}
        </button>
    );
}
