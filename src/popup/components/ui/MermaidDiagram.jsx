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
        sequence: {
            diagramMarginX: 20,
            diagramMarginY: 10,
            actorMargin: 60,
            width: 150,
            height: 40,
            boxMargin: 6,
            boxTextMargin: 5,
            noteMargin: 10,
            messageMargin: 30,
            mirrorActors: true,
            useMaxWidth: true
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
            edgeLabelBackground: '#1e293b',
            actorBkg: '#334155',
            actorBorder: '#818cf8',
            actorTextColor: '#e2e8f0',
            actorLineColor: '#94a3b8',
            signalColor: '#e2e8f0',
            signalTextColor: '#e2e8f0',
            labelBoxBkgColor: '#1e293b',
            labelBoxBorderColor: '#475569',
            labelTextColor: '#e2e8f0',
            loopTextColor: '#94a3b8',
            noteBkgColor: '#334155',
            noteBorderColor: '#6366f1',
            noteTextColor: '#e2e8f0',
            activationBkgColor: '#475569',
            activationBorderColor: '#818cf8'
        }
    });
    mermaidInitialized = true;
}

let renderCounter = 0;

/**
 * Sanitize Mermaid code to fix common LLM-generated syntax issues.
 * Ensures node labels with special characters are properly quoted.
 */
function sanitizeMermaidCode(code) {
    const firstLine = code.trim().split('\n')[0].trim().toLowerCase();
    const isSequenceDiagram = firstLine.startsWith('sequencediagram');

    // Sequence diagrams need minimal sanitization
    if (isSequenceDiagram) {
        return code.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('%%') || trimmed === 'end' ||
                trimmed === 'sequenceDiagram' ||
                /^(participant|actor|activate|deactivate|Note\s|alt|else|opt|loop|par|and|rect|critical|break)\s*/i.test(trimmed)) {
                return line;
            }
            return line.replace(/<br\s*\/?>/gi, '\\n');
        }).join('\n');
    }

    // Flowchart sanitization
    return code.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('%%') || trimmed === 'end' ||
            trimmed.startsWith('class ') || trimmed.startsWith('classDef ') ||
            trimmed.startsWith('style ') || trimmed.startsWith('linkStyle ') ||
            /^(flowchart|graph|subgraph)\s/.test(trimmed)) {
            return line;
        }

        // Strip quotes from edge labels: -->|"text"| → -->|text|
        line = line.replace(/(\|)\s*"([^"]*?)"\s*(\|)/g, '$1$2$3');

        if (/^\s*\w+\s*(-->|---|-\.->|==>|-.->|--)\s*\w+/.test(line) && !/[\[({"']/.test(line)) {
            return line;
        }
        // Fix unquoted node labels with special chars: ID[((file.py))] → ID["file.py"]
        return line.replace(
            /(\b[A-Za-z_]\w*)\s*([\[({])\(*([^"]*?)\)*([\])}])/g,
            (match, id, open, label, close) => {
                if (label.startsWith('"') && label.endsWith('"')) return match;
                if (/[()[\]{}<>|#&]/.test(label)) {
                    const cleanLabel = label.replace(/[()[\]{}<>|]/g, ' ').replace(/\s+/g, ' ').trim();
                    return `${id}${open}"${cleanLabel}"${close}`;
                }
                return match;
            }
        );
    }).join('\n');
}

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
                const sanitized = sanitizeMermaidCode(code.trim());
                const { svg } = await mermaid.render(id, sanitized);
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
