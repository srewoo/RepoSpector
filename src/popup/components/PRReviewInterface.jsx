import React, { useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
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
    Copy
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { FindingCard } from './FindingCard';
import { FindingThread } from './FindingThread';
import { StaticAnalysisResults } from './StaticAnalysisResults';
import { PRQuickActions } from './QuickActions';
import { MarkdownRenderer } from './ui/MarkdownRenderer';

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
    loading = false
}) {
    const [activeTab, setActiveTab] = useState('summary'); // 'summary' | 'overview' | 'findings' | 'static'
    const [selectedFinding, setSelectedFinding] = useState(null);
    const [threadView, setThreadView] = useState(false);
    const [activeThread, setActiveThread] = useState(null);
    const [sendingMessage, setSendingMessage] = useState(false);
    const [postingReview, setPostingReview] = useState(false);
    const [postResult, setPostResult] = useState(null); // { success, error }
    const [generatedDescription, setGeneratedDescription] = useState(null);
    const [generatedChangelog, setGeneratedChangelog] = useState(null);
    const [generatedMermaid, setGeneratedMermaid] = useState(null);
    const [generating, setGenerating] = useState(null); // 'description' | 'changelog' | 'mermaid' | null

    const { analysis, staticAnalysis, reviewEffort } = analysisResult || {};
    const staticFindings = staticAnalysisResult?.findings || staticAnalysis?.findings || [];

    // Parse findings from LLM analysis text
    const parseLLMFindings = (text) => {
        if (!text) return [];

        const findings = [];

        // Parse Critical Issues section
        const criticalMatch = text.match(/###?\s*Critical Issues[^\n]*\n([\s\S]*?)(?=###?\s*Warnings|###?\s*Suggestions|###?\s*Security|$)/i);
        if (criticalMatch && criticalMatch[1]) {
            const issues = extractIssuesFromSection(criticalMatch[1], 'critical');
            findings.push(...issues);
        }

        // Parse Warnings section
        const warningsMatch = text.match(/###?\s*Warnings[^\n]*\n([\s\S]*?)(?=###?\s*Suggestions|###?\s*Security|###?\s*Critical|$)/i);
        if (warningsMatch && warningsMatch[1]) {
            const issues = extractIssuesFromSection(warningsMatch[1], 'high');
            findings.push(...issues);
        }

        // Parse Suggestions section
        const suggestionsMatch = text.match(/###?\s*Suggestions[^\n]*\n([\s\S]*?)(?=###?\s*Security|###?\s*Critical|###?\s*Warnings|$)/i);
        if (suggestionsMatch && suggestionsMatch[1]) {
            const issues = extractIssuesFromSection(suggestionsMatch[1], 'low');
            findings.push(...issues);
        }

        return findings;
    };

    const extractIssuesFromSection = (sectionText, defaultSeverity) => {
        const issues = [];

        // Try to parse structured format (File:, Line:, Issue:, etc.)
        const structuredPattern = /File:\s*([^\n]+)\s*\n\s*Line:\s*(\d+)[^\n]*\n\s*Type:\s*([^\n]+)\s*\n\s*Severity:\s*([^\n]+)\s*\n\s*Issue:\s*([^\n]+)/gi;
        let match;

        while ((match = structuredPattern.exec(sectionText)) !== null) {
            issues.push({
                id: `llm-${issues.length}-${Date.now()}`,
                file: match[1].trim(),
                line: parseInt(match[2], 10),
                type: match[3].trim(),
                severity: mapSeverity(match[4].trim()),
                message: match[5].trim(),
                source: 'ai',
                confidence: 0.85
            });
        }

        // If no structured issues found, try to extract numbered items
        if (issues.length === 0) {
            const numberedPattern = /^\s*\d+\.\s*\*?\*?([^*\n:]+)\*?\*?:?\s*([^\n]+)/gm;
            while ((match = numberedPattern.exec(sectionText)) !== null) {
                const title = match[1].trim();
                const desc = match[2].trim();
                if (title && desc && !title.toLowerCase().includes('no ') && !desc.toLowerCase().includes('no current')) {
                    issues.push({
                        id: `llm-${issues.length}-${Date.now()}`,
                        file: 'Unknown',
                        line: 0,
                        type: title,
                        severity: defaultSeverity,
                        message: desc,
                        source: 'ai',
                        confidence: 0.75
                    });
                }
            }
        }

        return issues;
    };

    const mapSeverity = (severityText) => {
        const text = severityText.toLowerCase();
        if (text.includes('critical')) return 'critical';
        if (text.includes('high')) return 'high';
        if (text.includes('medium')) return 'medium';
        if (text.includes('low')) return 'low';
        return 'medium';
    };

    const llmFindings = parseLLMFindings(analysis);
    const findings = [...staticFindings, ...llmFindings];

    // Determine verdict based on findings severity
    const getVerdictFromFindings = (findingsList) => {
        if (!findingsList || findingsList.length === 0) return null;

        const hasCritical = findingsList.some(f => f.severity === 'critical');
        const hasHigh = findingsList.some(f => f.severity === 'high');
        const hasMedium = findingsList.some(f => f.severity === 'medium');

        if (hasCritical) {
            return { action: 'block', verdict: 'Do Not Merge', level: 'critical', score: 15 };
        }
        if (hasHigh) {
            return { action: 'block', verdict: 'Changes Requested', level: 'high', score: 35 };
        }
        if (hasMedium) {
            return { action: 'caution', verdict: 'Review Carefully', level: 'medium', score: 55 };
        }
        return { action: 'review', verdict: 'Minor Issues', level: 'low', score: 75 };
    };

    const findingsVerdict = getVerdictFromFindings(findings);

    // Parse LLM verdict from analysis text
    const parseLLMVerdict = (text) => {
        if (!text) return null;

        const verdictMatch = text.match(/VERDICT:\s*(\w+)/i);
        const riskMatch = text.match(/RISK_LEVEL:\s*(\w+)/i);

        if (verdictMatch) {
            const verdict = verdictMatch[1].toUpperCase();
            const risk = riskMatch ? riskMatch[1].toLowerCase() : 'medium';

            // Map LLM verdict to action and display
            const verdictMap = {
                'APPROVE': { action: 'approve', verdict: 'Safe to Merge', level: 'low', score: 90 },
                'REQUEST_CHANGES': { action: 'block', verdict: 'Changes Requested', level: 'high', score: 40 },
                'NEEDS_DISCUSSION': { action: 'caution', verdict: 'Needs Discussion', level: 'medium', score: 60 },
                'BLOCK': { action: 'block', verdict: 'Do Not Merge', level: 'critical', score: 20 }
            };

            const riskScoreMap = {
                'low': 85,
                'medium': 55,
                'high': 30,
                'critical': 15
            };

            const mapped = verdictMap[verdict] || { action: 'review', verdict: verdict, level: risk, score: 50 };
            // Adjust score based on risk level from LLM
            if (riskMatch) {
                mapped.score = riskScoreMap[risk] || mapped.score;
                mapped.level = risk;
            }

            return mapped;
        }
        return null;
    };

    const llmVerdict = parseLLMVerdict(analysis);

    // Priority: findings > LLM verdict > static analysis
    // Use the most severe assessment
    const getEffectiveVerdict = () => {
        const verdicts = [findingsVerdict, llmVerdict].filter(Boolean);

        if (verdicts.length === 0) {
            return staticAnalysisResult?.recommendation || analysisResult?.recommendation;
        }

        // Return the most severe verdict
        const severityOrder = { block: 0, caution: 1, review: 2, approve: 3 };
        verdicts.sort((a, b) => (severityOrder[a.action] || 3) - (severityOrder[b.action] || 3));
        return verdicts[0];
    };

    const effectiveVerdict = getEffectiveVerdict();

    // Use effective verdict for risk score
    const riskScore = effectiveVerdict
        ? { score: effectiveVerdict.score, level: effectiveVerdict.level }
        : (staticAnalysisResult?.riskScore || staticAnalysis?.riskScore);

    const effectiveRecommendation = effectiveVerdict
        ? { action: effectiveVerdict.action, verdict: effectiveVerdict.verdict }
        : (staticAnalysisResult?.recommendation || analysisResult?.recommendation);

    // Handle opening a thread for a finding
    const handleOpenThread = useCallback(async (finding) => {
        setSelectedFinding(finding);
        setThreadView(true);

        // Check if thread exists or create new one
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_OR_CREATE_THREAD',
                data: {
                    sessionId: session?.sessionId,
                    prIdentifier: {
                        url: prUrl,
                        ...prData
                    },
                    finding
                }
            });

            if (response.success) {
                setActiveThread(response.data);
            }
        } catch (err) {
            console.error('Failed to get/create thread:', err);
        }
    }, [session, prUrl, prData]);

    // Handle sending message in thread
    const handleSendMessage = useCallback(async (message) => {
        if (!activeThread?.threadId) return;

        setSendingMessage(true);
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'SEND_THREAD_MESSAGE',
                data: {
                    threadId: activeThread.threadId,
                    message
                }
            });

            if (response.success) {
                setActiveThread(response.data.thread);
            }
        } catch (err) {
            console.error('Failed to send message:', err);
        } finally {
            setSendingMessage(false);
        }
    }, [activeThread]);

    // Handle quick action
    const handleQuickAction = useCallback(async (actionType) => {
        if (!activeThread?.threadId) return;

        setSendingMessage(true);
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'THREAD_QUICK_ACTION',
                data: {
                    threadId: activeThread.threadId,
                    actionType
                }
            });

            if (response.success) {
                setActiveThread(response.data.thread);
            }
        } catch (err) {
            console.error('Failed to execute quick action:', err);
        } finally {
            setSendingMessage(false);
        }
    }, [activeThread]);

    // Handle PR-level quick actions
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

    // Handle thread status update
    const handleMarkResolved = useCallback(async () => {
        if (!activeThread?.threadId) return;

        try {
            await chrome.runtime.sendMessage({
                type: 'UPDATE_THREAD_STATUS',
                data: {
                    threadId: activeThread.threadId,
                    status: 'resolved'
                }
            });
            setActiveThread(prev => ({ ...prev, status: 'resolved' }));
        } catch (err) {
            console.error('Failed to mark resolved:', err);
        }
    }, [activeThread]);

    const handleDismiss = useCallback(async () => {
        if (!activeThread?.threadId) return;

        try {
            await chrome.runtime.sendMessage({
                type: 'UPDATE_THREAD_STATUS',
                data: {
                    threadId: activeThread.threadId,
                    status: 'dismissed'
                }
            });
            setActiveThread(prev => ({ ...prev, status: 'dismissed' }));
        } catch (err) {
            console.error('Failed to dismiss:', err);
        }
    }, [activeThread]);

    // Derive repoId for adaptive learning
    const repoId = prData?.branches?.targetRepo ||
        (prUrl ? prUrl.match(/(?:github\.com|gitlab\.com)\/([^/]+\/[^/]+)/)?.[1] : null) ||
        'unknown';

    // Handle finding-level dismiss (records to adaptive learning)
    const handleDismissFinding = useCallback(async (finding) => {
        if (!finding?.ruleId) return;
        try {
            await chrome.runtime.sendMessage({
                type: 'RECORD_FINDING_ACTION',
                data: {
                    ruleId: finding.ruleId,
                    repoId,
                    action: 'dismissed',
                    filePath: finding.filePath || finding.file,
                    findingMessage: finding.message
                }
            });
        } catch (err) {
            console.error('Failed to record dismiss:', err);
        }
    }, [repoId]);

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
            const response = await chrome.runtime.sendMessage({
                type: 'POST_PR_REVIEW',
                data: {
                    prUrl,
                    analysisResult: staticAnalysisResult || { findings: staticFindings },
                    aiSummary,
                    options: {
                        includeInlineComments: true,
                        maxFindings: 10,
                        maxInlineComments: 15,
                        event: 'COMMENT'
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
    }, [prUrl, staticAnalysisResult, staticFindings, aiSummary, postingReview]);

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

    const handleCopyToClipboard = async (text) => {
        await navigator.clipboard.writeText(text);
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
                    <div className="p-2 rounded-lg bg-primary/10">
                        <GitPullRequest className="w-5 h-5 text-primary" />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-lg font-medium text-text truncate">
                                {prData?.title || 'Pull Request'}
                            </h2>
                            {getVerdictBadge()}
                        </div>

                        <div className="flex items-center gap-3 mt-1 text-xs text-textMuted">
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
                    </div>

                    <div className="flex items-center gap-2">
                        {reviewEffort && (
                            <div className="text-right" title={reviewEffort.reasons?.join(', ')}>
                                <div className="text-lg font-bold text-primary">
                                    {reviewEffort.score}/5
                                </div>
                                <div className="text-xs text-textMuted">~{reviewEffort.estimatedMinutes}m</div>
                            </div>
                        )}
                        {riskScore && (
                            <div className="text-right">
                                <div className={cn('text-lg font-bold', getRiskColor())}>
                                    {riskScore.score}
                                </div>
                                <div className="text-xs text-textMuted">Risk Score</div>
                            </div>
                        )}
                        {prUrl && (
                            <a
                                href={prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-2 hover:bg-surface rounded-lg transition-colors"
                            >
                                <ExternalLink className="w-4 h-4 text-textMuted" />
                            </a>
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

            {/* Tab Content */}
            <AnimatePresence mode="wait">
                {activeTab === 'summary' && (
                    <motion.div
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
                                    Diagram
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
                            </div>
                        </Card>

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

                        {/* Generated Mermaid Diagram */}
                        {generatedMermaid && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-sm">Architecture Diagram</CardTitle>
                                        <Button variant="ghost" size="sm" onClick={() => handleCopyToClipboard('```mermaid\n' + generatedMermaid + '\n```')} className="h-7 px-2 text-xs">
                                            <Copy className="w-3 h-3 mr-1" /> Copy
                                        </Button>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <pre className="p-3 bg-background rounded-lg text-xs overflow-x-auto font-mono whitespace-pre-wrap">
                                        <code>{generatedMermaid}</code>
                                    </pre>
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
                    </motion.div>
                )}

                {activeTab === 'overview' && (
                    <motion.div
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
                    </motion.div>
                )}

                {activeTab === 'findings' && (
                    <motion.div
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
                                <p className="text-text">No findings detected</p>
                                <p className="text-sm text-textMuted mt-1">
                                    The code looks good based on static analysis
                                </p>
                            </Card>
                        )}
                    </motion.div>
                )}

                {activeTab === 'static' && (
                    <motion.div
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
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Loading overlay */}
            {loading && (
                <div className="fixed inset-0 bg-background/50 flex items-center justify-center z-50">
                    <Card className="p-6 flex items-center gap-3">
                        <RefreshCw className="w-5 h-5 animate-spin text-primary" />
                        <span>Analyzing PR...</span>
                    </Card>
                </div>
            )}
        </div>
    );
}

export default PRReviewInterface;
