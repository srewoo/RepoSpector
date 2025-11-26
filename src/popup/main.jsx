import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Error Boundary Component for catching React errors
class ModuleErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true };
    }

    componentDidCatch(error, errorInfo) {
        console.error('React Error Boundary caught:', error, errorInfo);
        this.setState({
            error,
            errorInfo
        });
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    padding: '20px',
                    fontFamily: 'system-ui, -apple-system, sans-serif',
                    maxWidth: '400px',
                    minHeight: '600px',
                    display: 'flex',
                    flexDirection: 'column'
                }}>
                    <h2 style={{ color: '#ef4444', marginBottom: '10px', fontSize: '18px' }}>
                        ⚠️ Extension Error
                    </h2>
                    <p style={{ marginBottom: '10px', color: '#374151' }}>
                        RepoSpector encountered an error. Please try:
                    </p>
                    <ul style={{ marginLeft: '20px', marginBottom: '15px', color: '#374151' }}>
                        <li>Refreshing the extension</li>
                        <li>Reloading the page</li>
                        <li>Checking your API key settings</li>
                    </ul>
                    <details style={{ marginTop: '15px' }}>
                        <summary style={{ cursor: 'pointer', color: '#6366f1', fontWeight: '500' }}>
                            Technical Details
                        </summary>
                        <pre style={{
                            marginTop: '10px',
                            padding: '10px',
                            background: '#f3f4f6',
                            borderRadius: '4px',
                            fontSize: '11px',
                            overflow: 'auto',
                            maxHeight: '200px',
                            color: '#1f2937'
                        }}>
                            {this.state.error && this.state.error.toString()}
                            {this.state.errorInfo && this.state.errorInfo.componentStack}
                        </pre>
                    </details>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            marginTop: '15px',
                            padding: '8px 16px',
                            background: '#6366f1',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '14px',
                            fontWeight: '500'
                        }}
                    >
                        Reload Extension
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}

// Initialize with error handling
try {
    const rootElement = document.getElementById('root');

    if (!rootElement) {
        throw new Error('Root element not found');
    }

    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            <ModuleErrorBoundary>
                <App />
            </ModuleErrorBoundary>
        </React.StrictMode>
    );
} catch (error) {
    console.error('Failed to initialize React app:', error);

    // Fallback UI if React fails to load
    const rootElement = document.getElementById('root');
    if (rootElement) {
        rootElement.innerHTML = `
            <div style="padding: 20px; font-family: system-ui; max-width: 400px;">
                <h2 style="color: #ef4444; font-size: 18px; margin-bottom: 10px;">Failed to Load Extension</h2>
                <p style="margin-bottom: 10px; color: #374151;">RepoSpector could not initialize. This may be due to:</p>
                <ul style="margin-left: 20px; color: #374151; margin-bottom: 15px;">
                    <li>Module loading errors</li>
                    <li>Incompatible browser version</li>
                    <li>Corrupted installation</li>
                </ul>
                <p style="margin-top: 15px; color: #374151;">
                    Try reinstalling the extension or check the console for errors.
                </p>
                <pre style="background: #f3f4f6; padding: 10px; margin-top: 10px; font-size: 11px; overflow: auto; border-radius: 4px; color: #1f2937;">
${error.message}
                </pre>
            </div>
        `;
    }
}
