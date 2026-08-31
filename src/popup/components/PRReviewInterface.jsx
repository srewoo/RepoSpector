import React, { useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { MotionDiv, LazyAnimatePresence } from './ui/MotionDiv';
import { usePRReview } from '../hooks/usePRReview.js';
import { ExportService } from '@/services/ExportService';
import { parseStandardsChecklist, parseSummaryCounts } from '../utils/findingsParser.js';
import {
    GitPullRequest,
    AlertTriangle,
    Shield,
    CheckCircle,
    XCircle,
    MessageSquare,
    ChevronRight,
    RefreshCw,
    Filter,
    ExternalLink,
    FileCode,
    Clock,
    User,
    Send,
    FileText,
    GitBranch,
    BookOpen,
    Tag,
    Copy,
    Download
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { FindingCard } from './FindingCard';
import { FindingThread } from './FindingThread';
import { StaticAnalysisResults } from './StaticAnalysisResults';
import { PRQuickActions } from './QuickActions';
import { MarkdownRenderer } from './ui/MarkdownRenderer';
// Lazy: keeps mermaid + react-zoom-pan-pinch out of the popup's first paint.
const MermaidDiagram = React.lazy(() =>
    import('./ui/MermaidDiagram').then((m) => ({ default: m.MermaidDiagram }))
);
import { copyToClipboard } from '../utils/clipboard';

// Compact relative time for the "Reviewed X ago" label.
function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

export function PRReviewInterface({
    prUrl,
    prData,
    analysisResult,
    staticAnalysisResult,
    aiSummary,
    session,
    onRefresh,
    onAskQuestion,
    onFocusArea,
    loading = false,
    progress = null
}) {
    // #12 — all state/logic lives in the hook
    const {
        activeTab, setActiveTab,
        selectedFinding, setSelectedFinding,
        threadView, setThreadView,
        activeThread, setActiveThread,
        sendingMessage,
        postingReview, setPostingReview,
        postResult, setPostResult,
        generatedDescription, setGeneratedDescription,
        generatedChangelog, setGeneratedChangelog,
        generatedMermaid, setGeneratedMermaid,
        generatedRepoInfo, setGeneratedRepoInfo,
        generatedLabels, setGeneratedLabels,
        generatedDocstrings, setGeneratedDocstrings,
        generating, setGenerating,
        findings, staticFindings,
        effectiveVerdict, riskScore, effectiveRecommendation,
        reviewEffort, isMultiPass,
        standardsChecklist, summaryCounts,
        reviewVerdict, reviewEvent, blockingCount,
        reviewSkipped, gate,
        handleOpenThread, handleSendMessage, handleQuickAction,
        handleMarkResolved, handleDismiss, handleDismissFinding,
        repoId
    } = usePRReview({ analysisResult, staticAnalysisResult, prUrl, prData, session });

    const { analysis, staticAnalysis } = analysisResult || {};

    // Handle PR-level quick actions (local to this component — delegates to parent callbacks)
    const handlePRAction = useCallback((actionId) => {
        switch (actionId) {
            case 'focus-security':
            case 'focus-performance':
            case 'focus-bugs':
                onFocusArea?.(actionId.replace('focus-', ''));
                break;
            case 'ask-question':
                onAskQuestion?.();
                break;
            case 'refresh':
                onRefresh?.();
                break;
        }
    }, [onFocusArea, onAskQuestion, onRefresh]);

    // Handle finding-level resolve (records to adaptive learning)
    const handleResolveFinding = useCallback(async (finding) => {
        if (!finding?.ruleId) return;
        try {
            await chrome.runtime.sendMessage({
                type: 'RECORD_FINDING_ACTION',
                data: {
                    ruleId: finding.ruleId,
                    repoId,
                    action: 'resolved',
                    filePath: finding.filePath || finding.file,
                    findingMessage: finding.message
                }
            });
        } catch (err) {
            console.error('Failed to record resolve:', err);
        }
    }, [repoId]);

    // Post review to PR
    const handlePostReview = useCallback(async () => {
        if (!prUrl || postingReview) return;
        setPostingReview(true);
        setPostResult(null);

        try {
            // Post the SAME findings the panel displays: `findings` is the
            // authoritative set — verified (false positives removed), deduped
            // against static analysis, and carrying the generated fix patches.
            //
            // This used to post `perFileFindings` instead, which meant the
            // review posted to the PR contained the exact false positives the
            // verification pass had just paid an LLM to remove, double-counted
            // static findings on the orchestrator path, and dropped every
            // suggested fix. Never diverge display from what gets posted.
            const response = await chrome.runtime.sendMessage({
                type: 'POST_PR_REVIEW',
                data: {
                    prUrl,
                    analysisResult: {
                        ...(staticAnalysisResult ?? {}),
                        findings,
                        // Let the post handler refuse an APPROVE/REQUEST_CHANGES for a
                        // run that a skip rule short-circuited. Without these two
                        // fields its guard has nothing to check.
                        reviewSkipped: reviewSkipped === true,
                        gate: gate ?? null,
                    },
                    aiSummary,
                    options: {
                        includeInlineComments: true,
                        maxFindings: 10,
                        maxInlineComments: 15,
                        // #22 — use mechanical verdict: APPROVE when no blocking, REQUEST_CHANGES otherwise
                        event: reviewEvent || 'COMMENT'
                    }
                }
            });

            if (response.success) {
                setPostResult({
                    success: true,
                    message: `Review posted! ${response.data?.commentsPosted || 0} inline comments added.`
                });
            } else {
                setPostResult({ success: false, error: response.error });
            }
        } catch (err) {
            setPostResult({ success: false, error: err.message });
        } finally {
            setPostingReview(false);
            // Clear result after 5 seconds
            setTimeout(() => setPostResult(null), 5000);
        }
    }, [prUrl, findings, staticAnalysisResult, aiSummary, postingReview, reviewEvent, reviewSkipped, gate, setPostingReview, setPostResult]);

    // Generate PR description
    const handleGenerateDescription = useCallback(async (apply = false) => {
        if (!prUrl || generating) return;
        setGenerating('description');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_PR_DESCRIPTION',
                data: { prUrl, applyToGit: apply }
            });
            if (response.success) {
                setGeneratedDescription(response.data.description);
                if (apply) setPostResult({ success: true, message: 'PR description updated!' });
            }
        } catch (err) {
            console.error('Failed to generate description:', err);
        } finally {
            setGenerating(null);
        }
    }, [prUrl, generating]);

    // Generate changelog
    const handleGenerateChangelog = useCallback(async () => {
        if (!prUrl || generating) return;
        setGenerating('changelog');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_CHANGELOG',
                data: { prUrl }
            });
            if (response.success) setGeneratedChangelog(response.data.changelog);
        } catch (err) {
            console.error('Failed to generate changelog:', err);
        } finally {
            setGenerating(null);
        }
    }, [prUrl, generating]);

    // Generate Mermaid diagram
    const handleGenerateMermaid = useCallback(async () => {
        if (!prUrl || generating) return;
        setGenerating('mermaid');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_MERMAID_DIAGRAM',
                data: { prUrl }
            });
            if (response.success) setGeneratedMermaid(response.data.mermaidCode);
        } catch (err) {
            console.error('Failed to generate diagram:', err);
        } finally {
            setGenerating(null);
        }
    }, [prUrl, generating]);

    // Labels. Deterministic and free — no model call — so it is safe to offer as a
    // one-click action rather than behind a confirmation.
    const handleSuggestLabels = useCallback(async (apply = false) => {
        if (!prUrl || generating) return;
        setGenerating('labels');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_PR_LABELS',
                // Applying WRITES to the PR, so it is only ever an explicit act.
                // The review's findings feed the risk labels (`security`,
                // `review/blocking`). Absent before a review has run, which is
                // fine — the diff-derived labels do not need them.
                data: { prUrl, apply, findings: findings || [] },
            });
            if (response.success) setGeneratedLabels(response.data);
        } catch (err) {
            console.error('Failed to suggest labels:', err);
        } finally {
            setGenerating(null);
        }
    }, [prUrl, generating, findings]);

    const handleGenerateDocstrings = useCallback(async () => {
        if (!prUrl || generating) return;
        setGenerating('docstrings');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_DOCSTRINGS',
                data: { prUrl },
            });
            if (response.success) setGeneratedDocstrings(response.data);
        } catch (err) {
            console.error('Failed to generate docstrings:', err);
        } finally {
            setGenerating(null);
        }
    }, [prUrl, generating]);

    // SARIF export. Purely local — no model call and no network — so it needs no
    // budget, no spinner state and no error path beyond the download itself.
    const handleExportSarif = useCallback(() => {
        if (!findings?.length) return;
        try {
            const json = ExportService.exportFindingsAsSarif(findings, {
                prUrl,
                commitSha: prData?.headSha || null,
                model: analysisResult?.model || null,
                version: chrome.runtime?.getManifest?.()?.version,
            });
            const slug = (prUrl || 'review').split('/').slice(-3).join('-').replace(/[^\w.-]/g, '');
            ExportService.download(json, `repospector-${slug}.sarif`, 'application/json');
        } catch (err) {
            console.error('Failed to export SARIF:', err);
        }
    }, [findings, prUrl, prData, analysisResult]);

    const handleGenerateRepoInfo = useCallback(async () => {
        if (!prUrl || generating) return;
        setGenerating('repoinfo');
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GENERATE_REPO_INFO',
                data: { url: prUrl }
            });
            if (response.success && response.data?.repoInfoMarkdown) {
                setGeneratedRepoInfo({
                    markdown: response.data.repoInfoMarkdown,
                    repoId: response.data.repoId
                });
            }
        } catch (err) {
            console.error('Failed to generate RepoInfo:', err);
        } finally {
            setGenerating(null);
        }
    }, [prUrl, generating]);

    const handleCopyToClipboard = async (text) => {
        await copyToClipboard(text);
    };

    // Close thread view
    const handleCloseThread = () => {
        setThreadView(false);
        setSelectedFinding(null);
        setActiveThread(null);
    };

    const getRiskColor = () => {
        if (!riskScore?.level) return 'text-textMuted';
        switch (riskScore.level) {
            case 'low': return 'text-green-500';
            case 'medium': return 'text-yellow-500';
            case 'high': return 'text-orange-500';
            case 'critical': return 'text-red-500';
            default: return 'text-textMuted';
        }
    };

    const getVerdictBadge = () => {
        if (!effectiveRecommendation) return null;

        const colors = {
            approve: 'bg-green-500/10 text-green-500',
            review: 'bg-yellow-500/10 text-yellow-500',
            caution: 'bg-yellow-500/10 text-yellow-500',
            block: 'bg-red-500/10 text-red-500'
        };

        return (
            <span className={cn('px-2 py-1 text-xs font-medium rounded', colors[effectiveRecommendation.action] || colors.review)}>
                {effectiveRecommendation.verdict}
            </span>
        );
    };

    // Thread view
    if (threadView && activeThread) {
        return (
            <FindingThread
                thread={activeThread}
                finding={selectedFinding}
                onSendMessage={handleSendMessage}
                onQuickAction={handleQuickAction}
                onClose={handleCloseThread}
                onMarkResolved={handleMarkResolved}
                onDismiss={handleDismiss}
                sending={sendingMessage}
            />
        );
    }

    return (
        <div className="space-y-4">
            {/* PR Header */}
            <Card className="p-4">
                <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                        <GitPullRequest className="w-5 h-5 text-primary" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                                <h2 className="text-lg font-medium text-text truncate">
                                    {prData?.title || 'Pull Request'}
                                </h2>
                                <div className="flex items-center gap-2 flex-wrap mt-1">
                                    {getVerdictBadge()}
                                </div>
                            </div>
                            {prUrl && (
                                <a
                                    href={prUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-2 hover:bg-surface rounded-lg transition-colors shrink-0"
                                >
                                    <ExternalLink className="w-4 h-4 text-textMuted" />
                                </a>
                            )}
                        </div>

                        <div className="flex items-center gap-3 mt-2 text-xs text-textMuted">
                            {prData?.author && (
                                <span className="flex items-center gap-1">
                                    <User className="w-3 h-3" />
                                    {prData.author.login || prData.author}
                                </span>
                            )}
                            {prData?.stats && (
                                <span>
                                    <span className="text-green-500">+{prData.stats.additions}</span>
                                    {' / '}
                                    <span className="text-red-500">-{prData.stats.deletions}</span>
                                </span>
                            )}
                            {prData?.files && (
                                <span className="flex items-center gap-1">
                                    <FileCode className="w-3 h-3" />
                                    {prData.files.length} files
                                </span>
                            )}
                        </div>

                        {(reviewEffort || riskScore) && (
                            <div className="flex items-center gap-3 mt-3">
                                {reviewEffort && (
                                    <div className="text-center px-3 py-1.5 rounded-lg bg-primary/5 border border-primary/10" title={`Review Complexity: ${reviewEffort.label || ''}\nEstimated review time: ~${reviewEffort.estimatedMinutes} minutes\n${reviewEffort.reasons?.join('\n') || ''}`}>
                                        <div className="text-sm font-bold text-primary leading-tight">
                                            {reviewEffort.score}/5
                                        </div>
                                        <div className="text-[10px] text-textMuted leading-tight mt-0.5">Complexity · ~{reviewEffort.estimatedMinutes}m</div>
                                    </div>
                                )}
                                {riskScore && (
                                    <div className="text-center px-3 py-1.5 rounded-lg bg-surface border border-border" title={`Code Health Score: ${riskScore.score}/100\nRisk Level: ${riskScore.level || 'unknown'}\n${riskScore.description || ''}\n\n100 = No issues, 0 = Critical risk`}>
                                        <div className={cn('text-sm font-bold leading-tight', getRiskColor())}>
                                            {riskScore.score}/100
                                        </div>
                                        <div className="text-[10px] text-textMuted leading-tight mt-0.5">Health</div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {/* Quick Actions + Post to PR */}
                <div className="mt-4 pt-4 border-t border-border">
                    <div className="flex items-center justify-between gap-2">
                        <PRQuickActions
                            onAction={handlePRAction}
                            disabled={loading}
                        />
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handlePostReview}
                            disabled={loading || postingReview || !findings.length}
                            className="shrink-0 text-xs"
                        >
                            {postingReview ? (
                                <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                            ) : (
                                <Send className="w-3.5 h-3.5 mr-1.5" />
                            )}
                            {postingReview ? 'Posting...' : 'Post to PR'}
                        </Button>
                    </div>
                    {postResult && (
                        <div className={cn(
                            'mt-2 px-3 py-2 rounded-lg text-xs flex items-center gap-2',
                            postResult.success
                                ? 'bg-green-500/10 text-green-500'
                                : 'bg-red-500/10 text-red-400'
                        )}>
                            {postResult.success ? (
                                <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                                <XCircle className="w-3.5 h-3.5 shrink-0" />
                            )}
                            {postResult.success ? postResult.message : postResult.error}
                        </div>
                    )}
                </div>
            </Card>

            {/* Tabs */}
            <div className="flex border-b border-border">
                {[
                    { id: 'summary', label: 'Summary' },
                    { id: 'overview', label: 'Overview' },
                    { id: 'findings', label: `Findings (${findings.length})` },
                    { id: 'static', label: 'Static Analysis' }
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={cn(
                            'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                            activeTab === tab.id
                                ? 'border-primary text-primary'
                                : 'border-transparent text-textMuted hover:text-text'
                        )}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Reviewed-when + Re-run */}
            {analysisResult?.reviewedAt && (
                <div className="flex items-center justify-between px-1 py-2 text-xs text-textMuted">
                    <span>Reviewed {timeAgo(analysisResult.reviewedAt)}</span>
                    <button
                        type="button"
                        onClick={onRefresh}
                        disabled={loading}
                        className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                        title="Run a fresh review of this PR"
                    >
                        <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
                        {loading ? 'Reviewing…' : 'Re-run'}
                    </button>
                </div>
            )}

            {/* Tab Content */}
            <LazyAnimatePresence mode="wait">
                {activeTab === 'summary' && (
                    <MotionDiv
                        key="summary"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="space-y-4"
                    >
                        {aiSummary ? (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">PR Summary</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <MarkdownRenderer content={aiSummary} />
                                </CardContent>
                            </Card>
                        ) : (
                            <Card className="p-6 text-center">
                                <p className="text-textMuted text-sm">
                                    {loading ? 'Generating summary...' : 'No AI summary available for this PR.'}
                                </p>
                            </Card>
                        )}

                        {/* Generation Actions */}
                        <Card className="p-4">
                            <p className="text-xs font-medium text-textMuted mb-3">Generate</p>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    variant="outline" size="sm"
                                    onClick={() => handleGenerateDescription(false)}
                                    disabled={!!generating}
                                    className="text-xs"
                                >
                                    {generating === 'description' ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <FileText className="w-3 h-3 mr-1" />}
                                    PR Description
                                </Button>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={handleGenerateMermaid}
                                    disabled={!!generating}
                                    className="text-xs"
                                >
                                    {generating === 'mermaid' ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <GitBranch className="w-3 h-3 mr-1" />}
                                    Sequence Diagram
                                </Button>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={handleGenerateChangelog}
                                    disabled={!!generating}
                                    className="text-xs"
                                >
                                    {generating === 'changelog' ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <BookOpen className="w-3 h-3 mr-1" />}
                                    Changelog
                                </Button>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={handleGenerateRepoInfo}
                                    disabled={!!generating}
                                    className="text-xs"
                                >
                                    {generating === 'repoinfo' ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <FileText className="w-3 h-3 mr-1" />}
                                    RepoInfo.md
                                </Button>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={() => handleSuggestLabels(false)}
                                    disabled={!!generating}
                                    className="text-xs"
                                    title="Derived from the diff — no model call, no cost"
                                >
                                    {generating === 'labels' ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Tag className="w-3 h-3 mr-1" />}
                                    Labels
                                </Button>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={handleGenerateDocstrings}
                                    disabled={!!generating}
                                    className="text-xs"
                                    title="Docstrings for functions this PR added or changed that have none"
                                >
                                    {generating === 'docstrings' ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <BookOpen className="w-3 h-3 mr-1" />}
                                    Docstrings
                                </Button>
                                <Button
                                    variant="outline" size="sm"
                                    onClick={handleExportSarif}
                                    disabled={!!generating || !(findings && findings.length)}
                                    className="text-xs"
                                    title="SARIF 2.1.0 — upload to GitHub code scanning, or feed your own dashboard"
                                >
                                    <Download className="w-3 h-3 mr-1" />
                                    Export SARIF
                                </Button>
                            </div>
                            <p className="text-[11px] text-textMuted mt-3">
                                Also available in Chat: <code>/ask-line file.js:214 why?</code> for a
                                question about one line, and <code>/history</code> for what your team
                                decided about this code before.
                            </p>
                        </Card>

                        {/* Suggested labels */}
                        {generatedLabels && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">Suggested labels</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2">
                                    {generatedLabels.labels?.length ? (
                                        <>
                                            <div className="flex flex-wrap gap-1.5">
                                                {generatedLabels.labels.map(l => (
                                                    <span
                                                        key={l}
                                                        title={(generatedLabels.reasons?.[l] || []).join('; ')}
                                                        className="px-2 py-0.5 text-[11px] rounded-full bg-primary/10 text-primary border border-primary/20"
                                                    >
                                                        {l}
                                                    </span>
                                                ))}
                                            </div>
                                            {/* Every label names the files that produced it — a wrong
                                                label is a rule to fix, not a prompt to re-roll. */}
                                            <p className="text-[11px] text-textMuted">
                                                Hover a label for why it was applied.
                                            </p>
                                            {generatedLabels.applied?.applied?.length ? (
                                                <p className="text-xs text-green-600 dark:text-green-400">
                                                    Applied: {generatedLabels.applied.applied.join(', ')}
                                                </p>
                                            ) : generatedLabels.applied?.error ? (
                                                <p className="text-xs text-red-500">
                                                    Could not apply: {generatedLabels.applied.error}
                                                </p>
                                            ) : (
                                                <Button
                                                    variant="outline" size="sm"
                                                    onClick={() => handleSuggestLabels(true)}
                                                    disabled={!!generating}
                                                    className="text-xs"
                                                >
                                                    Apply to PR
                                                </Button>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-xs text-textMuted">No labels matched this diff.</p>
                                    )}
                                    {generatedLabels.skipped?.length > 0 && (
                                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                                            {generatedLabels.skipped.length} custom label rule(s) unusable:{' '}
                                            {generatedLabels.skipped.map(sk => `${sk.label} (${sk.reason})`).join('; ')}
                                        </p>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* Generated docstrings */}
                        {generatedDocstrings && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">Docstrings</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {generatedDocstrings.docstrings?.length ? (
                                        generatedDocstrings.docstrings.map((d, i) => (
                                            <div key={`${d.filename}:${d.name}:${i}`} className="space-y-1">
                                                <p className="text-xs font-medium text-text">
                                                    {d.filename}:{d.insertAtLine} — <code>{d.name}</code>
                                                </p>
                                                <pre className="text-[11px] bg-background border border-white/10 rounded-lg p-2 overflow-x-auto whitespace-pre">
                                                    {d.docstring}
                                                </pre>
                                            </div>
                                        ))
                                    ) : (
                                        <p className="text-xs text-textMuted">
                                            {generatedDocstrings.message
                                                || 'Nothing to document in this PR.'}
                                        </p>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        {/* Generated PR Description */}
                        {generatedDescription && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-sm">Generated PR Description</CardTitle>
                                        <div className="flex gap-1">
                                            <Button variant="ghost" size="sm" onClick={() => handleCopyToClipboard(generatedDescription)} className="h-7 px-2 text-xs">
                                                <Copy className="w-3 h-3 mr-1" /> Copy
                                            </Button>
                                            <Button variant="outline" size="sm" onClick={() => handleGenerateDescription(true)} className="h-7 px-2 text-xs">
                                                <Send className="w-3 h-3 mr-1" /> Apply to PR
                                            </Button>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <MarkdownRenderer content={generatedDescription} />
                                </CardContent>
                            </Card>
                        )}

                        {/* Generated Sequence Diagram */}
                        {generatedMermaid && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-sm">Sequence Diagram</CardTitle>
                                        <Button variant="ghost" size="sm" onClick={() => handleCopyToClipboard('```mermaid\n' + generatedMermaid + '\n```')} className="h-7 px-2 text-xs">
                                            <Copy className="w-3 h-3 mr-1" /> Copy
                                        </Button>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <React.Suspense fallback={<div className="text-xs text-textMuted p-2">Loading diagram…</div>}>
                                        <MermaidDiagram code={generatedMermaid} />
                                    </React.Suspense>
                                </CardContent>
                            </Card>
                        )}

                        {/* Generated Changelog */}
                        {generatedChangelog && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-sm">Changelog Entry</CardTitle>
                                        <Button variant="ghost" size="sm" onClick={() => handleCopyToClipboard(generatedChangelog)} className="h-7 px-2 text-xs">
                                            <Copy className="w-3 h-3 mr-1" /> Copy
                                        </Button>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <MarkdownRenderer content={generatedChangelog} />
                                </CardContent>
                            </Card>
                        )}

                        {/* Generated RepoInfo.md */}
                        {generatedRepoInfo && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-sm">RepoInfo.md</CardTitle>
                                        <div className="flex gap-1">
                                            <Button variant="ghost" size="sm" onClick={() => handleCopyToClipboard(generatedRepoInfo.markdown)} className="h-7 px-2 text-xs">
                                                <Copy className="w-3 h-3 mr-1" /> Copy
                                            </Button>
                                            <button
                                                onClick={() => {
                                                    try {
                                                        const blob = new Blob([generatedRepoInfo.markdown], { type: 'text/markdown' });
                                                        const url = URL.createObjectURL(blob);
                                                        const a = document.createElement('a');
                                                        a.href = url;
                                                        a.download = `RepoInfo-${(generatedRepoInfo.repoId || 'repo').replace(/\//g, '-')}.md`;
                                                        a.click();
                                                        URL.revokeObjectURL(url);
                                                    } catch (e) {
                                                        console.error('Download failed:', e);
                                                    }
                                                }}
                                                className="h-7 px-2 text-xs text-textMuted hover:text-text transition-colors flex items-center gap-1"
                                            >
                                                <Download className="w-3 h-3" /> Download
                                            </button>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="max-h-[400px] overflow-y-auto">
                                        <MarkdownRenderer content={generatedRepoInfo.markdown} />
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </MotionDiv>
                )}

                {activeTab === 'overview' && (
                    <MotionDiv
                        key="overview"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="space-y-4"
                    >
                        {/* LLM Analysis */}
                        {analysis && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm">AI Analysis</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <MarkdownRenderer content={analysis} />
                                </CardContent>
                            </Card>
                        )}

                        {/* Summary stats */}
                        {staticAnalysisResult?.summary && (
                            <div className="grid grid-cols-4 gap-3">
                                {Object.entries(staticAnalysisResult.summary.bySeverity || {})
                                    .filter(([_, count]) => count > 0)
                                    .map(([severity, count]) => (
                                        <Card key={severity} className="p-3 text-center">
                                            <div className={cn(
                                                'text-2xl font-bold',
                                                severity === 'critical' ? 'text-red-500' :
                                                    severity === 'high' ? 'text-orange-500' :
                                                        severity === 'medium' ? 'text-yellow-500' : 'text-blue-500'
                                            )}>
                                                {count}
                                            </div>
                                            <div className="text-xs text-textMuted capitalize">{severity}</div>
                                        </Card>
                                    ))}
                            </div>
                        )}
                    </MotionDiv>
                )}

                {activeTab === 'findings' && (
                    <MotionDiv
                        key="findings"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="space-y-3"
                    >
                        {findings.length > 0 ? (
                            findings.map((finding, i) => (
                                <div key={`${finding.filePath || finding.file}-${finding.line}-${i}`} className="relative group">
                                    <FindingCard
                                        finding={finding}
                                        onDismiss={handleDismissFinding}
                                        onMarkResolved={handleResolveFinding}
                                    />
                                    <button
                                        onClick={() => handleOpenThread(finding)}
                                        className="absolute top-4 right-20 p-2 hover:bg-surface rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                                        title="Discuss this finding"
                                    >
                                        <MessageSquare className="w-4 h-4 text-primary" />
                                    </button>
                                </div>
                            ))
                        ) : (
                            <Card className="p-6 text-center">
                                <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-3" />
                                <p className="text-text">No genuine problems found</p>
                                <p className="text-sm text-textMuted mt-1">
                                    The reviewed changes passed RepoSpector's evidence and confidence checks.
                                </p>
                            </Card>
                        )}
                    </MotionDiv>
                )}

                {activeTab === 'static' && (
                    <MotionDiv
                        key="static"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                    >
                        <StaticAnalysisResults
                            results={staticAnalysisResult}
                            onRefresh={onRefresh}
                            loading={loading}
                            repoId={repoId}
                        />
                    </MotionDiv>
                )}
            </LazyAnimatePresence>

            {/* Loading overlay with progress */}
            {loading && (
                <div className="fixed inset-0 bg-background/50 flex items-center justify-center z-50">
                    <Card className="p-6 flex flex-col items-center gap-3 max-w-sm w-full mx-4">
                        <RefreshCw className="w-5 h-5 animate-spin text-primary" />
                        {progress && (progress.phase || progress.step) ? (
                            <>
                                <span className="text-sm font-medium">
                                    {progress.message
                                        || (progress.step === 'chunk_findings'
                                            ? `Reviewing chunk ${progress.chunkIndex}/${progress.totalChunks}…`
                                            : 'Analyzing PR...')}
                                </span>
                                {progress.totalChunks > 0 && (
                                    <div className="w-full">
                                        <div className="flex justify-between text-xs text-textMuted mb-1">
                                            <span>Chunks</span>
                                            <span>{progress.chunkIndex || 0}/{progress.totalChunks}</span>
                                        </div>
                                        <div className="w-full bg-surface rounded-full h-1.5">
                                            <div
                                                className="bg-primary rounded-full h-1.5 transition-all duration-300"
                                                style={{ width: `${((progress.chunkIndex || 0) / progress.totalChunks) * 100}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                                {progress.totalUnits > 0 && !progress.totalChunks && (
                                    <div className="w-full">
                                        <div className="flex justify-between text-xs text-textMuted mb-1">
                                            <span>File groups</span>
                                            <span>{progress.completedUnits || 0}/{progress.totalUnits}</span>
                                        </div>
                                        <div className="w-full bg-surface rounded-full h-1.5">
                                            <div
                                                className="bg-primary rounded-full h-1.5 transition-all duration-300"
                                                style={{ width: `${progress.percentage || 0}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                                {progress.streamedFindings?.length > 0 && (
                                    <div className="w-full pt-2 border-t border-border">
                                        <p className="text-xs text-textMuted mb-1">
                                            {progress.streamedFindings.length} finding(s) so far
                                        </p>
                                        <ul className="text-xs space-y-0.5 max-h-32 overflow-y-auto">
                                            {progress.streamedFindings.slice(-5).map((f, i) => (
                                                <li key={i} className="truncate text-text">
                                                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
                                                        f.severity === 'blocking' ? 'bg-red-500'
                                                        : f.severity === 'suggestion' ? 'bg-yellow-500'
                                                        : 'bg-blue-500'
                                                    }`} />
                                                    {f.file}:{f.line} — {(f.title || f.suggestion || '').slice(0, 60)}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </>
                        ) : (
                            <span>Analyzing PR...</span>
                        )}
                    </Card>
                </div>
            )}
        </div>
    );
}

export default PRReviewInterface;
