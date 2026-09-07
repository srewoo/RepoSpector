import React from 'react';
import { cn } from '@/lib/utils';
import {
    HelpCircle,
    Wrench,
    AlertCircle,
    Shield,
    Zap,
    Bug,
    MessageSquare,
    RefreshCw,
    FlaskConical
} from 'lucide-react';
import { Button } from './ui/Button';
import { offersTestGeneration } from '@/utils/prTestPrompts';
import { filterActionsByAllowedIds } from '@/utils/quickActionsFilter';

const defaultActions = [
    {
        id: 'explain',
        label: 'Explain',
        icon: HelpCircle,
        color: 'text-blue-500',
        bgColor: 'bg-blue-500/10',
        description: 'Get a detailed explanation of this issue'
    },
    {
        id: 'fix',
        label: 'How to Fix',
        icon: Wrench,
        color: 'text-green-500',
        bgColor: 'bg-green-500/10',
        description: 'Get specific code to fix this issue'
    },
    {
        id: 'false-positive',
        label: 'False Positive?',
        icon: AlertCircle,
        color: 'text-yellow-500',
        bgColor: 'bg-yellow-500/10',
        description: 'Check if this might be a false positive'
    }
];

const contextualActions = {
    security: [
        {
            id: 'security-impact',
            label: 'Security Impact',
            icon: Shield,
            color: 'text-red-500',
            bgColor: 'bg-red-500/10',
            description: 'Understand the security implications'
        }
    ],
    performance: [
        {
            id: 'perf-impact',
            label: 'Performance Impact',
            icon: Zap,
            color: 'text-orange-500',
            bgColor: 'bg-orange-500/10',
            description: 'Understand the performance implications'
        }
    ],
    bug: [
        {
            id: 'write-test',
            label: 'Write Test',
            icon: Bug,
            color: 'text-purple-500',
            bgColor: 'bg-purple-500/10',
            description: 'Generate a test to catch this bug'
        }
    ]
};

export function QuickActions({
    finding,
    onAction,
    disabled = false,
    showLabels = true,
    compact = false,
    className,
    // Filters the rendered actions to these ids. `null` (default) renders
    // every candidate action, unchanged for existing callers. Pass this when
    // the caller's action handler implements only a subset of ids — see
    // `filterActionsByAllowedIds`.
    allowedIds = null
}) {
    // `toCanonicalFinding` emits `category`, never `type`; the legacy `type`
    // fallback keeps any pre-canonical caller working.
    const kind = finding?.category || finding?.type;
    // Only `static/missing-test` qualifies. That finding's file and symbol are
    // themselves the newly-exported, untested thing, which is exactly what
    // PRTestGenerationService can act on. `graph/untested-blast-radius` is
    // deliberately excluded even though it is category 'coverage': its
    // untested symbols are DEPENDENTS living in files this PR does not touch,
    // so ReviewFileContextService cannot fetch their source and generation
    // would always skip.
    const wantsTest = offersTestGeneration(finding);
    const actions = filterActionsByAllowedIds([
        ...defaultActions,
        ...(kind ? contextualActions[kind] || [] : []),
        ...(wantsTest && !contextualActions[kind]?.some(a => a.id === 'write-test')
            ? contextualActions.bug.filter(a => a.id === 'write-test')
            : []),
    ], allowedIds);

    if (compact) {
        return (
            <div className={cn('flex flex-wrap gap-1', className)}>
                {actions.slice(0, 3).map(action => (
                    <button
                        key={action.id}
                        onClick={() => onAction(action.id)}
                        disabled={disabled}
                        className={cn(
                            'p-1.5 rounded transition-colors',
                            action.bgColor,
                            'hover:opacity-80 disabled:opacity-50'
                        )}
                        title={action.description}
                    >
                        <action.icon className={cn('w-3.5 h-3.5', action.color)} />
                    </button>
                ))}
            </div>
        );
    }

    return (
        <div className={cn('space-y-2', className)}>
            {showLabels && (
                <span className="text-xs text-textMuted">Quick Actions</span>
            )}
            <div className="flex flex-wrap gap-2">
                {actions.map(action => (
                    <Button
                        key={action.id}
                        variant="outline"
                        size="sm"
                        onClick={() => onAction(action.id)}
                        disabled={disabled}
                        className="flex items-center gap-1.5"
                        title={action.description}
                    >
                        <action.icon className={cn('w-3.5 h-3.5', action.color)} />
                        {action.label}
                    </Button>
                ))}
            </div>
        </div>
    );
}

/**
 * PR-level quick actions
 */
export function PRQuickActions({
    onAction,
    disabled = false,
    className
}) {
    const prActions = [
        {
            id: 'focus-security',
            label: 'Focus on Security',
            icon: Shield,
            color: 'text-red-500'
        },
        {
            id: 'focus-performance',
            label: 'Focus on Performance',
            icon: Zap,
            color: 'text-orange-500'
        },
        {
            id: 'focus-bugs',
            label: 'Focus on Bugs',
            icon: Bug,
            color: 'text-purple-500'
        },
        {
            id: 'ask-question',
            label: 'Ask Question',
            icon: MessageSquare,
            color: 'text-blue-500'
        },
        {
            id: 'generate-tests',
            label: 'Generate Tests',
            icon: FlaskConical,
            color: 'text-emerald-500'
        },
        {
            id: 'refresh',
            label: 'Re-analyze',
            icon: RefreshCw,
            color: 'text-green-500'
        }
    ];

    return (
        <div className={cn('flex flex-wrap gap-2', className)}>
            {prActions.map(action => (
                <Button
                    key={action.id}
                    variant="outline"
                    size="sm"
                    onClick={() => onAction(action.id)}
                    disabled={disabled}
                    className="flex items-center gap-1.5"
                >
                    <action.icon className={cn('w-3.5 h-3.5', action.color)} />
                    {action.label}
                </Button>
            ))}
        </div>
    );
}

export default QuickActions;
