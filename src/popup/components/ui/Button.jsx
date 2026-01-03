import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

const buttonVariants = {
    primary: 'bg-primary hover:bg-primaryHover text-white shadow-lg shadow-primary/20',
    secondary: 'bg-secondary hover:bg-secondary/90 text-white shadow-lg shadow-secondary/20',
    outline: 'border border-border bg-transparent hover:bg-surfaceHighlight text-text',
    ghost: 'hover:bg-surfaceHighlight text-text',
    danger: 'bg-error hover:bg-error/90 text-white',
    success: 'bg-success hover:bg-success/90 text-white',
    gradient: 'bg-gradient-to-r from-primary to-secondary hover:from-primary/90 hover:to-secondary/90 text-white shadow-lg',
};

const buttonSizes = {
    default: 'h-10 px-4 py-2',
    sm: 'h-8 px-3 text-xs',
    lg: 'h-12 px-8 text-lg',
    xl: 'h-14 px-10 text-xl',
    icon: 'h-10 w-10 p-0 flex items-center justify-center',
    'icon-sm': 'h-8 w-8 p-0 flex items-center justify-center',
};

const Button = React.forwardRef(({
    className,
    variant = 'primary',
    size = 'default',
    isLoading,
    animate = true,
    children,
    ...props
}, ref) => {
    const baseClasses = cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant] || buttonVariants.primary,
        buttonSizes[size] || buttonSizes.default,
        className
    );

    // Use motion.button for animated version
    if (animate) {
        return (
            <motion.button
                ref={ref}
                className={baseClasses}
                disabled={isLoading || props.disabled}
                whileHover={{ scale: props.disabled ? 1 : 1.02 }}
                whileTap={{ scale: props.disabled ? 1 : 0.98 }}
                transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                {...props}
            >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {children}
            </motion.button>
        );
    }

    return (
        <button
            ref={ref}
            className={cn(baseClasses, 'active:scale-95')}
            disabled={isLoading || props.disabled}
            {...props}
        >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {children}
        </button>
    );
});

Button.displayName = 'Button';

// Icon button wrapper for convenience
const IconButton = React.forwardRef(({ className, ...props }, ref) => (
    <Button
        ref={ref}
        size="icon"
        variant="ghost"
        className={cn('rounded-full', className)}
        {...props}
    />
));

IconButton.displayName = 'IconButton';

export { Button, IconButton };
