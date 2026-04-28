/**
 * #12 — usePRReview hook.
 *
 * Extracts all state management, data parsing, and Chrome messaging from
 * PRReviewInterface into a single hook. The component becomes a thin view
 * layer that consumes this hook.
 */
import { useState, useCallback, useMemo } from 'react';
import {
    parseLLMFindings,
    convertMultiPassFindings,
    parseStandardsChecklist,
    parseSummaryCounts
} from '../utils/findingsParser.js';

// ── Verdict helpers ───────────────────────────────────────────────────────────

function getVerdictFromFindings(findingsList) {
    if (!findingsList?.length) return null;
    const hasCritical = findingsList.some(f => f.severity === 'critical');
    const hasHigh = findingsList.some(f => f.severity === 'high');
    const hasMedium = findingsList.some(f => f.severity === 'medium');
    if (hasCritical) return { action: 'block', verdict: 'Do Not Merge', level: 'critical', score: 15 };
    if (hasHigh) return { action: 'block', verdict: 'Changes Requested', level: 'high', score: 35 };
    if (hasMedium) return { action: 'caution', verdict: 'Review Carefully', level: 'medium', score: 55 };
    return { action: 'review', verdict: 'Minor Issues', level: 'low', score: 75 };
}

function parseLLMVerdict(text) {
    if (!text) return null;
    const verdictMatch = text.match(/VERDICT:\s*(\w+)/i);
    const riskMatch = text.match(/RISK_LEVEL:\s*(\w+)/i);
    if (!verdictMatch) return null;
    const verdict = verdictMatch[1].toUpperCase();
    const risk = riskMatch ? riskMatch[1].toLowerCase() : 'medium';
    const verdictMap = {
        APPROVE: { action: 'approve', verdict: 'Safe to Merge', level: 'low', score: 90 },
        APPROVED: { action: 'approve', verdict: 'Safe to Merge', level: 'low', score: 90 },
        REQUEST_CHANGES: { action: 'block', verdict: 'Changes Requested', level: 'high', score: 40 },
        CHANGES_REQUESTED: { action: 'block', verdict: 'Changes Requested', level: 'high', score: 40 },
        NEEDS_DISCUSSION: { action: 'caution', verdict: 'Needs Discussion', level: 'medium', score: 60 },
        BLOCK: { action: 'block', verdict: 'Do Not Merge', level: 'critical', score: 20 }
    };
    const riskScoreMap = { low: 85, medium: 55, high: 30, critical: 15 };
    const mapped = verdictMap[verdict] || { action: 'review', verdict, level: risk, score: 50 };
    if (riskMatch) {
        mapped.score = riskScoreMap[risk] || mapped.score;
        mapped.level = risk;
    }
    return mapped;
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function usePRReview({ analysisResult, staticAnalysisResult, prUrl, prData, session }) {
    const [activeTab, setActiveTab] = useState('summary');
    const [selectedFinding, setSelectedFinding] = useState(null);
    const [threadView, setThreadView] = useState(false);
    const [activeThread, setActiveThread] = useState(null);
    const [sendingMessage, setSendingMessage] = useState(false);
    const [postingReview, setPostingReview] = useState(false);
    const [postResult, setPostResult] = useState(null);
    const [generatedDescription, setGeneratedDescription] = useState(null);
    const [generatedChangelog, setGeneratedChangelog] = useState(null);
    const [generatedMermaid, setGeneratedMermaid] = useState(null);
    const [generatedRepoInfo, setGeneratedRepoInfo] = useState(null);
    const [generating, setGenerating] = useState(null);

    const { analysis, staticAnalysis, reviewEffort, isMultiPass, perFileFindings, reviewVerdict, reviewEvent, blockingCount } = analysisResult || {};
    const staticFindings = staticAnalysisResult?.findings || staticAnalysis?.findings || [];

    // Derive findings
    const multiPassFindings = useMemo(() =>
        isMultiPass ? convertMultiPassFindings(perFileFindings) : [],
        [isMultiPass, perFileFindings]
    );
    const llmFindings = useMemo(() =>
        multiPassFindings.length > 0 ? multiPassFindings : parseLLMFindings(analysis),
        [multiPassFindings, analysis]
    );
    const findings = useMemo(() => [...staticFindings, ...llmFindings], [staticFindings, llmFindings]);

    // Derive verdicts
    const findingsVerdict = useMemo(() => getVerdictFromFindings(findings), [findings]);
    const llmVerdict = useMemo(() => parseLLMVerdict(analysis), [analysis]);
    const effectiveVerdict = useMemo(() => {
        const verdicts = [findingsVerdict, llmVerdict].filter(Boolean);
        if (!verdicts.length) return staticAnalysisResult?.recommendation || analysisResult?.recommendation;
        const severityOrder = { block: 0, caution: 1, review: 2, approve: 3 };
        return [...verdicts].sort((a, b) => (severityOrder[a.action] || 3) - (severityOrder[b.action] || 3))[0];
    }, [findingsVerdict, llmVerdict, staticAnalysisResult, analysisResult]);

    const riskScore = useMemo(() =>
        effectiveVerdict
            ? { score: effectiveVerdict.score, level: effectiveVerdict.level }
            : (staticAnalysisResult?.riskScore || staticAnalysis?.riskScore),
        [effectiveVerdict, staticAnalysisResult, staticAnalysis]
    );
    const effectiveRecommendation = useMemo(() =>
        effectiveVerdict
            ? { action: effectiveVerdict.action, verdict: effectiveVerdict.verdict }
            : (staticAnalysisResult?.recommendation || analysisResult?.recommendation),
        [effectiveVerdict, staticAnalysisResult, analysisResult]
    );

    // #22 — standards checklist and summary counts from new format
    const standardsChecklist = useMemo(() => parseStandardsChecklist(analysis), [analysis]);
    const summaryCounts = useMemo(() => parseSummaryCounts(analysis), [analysis]);

    // Derived repoId for adaptive learning
    const repoId = prData?.branches?.targetRepo ||
        (prUrl ? prUrl.match(/(?:github\.com|gitlab\.com)\/([^/]+\/[^/]+)/)?.[1] : null) ||
        'unknown';

    // ── Thread handlers ───────────────────────────────────────────────────────

    const handleOpenThread = useCallback(async (finding) => {
        setSelectedFinding(finding);
        setThreadView(true);
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_OR_CREATE_THREAD',
                data: { sessionId: session?.sessionId, prIdentifier: { url: prUrl, ...prData }, finding }
            });
            if (response.success) setActiveThread(response.data);
        } catch (err) {
            console.error('Failed to get/create thread:', err);
        }
    }, [session, prUrl, prData]);

    const handleSendMessage = useCallback(async (message) => {
        if (!activeThread?.threadId) return;
        setSendingMessage(true);
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'SEND_THREAD_MESSAGE',
                data: { threadId: activeThread.threadId, message }
            });
            if (response.success) setActiveThread(response.data.thread);
        } catch (err) {
            console.error('Failed to send message:', err);
        } finally {
            setSendingMessage(false);
        }
    }, [activeThread]);

    const handleQuickAction = useCallback(async (actionType) => {
        if (!activeThread?.threadId) return;
        setSendingMessage(true);
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'THREAD_QUICK_ACTION',
                data: { threadId: activeThread.threadId, actionType }
            });
            if (response.success) setActiveThread(response.data.thread);
        } catch (err) {
            console.error('Failed to execute quick action:', err);
        } finally {
            setSendingMessage(false);
        }
    }, [activeThread]);

    const handleMarkResolved = useCallback(async () => {
        if (!activeThread?.threadId) return;
        try {
            await chrome.runtime.sendMessage({
                type: 'UPDATE_THREAD_STATUS',
                data: { threadId: activeThread.threadId, status: 'resolved' }
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
                data: { threadId: activeThread.threadId, status: 'dismissed' }
            });
            setActiveThread(prev => ({ ...prev, status: 'dismissed' }));
        } catch (err) {
            console.error('Failed to dismiss:', err);
        }
    }, [activeThread]);

    const handleDismissFinding = useCallback(async (finding) => {
        if (!finding?.ruleId) return;
        try {
            await chrome.runtime.sendMessage({
                type: 'RECORD_FINDING_ACTION',
                data: {
                    ruleId: finding.ruleId, repoId,
                    action: 'dismissed',
                    filePath: finding.filePath || finding.file,
                    findingMessage: finding.message
                }
            });
        } catch (err) {
            console.error('Failed to record dismiss:', err);
        }
    }, [repoId]);

    return {
        // UI state
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
        generating, setGenerating,
        // Derived data
        findings, staticFindings, llmFindings,
        effectiveVerdict, riskScore, effectiveRecommendation,
        reviewEffort, isMultiPass,
        standardsChecklist, summaryCounts,
        reviewVerdict, reviewEvent, blockingCount,
        // Handlers
        handleOpenThread, handleSendMessage, handleQuickAction,
        handleMarkResolved, handleDismiss, handleDismissFinding,
        repoId
    };
}
