import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * MarkdownRenderer - Renders markdown content with proper styling
 * @param {string} content - Markdown content to render
 * @param {string} className - Additional CSS classes
 * @param {boolean} showCopy - Whether to show copy button (default: true)
 */
export function MarkdownRenderer({ content, className, showCopy = true }) {
    const [copied, setCopied] = useState(false);

    if (!content) return null;

    const handleCopy = async () => {
        try {
            // Try modern clipboard API first
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(content);
            } else {
                // Fallback for extension context
                const textArea = document.createElement('textarea');
                textArea.value = content;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                textArea.style.top = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            // Final fallback using execCommand
            try {
                const textArea = document.createElement('textarea');
                textArea.value = content;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                textArea.style.top = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            } catch (fallbackErr) {
                console.error('Failed to copy:', fallbackErr);
            }
        }
    };

    return (
        <div className="relative">
            {showCopy && (
                <button
                    onClick={handleCopy}
                    className="absolute top-0 right-0 p-1.5 rounded-md bg-surface hover:bg-surfaceHighlight border border-border transition-colors z-10"
                    title="Copy to clipboard"
                >
                    {copied ? (
                        <Check className="w-4 h-4 text-green-500" />
                    ) : (
                        <Copy className="w-4 h-4 text-textMuted hover:text-text" />
                    )}
                </button>
            )}
            <ReactMarkdown
            className={cn('markdown-content', className)}
            components={{
                // Headings
                h1: ({ children }) => (
                    <h1 className="text-xl font-bold text-text mt-4 mb-2 first:mt-0">{children}</h1>
                ),
                h2: ({ children }) => (
                    <h2 className="text-lg font-semibold text-text mt-4 mb-2 first:mt-0">{children}</h2>
                ),
                h3: ({ children }) => (
                    <h3 className="text-base font-semibold text-text mt-3 mb-1.5 first:mt-0">{children}</h3>
                ),
                h4: ({ children }) => (
                    <h4 className="text-sm font-semibold text-text mt-2 mb-1 first:mt-0">{children}</h4>
                ),

                // Paragraphs
                p: ({ children }) => (
                    <p className="text-sm text-text mb-2 last:mb-0 leading-relaxed">{children}</p>
                ),

                // Lists
                ul: ({ children }) => (
                    <ul className="list-disc list-inside space-y-1 mb-2 ml-2 text-sm">{children}</ul>
                ),
                ol: ({ children }) => (
                    <ol className="list-decimal list-inside space-y-1 mb-2 ml-2 text-sm">{children}</ol>
                ),
                li: ({ children }) => (
                    <li className="text-text">{children}</li>
                ),

                // Code — detect inline vs block by checking for language className
                // In react-markdown v9+ the `inline` prop is removed, so we infer:
                // code blocks have a className like "language-js", inline code does not
                code: ({ inline, className, children }) => {
                    const isCodeBlock = className || inline === false;
                    if (!isCodeBlock) {
                        return (
                            <code className="inline px-1.5 py-0.5 bg-surface rounded text-xs font-mono text-primary whitespace-nowrap">
                                {children}
                            </code>
                        );
                    }
                    return (
                        <code className={cn("block", className)}>
                            {children}
                        </code>
                    );
                },
                pre: ({ children }) => (
                    <pre className="bg-background border border-border rounded-lg p-3 overflow-x-auto mb-3 text-xs font-mono">
                        {children}
                    </pre>
                ),

                // Bold and italic
                strong: ({ children }) => (
                    <strong className="font-semibold text-text">{children}</strong>
                ),
                em: ({ children }) => (
                    <em className="italic text-textMuted">{children}</em>
                ),

                // Links
                a: ({ href, children }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                    >
                        {children}
                    </a>
                ),

                // Blockquotes
                blockquote: ({ children }) => (
                    <blockquote className="border-l-4 border-primary/30 pl-3 italic text-textMuted my-2">
                        {children}
                    </blockquote>
                ),

                // Horizontal rule
                hr: () => (
                    <hr className="border-border my-4" />
                ),

                // Tables
                table: ({ children }) => (
                    <div className="overflow-x-auto mb-3">
                        <table className="min-w-full text-sm border border-border rounded">
                            {children}
                        </table>
                    </div>
                ),
                thead: ({ children }) => (
                    <thead className="bg-surface">{children}</thead>
                ),
                tbody: ({ children }) => (
                    <tbody className="divide-y divide-border">{children}</tbody>
                ),
                tr: ({ children }) => (
                    <tr>{children}</tr>
                ),
                th: ({ children }) => (
                    <th className="px-3 py-2 text-left font-semibold text-text border-b border-border">
                        {children}
                    </th>
                ),
                td: ({ children }) => (
                    <td className="px-3 py-2 text-text">{children}</td>
                ),

                // Checkboxes (task lists)
                input: ({ type, checked }) => {
                    if (type === 'checkbox') {
                        return (
                            <input
                                type="checkbox"
                                checked={checked}
                                readOnly
                                className="mr-2 rounded border-border"
                            />
                        );
                    }
                    return null;
                }
            }}
        >
            {content}
        </ReactMarkdown>
        </div>
    );
}

export default MarkdownRenderer;
