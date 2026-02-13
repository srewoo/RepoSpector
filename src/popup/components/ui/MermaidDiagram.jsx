import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { Download } from 'lucide-react';

let mermaidInitialized = false;

function initMermaid() {
    if (mermaidInitialized) return;
    mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 12,
        flowchart: {
            htmlLabels: true,
            curve: 'basis',
            padding: 12,
            nodeSpacing: 30,
            rankSpacing: 40
        },
        themeVariables: {
            primaryColor: '#6366f1',
            primaryTextColor: '#e2e8f0',
            primaryBorderColor: '#818cf8',
            lineColor: '#94a3b8',
            secondaryColor: '#1e293b',
            tertiaryColor: '#0f172a',
            background: '#0f172a',
            mainBkg: '#1e293b',
            nodeBorder: '#475569',
            clusterBkg: '#1e293b',
            clusterBorder: '#334155',
            titleColor: '#e2e8f0',
            edgeLabelBackground: '#1e293b'
        }
    });
    mermaidInitialized = true;
}

let renderCounter = 0;

export function MermaidDiagram({ code, className = '' }) {
    const containerRef = useRef(null);
    const [svgContent, setSvgContent] = useState(null);
    const [error, setError] = useState(null);
    const [showCode, setShowCode] = useState(false);

    useEffect(() => {
        if (!code) return;

        initMermaid();

        const renderDiagram = async () => {
            try {
                setError(null);
                const id = `mermaid-${++renderCounter}`;
                const { svg } = await mermaid.render(id, code.trim());
                setSvgContent(svg);
            } catch (err) {
                console.warn('Mermaid render error:', err);
                setError(err.message || 'Failed to render diagram');
                setSvgContent(null);
            }
        };

        renderDiagram();
    }, [code]);

    if (!code) return null;

    return (
        <div className={className}>
            {svgContent ? (
                <div
                    ref={containerRef}
                    className="overflow-x-auto rounded-lg bg-[#0f172a] p-4"
                    dangerouslySetInnerHTML={{ __html: svgContent }}
                />
            ) : error ? (
                <div className="space-y-2">
                    <p className="text-xs text-amber-400">Diagram render failed — showing source code</p>
                    <pre className="p-3 bg-background rounded-lg text-xs overflow-x-auto font-mono whitespace-pre-wrap">
                        <code>{code}</code>
                    </pre>
                </div>
            ) : (
                <div className="flex items-center justify-center p-6 text-textMuted text-sm">
                    Rendering diagram...
                </div>
            )}
            {svgContent && (
                <div className="mt-2 flex items-center gap-3">
                    <button
                        onClick={() => setShowCode(v => !v)}
                        className="text-xs text-textMuted hover:text-text transition-colors"
                    >
                        {showCode ? 'Hide source' : 'View source'}
                    </button>
                    <button
                        onClick={() => {
                            try {
                                const blob = new Blob([svgContent], { type: 'image/svg+xml' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = 'repo-diagram.svg';
                                a.click();
                                URL.revokeObjectURL(url);
                            } catch (e) {
                                console.error('Download failed:', e);
                            }
                        }}
                        className="text-xs text-textMuted hover:text-text transition-colors flex items-center gap-1"
                    >
                        <Download className="w-3 h-3" />
                        Download SVG
                    </button>
                </div>
            )}
            {showCode && svgContent && (
                <pre className="mt-1 p-3 bg-background rounded-lg text-xs overflow-x-auto font-mono whitespace-pre-wrap">
                    <code>{code}</code>
                </pre>
            )}
        </div>
    );
}
