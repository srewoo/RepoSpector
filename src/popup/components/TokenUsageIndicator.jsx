import React from 'react';
import { AlertCircle, Zap, AlertTriangle } from 'lucide-react';

/**
 * Token Usage Indicator
 * Shows token usage and warns when approaching limits
 */
export function TokenUsageIndicator({ messageCount, estimatedTokens, tokenLimit, className = '' }) {
    if (!messageCount || messageCount < 3) {
        return null; // Don't show for short conversations
    }

    const utilizationPercent = tokenLimit ? Math.round((estimatedTokens / tokenLimit) * 100) : 0;

    // Determine warning level
    let level = 'safe'; // < 50%
    let color = 'text-green-400';
    let bgColor = 'bg-green-500/10';
    let borderColor = 'border-green-500/20';
    let Icon = Zap;
    let message = null;

    if (utilizationPercent >= 90) {
        level = 'critical';
        color = 'text-red-400';
        bgColor = 'bg-red-500/10';
        borderColor = 'border-red-500/20';
        Icon = AlertCircle;
        message = 'Token limit critical! Older messages will be removed to fit.';
    } else if (utilizationPercent >= 70) {
        level = 'warning';
        color = 'text-yellow-400';
        bgColor = 'bg-yellow-500/10';
        borderColor = 'border-yellow-500/20';
        Icon = AlertTriangle;
        message = 'Conversation getting long. Consider starting a new session if responses slow down.';
    } else if (utilizationPercent >= 50) {
        level = 'moderate';
        color = 'text-blue-400';
        bgColor = 'bg-blue-500/10';
        borderColor = 'border-blue-500/20';
        Icon = Zap;
        message = null; // No message for moderate usage
    }

    return (
        <div className={`flex items-start gap-2 px-3 py-2 ${bgColor} border ${borderColor} rounded-lg text-xs ${className}`}>
            <Icon className={`w-4 h-4 ${color} mt-0.5 flex-shrink-0`} />
            <div className="flex-1">
                <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`font-medium ${color}`}>
                        Token Usage: {utilizationPercent}%
                    </span>
                    <span className="text-textMuted">
                        {estimatedTokens?.toLocaleString()} / {tokenLimit?.toLocaleString()}
                    </span>
                </div>

                {/* Progress bar */}
                <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                        className={`h-full transition-all duration-500 ${
                            level === 'critical' ? 'bg-red-500' :
                            level === 'warning' ? 'bg-yellow-500' :
                            level === 'moderate' ? 'bg-blue-500' :
                            'bg-green-500'
                        }`}
                        style={{ width: `${Math.min(utilizationPercent, 100)}%` }}
                    />
                </div>

                {/* Warning message */}
                {message && (
                    <p className={`mt-1.5 ${color} text-opacity-80`}>
                        {message}
                    </p>
                )}

                {/* Helpful tip */}
                {level === 'warning' || level === 'critical' ? (
                    <p className="mt-1.5 text-textMuted text-opacity-60">
                        💡 Tip: Use the "Clear Chat" button to start fresh
                    </p>
                ) : null}
            </div>
        </div>
    );
}
