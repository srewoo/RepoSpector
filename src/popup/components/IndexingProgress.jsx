import React from 'react';
import { Loader2, CheckCircle, AlertCircle, FolderTree, Download, Scissors, Brain, Database } from 'lucide-react';
import { Card, CardContent } from './ui/Card';
import { cn } from '../utils/cn';

/**
 * Visual stages for the indexing process
 */
const INDEXING_STAGES = [
    { id: 'fetching_tree', label: 'Fetch', icon: FolderTree, description: 'Getting repo structure' },
    { id: 'downloading', label: 'Download', icon: Download, description: 'Downloading files' },
    { id: 'chunking', label: 'Chunk', icon: Scissors, description: 'Splitting code' },
    { id: 'embedding', label: 'Embed', icon: Brain, description: 'Generating vectors' },
    { id: 'complete', label: 'Done', icon: Database, description: 'Ready to use' }
];

/**
 * Get the current stage index based on status
 */
function getStageIndex(status) {
    switch (status) {
        case 'starting':
        case 'fetching_tree':
        case 'filtered':
            return 0;
        case 'downloading':
            return 1;
        case 'clearing':
        case 'chunking':
            return 2;
        case 'embedding':
            return 3;
        case 'complete':
            return 4;
        default:
            return -1;
    }
}

/**
 * IndexingProgress component - Shows repository indexing status and progress with visual stages
 */
export function IndexingProgress({ progress, onCancel }) {
    const { status, message, current, total, percent } = progress || {};

    // Calculate progress percentage
    const progressPercent = percent || (total > 0 ? Math.round((current / total) * 100) : 0);
    const currentStageIndex = getStageIndex(status);
    const isError = status === 'error';
    const isComplete = status === 'complete';

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
            <CardContent className="p-4 space-y-4">
                {/* Visual Stage Indicator */}
                {!isError && (
                    <div className="flex items-center justify-between px-1">
                        {INDEXING_STAGES.map((stage, index) => {
                            const StageIcon = stage.icon;
                            const isActive = index === currentStageIndex;
                            const isCompleted = index < currentStageIndex || isComplete;
                            const isPending = index > currentStageIndex && !isComplete;

                            return (
                                <React.Fragment key={stage.id}>
                                    {/* Stage circle with icon */}
                                    <div className="flex flex-col items-center gap-1">
                                        <div
                                            className={cn(
                                                'w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300',
                                                isCompleted && 'bg-green-500/20 text-green-500',
                                                isActive && 'bg-primary/20 text-primary ring-2 ring-primary/50',
                                                isPending && 'bg-surfaceHighlight text-textMuted'
                                            )}
                                        >
                                            {isCompleted && !isActive ? (
                                                <CheckCircle className="w-4 h-4" />
                                            ) : (
                                                <StageIcon className={cn(
                                                    'w-4 h-4',
                                                    isActive && 'animate-pulse'
                                                )} />
                                            )}
                                        </div>
                                        <span className={cn(
                                            'text-[10px] font-medium',
                                            isCompleted && 'text-green-500',
                                            isActive && 'text-primary',
                                            isPending && 'text-textMuted/50'
                                        )}>
                                            {stage.label}
                                        </span>
                                    </div>

                                    {/* Connector line between stages */}
                                    {index < INDEXING_STAGES.length - 1 && (
                                        <div className="flex-1 h-0.5 mx-1 -mt-4">
                                            <div
                                                className={cn(
                                                    'h-full rounded-full transition-all duration-500',
                                                    index < currentStageIndex ? 'bg-green-500' : 'bg-surfaceHighlight'
                                                )}
                                            />
                                        </div>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>
                )}

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
                    <div className="text-xs text-green-500 flex items-center gap-2 bg-green-500/10 p-2 rounded-lg">
                        <CheckCircle className="w-4 h-4" />
                        <span>Repository indexed successfully! Deep context is now available.</span>
                    </div>
                )}

                {/* Error message */}
                {status === 'error' && (
                    <div className="text-xs text-red-500 flex items-center gap-2 bg-red-500/10 p-2 rounded-lg">
                        <AlertCircle className="w-4 h-4" />
                        <span>{message || 'An error occurred during indexing.'}</span>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
