// Diff parser utility for extracting and analyzing diff content
// Supports GitHub, GitLab, Bitbucket, and other SCM platforms

import { Sanitizer } from './sanitizer.js';
import { ErrorHandler } from './errorHandler.js';

export class DiffParser {
    constructor() {
        this.sanitizer = new Sanitizer();
        this.errorHandler = new ErrorHandler();
        
        this.platformPatterns = {
            github: {
                diffContainer: '.diff-table, .js-diff-table, [data-testid="diff-view"]',
                fileHeader: '.file-header, .js-file-header',
                addedLines: '.blob-code-addition, .gd',
                removedLines: '.blob-code-deletion, .gi', 
                contextLines: '.blob-code-context',
                lineNumber: '.blob-num',
                fileName: '.file-info a, .file-header .file-title'
            },
            gitlab: {
                diffContainer: '.diff-content, .diffs',
                fileHeader: '.file-title',
                addedLines: '.line_content.new, .gi',
                removedLines: '.line_content.old, .gd',
                contextLines: '.line_content:not(.new):not(.old)',
                lineNumber: '.diff-line-num',
                fileName: '.file-title'
            },
            bitbucket: {
                diffContainer: '.refract-content-container, .bb-udiff',
                fileHeader: '.filename',
                addedLines: '.addition, .gi',
                removedLines: '.deletion, .gd',
                contextLines: '.context',
                lineNumber: '.line-number',
                fileName: '.filename'
            }
        };

        // Diff pattern matchers for different platforms
        this.diffPatterns = {
            github: {
                addedLine: /^\+(?!\+\+)/,
                removedLine: /^-(?!--)/,
                contextLine: /^ /,
                hunkHeader: /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
                fileHeader: /^diff --git a\/(.+) b\/(.+)/,
                binaryFile: /^Binary files? .* differ/,
                newFile: /^new file mode/,
                deletedFile: /^deleted file mode/,
                renamedFile: /^rename from .* to .*/
            },
            gitlab: {
                addedLine: /^\+(?!\+\+)/,
                removedLine: /^-(?!--)/,
                contextLine: /^ /,
                hunkHeader: /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
                fileHeader: /^diff --git a\/(.+) b\/(.+)/,
                binaryFile: /^Binary files? .* differ/
            },
            bitbucket: {
                addedLine: /^\+/,
                removedLine: /^-/,
                contextLine: /^ /,
                hunkHeader: /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
                fileHeader: /^diff --git a\/(.+) b\/(.+)/
            },
            generic: {
                addedLine: /^\+/,
                removedLine: /^-/,
                contextLine: /^ /,
                hunkHeader: /^@@.*@@/,
                fileHeader: /^diff /
            }
        };
    }

    /**
     * Parse diff content from different SCM platforms
     */
    async parseDiff(diffContent, options = {}) {
        try {
            const {
                platform = this.detectPlatform(window.location.href),
                extractContext = true,
                includeMetadata = true
            } = options;

            // Sanitize input
            const sanitizedContent = this.sanitizer.sanitizeInput(diffContent);
            
            // Detect if this is actually a diff
            if (!this.isDiffContent(sanitizedContent)) {
                throw new Error('Content does not appear to be a valid diff');
            }

            // Parse based on platform
            let parsedDiff;
            switch (platform) {
                case 'github':
                    parsedDiff = await this.parseGitHubDiff(sanitizedContent);
                    break;
                case 'gitlab':
                    parsedDiff = await this.parseGitLabDiff(sanitizedContent);
                    break;
                case 'bitbucket':
                    parsedDiff = await this.parseBitbucketDiff(sanitizedContent);
                    break;
                default:
                    parsedDiff = await this.parseGenericDiff(sanitizedContent);
            }

            // Extract additional context if requested
            if (extractContext) {
                parsedDiff = await this.enhanceWithContext(parsedDiff, platform);
            }

            // Add metadata if requested
            if (includeMetadata) {
                parsedDiff.metadata = this.extractMetadata(sanitizedContent, platform);
            }

            return parsedDiff;

        } catch (error) {
            this.errorHandler.logError('Diff parsing', error);
            throw error;
        }
    }

    /**
     * Extract changed code from DOM for live diff pages
     */
    async extractDiffFromDOM(_options = {}) {
        try {
            const platform = this.detectPlatform(window.location.href);
            
            switch (platform) {
                case 'github':
                    return await this.extractGitHubDiffFromDOM();
                case 'gitlab':
                    return await this.extractGitLabDiffFromDOM();
                case 'bitbucket':
                    return await this.extractBitbucketDiffFromDOM();
                default:
                    return await this.extractGenericDiffFromDOM();
            }
        } catch (error) {
            this.errorHandler.logError('DOM diff extraction', error);
            throw error;
        }
    }

    /**
     * Detect platform from URL
     */
    detectPlatform(url) {
        if (url.includes('github.com')) return 'github';
        if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab';
        if (url.includes('bitbucket.org')) return 'bitbucket';
        if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) return 'azure';
        return 'generic';
    }

    /**
     * Check if content is a valid diff
     */
    isDiffContent(content) {
        // Check for common diff indicators
        const diffIndicators = [
            /^diff --git/m,
            /^@@.*@@/m,
            /^\+\+\+ /m,
            /^--- /m,
            /^Index: /m,
            /^\+[^+]/m,
            /^-[^-]/m
        ];

        return diffIndicators.some(pattern => pattern.test(content));
    }

    /**
     * Parse GitHub-specific diff format
     */
    async parseGitHubDiff(content) {
        const patterns = this.diffPatterns.github;
        const files = [];
        let currentFile = null;
        let currentHunk = null;

        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // File header
            if (patterns.fileHeader.test(line)) {
                if (currentFile) {
                    files.push(currentFile);
                }

                const match = line.match(patterns.fileHeader);
                currentFile = {
                    oldPath: match[1],
                    newPath: match[2],
                    hunks: [],
                    changes: {
                        additions: 0,
                        deletions: 0,
                        total: 0
                    },
                    type: 'modified',
                    language: this.detectLanguage(match[2])
                };
                currentHunk = null;
            }

            // File type detection
            if (currentFile) {
                if (patterns.newFile.test(line)) {
                    currentFile.type = 'added';
                } else if (patterns.deletedFile.test(line)) {
                    currentFile.type = 'deleted';
                } else if (patterns.renamedFile.test(line)) {
                    currentFile.type = 'renamed';
                } else if (patterns.binaryFile.test(line)) {
                    currentFile.type = 'binary';
                }
            }

            // Hunk header
            if (patterns.hunkHeader.test(line)) {
                if (currentHunk) {
                    currentFile.hunks.push(currentHunk);
                }

                const match = line.match(patterns.hunkHeader);
                currentHunk = {
                    oldStart: parseInt(match[1]),
                    oldLines: parseInt(match[2]) || 1,
                    newStart: parseInt(match[3]),
                    newLines: parseInt(match[4]) || 1,
                    context: match[0],
                    lines: []
                };
            }

            // Content lines
            if (currentHunk && (patterns.addedLine.test(line) || patterns.removedLine.test(line) || patterns.contextLine.test(line))) {
                const lineType = patterns.addedLine.test(line) ? 'added' :
                               patterns.removedLine.test(line) ? 'deleted' : 'context';
                
                const lineData = {
                    type: lineType,
                    content: line.substring(1), // Remove +/- prefix
                    number: {
                        old: lineType !== 'added' ? currentHunk.oldStart + currentHunk.lines.filter(l => l.type !== 'added').length : null,
                        new: lineType !== 'deleted' ? currentHunk.newStart + currentHunk.lines.filter(l => l.type !== 'deleted').length : null
                    }
                };

                currentHunk.lines.push(lineData);

                if (lineType === 'added') {
                    currentFile.changes.additions++;
                } else if (lineType === 'deleted') {
                    currentFile.changes.deletions++;
                }
                currentFile.changes.total++;
            }
        }

        // Add last file
        if (currentFile) {
            if (currentHunk) {
                currentFile.hunks.push(currentHunk);
            }
            files.push(currentFile);
        }

        return {
            platform: 'github',
            files,
            summary: this.generateDiffSummary(files)
        };
    }

    /**
     * Parse GitLab-specific diff format
     */
    async parseGitLabDiff(content) {
        // GitLab uses similar format to GitHub, with minor differences
        const parsedDiff = await this.parseGitHubDiff(content);
        parsedDiff.platform = 'gitlab';
        return parsedDiff;
    }

    /**
     * Parse Bitbucket-specific diff format
     */
    async parseBitbucketDiff(content) {
        const parsedDiff = await this.parseGitHubDiff(content);
        parsedDiff.platform = 'bitbucket';
        return parsedDiff;
    }

    /**
     * Parse generic diff format
     */
    async parseGenericDiff(content) {
        const parsedDiff = await this.parseGitHubDiff(content);
        parsedDiff.platform = 'generic';
        return parsedDiff;
    }

    /**
     * Extract GitHub diff from DOM
     */
    async extractGitHubDiffFromDOM() {
        const diffFiles = [];

        // GitHub PR diff files
        const fileElements = document.querySelectorAll('[data-tagsearch-path], .file-diff-split, .js-diff-progressive-container');
        
        for (const fileElement of fileElements) {
            try {
                const filePath = this.extractGitHubFilePath(fileElement);
                const fileChanges = this.extractGitHubFileChanges(fileElement);
                
                if (filePath && fileChanges.length > 0) {
                    diffFiles.push({
                        path: filePath,
                        language: this.detectLanguage(filePath),
                        changes: fileChanges,
                        type: this.detectChangeType(fileElement)
                    });
                }
            } catch (error) {
                console.warn('Failed to extract file diff:', error);
                continue;
            }
        }

        return {
            platform: 'github',
            files: diffFiles,
            url: window.location.href,
            extractedAt: new Date().toISOString(),
            summary: this.generateDiffSummary(diffFiles)
        };
    }

    /**
     * Extract GitLab diff from DOM
     */
    async extractGitLabDiffFromDOM() {
        const diffFiles = [];

        // GitLab diff files
        const fileElements = document.querySelectorAll('.diff-file, .file-holder');
        
        for (const fileElement of fileElements) {
            try {
                const filePath = this.extractGitLabFilePath(fileElement);
                const fileChanges = this.extractGitLabFileChanges(fileElement);
                
                if (filePath && fileChanges.length > 0) {
                    diffFiles.push({
                        path: filePath,
                        language: this.detectLanguage(filePath),
                        changes: fileChanges,
                        type: this.detectChangeType(fileElement)
                    });
                }
            } catch (error) {
                console.warn('Failed to extract GitLab file diff:', error);
                continue;
            }
        }

        return {
            platform: 'gitlab',
            files: diffFiles,
            url: window.location.href,
            extractedAt: new Date().toISOString(),
            summary: this.generateDiffSummary(diffFiles)
        };
    }

    /**
     * Extract Bitbucket diff from DOM
     */
    async extractBitbucketDiffFromDOM() {
        const diffFiles = [];

        // Bitbucket diff files
        const fileElements = document.querySelectorAll('.diff-container, .file-diff');
        
        for (const fileElement of fileElements) {
            try {
                const filePath = this.extractBitbucketFilePath(fileElement);
                const fileChanges = this.extractBitbucketFileChanges(fileElement);
                
                if (filePath && fileChanges.length > 0) {
                    diffFiles.push({
                        path: filePath,
                        language: this.detectLanguage(filePath),
                        changes: fileChanges,
                        type: this.detectChangeType(fileElement)
                    });
                }
            } catch (error) {
                console.warn('Failed to extract Bitbucket file diff:', error);
                continue;
            }
        }

        return {
            platform: 'bitbucket',
            files: diffFiles,
            url: window.location.href,
            extractedAt: new Date().toISOString(),
            summary: this.generateDiffSummary(diffFiles)
        };
    }

    /**
     * Extract generic diff from DOM
     */
    async extractGenericDiffFromDOM() {
        const diffFiles = [];

        // Try common diff selectors
        const selectors = [
            '.diff', '.file-diff', '.code-diff',
            '[class*="diff"]', '[id*="diff"]',
            'pre', 'code'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            
            for (const element of elements) {
                const text = element.textContent || '';
                if (this.isDiffContent(text)) {
                    try {
                        const parsed = await this.parseGenericDiff(text);
                        diffFiles.push(...parsed.files);
                    } catch (error) {
                        console.warn('Failed to parse generic diff:', error);
                    }
                }
            }
        }

        return {
            platform: 'generic',
            files: diffFiles,
            url: window.location.href,
            extractedAt: new Date().toISOString(),
            summary: this.generateDiffSummary(diffFiles)
        };
    }

    // Helper methods for GitHub DOM extraction
    extractGitHubFilePath(fileElement) {
        // Try various selectors for GitHub file path
        const selectors = [
            '[data-tagsearch-path]',
            '.file-header [title]',
            '.file-info a',
            '.js-file-header-text'
        ];

        for (const selector of selectors) {
            const element = fileElement.querySelector(selector);
            if (element) {
                return element.getAttribute('data-tagsearch-path') || 
                       element.getAttribute('title') || 
                       element.textContent?.trim();
            }
        }

        return null;
    }

    extractGitHubFileChanges(fileElement) {
        const changes = [];
        
        // Extract added lines
        const addedLines = fileElement.querySelectorAll('.blob-code-addition, .blob-code.blob-code-addition');
        addedLines.forEach(line => {
            changes.push({
                type: 'added',
                content: line.textContent?.trim() || '',
                lineNumber: this.extractLineNumber(line)
            });
        });

        // Extract deleted lines
        const deletedLines = fileElement.querySelectorAll('.blob-code-deletion, .blob-code.blob-code-deletion');
        deletedLines.forEach(line => {
            changes.push({
                type: 'deleted',
                content: line.textContent?.trim() || '',
                lineNumber: this.extractLineNumber(line)
            });
        });

        return changes;
    }

    // Helper methods for GitLab DOM extraction
    extractGitLabFilePath(fileElement) {
        const selectors = [
            '.file-title-name',
            '.diff-file-path',
            '.file-header-content strong'
        ];

        for (const selector of selectors) {
            const element = fileElement.querySelector(selector);
            if (element) {
                return element.textContent?.trim();
            }
        }

        return null;
    }

    extractGitLabFileChanges(fileElement) {
        const changes = [];
        
        // Extract added lines
        const addedLines = fileElement.querySelectorAll('.line_content.new, .new');
        addedLines.forEach(line => {
            changes.push({
                type: 'added',
                content: line.textContent?.trim() || '',
                lineNumber: this.extractLineNumber(line)
            });
        });

        // Extract deleted lines
        const deletedLines = fileElement.querySelectorAll('.line_content.old, .old');
        deletedLines.forEach(line => {
            changes.push({
                type: 'deleted',
                content: line.textContent?.trim() || '',
                lineNumber: this.extractLineNumber(line)
            });
        });

        return changes;
    }

    // Helper methods for Bitbucket DOM extraction
    extractBitbucketFilePath(fileElement) {
        const selectors = [
            '.filename',
            '.file-path',
            '.diff-file-name'
        ];

        for (const selector of selectors) {
            const element = fileElement.querySelector(selector);
            if (element) {
                return element.textContent?.trim();
            }
        }

        return null;
    }

    extractBitbucketFileChanges(fileElement) {
        const changes = [];
        
        // Extract added lines
        const addedLines = fileElement.querySelectorAll('.addition, .add-line');
        addedLines.forEach(line => {
            changes.push({
                type: 'added',
                content: line.textContent?.trim() || '',
                lineNumber: this.extractLineNumber(line)
            });
        });

        // Extract deleted lines
        const deletedLines = fileElement.querySelectorAll('.deletion, .remove-line');
        deletedLines.forEach(line => {
            changes.push({
                type: 'deleted',
                content: line.textContent?.trim() || '',
                lineNumber: this.extractLineNumber(line)
            });
        });

        return changes;
    }

    /**
     * Extract line number from diff line element
     */
    extractLineNumber(lineElement) {
        // Try to find line number in various formats
        const lineNumElement = lineElement.querySelector('[data-line-number], .line-number, .blob-num');
        if (lineNumElement) {
            return parseInt(lineNumElement.textContent?.trim()) || 0;
        }

        // Try to extract from data attributes
        const lineNum = lineElement.getAttribute('data-line-number') || 
                       lineElement.getAttribute('data-line') ||
                       lineElement.getAttribute('line-number');
        
        return lineNum ? parseInt(lineNum) : 0;
    }

    /**
     * Detect change type (added, deleted, modified, renamed)
     */
    detectChangeType(fileElement) {
        const classNames = fileElement.className || '';
        const text = fileElement.textContent || '';

        if (classNames.includes('added') || text.includes('new file')) {
            return 'added';
        }
        if (classNames.includes('deleted') || text.includes('deleted file')) {
            return 'deleted';
        }
        if (classNames.includes('renamed') || text.includes('renamed')) {
            return 'renamed';
        }
        
        return 'modified';
    }

    /**
     * Detect programming language from file path
     */
    detectLanguage(filePath) {
        if (!filePath) return 'text';

        const extension = filePath.split('.').pop()?.toLowerCase();
        
        const languageMap = {
            'js': 'javascript',
            'jsx': 'javascript',
            'ts': 'typescript',
            'tsx': 'typescript',
            'py': 'python',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'cs': 'csharp',
            'go': 'go',
            'rb': 'ruby',
            'php': 'php',
            'swift': 'swift',
            'kt': 'kotlin',
            'rs': 'rust',
            'scala': 'scala',
            'clj': 'clojure',
            'hs': 'haskell',
            'ml': 'ocaml',
            'fs': 'fsharp',
            'elm': 'elm',
            'dart': 'dart',
            'lua': 'lua',
            'r': 'r',
            'pl': 'perl',
            'sh': 'bash',
            'bash': 'bash',
            'zsh': 'zsh',
            'fish': 'fish',
            'ps1': 'powershell',
            'html': 'html',
            'css': 'css',
            'scss': 'scss',
            'sass': 'sass',
            'less': 'less',
            'json': 'json',
            'xml': 'xml',
            'yaml': 'yaml',
            'yml': 'yaml',
            'toml': 'toml',
            'ini': 'ini',
            'cfg': 'ini',
            'conf': 'ini',
            'sql': 'sql',
            'md': 'markdown',
            'tex': 'latex',
            'dockerfile': 'dockerfile'
        };

        return languageMap[extension] || 'text';
    }

    /**
     * Generate summary of diff changes
     */
    generateDiffSummary(files) {
        const summary = {
            totalFiles: files.length,
            addedFiles: 0,
            deletedFiles: 0,
            modifiedFiles: 0,
            renamedFiles: 0,
            totalAdditions: 0,
            totalDeletions: 0,
            languages: new Set(),
            filesByType: {}
        };

        files.forEach(file => {
            // Count file types
            switch (file.type) {
                case 'added':
                    summary.addedFiles++;
                    break;
                case 'deleted':
                    summary.deletedFiles++;
                    break;
                case 'renamed':
                    summary.renamedFiles++;
                    break;
                default:
                    summary.modifiedFiles++;
            }

            // Count changes
            if (file.changes) {
                if (typeof file.changes.additions === 'number') {
                    summary.totalAdditions += file.changes.additions;
                }
                if (typeof file.changes.deletions === 'number') {
                    summary.totalDeletions += file.changes.deletions;
                }
            }

            // Track languages
            if (file.language && file.language !== 'text') {
                summary.languages.add(file.language);
            }

            // Group by file type
            const lang = file.language || 'text';
            summary.filesByType[lang] = (summary.filesByType[lang] || 0) + 1;
        });

        summary.languages = Array.from(summary.languages);

        return summary;
    }

    /**
     * Enhance parsed diff with additional context
     */
    async enhanceWithContext(parsedDiff, platform) {
        // Add repository information if available
        parsedDiff.repository = this.extractRepositoryInfo(platform);
        
        // Add commit information if available
        parsedDiff.commit = this.extractCommitInfo(platform);
        
        // Add PR/MR information if available
        parsedDiff.pullRequest = this.extractPullRequestInfo(platform);

        return parsedDiff;
    }

    /**
     * Extract repository information from current page
     */
    extractRepositoryInfo(platform) {
        const url = window.location.href;
        
        switch (platform) {
            case 'github': {
                const githubMatch = url.match(/github\.com\/([^/]+)\/([^/]+)/);
                return githubMatch ? {
                    owner: githubMatch[1],
                    name: githubMatch[2],
                    url: `https://github.com/${githubMatch[1]}/${githubMatch[2]}`
                } : null;
            }
                
            case 'gitlab': {
                const gitlabMatch = url.match(/gitlab\.com\/([^/]+)\/([^/]+)/);
                return gitlabMatch ? {
                    owner: gitlabMatch[1],
                    name: gitlabMatch[2],
                    url: `https://gitlab.com/${gitlabMatch[1]}/${gitlabMatch[2]}`
                } : null;
            }
                
            case 'bitbucket': {
                const bitbucketMatch = url.match(/bitbucket\.org\/([^/]+)\/([^/]+)/);
                return bitbucketMatch ? {
                    owner: bitbucketMatch[1],
                    name: bitbucketMatch[2],
                    url: `https://bitbucket.org/${bitbucketMatch[1]}/${bitbucketMatch[2]}`
                } : null;
            }
                
            default:
                return null;
        }
    }

    /**
     * Extract commit information from current page
     */
    extractCommitInfo(platform) {
        const url = window.location.href;
        
        switch (platform) {
            case 'github': {
                const commitMatch = url.match(/\/commit\/([a-f0-9]+)/);
                return commitMatch ? { hash: commitMatch[1] } : null;
            }
                
            case 'gitlab': {
                const gitlabCommitMatch = url.match(/\/-\/commit\/([a-f0-9]+)/);
                return gitlabCommitMatch ? { hash: gitlabCommitMatch[1] } : null;
            }
                
            default:
                return null;
        }
    }

    /**
     * Extract pull request information from current page
     */
    extractPullRequestInfo(platform) {
        const url = window.location.href;
        
        switch (platform) {
            case 'github': {
                const prMatch = url.match(/\/pull\/(\d+)/);
                return prMatch ? { number: parseInt(prMatch[1]) } : null;
            }
                
            case 'gitlab': {
                const mrMatch = url.match(/\/-\/merge_requests\/(\d+)/);
                return mrMatch ? { number: parseInt(mrMatch[1]) } : null;
            }
                
            case 'bitbucket': {
                const pullMatch = url.match(/\/pull-requests\/(\d+)/);
                return pullMatch ? { number: parseInt(pullMatch[1]) } : null;
            }
                
            default:
                return null;
        }
    }

    /**
     * Extract metadata from diff content
     */
    extractMetadata(content, platform) {
        return {
            platform,
            extractedAt: new Date().toISOString(),
            contentLength: content.length,
            lineCount: content.split('\n').length,
            encoding: 'utf-8'
        };
    }

    /**
     * Get most relevant changed code for test generation
     */
    getRelevantChanges(parsedDiff, options = {}) {
        const {
            includeContext = true,
            maxLines = 1000,
            preferAdditions = true,
            languageFilter = null
        } = options;

        let relevantChanges = [];

        parsedDiff.files.forEach(file => {
            // Filter by language if specified
            if (languageFilter && file.language !== languageFilter) {
                return;
            }

            // Skip binary files
            if (file.type === 'binary') {
                return;
            }

            file.hunks?.forEach(hunk => {
                hunk.lines.forEach(line => {
                    // Include additions, deletions, and optionally context
                    if (line.type === 'added' || 
                        line.type === 'deleted' || 
                        (includeContext && line.type === 'context')) {
                        
                        relevantChanges.push({
                            file: file.newPath || file.oldPath,
                            language: file.language,
                            type: line.type,
                            content: line.content,
                            lineNumber: line.number
                        });
                    }
                });
            });
        });

        // Sort by preference (additions first if preferAdditions is true)
        if (preferAdditions) {
            relevantChanges.sort((a, b) => {
                if (a.type === 'added' && b.type !== 'added') return -1;
                if (a.type !== 'added' && b.type === 'added') return 1;
                return 0;
            });
        }

        // Limit the number of lines
        if (relevantChanges.length > maxLines) {
            relevantChanges = relevantChanges.slice(0, maxLines);
        }

        return relevantChanges;
    }
} 