import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Collapsible section component with smooth animations
 */
export function Collapsible({
    title,
    icon: Icon,
    defaultOpen = false,
    children,
    className,
    badge
}) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    return (
        <div className={cn('border border-border rounded-xl overflow-hidden', className)}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    'w-full flex items-center justify-between p-4 text-left',
                    'bg-surface hover:bg-surfaceHighlight/50 transition-colors',
                    isOpen && 'border-b border-border bg-surfaceHighlight/30'
                )}
            >
                <div className="flex items-center gap-3">
                    {Icon && <Icon className="w-4 h-4 text-primary" />}
                    <span className="font-medium text-text">{title}</span>
                    {badge && (
                        <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full">
                            {badge}
                        </span>
                    )}
                </div>
                <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                >
                    <ChevronDown className="w-4 h-4 text-textMuted" />
                </motion.div>
            </button>

            <AnimatePresence initial={false}>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeInOut' }}
                    >
                        <div className="p-4 bg-surface/50">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/**
 * CollapsibleGroup - Wrapper for multiple collapsible sections
 * Can optionally implement accordion behavior (only one open at a time)
 */
export function CollapsibleGroup({ children, className, accordion = false }) {
    const [openIndex, setOpenIndex] = useState(0);

    if (!accordion) {
        return <div className={cn('space-y-3', className)}>{children}</div>;
    }

    // For accordion behavior, clone children and control their state
    return (
        <div className={cn('space-y-3', className)}>
            {React.Children.map(children, (child, index) => {
                if (!React.isValidElement(child)) return child;
                return React.cloneElement(child, {
                    defaultOpen: index === openIndex,
                    onChange: () => setOpenIndex(index)
                });
            })}
        </div>
    );
}
