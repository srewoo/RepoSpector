import React, { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Shield,
    AlertTriangle,
    AlertCircle,
    Bug,
    Zap,
    ChevronDown,
    ChevronRight,
    Filter,
    SortDesc,
    FileCode,
    Check,
    X,
    RefreshCw,
    Download
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { FindingCard } from './FindingCard';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export function StaticAnalysisResults({
    results,
    onRefresh,
    onExport,
    loading = false,
    compact = false,
    repoId = null
}) {
    const [selectedSeverity, setSelectedSeverity] = useState(null);
    const [selectedCategory, setSelectedCategory] = useState(null);
    const [selectedFile, setSelectedFile] = useState(null);
    const [sortBy, setSortBy] = useState('confidence'); // 'confidence' | 'severity' | 'file'
    const [dismissedFindings, setDismissedFindings] = useState(new Set());
    const [resolvedFindings, setResolvedFindings] = useState(new Set());
    const [expandedFiles, setExpandedFiles] = useState(new Set());
    const [showAll, setShowAll] = useState(false);

    const { findings = [], summary = {}, riskScore = {}, unfilteredCount } = results || {};
    const isFiltered = unfilteredCount && unfilteredCount > findings.length;

    // Filter and sort findings
    const filteredFindings = useMemo(() => {
        let filtered = findings.filter(f => {
            const id = `${f.filePath}:${f.line}:${f.ruleId}`;
            if (dismissedFindings.has(id) || resolvedFindings.has(id)) return false;
            if (selectedSeverity && f.severity !== selectedSeverity) return false;
            if (selectedCategory && f.category !== selectedCategory) return false;
            if (selectedFile && f.filePath !== selectedFile) return false;
            return true;
        });

        // Sort
        filtered.sort((a, b) => {
            if (sortBy === 'confidence') {
                return (b.confidence || 0) - (a.confidence || 0);
            } else if (sortBy === 'severity') {
                return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
            } else if (sortBy === 'file') {
                const fileCompare = (a.filePath || '').localeCompare(b.filePath || '');
                if (fileCompare !== 0) return fileCompare;
                return (a.line || 0) - (b.line || 0);
            }
            return 0;
        });

        return filtered;
    }, [findings, selectedSeverity, selectedCategory, selectedFile, sortBy, dismissedFindings, resolvedFindings]);

    // Group findings by file
    const findingsByFile = useMemo(() => {
        const grouped = {};
        for (const finding of filteredFindings) {
            const file = finding.filePath || 'unknown';
            if (!grouped[file]) grouped[file] = [];
            grouped[file].push(finding);
        }
        return grouped;
    }, [filteredFindings]);

    // Get unique categories and files for filters
    const categories = useMemo(() => {
        const cats = new Set(findings.map(f => f.category).filter(Boolean));
        return [...cats];
    }, [findings]);

    const files = useMemo(() => {
        const fileSet = new Set(findings.map(f => f.filePath).filter(Boolean));
        return [...fileSet];
    }, [findings]);

    const handleDismiss = (finding) => {
        const id = `${finding.filePath}:${finding.line}:${finding.ruleId}`;
        setDismissedFindings(prev => new Set([...prev, id]));

        // Record to adaptive learning
        if (repoId && finding.ruleId) {
            chrome.runtime.sendMessage({
                type: 'RECORD_FINDING_ACTION',
                data: {
                    ruleId: finding.ruleId,
                    repoId,
                    action: 'dismissed',
                    filePath: finding.filePath,
                    findingMessage: finding.message
                }
            }).catch(() => {});
        }
    };

    const handleMarkResolved = (finding) => {
        const id = `${finding.filePath}:${finding.line}:${finding.ruleId}`;
        setResolvedFindings(prev => new Set([...prev, id]));

        // Record to adaptive learning
        if (repoId && finding.ruleId) {
            chrome.runtime.sendMessage({
                type: 'RECORD_FINDING_ACTION',
                data: {
                    ruleId: finding.ruleId,
                    repoId,
                    action: 'resolved',
                    filePath: finding.filePath,
                    findingMessage: finding.message
                }
            }).catch(() => {});
        }
    };

    const toggleFileExpanded = (file) => {
        setExpandedFiles(prev => {
            const next = new Set(prev);
            if (next.has(file)) {
                next.delete(file);
            } else {
                next.add(file);
            }
            return next;
        });
    };

    const getRiskScoreColor = () => {
        if (!riskScore.level) return 'text-textMuted';
        switch (riskScore.level) {
            case 'low': return 'text-green-500';
            case 'medium': return 'text-yellow-500';
            case 'high': return 'text-orange-500';
            case 'critical': return 'text-red-500';
            default: return 'text-textMuted';
        }
    };

    const getSeverityCount = (severity) => {
        return summary.bySeverity?.[severity] || 0;
    };

    if (loading) {
        return (
            <Card className="p-6">
                <div className="flex items-center justify-center gap-3">
                    <RefreshCw className="w-5 h-5 animate-spin text-primary" />
                    <span className="text-textMuted">Running static analysis...</span>
                </div>
            </Card>
        );
    }

    if (!results || findings.length === 0) {
        return (
            <Card className="p-6">
                <div className="text-center">
                    <Shield className="w-12 h-12 mx-auto text-green-500 mb-3" />
                    <h3 className="text-lg font-medium text-text">No Issues Found</h3>
                    <p className="text-sm text-textMuted mt-1">
                        Static analysis completed with no findings
                    </p>
                    {onRefresh && (
                        <Button variant="outline" size="sm" onClick={onRefresh} className="mt-4">
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Re-analyze
                        </Button>
                    )}
                </div>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            {/* Summary Header */}
            <Card className="p-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                            <Shield className={cn('w-5 h-5', getRiskScoreColor())} />
                            <div>
                                <span className="text-sm font-medium text-text">Risk Score: </span>
                                <span className={cn('text-lg font-bold', getRiskScoreColor())}>
                                    {riskScore.score ?? 'N/A'}
                                </span>
                            </div>
                        </div>
                        <div className="h-8 w-px bg-border" />
                        <div className="flex items-center gap-3">
                            {/* Severity badges */}
                            {getSeverityCount('critical') > 0 && (
                                <span className="px-2 py-1 text-xs font-medium rounded bg-red-500/10 text-red-500">
                                    {getSeverityCount('critical')} Critical
                                </span>
                            )}
                            {getSeverityCount('high') > 0 && (
                                <span className="px-2 py-1 text-xs font-medium rounded bg-orange-500/10 text-orange-500">
                                    {getSeverityCount('high')} High
                                </span>
                            )}
                            {getSeverityCount('medium') > 0 && (
                                <span className="px-2 py-1 text-xs font-medium rounded bg-yellow-500/10 text-yellow-500">
                                    {getSeverityCount('medium')} Medium
                                </span>
                            )}
                            {(getSeverityCount('low') + getSeverityCount('info')) > 0 && (
                                <span className="px-2 py-1 text-xs font-medium rounded bg-blue-500/10 text-blue-500">
                                    {getSeverityCount('low') + getSeverityCount('info')} Low/Info
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {onRefresh && (
                            <Button variant="ghost" size="sm" onClick={onRefresh}>
                                <RefreshCw className="w-4 h-4" />
                            </Button>
                        )}
                        {onExport && (
                            <Button variant="ghost" size="sm" onClick={onExport}>
                                <Download className="w-4 h-4" />
                            </Button>
                        )}
                    </div>
                </div>

                {/* Filters */}
                <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border">
                    <Filter className="w-4 h-4 text-textMuted" />

                    {/* Severity Filter */}
                    <select
                        value={selectedSeverity || ''}
                        onChange={(e) => setSelectedSeverity(e.target.value || null)}
                        className="px-2 py-1 text-xs rounded bg-surface border border-border text-text"
                    >
                        <option value="">All Severities</option>
                        {SEVERITY_ORDER.map(sev => (
                            <option key={sev} value={sev}>
                                {sev.charAt(0).toUpperCase() + sev.slice(1)} ({getSeverityCount(sev)})
                            </option>
                        ))}
                    </select>

                    {/* Category Filter */}
                    {categories.length > 0 && (
                        <select
                            value={selectedCategory || ''}
                            onChange={(e) => setSelectedCategory(e.target.value || null)}
                            className="px-2 py-1 text-xs rounded bg-surface border border-border text-text"
                        >
                            <option value="">All Categories</option>
                            {categories.map(cat => (
                                <option key={cat} value={cat}>{cat}</option>
                            ))}
                        </select>
                    )}

                    {/* File Filter */}
                    {files.length > 1 && (
                        <select
                            value={selectedFile || ''}
                            onChange={(e) => setSelectedFile(e.target.value || null)}
                            className="px-2 py-1 text-xs rounded bg-surface border border-border text-text max-w-[200px]"
                        >
                            <option value="">All Files</option>
                            {files.map(file => (
                                <option key={file} value={file}>
                                    {file.split('/').pop()}
                                </option>
                            ))}
                        </select>
                    )}

                    <div className="flex-1" />

                    {/* Sort */}
                    <div className="flex items-center gap-1">
                        <SortDesc className="w-4 h-4 text-textMuted" />
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                            className="px-2 py-1 text-xs rounded bg-surface border border-border text-text"
                        >
                            <option value="confidence">Sort by Confidence</option>
                            <option value="severity">Sort by Severity</option>
                            <option value="file">Sort by File</option>
                        </select>
                    </div>
                </div>

                {/* Threshold indicator */}
                {isFiltered && !showAll && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-textMuted">
                        <span>Showing {findings.length} of {unfilteredCount} findings (filtered by severity)</span>
                        <button
                            onClick={() => setShowAll(true)}
                            className="text-primary hover:underline"
                        >
                            Show All
                        </button>
                    </div>
                )}
                {showAll && isFiltered && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-textMuted">
                        <span>Showing all {unfilteredCount} findings</span>
                        <button
                            onClick={() => setShowAll(false)}
                            className="text-primary hover:underline"
                        >
                            Apply Filter
                        </button>
                    </div>
                )}

                {/* Active filters summary */}
                {(dismissedFindings.size > 0 || resolvedFindings.size > 0) && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-textMuted">
                        {dismissedFindings.size > 0 && (
                            <span>{dismissedFindings.size} dismissed</span>
                        )}
                        {resolvedFindings.size > 0 && (
                            <span className="text-green-500">{resolvedFindings.size} resolved</span>
                        )}
                        <button
                            onClick={() => {
                                setDismissedFindings(new Set());
                                setResolvedFindings(new Set());
                            }}
                            className="text-primary hover:underline"
                        >
                            Reset
                        </button>
                    </div>
                )}
            </Card>

            {/* Findings List */}
            {sortBy === 'file' ? (
                // Grouped by file view
                <div className="space-y-3">
                    {Object.entries(findingsByFile).map(([file, fileFindings]) => (
                        <Card key={file} className="overflow-hidden">
                            <button
                                onClick={() => toggleFileExpanded(file)}
                                className="w-full p-3 flex items-center gap-3 text-left hover:bg-surface/30 transition-colors"
                            >
                                <FileCode className="w-4 h-4 text-textMuted" />
                                <span className="flex-1 text-sm font-medium text-text truncate">
                                    {file}
                                </span>
                                <span className="px-2 py-0.5 text-xs rounded bg-surface text-textMuted">
                                    {fileFindings.length} {fileFindings.length === 1 ? 'issue' : 'issues'}
                                </span>
                                {expandedFiles.has(file) ? (
                                    <ChevronDown className="w-4 h-4 text-textMuted" />
                                ) : (
                                    <ChevronRight className="w-4 h-4 text-textMuted" />
                                )}
                            </button>

                            <AnimatePresence>
                                {expandedFiles.has(file) && (
                                    <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: 'auto', opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        <CardContent className="pt-0 pb-3 px-3 space-y-2 border-t border-border">
                                            {fileFindings.map((finding, i) => (
                                                <FindingCard
                                                    key={`${finding.line}-${finding.ruleId}-${i}`}
                                                    finding={finding}
                                                    compact={compact}
                                                    onDismiss={handleDismiss}
                                                    onMarkResolved={handleMarkResolved}
                                                />
                                            ))}
                                        </CardContent>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </Card>
                    ))}
                </div>
            ) : (
                // Flat list view
                <div className="space-y-3">
                    {filteredFindings.map((finding, i) => (
                        <FindingCard
                            key={`${finding.filePath}-${finding.line}-${finding.ruleId}-${i}`}
                            finding={finding}
                            compact={compact}
                            onDismiss={handleDismiss}
                            onMarkResolved={handleMarkResolved}
                        />
                    ))}
                </div>
            )}

            {/* Summary Footer */}
            {filteredFindings.length === 0 && findings.length > 0 && (
                <Card className="p-4 text-center">
                    <Check className="w-8 h-8 mx-auto text-green-500 mb-2" />
                    <p className="text-sm text-textMuted">
                        All {findings.length} findings have been addressed or filtered
                    </p>
                </Card>
            )}

            {/* Corroboration Stats */}
            {summary.corroborated > 0 && (
                <div className="text-xs text-textMuted text-center">
                    {summary.corroborated} of {findings.length} findings corroborated by multiple tools
                </div>
            )}
        </div>
    );
}

export default StaticAnalysisResults;
