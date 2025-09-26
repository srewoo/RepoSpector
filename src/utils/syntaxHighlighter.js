// Syntax Highlighter Utility
export class SyntaxHighlighter {
    constructor() {
        this.languages = {
            javascript: {
                keywords: /\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/g,
                strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
                comments: /(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm,
                numbers: /\b(\d+\.?\d*)\b/g,
                functions: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g,
                operators: /([+\-*/%=<>!&|^~?:]+)/g,
                brackets: /([{}[\]()])/g,
                properties: /\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g
            },
            typescript: {
                keywords: /\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|function|if|import|in|instanceof|interface|let|new|return|super|switch|this|throw|try|type|typeof|var|void|while|with|yield|implements|private|protected|public|static|readonly|abstract|namespace|module|declare|as|is|keyof|never|unknown|any|boolean|number|string|symbol|object)\b/g,
                strings: /(["'`])(?:(?=(\\?))\2.)*?\1/g,
                comments: /(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm,
                numbers: /\b(\d+\.?\d*)\b/g,
                functions: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g,
                types: /:\s*([A-Z][a-zA-Z0-9_$<>[\]|&]*)/g,
                generics: /<([^>]+)>/g,
                operators: /([+\-*/%=<>!&|^~?:]+)/g,
                brackets: /([{}[\]()])/g,
                properties: /\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g
            },
            python: {
                keywords: /\b(and|as|assert|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield|async|await)\b/g,
                strings: /(["'])(?:(?=(\\?))\2.)*?\1|"""[\s\S]*?"""|'''[\s\S]*?'''/g,
                comments: /(#.*$)/gm,
                numbers: /\b(\d+\.?\d*)\b/g,
                functions: /\b(def\s+)([a-zA-Z_][a-zA-Z0-9_]*)/g,
                decorators: /@[a-zA-Z_][a-zA-Z0-9_]*/g,
                operators: /([+\-*/%=<>!&|^~]+)/g,
                brackets: /([{}[\]()])/g
            },
            java: {
                keywords: /\b(abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|native|new|package|private|protected|public|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while)\b/g,
                strings: /(["'])(?:(?=(\\?))\2.)*?\1/g,
                comments: /(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm,
                numbers: /\b(\d+\.?\d*[fFlLdD]?)\b/g,
                annotations: /@[A-Z][a-zA-Z0-9_]*/g,
                types: /\b([A-Z][a-zA-Z0-9_<>[\]]*)\b/g,
                operators: /([+\-*/%=<>!&|^~?:]+)/g,
                brackets: /([{}[\]()])/g
            },
            csharp: {
                keywords: /\b(abstract|as|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|var|virtual|void|volatile|while)\b/g,
                strings: /(["'])(?:(?=(\\?))\2.)*?\1|@"[^"]*"/g,
                comments: /(\/\/.*$)|(\/\*[\s\S]*?\*\/)/gm,
                numbers: /\b(\d+\.?\d*[fFdDmM]?)\b/g,
                types: /\b([A-Z][a-zA-Z0-9_<>[\]]*)\b/g,
                operators: /([+\-*/%=<>!&|^~?:]+)/g,
                brackets: /([{}[\]()])/g
            }
        };

        this.themes = {
            default: {
                keyword: 'color: #569cd6; font-weight: bold;',
                string: 'color: #ce9178;',
                comment: 'color: #6a9955; font-style: italic;',
                number: 'color: #b5cea8;',
                function: 'color: #dcdcaa;',
                operator: 'color: #d4d4d4;',
                bracket: 'color: #ffd700;',
                property: 'color: #9cdcfe;',
                type: 'color: #4ec9b0;',
                decorator: 'color: #c586c0;',
                annotation: 'color: #c586c0;',
                generic: 'color: #4ec9b0;',
                default: 'color: #d4d4d4;'
            },
            light: {
                keyword: 'color: #0000ff; font-weight: bold;',
                string: 'color: #a31515;',
                comment: 'color: #008000; font-style: italic;',
                number: 'color: #098658;',
                function: 'color: #795e26;',
                operator: 'color: #000000;',
                bracket: 'color: #000000;',
                property: 'color: #001080;',
                type: 'color: #267f99;',
                decorator: 'color: #af00db;',
                annotation: 'color: #af00db;',
                generic: 'color: #267f99;',
                default: 'color: #000000;'
            }
        };
    }

    /**
     * Highlight code with proper syntax highlighting
     */
    highlight(code, language = 'javascript', theme = 'default') {
        if (!code) return '';
        
        // Detect language if not specified
        if (language === 'auto') {
            language = this.detectLanguage(code);
        }
        
        const lang = this.languages[language] || this.languages.javascript;
        const styles = this.themes[theme] || this.themes.default;
        
        // Escape HTML first
        let highlighted = this.escapeHtml(code);
        
        // Store strings and comments to avoid highlighting inside them
        const placeholders = new Map();
        let placeholderIndex = 0;
        
        // Replace comments first
        if (lang.comments) {
            highlighted = highlighted.replace(lang.comments, (match) => {
                const placeholder = `__COMMENT_${placeholderIndex++}__`;
                placeholders.set(placeholder, `<span style="${styles.comment}">${match}</span>`);
                return placeholder;
            });
        }
        
        // Replace strings
        if (lang.strings) {
            highlighted = highlighted.replace(lang.strings, (match) => {
                const placeholder = `__STRING_${placeholderIndex++}__`;
                placeholders.set(placeholder, `<span style="${styles.string}">${match}</span>`);
                return placeholder;
            });
        }
        
        // Highlight language-specific features
        if (lang.decorators) {
            highlighted = highlighted.replace(lang.decorators, 
                `<span style="${styles.decorator}">$&</span>`);
        }
        
        if (lang.annotations) {
            highlighted = highlighted.replace(lang.annotations, 
                `<span style="${styles.annotation}">$&</span>`);
        }
        
        // Highlight types (TypeScript, Java, C#)
        if (lang.types) {
            highlighted = highlighted.replace(lang.types, 
                `<span style="${styles.type}">$1</span>`);
        }
        
        if (lang.generics) {
            highlighted = highlighted.replace(lang.generics, 
                `<span style="${styles.generic}">&lt;$1&gt;</span>`);
        }
        
        // Highlight keywords
        highlighted = highlighted.replace(lang.keywords, 
            `<span style="${styles.keyword}">$&</span>`);
        
        // Highlight numbers
        highlighted = highlighted.replace(lang.numbers, 
            `<span style="${styles.number}">$&</span>`);
        
        // Highlight functions
        if (lang.functions) {
            if (language === 'python') {
                highlighted = highlighted.replace(lang.functions, 
                    `$1<span style="${styles.function}">$2</span>`);
            } else {
                highlighted = highlighted.replace(lang.functions, 
                    `<span style="${styles.function}">$1</span>`);
            }
        }
        
        // Highlight properties
        if (lang.properties) {
            highlighted = highlighted.replace(lang.properties, 
                `.<span style="${styles.property}">$1</span>`);
        }
        
        // Highlight operators
        highlighted = highlighted.replace(lang.operators, 
            `<span style="${styles.operator}">$1</span>`);
        
        // Highlight brackets
        highlighted = highlighted.replace(lang.brackets, 
            `<span style="${styles.bracket}">$1</span>`);
        
        // Restore strings and comments
        placeholders.forEach((value, key) => {
            highlighted = highlighted.replace(key, value);
        });
        
        // Add line numbers
        const lines = highlighted.split('\n');
        const numberedLines = lines.map((line, index) => {
            const lineNumber = index + 1;
            return `<span class="line-number" style="color: #858585; margin-right: 1em; user-select: none;">${lineNumber.toString().padStart(3)}</span>${line}`;
        });
        
        return `<pre style="background: ${theme === 'light' ? '#f5f5f5' : '#1e1e1e'}; padding: 1em; border-radius: 4px; overflow-x: auto; font-family: 'Consolas', 'Monaco', 'Courier New', monospace; line-height: 1.5;">${numberedLines.join('\n')}</pre>`;
    }

    /**
     * Detect language from code content
     */
    detectLanguage(code) {
        // Simple heuristic-based detection
        if (code.includes('import React') || code.includes('jsx')) return 'javascript';
        if (code.includes('interface ') || code.includes('type ')) return 'typescript';
        if (code.includes('def ') || code.includes('import numpy')) return 'python';
        if (code.includes('public class') || code.includes('System.out')) return 'java';
        if (code.includes('using System') || code.includes('namespace ')) return 'csharp';
        
        // Default to JavaScript
        return 'javascript';
    }

    /**
     * Escape HTML characters
     */
    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    /**
     * Create highlighted diff view
     */
    highlightDiff(oldCode, newCode) {
        const oldLines = oldCode.split('\n');
        const newLines = newCode.split('\n');
        const maxLines = Math.max(oldLines.length, newLines.length);
        
        let diffHtml = '<div style="display: flex; font-family: monospace; font-size: 14px;">';
        
        // Old code column
        diffHtml += '<div style="flex: 1; background: #ffecec; padding: 1em; border-right: 1px solid #ddd;">';
        diffHtml += '<h4 style="margin: 0 0 1em 0; color: #d00;">Original</h4>';
        
        for (let i = 0; i < maxLines; i++) {
            const line = oldLines[i] || '';
            const lineNumber = i + 1;
            const isRemoved = i >= oldLines.length || (newLines[i] !== undefined && line !== newLines[i]);
            
            diffHtml += `<div style="${isRemoved ? 'background: #fdd;' : ''}">`;
            diffHtml += `<span style="color: #999; margin-right: 1em;">${lineNumber}</span>`;
            diffHtml += this.escapeHtml(line);
            diffHtml += '</div>';
        }
        
        diffHtml += '</div>';
        
        // New code column
        diffHtml += '<div style="flex: 1; background: #eeffee; padding: 1em;">';
        diffHtml += '<h4 style="margin: 0 0 1em 0; color: #0a0;">Modified</h4>';
        
        for (let i = 0; i < maxLines; i++) {
            const line = newLines[i] || '';
            const lineNumber = i + 1;
            const isAdded = i >= newLines.length || (oldLines[i] !== undefined && line !== oldLines[i]);
            
            diffHtml += `<div style="${isAdded ? 'background: #dfd;' : ''}">`;
            diffHtml += `<span style="color: #999; margin-right: 1em;">${lineNumber}</span>`;
            diffHtml += this.escapeHtml(line);
            diffHtml += '</div>';
        }
        
        diffHtml += '</div>';
        diffHtml += '</div>';
        
        return diffHtml;
    }

    /**
     * Create a diff view between two code snippets
     */
    createDiff(oldCode, newCode) {
        const oldLines = oldCode.split('\n');
        const newLines = newCode.split('\n');
        const maxLines = Math.max(oldLines.length, newLines.length);
        
        let html = '<div class="syntax-diff">';
        
        // Old code column
        html += '<div style="flex: 1; background: #ffecec; padding: 1em; border-right: 1px solid #ddd;">';
        html += '<h4 style="margin: 0 0 1em 0; color: #d00;">Original</h4>';
        
        for (let i = 0; i < maxLines; i++) {
            const line = oldLines[i] || '';
            const lineNumber = i + 1;
            const isRemoved = i >= oldLines.length || (newLines[i] !== undefined && line !== newLines[i]);
            
            html += `<div style="${isRemoved ? 'background: #fdd;' : ''}">`;
            html += `<span style="color: #999; margin-right: 1em;">${lineNumber}</span>`;
            html += this.escapeHtml(line);
            html += '</div>';
        }
        
        html += '</div>';
        
        // New code column
        html += '<div style="flex: 1; background: #eeffee; padding: 1em;">';
        html += '<h4 style="margin: 0 0 1em 0; color: #0a0;">Modified</h4>';
        
        for (let i = 0; i < maxLines; i++) {
            const line = newLines[i] || '';
            const lineNumber = i + 1;
            const isAdded = i >= newLines.length || (oldLines[i] !== undefined && line !== oldLines[i]);
            
            html += `<div style="${isAdded ? 'background: #dfd;' : ''}">`;
            html += `<span style="color: #999; margin-right: 1em;">${lineNumber}</span>`;
            html += this.escapeHtml(line);
            html += '</div>';
        }
        
        html += '</div>';
        html += '</div>';
        
        return html;
    }
}

// Export singleton instance
export const syntaxHighlighter = new SyntaxHighlighter(); 