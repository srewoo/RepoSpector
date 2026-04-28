/**
 * #13a — Lazy-loading framer-motion wrapper.
 *
 * Usage:
 *   import { MotionDiv, MotionButton, LazyAnimatePresence } from './ui/MotionDiv';
 *
 * - Simple fade/slide: use <FadeIn> or <SlideUp> — pure CSS, zero JS cost.
 * - Full framer API (layout, drag, complex sequences): use <MotionDiv> /
 *   <MotionButton> — these lazy-load framer-motion on first interaction,
 *   keeping it out of the initial bundle.
 *
 * Migration guide for existing motion.div usages:
 *   - motion.div with just initial/animate/exit fade  → <FadeIn>
 *   - motion.div with whileHover/whileTap on a button  → plain button + CSS
 *   - motion.div with layout / complex spring          → <MotionDiv>
 */

import React, { Suspense, lazy } from 'react';
import { cn } from '@/lib/utils';

// ── CSS-only primitives (no framer-motion, no Suspense) ──────────────────────

/**
 * Fade-in wrapper using CSS animation. Replaces the common pattern:
 *   <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
 */
export function FadeIn({ children, className, duration = 200, delay = 0, ...props }) {
    return (
        <div
            className={cn('animate-fade-in', className)}
            style={{ animationDuration: `${duration}ms`, animationDelay: `${delay}ms` }}
            {...props}
        >
            {children}
        </div>
    );
}

/**
 * Slide-up + fade-in wrapper. Replaces common entrance animations.
 */
export function SlideUp({ children, className, duration = 250, delay = 0, ...props }) {
    return (
        <div
            className={cn('animate-slide-up', className)}
            style={{ animationDuration: `${duration}ms`, animationDelay: `${delay}ms` }}
            {...props}
        >
            {children}
        </div>
    );
}

// ── Lazy framer-motion wrappers ───────────────────────────────────────────────

const LazyMotion = lazy(() =>
    import('framer-motion').then((m) => ({
        default: ({ children, ...p }) => {
            const Tag = m.motion[p.as || 'div'] || m.motion.div;
            return <Tag {...p}>{children}</Tag>;
        }
    }))
);

const LazyAnimatePresenceImpl = lazy(() =>
    import('framer-motion').then((m) => ({
        default: m.AnimatePresence
    }))
);

function MotionFallback({ children, className }) {
    return <div className={cn('transition-all', className)}>{children}</div>;
}

/**
 * Drop-in replacement for <motion.div>.
 * Lazy-loads framer-motion; shows a plain div until the chunk arrives.
 */
export function MotionDiv({ children, className, fallback, ...props }) {
    return (
        <Suspense fallback={fallback ?? <MotionFallback className={className}>{children}</MotionFallback>}>
            <LazyMotion as="div" className={className} {...props}>
                {children}
            </LazyMotion>
        </Suspense>
    );
}

/**
 * Drop-in replacement for <motion.button>.
 */
export function MotionButton({ children, className, fallback, ...props }) {
    return (
        <Suspense fallback={fallback ?? <button className={className}>{children}</button>}>
            <LazyMotion as="button" className={className} {...props}>
                {children}
            </LazyMotion>
        </Suspense>
    );
}

/**
 * Drop-in replacement for <AnimatePresence>.
 */
export function LazyAnimatePresence({ children, ...props }) {
    return (
        <Suspense fallback={<>{children}</>}>
            <LazyAnimatePresenceImpl {...props}>
                {children}
            </LazyAnimatePresenceImpl>
        </Suspense>
    );
}
