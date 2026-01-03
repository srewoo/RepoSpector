import React from 'react';
import { cn } from '../../utils/cn';

/**
 * Base Skeleton component with pulse animation
 */
export function Skeleton({ className, ...props }) {
    return (
        <div
            className={cn(
                'animate-pulse rounded-md bg-surfaceHighlight/50',
                className
            )}
            {...props}
        />
    );
}

/**
 * Skeleton for text lines
 */
export function SkeletonText({ lines = 1, className }) {
    return (
        <div className={cn('space-y-2', className)}>
            {Array.from({ length: lines }).map((_, i) => (
                <Skeleton
                    key={i}
                    className={cn(
                        'h-4',
                        i === lines - 1 && lines > 1 ? 'w-3/4' : 'w-full'
                    )}
                />
            ))}
        </div>
    );
}

/**
 * Skeleton for avatar/icon circles
 */
export function SkeletonAvatar({ size = 'md', className }) {
    const sizes = {
        sm: 'w-6 h-6',
        md: 'w-8 h-8',
        lg: 'w-12 h-12',
        xl: 'w-16 h-16'
    };

    return (
        <Skeleton className={cn('rounded-full', sizes[size], className)} />
    );
}

/**
 * Skeleton for cards - repo card style
 */
export function SkeletonCard({ className }) {
    return (
        <div className={cn('p-4 rounded-xl border border-border bg-surface/50 space-y-3', className)}>
            <div className="flex items-center gap-3">
                <SkeletonAvatar size="md" />
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                </div>
            </div>
            <div className="flex gap-2">
                <Skeleton className="h-8 w-20 rounded-lg" />
                <Skeleton className="h-8 w-20 rounded-lg" />
            </div>
        </div>
    );
}

/**
 * Skeleton for chat messages
 */
export function SkeletonMessage({ isUser = false, className }) {
    return (
        <div className={cn('flex gap-3', isUser && 'flex-row-reverse', className)}>
            <SkeletonAvatar size="md" />
            <div className={cn('flex-1 max-w-[80%] space-y-2', isUser && 'flex flex-col items-end')}>
                <Skeleton className={cn('h-4', isUser ? 'w-24' : 'w-32')} />
                <Skeleton className={cn('h-20 rounded-2xl', isUser ? 'w-48' : 'w-full')} />
            </div>
        </div>
    );
}

/**
 * Skeleton for settings sections
 */
export function SkeletonSettingsSection({ className }) {
    return (
        <div className={cn('space-y-4', className)}>
            <div className="flex items-center justify-between">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-5 rounded" />
            </div>
            <div className="space-y-3 pl-4">
                <div className="flex items-center justify-between">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-8 w-32 rounded-lg" />
                </div>
                <div className="flex items-center justify-between">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-8 w-40 rounded-lg" />
                </div>
            </div>
        </div>
    );
}

/**
 * Skeleton for code blocks
 */
export function SkeletonCode({ lines = 5, className }) {
    return (
        <div className={cn('p-4 rounded-lg bg-[#1e1e1e] border border-border space-y-2', className)}>
            <div className="flex items-center justify-between mb-3">
                <Skeleton className="h-4 w-20 bg-surfaceHighlight/30" />
                <Skeleton className="h-6 w-16 rounded bg-surfaceHighlight/30" />
            </div>
            {Array.from({ length: lines }).map((_, i) => (
                <div key={i} className="flex gap-3">
                    <Skeleton className="h-4 w-6 bg-surfaceHighlight/20" />
                    <Skeleton
                        className="h-4 bg-surfaceHighlight/30"
                        style={{ width: `${Math.random() * 40 + 40}%` }}
                    />
                </div>
            ))}
        </div>
    );
}

/**
 * Skeleton for the repos list
 */
export function SkeletonReposList({ count = 3, className }) {
    return (
        <div className={cn('space-y-4', className)}>
            {/* Current repo section */}
            <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <SkeletonCard />
            </div>

            {/* Indexed repos section */}
            <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                {Array.from({ length: count }).map((_, i) => (
                    <SkeletonCard key={i} />
                ))}
            </div>
        </div>
    );
}
