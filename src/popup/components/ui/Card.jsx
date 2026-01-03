import React from 'react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

const cardVariants = {
    default: 'rounded-xl border border-border bg-surface/50 text-text shadow-sm backdrop-blur-sm',
    elevated: 'rounded-xl border border-border bg-surface/80 text-text shadow-lg shadow-black/10 backdrop-blur-md',
    interactive: 'rounded-xl border border-border bg-surface/50 text-text shadow-sm backdrop-blur-sm cursor-pointer transition-all duration-200 hover:shadow-lg hover:border-primary/30 hover:-translate-y-0.5',
    outline: 'rounded-xl border border-border bg-transparent text-text',
    ghost: 'rounded-xl bg-transparent text-text',
};

const Card = React.forwardRef(({ className, variant = 'default', animate = false, ...props }, ref) => {
    const Component = animate ? motion.div : 'div';

    const animationProps = animate ? {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -10 },
        transition: { duration: 0.2 }
    } : {};

    return (
        <Component
            ref={ref}
            className={cn(cardVariants[variant] || cardVariants.default, className)}
            {...animationProps}
            {...props}
        />
    );
});
Card.displayName = 'Card';

const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn('flex flex-col space-y-1.5 p-6', className)}
        {...props}
    />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
    <h3
        ref={ref}
        className={cn('font-semibold leading-none tracking-tight', className)}
        {...props}
    />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
    <p
        ref={ref}
        className={cn('text-sm text-textMuted', className)}
        {...props}
    />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef(({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn('flex items-center p-6 pt-0', className)}
        {...props}
    />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
