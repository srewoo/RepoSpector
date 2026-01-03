import React, { useState, useRef, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Language detection based on first line or common patterns
function detectLanguage(code) {
    if (!code) return 'text';

    const firstLine = code.split('\n')[0].toLowerCase();

    // Common shebang patterns
    if (firstLine.startsWith('#!') && firstLine.includes('python')) return 'python';
    if (firstLine.startsWith('#!') && firstLine.includes('node')) return 'javascript';
    if (firstLine.startsWith('#!') && firstLine.includes('bash')) return 'bash';

    // Pattern detection
    if (/^(import|from)\s+\w+/.test(code) && /def\s+\w+\(/.test(code)) return 'python';
    if (/^(import|export|const|let|var|function|class)\s+/.test(code)) return 'javascript';
    if (/^(package|func|type|import)\s+/.test(code)) return 'go';
    if (/^(public|private|class|interface|package)\s+/.test(code)) return 'java';
    if (/^(fn|let|mut|use|struct|impl)\s+/.test(code)) return 'rust';
    if (/^[a-z_]+\s*:\s*/m.test(code) && /^\s+-\s+/m.test(code)) return 'yaml';
    if (/^\s*[{[]/.test(code) && /^\s*[}\]]/.test(code.split('\n').pop())) return 'json';
    if (/^<[?!]?[\w-]+/.test(code)) return 'html';
    if (/^[.#]?[\w-]+\s*{/.test(code)) return 'css';
    if (/^\$|^npm|^git|^cd\s|^ls\s|^mkdir/.test(firstLine)) return 'bash';

    return 'text';
}

// Basic syntax highlighting using regex
function highlightCode(code, language) {
    if (!code) return '';

    // Define patterns for different token types
    const patterns = {
        javascript: [
            { regex: /(\/\/.*$)/gm, class: 'token-comment' },
            { regex: /(\/\*[\s\S]*?\*\/)/g, class: 'token-comment' },
            { regex: /(['"`])(?:(?!\1)[^\\]|\\.)*?\1/g, class: 'token-string' },
            { regex: /\b(const|let|var|function|class|return|if|else|for|while|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof|null|undefined|true|false)\b/g, class: 'token-keyword' },
            { regex: /\b(\d+\.?\d*)\b/g, class: 'token-number' },
            { regex: /\b([A-Z][a-zA-Z0-9]*)\b/g, class: 'token-class' },
            { regex: /\b([a-z_][a-zA-Z0-9_]*)\s*(?=\()/g, class: 'token-function' },
        ],
        python: [
            { regex: /(#.*$)/gm, class: 'token-comment' },
            { regex: /('''[\s\S]*?'''|"""[\s\S]*?""")/g, class: 'token-string' },
            { regex: /(['"])(?:(?!\1)[^\\]|\\.)*?\1/g, class: 'token-string' },
            { regex: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|lambda|and|or|not|in|is|True|False|None|self)\b/g, class: 'token-keyword' },
            { regex: /\b(\d+\.?\d*)\b/g, class: 'token-number' },
            { regex: /\b([A-Z][a-zA-Z0-9]*)\b/g, class: 'token-class' },
            { regex: /@\w+/g, class: 'token-decorator' },
        ],
        go: [
            { regex: /(\/\/.*$)/gm, class: 'token-comment' },
            { regex: /(\/\*[\s\S]*?\*\/)/g, class: 'token-comment' },
            { regex: /(`[^`]*`|"[^"]*")/g, class: 'token-string' },
            { regex: /\b(func|package|import|var|const|type|struct|interface|return|if|else|for|range|switch|case|default|go|chan|select|defer|make|new|nil|true|false)\b/g, class: 'token-keyword' },
            { regex: /\b(\d+\.?\d*)\b/g, class: 'token-number' },
        ],
        bash: [
            { regex: /(#.*$)/gm, class: 'token-comment' },
            { regex: /("(?:[^"\\]|\\.)*"|'[^']*')/g, class: 'token-string' },
            { regex: /(\$\w+|\$\{[^}]+\})/g, class: 'token-variable' },
            { regex: /\b(if|then|else|fi|for|do|done|while|case|esac|function|return|exit|echo|cd|ls|mkdir|rm|cp|mv|chmod|chown|grep|sed|awk|cat|npm|git|node|python)\b/g, class: 'token-keyword' },
        ],
    };

    let highlighted = escapeHtml(code);

    // Apply patterns for the detected language or javascript as fallback
    const langPatterns = patterns[language] || patterns.javascript;

    // Sort patterns by match position to avoid overlapping replacements
    const matches = [];
    langPatterns.forEach(({ regex, class: className }) => {
        let match;
        regex.lastIndex = 0;
        while ((match = regex.exec(code)) !== null) {
            matches.push({
                start: match.index,
                end: match.index + match[0].length,
                text: match[0],
                className
            });
        }
    });

    // Sort by position (reverse) to replace from end to start
    matches.sort((a, b) => b.start - a.start);

    // Remove overlapping matches (keep first one found)
    const usedRanges = [];
    const filteredMatches = matches.filter(match => {
        const overlaps = usedRanges.some(
            range => !(match.end <= range.start || match.start >= range.end)
        );
        if (!overlaps) {
            usedRanges.push({ start: match.start, end: match.end });
            return true;
        }
        return false;
    });

    // Apply replacements
    filteredMatches.forEach(({ start, end, text, className }) => {
        const before = highlighted.substring(0, start);
        const after = highlighted.substring(end);
        highlighted = before + `<span class="${className}">${escapeHtml(text)}</span>` + after;
    });

    return highlighted;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function CodeBlock({ code, language: providedLanguage, showLineNumbers = false }) {
    const [copied, setCopied] = useState(false);
    const codeRef = useRef(null);

    const language = providedLanguage || detectLanguage(code);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    };

    const lines = code?.split('\n') || [];
    const highlightedCode = highlightCode(code, language);

    return (
        <div className="relative group rounded-lg overflow-hidden bg-[#1e1e1e] border border-border">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-surfaceHighlight/50 border-b border-border">
                <span className="text-xs text-textMuted font-mono lowercase">{language}</span>
                <motion.button
                    onClick={handleCopy}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-textMuted hover:text-text rounded transition-colors"
                    whileTap={{ scale: 0.95 }}
                >
                    <AnimatePresence mode="wait">
                        {copied ? (
                            <motion.div
                                key="check"
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                exit={{ scale: 0 }}
                                className="flex items-center gap-1 text-success"
                            >
                                <Check className="w-3 h-3" />
                                <span>Copied!</span>
                            </motion.div>
                        ) : (
                            <motion.div
                                key="copy"
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                exit={{ scale: 0 }}
                                className="flex items-center gap-1"
                            >
                                <Copy className="w-3 h-3" />
                                <span>Copy</span>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.button>
            </div>

            {/* Code Content */}
            <div className="overflow-x-auto">
                <pre className="p-3 m-0 text-sm font-mono leading-relaxed">
                    {showLineNumbers ? (
                        <table className="w-full border-collapse">
                            <tbody>
                                {lines.map((line, i) => (
                                    <tr key={i} className="leading-relaxed">
                                        <td className="pr-4 text-right text-textMuted/40 select-none w-8">
                                            {i + 1}
                                        </td>
                                        <td className="whitespace-pre-wrap break-all">
                                            <span
                                                dangerouslySetInnerHTML={{
                                                    __html: highlightCode(line, language)
                                                }}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : (
                        <code
                            ref={codeRef}
                            className="whitespace-pre-wrap break-all text-gray-300"
                            dangerouslySetInnerHTML={{ __html: highlightedCode }}
                        />
                    )}
                </pre>
            </div>

            {/* Syntax highlighting styles */}
            <style>{`
                .token-keyword { color: #c586c0; }
                .token-string { color: #ce9178; }
                .token-comment { color: #6a9955; }
                .token-number { color: #b5cea8; }
                .token-function { color: #dcdcaa; }
                .token-class { color: #4ec9b0; }
                .token-variable { color: #9cdcfe; }
                .token-decorator { color: #dcdcaa; }
            `}</style>
        </div>
    );
}

// Simple inline code component
export function InlineCode({ children }) {
    return (
        <code className="px-1.5 py-0.5 bg-surfaceHighlight rounded text-sm font-mono text-primary">
            {children}
        </code>
    );
}
