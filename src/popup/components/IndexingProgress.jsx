import React from 'react';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { Card, CardContent } from './ui/Card';

/**
 * IndexingProgress component - Shows repository indexing status and progress
 */
export function IndexingProgress({ progress, onCancel }) {
    const { status, message, current, total, percent } = progress || {};

    // Calculate progress percentage
    const progressPercent = percent || (total > 0 ? Math.round((current / total) * 100) : 0);

    // Determine status icon and color
    const getStatusIcon = () => {
        switch (status) {
            case 'complete':
                return <CheckCircle className="w-5 h-5 text-green-500" />;
            case 'error':
                return <AlertCircle className="w-5 h-5 text-red-500" />;
            default:
                return <Loader2 className="w-5 h-5 text-primary animate-spin" />;
        }
    };

    const getStatusColor = () => {
        switch (status) {
            case 'complete':
                return 'bg-green-500';
            case 'error':
                return 'bg-red-500';
            default:
                return 'bg-primary';
        }
    };

    const getStatusText = () => {
        switch (status) {
            case 'starting':
                return 'Initializing...';
            case 'fetching_tree':
                return 'Fetching repository structure...';
            case 'filtered':
                return 'Analyzing files...';
            case 'downloading':
                return 'Downloading files...';
            case 'clearing':
                return 'Clearing old index...';
            case 'chunking':
                return 'Chunking code...';
            case 'embedding':
                return 'Generating embeddings...';
            case 'complete':
                return 'Indexing complete!';
            case 'error':
                return 'Indexing failed';
            default:
                return 'Processing...';
        }
    };

    return (
        <Card className="bg-surfaceHighlight/50 border-white/10">
            <CardContent className="p-4 space-y-3">
                {/* Header with icon */}
                <div className="flex items-center gap-3">
                    {getStatusIcon()}
                    <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-text">
                            {getStatusText()}
                        </h3>
                        {message && (
                            <p className="text-xs text-textMuted mt-0.5 truncate" title={message}>
                                {message}
                            </p>
                        )}
                    </div>
                </div>

                {/* Progress bar */}
                {status !== 'complete' && status !== 'error' && (
                    <div className="space-y-1">
                        <div className="w-full bg-surface/50 rounded-full h-2 overflow-hidden">
                            <div
                                className={`h-full ${getStatusColor()} transition-all duration-300 ease-out`}
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                        {current && total && (
                            <div className="flex justify-between text-xs text-textMuted">
                                <span>{current} / {total}</span>
                                <span>{progressPercent}%</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Action buttons */}
                {status !== 'complete' && status !== 'error' && onCancel && (
                    <button
                        onClick={onCancel}
                        className="w-full px-3 py-1.5 text-xs text-textMuted hover:text-text border border-white/10 rounded-lg hover:bg-white/5 transition-colors"
                    >
                        Cancel
                    </button>
                )}

                {/* Success message */}
                {status === 'complete' && (
                    <div className="text-xs text-green-500 flex items-center gap-2">
                        <CheckCircle className="w-4 h-4" />
                        <span>Repository indexed successfully! Deep context is now available.</span>
                    </div>
                )}

                {/* Error message */}
                {status === 'error' && (
                    <div className="text-xs text-red-500 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        <span>{message || 'An error occurred during indexing.'}</span>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
