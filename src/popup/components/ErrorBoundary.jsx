import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from './ui/Button';

/**
 * Error Boundary Component
 * Catches React errors and displays fallback UI
 */
export class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null
        };
    }

    static getDerivedStateFromError(error) {
        // Update state so the next render will show the fallback UI
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        // Log error details for debugging
        console.error('Error Boundary caught an error:', error, errorInfo);

        this.setState({
            error,
            errorInfo
        });

        // Log to error handler if available
        if (window.ErrorHandler) {
            window.ErrorHandler.logError(error, {
                component: errorInfo.componentStack,
                timestamp: new Date().toISOString()
            });
        }
    }

    handleReset = () => {
        // Reset error state and attempt recovery
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null
        });

        // Optionally trigger parent callback
        if (this.props.onReset) {
            this.props.onReset();
        }
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center min-h-screen p-8 bg-backgroundAlt">
                    <div className="max-w-md w-full bg-background rounded-lg shadow-lg p-6 space-y-4">
                        <div className="flex items-center gap-3 text-error">
                            <AlertTriangle className="w-8 h-8" />
                            <h2 className="text-xl font-semibold">Something went wrong</h2>
                        </div>

                        <p className="text-textMuted">
                            {this.props.fallbackMessage ||
                             'An unexpected error occurred. Please try refreshing or contact support if the problem persists.'}
                        </p>

                        {this.state.error && (
                            <details className="mt-4">
                                <summary className="cursor-pointer text-sm text-textMuted hover:text-text">
                                    Error details
                                </summary>
                                <div className="mt-2 p-3 bg-backgroundAlt rounded text-xs font-mono overflow-auto max-h-48">
                                    <p className="text-error font-semibold">{this.state.error.toString()}</p>
                                    {this.state.errorInfo && (
                                        <pre className="mt-2 text-textMuted whitespace-pre-wrap">
                                            {this.state.errorInfo.componentStack}
                                        </pre>
                                    )}
                                </div>
                            </details>
                        )}

                        <div className="flex gap-3 pt-4">
                            <Button
                                onClick={this.handleReset}
                                className="flex items-center gap-2"
                            >
                                <RefreshCw className="w-4 h-4" />
                                Try Again
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => window.location.reload()}
                            >
                                Reload Extension
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

/**
 * Higher-order component to wrap any component with error boundary
 */
export function withErrorBoundary(Component, fallbackMessage) {
    return function WithErrorBoundaryComponent(props) {
        return (
            <ErrorBoundary fallbackMessage={fallbackMessage}>
                <Component {...props} />
            </ErrorBoundary>
        );
    };
}
