import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

// Toast Context
const ToastContext = createContext(undefined);

// Toast types and their configurations
const TOAST_TYPES = {
    success: {
        icon: CheckCircle,
        className: 'bg-green-500/10 border-green-500/30 text-green-400',
        iconClass: 'text-green-500'
    },
    error: {
        icon: AlertCircle,
        className: 'bg-red-500/10 border-red-500/30 text-red-400',
        iconClass: 'text-red-500'
    },
    warning: {
        icon: AlertTriangle,
        className: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
        iconClass: 'text-yellow-500'
    },
    info: {
        icon: Info,
        className: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
        iconClass: 'text-blue-500'
    }
};

// Individual Toast component
function Toast({ id, type = 'info', title, message, duration = 3000, onDismiss }) {
    const config = TOAST_TYPES[type] || TOAST_TYPES.info;
    const Icon = config.icon;

    React.useEffect(() => {
        if (duration > 0) {
            const timer = setTimeout(() => {
                onDismiss(id);
            }, duration);
            return () => clearTimeout(timer);
        }
    }, [id, duration, onDismiss]);

    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className={`relative flex items-start gap-3 p-3 rounded-lg border backdrop-blur-sm shadow-lg max-w-xs ${config.className}`}
        >
            <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${config.iconClass}`} />
            <div className="flex-1 min-w-0">
                {title && (
                    <p className="text-sm font-semibold">{title}</p>
                )}
                {message && (
                    <p className="text-xs opacity-80 mt-0.5">{message}</p>
                )}
            </div>
            <button
                onClick={() => onDismiss(id)}
                className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
            >
                <X className="w-4 h-4 opacity-60 hover:opacity-100" />
            </button>
        </motion.div>
    );
}

// Toast Container component
function ToastContainer({ toasts, onDismiss }) {
    return (
        <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
            <AnimatePresence mode="popLayout">
                {toasts.map((toast) => (
                    <div key={toast.id} className="pointer-events-auto">
                        <Toast {...toast} onDismiss={onDismiss} />
                    </div>
                ))}
            </AnimatePresence>
        </div>
    );
}

// Toast Provider
export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);

    const addToast = useCallback((options) => {
        const id = Date.now() + Math.random();
        const toast = {
            id,
            type: 'info',
            duration: 3000,
            ...options
        };
        setToasts((prev) => [...prev, toast]);
        return id;
    }, []);

    const dismissToast = useCallback((id) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    const dismissAll = useCallback(() => {
        setToasts([]);
    }, []);

    // Convenience methods
    const toast = useCallback((message, options = {}) => {
        return addToast({ message, ...options });
    }, [addToast]);

    toast.success = (message, options = {}) => addToast({ type: 'success', message, ...options });
    toast.error = (message, options = {}) => addToast({ type: 'error', message, ...options });
    toast.warning = (message, options = {}) => addToast({ type: 'warning', message, ...options });
    toast.info = (message, options = {}) => addToast({ type: 'info', message, ...options });
    toast.dismiss = dismissToast;
    toast.dismissAll = dismissAll;

    const value = { toast, addToast, dismissToast, dismissAll };

    return (
        <ToastContext.Provider value={value}>
            {children}
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        </ToastContext.Provider>
    );
}

// Hook to use toast
export function useToast() {
    const context = useContext(ToastContext);
    if (context === undefined) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

export { ToastContext };
