import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import {
    AlertTriangle,
    AlertCircle,
    Info,
    Shield,
    Bug,
    Zap,
    ChevronDown,
    ChevronRight,
    ExternalLink,
    CheckCircle,
    XCircle,
    Copy,
    Check
} from 'lucide-react';
import { Card, CardContent } from './ui/Card';
import { Button } from './ui/Button';

const severityConfig = {
    critical: {
        icon: AlertCircle,
        color: 'text-red-500',
        bgColor: 'bg-red-500/10',
        borderColor: 'border-red-500/30',
        label: 'Critical'
    },
    high: {
        icon: AlertTriangle,
        color: 'text-orange-500',
        bgColor: 'bg-orange-500/10',
        borderColor: 'border-orange-500/30',
        label: 'High'
    },
    medium: {
        icon: AlertTriangle,
        color: 'text-yellow-500',
        bgColor: 'bg-yellow-500/10',
        borderColor: 'border-yellow-500/30',
        label: 'Medium'
    },
    low: {
        icon: Info,
        color: 'text-blue-500',
        bgColor: 'bg-blue-500/10',
        borderColor: 'border-blue-500/30',
        label: 'Low'
    },
    info: {
        icon: Info,
        color: 'text-gray-500',
        bgColor: 'bg-gray-500/10',
        borderColor: 'border-gray-500/30',
        label: 'Info'
    }
};

const categoryIcons = {
    security: Shield,
    bug: Bug,
    performance: Zap,
    'error-handling': AlertTriangle,
    quality: CheckCircle
};

export function FindingCard({ finding, onDismiss, onMarkResolved, compact = false }) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [showGrouped, setShowGrouped] = useState(false);
    const [copied, setCopied] = useState(false);

    const groupCount = finding.groupCount || 1;
    const groupedFindings = finding.groupedFindings || [];

    const severity = severityConfig[finding.severity] || severityConfig.medium;
    const SeverityIcon = severity.icon;
    const CategoryIcon = categoryIcons[finding.category?.toLowerCase()] || Shield;

    const confidence = Math.round((finding.confidence || 0.5) * 100);
    const confidenceColor = confidence >= 70 ? 'text-green-500' :
        confidence >= 50 ? 'text-yellow-500' : 'text-red-500';

    // Get file path - handle both filePath and file properties
    const filePath = finding.filePath || finding.file || 'Unknown';
    const fileName = filePath.split('/').pop() || filePath;
    const lineNumber = finding.line || finding.lineNumber || '?';
    const fileLocation = fileName !== 'Unknown' ? `${fileName}:${lineNumber}` : `Line ${lineNumber}`;

    // Get source badge for AI findings
    const sourceLabel = finding.source === 'ai' ? 'AI' : finding.tool || 'Static';

    const handleCopySnippet = async () => {
        if (finding.codeSnippet) {
            await navigator.clipboard.writeText(finding.codeSnippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const getToolBadges = () => {
        const tools = finding.toolsDetected || [finding.tool];
        return tools.map(tool => (
            <span
                key={tool}
                className="px-1.5 py-0.5 text-xs rounded bg-surface/80 text-textMuted"
            >
                {tool}
            </span>
        ));
    };

    if (compact) {
        return (
            <Card
                variant="outline"
                className={cn(
                    'p-3 transition-all hover:bg-surface/30',
                    severity.borderColor
                )}
            >
                <div className="flex items-start gap-3">
                    <div className={cn('p-1 rounded', severity.bgColor)}>
                        <SeverityIcon className={cn('w-4 h-4', severity.color)} />
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className={cn('text-xs font-medium', severity.color)}>
                                {severity.label}
                            </span>
                            <span className="text-xs text-textMuted">
                                {fileLocation}
                            </span>
                        </div>
                        <p className="text-sm text-text mt-1 truncate">
                            {finding.message}
                        </p>
                    </div>

                    <div className={cn('text-xs', confidenceColor)}>
                        {confidence}%
                    </div>
                </div>
            </Card>
        );
    }

    return (
        <Card
            variant="outline"
            animate
            className={cn(
                'overflow-hidden transition-all',
                severity.borderColor,
                isExpanded && 'shadow-md'
            )}
        >
            {/* Header */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-4 flex items-start gap-3 text-left hover:bg-surface/30 transition-colors"
            >
                <div className={cn('p-1.5 rounded-lg', severity.bgColor)}>
                    <SeverityIcon className={cn('w-5 h-5', severity.color)} />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn('px-2 py-0.5 text-xs font-medium rounded', severity.bgColor, severity.color)}>
                            {severity.label}
                        </span>
                        <span className="text-xs text-textMuted truncate">
                            {finding.ruleId || finding.category}
                        </span>
                        {groupCount > 1 && (
                            <span className="px-1.5 py-0.5 text-xs rounded bg-purple-500/10 text-purple-400">
                                {groupCount} similar
                            </span>
                        )}
                        {finding.isCorroborated && (
                            <span className="px-1.5 py-0.5 text-xs rounded bg-green-500/10 text-green-500">
                                Corroborated
                            </span>
                        )}
                    </div>

                    <p className="text-sm text-text mt-1">
                        {finding.message}
                    </p>

                    <div className="flex items-center gap-2 mt-2 text-xs text-textMuted flex-wrap">
                        <span className="flex items-center gap-1">
                            <CategoryIcon className="w-3 h-3" />
                            {fileLocation}
                        </span>
                        {finding.source === 'ai' ? (
                            <span className="px-1.5 py-0.5 text-xs rounded bg-purple-500/20 text-purple-400">
                                AI
                            </span>
                        ) : (
                            <span className="flex items-center gap-1">
                                {getToolBadges()}
                            </span>
                        )}
                    </div>
                </div>

                <div className="flex flex-col items-end gap-2 shrink-0 ml-2">
                    <span className={cn('text-sm font-medium whitespace-nowrap', confidenceColor)}>
                        {confidence}%
                    </span>
                    {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-textMuted" />
                    ) : (
                        <ChevronRight className="w-4 h-4 text-textMuted" />
                    )}
                </div>
            </button>

            {/* Expanded Content */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                    >
                        <CardContent className="pt-0 pb-4 px-4 border-t border-border">
                            {/* Code Snippet */}
                            {finding.codeSnippet && (
                                <div className="mt-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-medium text-textMuted">Code Context</span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={handleCopySnippet}
                                            className="h-6 px-2"
                                        >
                                            {copied ? (
                                                <Check className="w-3 h-3 text-green-500" />
                                            ) : (
                                                <Copy className="w-3 h-3" />
                                            )}
                                        </Button>
                                    </div>
                                    <pre className="p-3 bg-background rounded-lg text-xs overflow-x-auto font-mono">
                                        <code>{finding.codeSnippet}</code>
                                    </pre>
                                </div>
                            )}

                            {/* Details Grid */}
                            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                                {finding.cwe && (
                                    <div>
                                        <span className="text-textMuted">CWE:</span>
                                        <a
                                            href={`https://cwe.mitre.org/data/definitions/${finding.cwe.replace('CWE-', '')}.html`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="ml-1 text-primary hover:underline inline-flex items-center gap-1"
                                        >
                                            {finding.cwe}
                                            <ExternalLink className="w-3 h-3" />
                                        </a>
                                    </div>
                                )}
                                {(finding.owasp || finding.owaspCategory) && (
                                    <div>
                                        <span className="text-textMuted">OWASP:</span>
                                        <span className="ml-1 text-text">{finding.owasp || finding.owaspCategory}</span>
                                    </div>
                                )}
                                {finding.numToolsAgreeing > 1 && (
                                    <div>
                                        <span className="text-textMuted">Tools Agreeing:</span>
                                        <span className="ml-1 text-text">{finding.numToolsAgreeing}</span>
                                    </div>
                                )}
                                {finding.correlationBonus > 0 && (
                                    <div>
                                        <span className="text-textMuted">Correlation Bonus:</span>
                                        <span className="ml-1 text-green-500">+{Math.round(finding.correlationBonus * 100)}%</span>
                                    </div>
                                )}
                            </div>

                            {/* Remediation */}
                            {finding.remediation && (
                                <div className="mt-4 p-3 bg-blue-500/10 rounded-lg">
                                    <span className="text-xs font-medium text-blue-400">Remediation</span>
                                    <p className="text-xs text-text mt-1">{finding.remediation}</p>
                                </div>
                            )}

                            {/* Related Findings */}
                            {finding.relatedFindings?.length > 0 && (
                                <div className="mt-4">
                                    <span className="text-xs font-medium text-textMuted">Related Findings</span>
                                    <div className="mt-2 space-y-1">
                                        {finding.relatedFindings.map((related, i) => (
                                            <div key={i} className="text-xs text-textMuted flex items-center gap-2">
                                                <span className="px-1.5 py-0.5 rounded bg-surface/80">{related.tool}</span>
                                                <span className="truncate">{related.message}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Actions */}
                            <div className="mt-4 flex items-center gap-2">
                                {onMarkResolved && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => onMarkResolved(finding)}
                                        className="text-xs"
                                    >
                                        <CheckCircle className="w-3 h-3 mr-1" />
                                        Mark Resolved
                                    </Button>
                                )}
                                {onDismiss && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => onDismiss(finding)}
                                        className="text-xs text-textMuted"
                                    >
                                        <XCircle className="w-3 h-3 mr-1" />
                                        Dismiss
                                    </Button>
                                )}
                            </div>

                            {/* Grouped Similar Findings */}
                            {groupCount > 1 && (
                                <div className="mt-4">
                                    <button
                                        onClick={() => setShowGrouped(!showGrouped)}
                                        className="flex items-center gap-2 text-xs text-primary hover:underline"
                                    >
                                        {showGrouped ? (
                                            <ChevronDown className="w-3 h-3" />
                                        ) : (
                                            <ChevronRight className="w-3 h-3" />
                                        )}
                                        {groupCount - 1} similar finding{groupCount - 1 > 1 ? 's' : ''} in this file
                                    </button>
                                    <AnimatePresence>
                                        {showGrouped && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.15 }}
                                                className="mt-2 space-y-1 pl-4 border-l-2 border-border"
                                            >
                                                {groupedFindings.map((gf, idx) => (
                                                    <div key={idx} className="text-xs text-textMuted py-1">
                                                        <span className="text-text">Line {gf.line || '?'}</span>
                                                        {' '}&mdash; {gf.message}
                                                    </div>
                                                ))}
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            )}
                        </CardContent>
                    </motion.div>
                )}
            </AnimatePresence>
        </Card>
    );
}

export default FindingCard;
