// Smart chunking utility for handling large codebases
export class CodeChunker {
    constructor(options = {}) {
        // Token limits for different models
        this.modelLimits = {
            'gpt-4.1': 128000,
            'gpt-4o': 128000,
            'gpt-4o-mini': 128000,
            'o3': 200000,
            'o3-mini': 200000,
            'gpt-4.1-mini': 128000,
            'default': 8000
        };
        
        // Reserve tokens for system prompt and response
        this.reservedTokens = options.reservedTokens || 2000;
        
        // Approximate tokens per character (conservative estimate)
        this.tokensPerChar = 0.25; // ~4 chars per token
        
        // Maximum concurrent requests
        this.maxConcurrent = options.maxConcurrent || 3;
        
        // Overlap between chunks for context
        this.overlapTokens = options.overlapTokens || 200;
    }
    
    /**
     * Estimate token count for a given text
     */
    estimateTokens(text) {
        // Simple estimation: ~4 characters per token on average
        // For code, it's often more dense, so we use a conservative estimate
        return Math.ceil(text.length * this.tokensPerChar);
    }
    
    /**
     * Get maximum tokens for a model
     */
    getMaxTokensForModel(model) {
        return this.modelLimits[model] || this.modelLimits.default;
    }
    
    /**
     * Calculate chunk size based on model
     */
    getChunkSize(model) {
        const maxTokens = this.getMaxTokensForModel(model);
        const availableTokens = maxTokens - this.reservedTokens;
        return Math.floor(availableTokens / this.tokensPerChar);
    }
    
    /**
     * Split code into semantic chunks
     */
    createSemanticChunks(code, model) {
        const chunkSize = this.getChunkSize(model);
        const chunks = [];
        
        // Try to split by major code boundaries
        const boundaries = this.findCodeBoundaries(code);
        
        let currentChunk = '';
        let currentTokens = 0;
        let lastBoundaryIndex = 0;
        
        for (const boundary of boundaries) {
            const segment = code.substring(lastBoundaryIndex, boundary.end);
            const segmentTokens = this.estimateTokens(segment);
            
            if (currentTokens + segmentTokens > chunkSize && currentChunk) {
                // Save current chunk
                chunks.push({
                    content: currentChunk,
                    startIndex: chunks.length === 0 ? 0 : lastBoundaryIndex - segment.length,
                    endIndex: lastBoundaryIndex,
                    tokens: currentTokens,
                    type: 'code'
                });
                
                // Start new chunk with overlap
                const overlapStart = Math.max(0, lastBoundaryIndex - this.calculateOverlapChars());
                currentChunk = code.substring(overlapStart, boundary.end);
                currentTokens = this.estimateTokens(currentChunk);
            } else {
                currentChunk += segment;
                currentTokens += segmentTokens;
            }
            
            lastBoundaryIndex = boundary.end;
        }
        
        // Add remaining content
        if (currentChunk) {
            chunks.push({
                content: currentChunk,
                startIndex: chunks.length === 0 ? 0 : lastBoundaryIndex - currentChunk.length,
                endIndex: code.length,
                tokens: currentTokens,
                type: 'code'
            });
        }
        
        return chunks;
    }
    
    /**
     * Find natural boundaries in code (functions, classes, etc.)
     */
    findCodeBoundaries(code) {
        const boundaries = [];
        
        // Patterns for different code structures
        const patterns = [
            // JavaScript/TypeScript functions and classes
            { regex: /^(export\s+)?(async\s+)?(function\s+\w+|const\s+\w+\s*=\s*(async\s+)?function|\w+\s*\([^)]*\)\s*{|class\s+\w+)/gm, type: 'function' },
            // Method definitions
            { regex: /^\s*(async\s+)?\w+\s*\([^)]*\)\s*{/gm, type: 'method' },
            // Python functions and classes
            { regex: /^(def\s+\w+|class\s+\w+)/gm, type: 'python' },
            // Java/C# methods and classes
            { regex: /^(public|private|protected)\s+(static\s+)?(class|interface|void|int|string|boolean|float|double)\s+\w+/gm, type: 'java' },
            // Module/namespace boundaries
            { regex: /^(module|namespace)\s+\w+/gm, type: 'module' }
        ];
        
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.regex.exec(code)) !== null) {
                boundaries.push({
                    start: match.index,
                    end: this.findBlockEnd(code, match.index),
                    type: pattern.type,
                    name: match[0]
                });
            }
        }
        
        // Sort boundaries by start position
        boundaries.sort((a, b) => a.start - b.start);
        
        // Merge overlapping boundaries
        const merged = [];
        for (const boundary of boundaries) {
            if (merged.length === 0 || boundary.start >= merged[merged.length - 1].end) {
                merged.push(boundary);
            } else {
                // Extend the previous boundary
                merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, boundary.end);
            }
        }
        
        // If no boundaries found, create artificial ones
        if (merged.length === 0) {
            const lines = code.split('\n');
            const linesPerChunk = Math.ceil(lines.length / Math.ceil(code.length / this.getChunkSize('default')));
            
            for (let i = 0; i < lines.length; i += linesPerChunk) {
                const start = code.indexOf(lines[i]);
                const endLine = Math.min(i + linesPerChunk, lines.length - 1);
                const end = code.indexOf(lines[endLine]) + lines[endLine].length;
                
                merged.push({
                    start,
                    end,
                    type: 'artificial',
                    name: `Lines ${i + 1}-${endLine + 1}`
                });
            }
        }
        
        return merged;
    }
    
    /**
     * Find the end of a code block starting at given position
     */
    findBlockEnd(code, startPos) {
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
        let inComment = false;
        let i = startPos;
        
        // Find the opening brace
        while (i < code.length && code[i] !== '{') {
            if (code[i] === '\n') {
                // Check if this is Python-style (indentation-based)
                const nextLineMatch = code.substring(i + 1).match(/^(\s*)/);
                if (nextLineMatch) {
                    const baseIndent = nextLineMatch[1].length;
                    // Find where indentation returns to base level
                    const lines = code.substring(i).split('\n');
                    for (let j = 1; j < lines.length; j++) {
                        const lineIndent = lines[j].match(/^(\s*)/)[1].length;
                        if (lineIndent <= baseIndent && lines[j].trim()) {
                            return i + lines.slice(0, j).join('\n').length;
                        }
                    }
                }
            }
            i++;
        }
        
        if (i >= code.length) {
            // No opening brace found, try to find end by other means
            const nextFunction = code.substring(startPos + 1).search(/^(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=)/m);
            return nextFunction === -1 ? code.length : startPos + nextFunction;
        }
        
        // Count braces to find matching closing brace
        braceCount = 1;
        i++;
        
        while (i < code.length && braceCount > 0) {
            // Handle strings
            if (!inComment && (code[i] === '"' || code[i] === "'" || code[i] === '`')) {
                if (!inString) {
                    inString = true;
                    stringChar = code[i];
                } else if (code[i] === stringChar && code[i - 1] !== '\\') {
                    inString = false;
                }
            }
            
            // Handle comments
            if (!inString) {
                if (code[i] === '/' && code[i + 1] === '/') {
                    // Single line comment
                    while (i < code.length && code[i] !== '\n') i++;
                } else if (code[i] === '/' && code[i + 1] === '*') {
                    // Multi-line comment
                    i += 2;
                    while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
                    i++;
                }
            }
            
            // Count braces
            if (!inString && !inComment) {
                if (code[i] === '{') braceCount++;
                else if (code[i] === '}') braceCount--;
            }
            
            i++;
        }
        
        return i;
    }
    
    /**
     * Calculate overlap size in characters
     */
    calculateOverlapChars() {
        return Math.floor(this.overlapTokens / this.tokensPerChar);
    }
    
    /**
     * Create batches for parallel processing
     */
    createBatches(chunks, maxConcurrent) {
        const batches = [];
        for (let i = 0; i < chunks.length; i += maxConcurrent) {
            batches.push(chunks.slice(i, i + maxConcurrent));
        }
        return batches;
    }
    
    /**
     * Prepare chunks with context
     */
    prepareChunksWithContext(chunks, globalContext) {
        return chunks.map((chunk, index) => ({
            ...chunk,
            context: {
                ...globalContext,
                chunkIndex: index,
                totalChunks: chunks.length,
                previousChunkSummary: index > 0 ? this.summarizeChunk(chunks[index - 1]) : null,
                nextChunkPreview: index < chunks.length - 1 ? chunks[index + 1].content.substring(0, 200) : null
            }
        }));
    }
    
    /**
     * Summarize a chunk for context
     */
    summarizeChunk(chunk) {
        const lines = chunk.content.split('\n');
        const functions = chunk.content.match(/function\s+(\w+)|(\w+)\s*\([^)]*\)\s*{|class\s+(\w+)/g) || [];
        
        return {
            lines: lines.length,
            functions: functions.map(f => f.trim()),
            preview: chunk.content.substring(0, 100) + '...'
        };
    }
} 