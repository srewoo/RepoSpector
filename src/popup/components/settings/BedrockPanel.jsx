import React, { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { BEDROCK_REGIONS, DEFAULT_BEDROCK_REGION } from '../../../utils/constants.js';
import { KeyTestVerdict } from './KeyTestVerdict.jsx';

/**
 * AWS Bedrock credentials — four fields, not one key.
 *
 * `bedrock.regionCustom` / `bedrock.setRegionCustom` are threaded in from
 * `Settings.jsx` (rather than kept as local state here) because the initial
 * value depends on the saved settings load there: a saved region absent from
 * `BEDROCK_REGIONS` must start in custom-entry mode.
 */
export function BedrockPanel({ keyTest, keyTesting, testApiKey, refreshModels, bedrock }) {
    const [showBedrockSecret, setShowBedrockSecret] = useState(false);
    const {
        accessKeyId: bedrockAccessKeyId,
        setAccessKeyId: setBedrockAccessKeyId,
        secretKey: bedrockSecretKey,
        setSecretKey: setBedrockSecretKey,
        sessionToken: bedrockSessionToken,
        setSessionToken: setBedrockSessionToken,
        region: bedrockRegion,
        setRegion: setBedrockRegion,
        regionCustom: bedrockRegionCustom,
        setRegionCustom: setBedrockRegionCustom,
    } = bedrock;

    return (
        <div className="space-y-3">
            <div className="space-y-2">
                <label className="text-sm font-medium text-text">AWS Region</label>
                {/* A real <select>, not a <datalist>. A datalist is an
                    autocomplete: it FILTERS its options against whatever
                    is already in the field, so with the field defaulted
                    to us-east-1 the list showed exactly one region and
                    looked broken. The "Other…" entry keeps the original
                    goal — AWS adds regions faster than a hardcoded list
                    can track, so the list must never be a ceiling. */}
                {bedrockRegionCustom ? (
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={bedrockRegion}
                            onChange={(e) => setBedrockRegion(e.target.value.trim())}
                            placeholder="e.g. ap-southeast-5"
                            autoFocus
                            className="flex-1 h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                        />
                        <button
                            type="button"
                            onClick={() => {
                                setBedrockRegionCustom(false);
                                if (!BEDROCK_REGIONS.includes(bedrockRegion)) {
                                    setBedrockRegion(DEFAULT_BEDROCK_REGION);
                                }
                            }}
                            className="text-xs text-primary hover:underline shrink-0"
                        >
                            Pick from list
                        </button>
                    </div>
                ) : (
                    <select
                        value={bedrockRegion}
                        onChange={(e) => {
                            if (e.target.value === '__custom__') {
                                setBedrockRegionCustom(true);
                                return;
                            }
                            setBedrockRegion(e.target.value);
                        }}
                        className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                    >
                        {BEDROCK_REGIONS.map(r => (
                            <option key={r} value={r}>{r}</option>
                        ))}
                        <option value="__custom__">Other (type a region)…</option>
                    </select>
                )}
            </div>

            <div className="space-y-2">
                <label className="text-sm font-medium text-text">Access Key ID</label>
                <input
                    type="text"
                    value={bedrockAccessKeyId}
                    onChange={(e) => setBedrockAccessKeyId(e.target.value)}
                    placeholder="AKIA… or ASIA…"
                    className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                />
            </div>

            <div className="space-y-2">
                <label className="text-sm font-medium text-text">Secret Access Key</label>
                <div className="relative">
                    <input
                        type={showBedrockSecret ? 'text' : 'password'}
                        value={bedrockSecretKey}
                        onChange={(e) => setBedrockSecretKey(e.target.value)}
                        onBlur={() => { if (bedrockAccessKeyId && bedrockSecretKey) refreshModels(); }}
                        placeholder="••••••••••••••••••••"
                        className="w-full h-10 px-3 pr-10 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                    />
                    <button
                        type="button"
                        onClick={() => setShowBedrockSecret(!showBedrockSecret)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-textMuted hover:text-text transition-colors"
                    >
                        {showBedrockSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                </div>
            </div>

            {/* Only temporary credentials need a session token, and
                omitting it with an ASIA key fails with a signature
                error that never mentions the token — so the field
                announces itself exactly when it becomes required. */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-text">
                    Session Token
                    {bedrockAccessKeyId.toUpperCase().startsWith('ASIA')
                        ? <span className="text-amber-500"> (required for temporary credentials)</span>
                        : <span className="text-textMuted"> (optional)</span>}
                </label>
                <input
                    type="password"
                    value={bedrockSessionToken}
                    onChange={(e) => setBedrockSessionToken(e.target.value)}
                    placeholder="Only for ASIA… temporary credentials"
                    className="w-full h-10 px-3 text-sm bg-background border border-border rounded-lg focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all placeholder:text-textMuted"
                />
            </div>

            <p className="text-xs text-textMuted">
                Needs <code>bedrock:InvokeModel</code>,{' '}
                <code>bedrock:InvokeModelWithResponseStream</code>, and{' '}
                <code>bedrock:ListFoundationModels</code> +{' '}
                <code>bedrock:ListInferenceProfiles</code> to list models.{' '}
                <a
                    href="https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html"
                    target="_blank" rel="noopener noreferrer"
                    className="text-primary hover:underline"
                >
                    AWS setup guide
                </a>
            </p>

            <div className="flex items-center justify-between">
                <span className="text-xs text-textMuted">
                    Check the credentials can actually invoke the selected model
                </span>
                <button
                    type="button"
                    onClick={testApiKey}
                    disabled={keyTesting}
                    className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                    title="Send one tiny signed request to the selected model"
                >
                    {keyTesting && <Loader2 className="w-3 h-3 animate-spin" />}
                    {keyTesting ? 'Testing…' : 'Test credentials'}
                </button>
            </div>
            <KeyTestVerdict result={keyTest} />
        </div>
    );
}
