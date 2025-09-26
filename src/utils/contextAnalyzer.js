// Context analyzer for smart test generation

class ContextAnalyzer {
    constructor() {
        this.cache = new Map();
        this.rateLimiter = new RateLimiter();
        this.MAX_CONTEXT_TOKENS = 4000; // Reserve tokens for context
        this.MAX_FILES_TO_ANALYZE = 10; // Limit for performance
    }

    /**
     * Analyze code and gather smart context
     * @param {string} code - The main code to test
     * @param {object} options - Analysis options
     * @returns {object} Enhanced context for test generation
     */
    async analyzeWithContext(code, options = {}) {
        const {
            url = window.location.href,
            platform = this.detectPlatform(url),
            level = 'smart' // 'minimal', 'smart', 'full'
        } = options;

        // Ensure we have a valid URL
        if (!url) {
            console.warn('No URL provided for context analysis, using minimal context');
            return {
                code,
                language: this.detectLanguage(code),
                imports: this.extractImports(code),
                exports: this.extractExports(code),
                dependencies: [],
                testingFramework: null,
                projectPatterns: {},
                tokenCount: this.estimateTokens(code)
            };
        }

        // Start with basic analysis
        const context = {
            code,
            language: this.detectLanguage(code),
            imports: this.extractImports(code),
            exports: this.extractExports(code),
            dependencies: [],
            testingFramework: null,
            projectPatterns: {},
            tokenCount: this.estimateTokens(code)
        };

        // Return minimal context if requested
        if (level === 'minimal') {
            return context;
        }

        // Try to get repository context based on platform
        if (platform === 'github') {
            await this.enhanceWithGitHubContext(context, url, level);
        } else if (platform === 'gitlab') {
            await this.enhanceWithGitLabContext(context, url, level);
        } else if (platform === 'bitbucket') {
            await this.enhanceWithBitbucketContext(context, url, level);
        } else if (platform === 'azure') {
            await this.enhanceWithAzureContext(context, url, level);
        } else if (platform === 'codeberg') {
            await this.enhanceWithCodebergContext(context, url, level);
        } else if (platform === 'gitea') {
            await this.enhanceWithGiteaContext(context, url, level);
        }

        // Smart token management
        this.optimizeContext(context);

        return context;
    }

    /**
     * Detect platform from URL using enhanced patterns
     */
    detectPlatform(url) {
        // Add null/undefined check for url
        if (!url || typeof url !== 'string') {
            return 'unknown';
        }
        
        if (url.includes('github.com')) return 'github';
        if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab';
        if (url.includes('bitbucket.org')) return 'bitbucket';
        if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) return 'azure';
        if (url.includes('sourceforge.net')) return 'sourceforge';
        if (url.includes('codeberg.org')) return 'codeberg';
        if (url.includes('gitea.')) return 'gitea';
        if (url.includes('git.sr.ht')) return 'sourcehut';
        if (url.includes('pagure.io')) return 'pagure';
        return 'unknown';
    }

    /**
     * Detect programming language from code
     */
    detectLanguage(code) {
        const patterns = {
            typescript: /(?:interface|type|enum)\s+\w+|:\s*(?:string|number|boolean|any|void)|<\w+>/,
            javascript: /(?:function|const|let|var|=>|class)\s+\w+|require\(|import\s+/,
            python: /(?:def|class)\s+\w+|import\s+\w+|from\s+\w+\s+import/,
            java: /(?:public|private|protected)\s+(?:class|interface)|package\s+[\w.]+/,
            csharp: /(?:namespace|using)\s+[\w.]+|(?:public|private)\s+class/,
            go: /(?:package|func)\s+\w+|import\s+\(|var\s+\w+\s+=/,
            ruby: /(?:def|class|module)\s+\w+|require\s+['"]|attr_\w+/,
            php: /(?:<\?php|\$\w+|function\s+\w+|class\s+\w+)/
        };

        // Check TypeScript first since it's a superset of JavaScript
        for (const [lang, pattern] of Object.entries(patterns)) {
            if (pattern.test(code)) {
                return lang;
            }
        }

        return 'javascript'; // Default fallback
    }

    /**
     * Extract imports from code
     */
    extractImports(code) {
        // Handle null/undefined code
        if (!code || typeof code !== 'string') {
            return [];
        }

        // JavaScript/TypeScript imports
        const esImports = code.match(/import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g) || [];
        const requireImports = code.match(/require\(['"]([^'"]+)['"]\)/g) || [];

        // Python imports
        const pyImports = code.match(/(?:from\s+([\w.]+)\s+)?import\s+([\w\s,]+)/g) || [];

        // Java imports
        const javaImports = code.match(/import\s+([\w.]+);/g) || [];

        const allImports = [...esImports, ...requireImports, ...pyImports, ...javaImports];
        return allImports
            .map(imp => this.parseImport(imp))
            .filter(Boolean);
    }

    /**
     * Parse import statement
     */
    parseImport(importStatement) {
        // Extract the module/file path
        const match = importStatement.match(/['"]([^'"]+)['"]|import\s+([\w.]+)/);
        if (match) {
            const path = match[1] || match[2];
            return {
                path,
                isRelative: path.startsWith('.'),
                isNodeModule: !path.startsWith('.') && !path.startsWith('/')
            };
        }
        return null;
    }

    /**
     * Extract exports from code
     */
    extractExports(code) {
        if (!code || typeof code !== 'string') {
            return [];
        }

        const exports = [];

        // ES6 exports
        const namedExports = code.match(/export\s+(?:const|let|var|function|class)\s+(\w+)/g) || [];
        const defaultExport = code.match(/export\s+default\s+(\w+)/);
        
        if (defaultExport) {
            exports.push({ name: 'default', type: 'default' });
        }
        
        namedExports.forEach(exp => {
            const match = exp.match(/export\s+(?:const|let|var|function|class)\s+(\w+)/);
            if (match) {
                exports.push({ name: match[1], type: 'named' });
            }
        });

        return exports;
    }

    /**
     * Enhance context with GitHub data
     */
    async enhanceWithGitHubContext(context, url, level) {
        try {
            // Add null/undefined check for url
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithGitHubContext');
                return;
            }
            
            const urlParts = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/blob\/([^/]+)\/(.+))?/);
            if (!urlParts) return;

            const [, owner, repo, branch = 'main', filePath] = urlParts;
            const cacheKey = `${owner}/${repo}`;

            // Set the current file path in context
            context.filePath = filePath;

            // Check cache first
            if (this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (Date.now() - cached.timestamp < 3600000) { // 1 hour cache
                    Object.assign(context, cached.data);
                    return;
                }
            }

            // Rate limit check
            if (!await this.rateLimiter.canMakeRequest()) {
                console.log('GitHub API rate limit reached, using basic context');
                return;
            }

            // For 'smart' level, analyze the current file more deeply
            if (level === 'smart') {
                // Analyze imports to determine what files to fetch
                const relativeImports = context.imports.filter(imp => imp.isRelative);
                
                if (relativeImports.length > 0 && filePath) {
                    const currentDir = filePath.substring(0, filePath.lastIndexOf('/'));
                    
                    // Fetch up to 5 most relevant imported files
                    const filesToFetch = relativeImports
                        .slice(0, 5)
                        .map(imp => this.resolveImportPath(imp.path, currentDir, filePath));
                    
                    context.dependencies = await this.fetchGitHubFiles(
                        owner, 
                        repo, 
                        branch, 
                        filesToFetch.filter(Boolean),
                        context
                    );
                }
                
                // Try to detect testing framework from package.json
                await this.detectTestingFrameworkFromGitHub(context, owner, repo, branch);
            }
            
            // For 'full' level, get broader repository context
            if (level === 'full') {
                try {
                    // Fetch repository structure (lightweight API call)
                    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
                    const treeResponse = await fetch(treeUrl, {
                        headers: this.getGitHubHeaders()
                    });

                    if (treeResponse.ok) {
                        const tree = await treeResponse.json();
                        
                        // Analyze repository structure
                        const analysis = this.analyzeRepoStructure(tree.tree, filePath);
                        
                        // Detect testing framework
                        context.testingFramework = this.detectTestingFramework(analysis);
                        
                        // Detect project patterns
                        context.projectPatterns = this.detectProjectPatterns(analysis);
                        
                        // For full context, also fetch test examples if available
                        if (analysis.testDirs.length > 0 && context.language) {
                            const testExamples = await this.fetchTestExamples(
                                owner, 
                                repo, 
                                branch, 
                                analysis.testDirs[0], 
                                context.language
                            );
                            if (testExamples) {
                                context.testExamples = testExamples;
                            }
                        }
                    }
                } catch (error) {
                    console.error('Failed to fetch repository structure:', error);
                }
                
                // Add detailed logging for full context verification
                if (level === 'full') {
                    console.log('🔍 FULL CONTEXT VERIFICATION - GitHub API Enhancement:');
                    console.log('📁 Repository Structure Analyzed');
                    console.log('🧪 Testing Framework Detected:', context.testingFramework);
                    console.log('🔧 Project Patterns:', context.projectPatterns);
                    console.log('🧩 Test Examples:', context.testExamples ? 'Extracted' : 'None found');
                    
                    // Store verification data for user inspection
                    context.fullContextVerification = {
                        timestamp: new Date().toISOString(),
                        method: 'GitHub API',
                        testingFramework: context.testingFramework,
                        projectPatterns: context.projectPatterns,
                        hasTestExamples: !!context.testExamples,
                        repositoryStructureAnalyzed: true
                    };
                }
            }

            // Cache the enhanced context
            if (context.testingFramework || context.projectPatterns) {
                this.cache.set(cacheKey, {
                    data: {
                        testingFramework: context.testingFramework,
                        projectPatterns: context.projectPatterns,
                        structure: context.structure
                    },
                    timestamp: Date.now()
                });
            }

        } catch (error) {
            console.error('Failed to enhance with GitHub context:', error);
        }
    }

    /**
     * Analyze repository structure
     */
    analyzeRepoStructure(tree, currentFilePath) {
        const analysis = {
            testDirs: [],
            configFiles: [],
            totalFiles: tree.length,
            fileTypes: {},
            possibleDependencies: []
        };

        const currentDir = currentFilePath ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/')) : '';

        tree.forEach(item => {
            if (item.type !== 'blob') return;

            const path = item.path;
            const ext = path.substring(path.lastIndexOf('.') + 1);
            
            // Count file types
            analysis.fileTypes[ext] = (analysis.fileTypes[ext] || 0) + 1;

            // Identify test directories
            if (path.includes('test') || path.includes('spec') || path.includes('__tests__')) {
                const dir = path.substring(0, path.lastIndexOf('/'));
                if (!analysis.testDirs.includes(dir)) {
                    analysis.testDirs.push(dir);
                }
            }

            // Identify config files
            if (path.match(/^(package\.json|tsconfig\.json|jest\.config\.|\.eslintrc|babel\.config\.)/)) {
                analysis.configFiles.push(path);
            }

            // Find files in the same directory (likely dependencies)
            if (currentDir && path.startsWith(currentDir) && path !== currentFilePath) {
                analysis.possibleDependencies.push(path);
            }
        });

        return analysis;
    }

    /**
     * Fetch imported files intelligently
     */
    async fetchImportedFiles(context, owner, repo, branch, analysis) {
        const filesToFetch = [];
        const currentDir = context.filePath ? context.filePath.substring(0, context.filePath.lastIndexOf('/')) : '';

        // Prioritize relative imports
        for (const imp of context.imports) {
            if (imp.isRelative && filesToFetch.length < 5) { // Limit to 5 files
                const possiblePaths = this.resolvePossiblePaths(imp.path, currentDir, analysis);
                if (possiblePaths.length > 0) {
                    filesToFetch.push(possiblePaths[0]);
                }
            }
        }

        // Fetch files in parallel with token limit
        const fetchPromises = filesToFetch.map(async (path) => {
            if (!await this.rateLimiter.canMakeRequest()) return null;

            try {
                const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
                const response = await fetch(fileUrl, {
                    headers: this.getGitHubHeaders()
                });

                if (!response.ok) return null;

                const data = await response.json();
                const content = atob(data.content);
                
                // Only include if it doesn't exceed token limit
                const tokens = this.estimateTokens(content);
                if (context.tokenCount + tokens < this.MAX_CONTEXT_TOKENS) {
                    context.tokenCount += tokens;
                    return {
                        path,
                        content: this.extractRelevantParts(content, context.language)
                    };
                }
            } catch (error) {
                console.error(`Failed to fetch ${path}:`, error);
            }
            return null;
        });

        const fetchedFiles = await Promise.all(fetchPromises);
        context.dependencies = fetchedFiles.filter(Boolean);
    }

    /**
     * Extract only relevant parts of code to save tokens
     */
    extractRelevantParts(code, language) {
        const lines = code.split('\n');
        const relevantParts = [];
        let inRelevantBlock = false;
        let blockLines = [];

        const relevantPatterns = {
            javascript: /(?:export|class|function|const|interface|type)\s+\w+/,
            python: /(?:def|class)\s+\w+/,
            java: /(?:public|protected)\s+(?:class|interface|enum)\s+\w+/
        };

        const pattern = relevantPatterns[language] || relevantPatterns.javascript;

        lines.forEach((line, index) => {
            if (pattern.test(line)) {
                inRelevantBlock = true;
                blockLines = [line];
            } else if (inRelevantBlock) {
                blockLines.push(line);
                
                // End block on empty line or closing brace at start of line
                if (line.trim() === '' || line.match(/^[}\]]/)) {
                    relevantParts.push({
                        startLine: index - blockLines.length + 1,
                        code: blockLines.join('\n')
                    });
                    inRelevantBlock = false;
                    blockLines = [];
                }
            }
        });

        // Return only the most important parts
        return relevantParts
            .slice(0, 5) // Limit to 5 most relevant blocks
            .map(part => part.code)
            .join('\n\n// ...\n\n');
    }

    /**
     * Detect testing framework from repository
     */
    detectTestingFramework(analysis) {
        // Check config files
        for (const configFile of analysis.configFiles) {
            if (configFile.includes('jest')) return 'jest';
            if (configFile.includes('mocha')) return 'mocha';
            if (configFile.includes('vitest')) return 'vitest';
            if (configFile.includes('pytest')) return 'pytest';
            if (configFile.includes('phpunit')) return 'phpunit';
        }

        // Check test directories
        for (const testDir of analysis.testDirs) {
            if (testDir.includes('jest')) return 'jest';
            if (testDir.includes('mocha')) return 'mocha';
            if (testDir.includes('spec')) return 'rspec';
        }

        // Check file types
        if (analysis.fileTypes['.test.js'] || analysis.fileTypes['.test.ts']) return 'jest';
        if (analysis.fileTypes['.spec.js'] || analysis.fileTypes['.spec.ts']) return 'jest';
        if (analysis.fileTypes['_test.py']) return 'pytest';
        if (analysis.fileTypes['Test.java']) return 'junit';

        return null;
    }

    /**
     * Detect project patterns
     */
    detectProjectPatterns(analysis) {
        const patterns = {
            hasTypeScript: !!(analysis.fileTypes['ts'] || analysis.fileTypes['tsx']),
            hasReact: !!(analysis.fileTypes['jsx'] || analysis.fileTypes['tsx']),
            hasTests: analysis.testDirs.length > 0,
            testLocation: analysis.testDirs[0] || null,
            projectType: this.inferProjectType(analysis)
        };

        return patterns;
    }

    /**
     * Infer project type from structure
     */
    inferProjectType(analysis) {
        if (analysis.configFiles.some(f => f.includes('package.json'))) {
            if (analysis.fileTypes['jsx'] || analysis.fileTypes['tsx']) return 'react';
            if (analysis.configFiles.some(f => f.includes('angular.json'))) return 'angular';
            if (analysis.configFiles.some(f => f.includes('vue.config'))) return 'vue';
            return 'node';
        }
        if (analysis.fileTypes['py'] > 10) return 'python';
        if (analysis.fileTypes['java'] > 10) return 'java';
        if (analysis.fileTypes['cs'] > 10) return 'csharp';
        return 'unknown';
    }

    /**
     * Estimate token count
     */
    estimateTokens(text) {
        if (!text || typeof text !== 'string') {
            return 0;
        }
        // Rough estimation: 1 token ≈ 4 characters
        return Math.ceil(text.length / 4);
    }

    /**
     * Optimize context to fit within token limits
     */
    optimizeContext(context) {
        if (context.tokenCount > this.MAX_CONTEXT_TOKENS) {
            // Remove least important dependencies
            while (context.tokenCount > this.MAX_CONTEXT_TOKENS && context.dependencies.length > 0) {
                const removed = context.dependencies.pop();
                context.tokenCount -= this.estimateTokens(removed.content);
            }
        }
    }

    /**
     * Resolve possible file paths for imports
     */
    resolvePossiblePaths(importPath, currentDir, analysis) {
        const possibleExtensions = ['.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
        const basePath = currentDir ? `${currentDir}/${importPath}` : importPath;
        
        const paths = [];
        
        // Try exact path first
        paths.push(basePath);
        
        // Try with extensions
        possibleExtensions.forEach(ext => {
            paths.push(basePath + ext);
        });

        // Filter to only paths that exist in the repo
        return paths.filter(path => 
            analysis.possibleDependencies.some(dep => dep === path || dep.startsWith(path))
        );
    }

    /**
     * Get GitHub API headers
     */
    getGitHubHeaders() {
        // In a real implementation, you might want to use a GitHub token
        // stored securely in the extension settings
        return {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'RepoSpector-Extension'
        };
    }

    /**
     * Enhance context with GitLab data
     */
    async enhanceWithGitLabContext(context, url, level) {
        try {
            // Add null/undefined check for url
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithGitLabContext');
                return;
            }
            
            // Check if we have a GitLab token stored for API-based enhancement
            let gitlabToken = null;
            try {
                const result = await chrome.storage.local.get(['gitlabToken']);
                if (result.gitlabToken) {
                    // Token is base64 encoded, decode it
                    gitlabToken = atob(result.gitlabToken);
                }
            } catch (error) {
                console.warn('Could not retrieve GitLab token:', error);
            }
            
            // If we have a token and full context is requested, use API-based enhancement
            if (gitlabToken && level === 'full') {
                console.log('Using GitLab API for full context enhancement');
                return await this.enhanceWithGitLabContextAPI(context, url, level, gitlabToken);
            }
            
            // Updated regex to handle more GitLab URL patterns including blob, merge requests, tree, etc.
            const urlParts = url.match(/gitlab\.com\/([^/]+\/[^/]+)(?:\/-\/(?:blob|tree|merge_requests|issues|commits)\/([^/]+)\/?(.*?))?(?:\?.*)?$/);
            if (!urlParts) {
                console.warn('GitLab URL pattern not recognized:', url);
                return;
            }

            const [, projectPath, branch, filePath] = urlParts;
            const cacheKey = projectPath;

            // Set the current file path in context
            if (filePath) {
                context.filePath = filePath;
                // Extract directory path for repository navigation
                const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
                context.currentDirectory = dirPath;
                
                // For smart level, try to get some repository context
                if (level === 'smart') {
                    await this.extractRepositoryContextFromPath(context, projectPath, branch || 'master', dirPath);
                }
            }

            // Check cache first
            if (this.cache.has(cacheKey)) {
                const cached = this.cache.get(cacheKey);
                if (Date.now() - cached.timestamp < 3600000) { // 1 hour cache
                    Object.assign(context, cached.data);
                    return;
                }
            }

            // Rate limit check
            if (!await this.rateLimiter.canMakeRequest()) {
                // Rate limit reached, using basic context
                return;
            }

            // Try to extract project info from the page itself
            const projectInfo = this.extractGitLabProjectInfo();
            
            if (projectInfo) {
                context.testingFramework = this.detectTestingFrameworkFromPage(projectInfo);
                context.projectPatterns = this.detectProjectPatternsFromPage(projectInfo);
                
                // For smart and full levels, extract more comprehensive context
                if (level === 'smart' || level === 'full') {
                    context.repositoryStructure = {
                        projectPath,
                        branch: branch || 'master',
                        currentPath: filePath || '',
                        discoveredFiles: projectInfo.files || [],
                        languages: projectInfo.languages || []
                    };
                }
            }

            // If we have a token but not full level, still try to get basic API info
            if (gitlabToken && level === 'smart') {
                try {
                    console.log('Using GitLab API for smart context enhancement');
                    const projectId = encodeURIComponent(projectPath);
                    
                    // Get basic project information
                    const projectResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectId}`, {
                        headers: {
                            'Authorization': `Bearer ${gitlabToken}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (projectResponse.ok) {
                        const projectInfo = await projectResponse.json();
                        context.repositoryInfo = {
                            name: projectInfo.name,
                            description: projectInfo.description,
                            defaultBranch: projectInfo.default_branch,
                            topics: projectInfo.topics || [],
                            visibility: projectInfo.visibility
                        };
                    }
                } catch (apiError) {
                    console.warn('GitLab API request failed for smart context:', apiError);
                }
            }

            // Cache the enhanced context
            if (context.testingFramework || context.projectPatterns || context.repositoryInfo) {
                this.cache.set(cacheKey, {
                    data: {
                        testingFramework: context.testingFramework,
                        projectPatterns: context.projectPatterns,
                        repositoryInfo: context.repositoryInfo,
                        filePath: context.filePath,
                        currentDirectory: context.currentDirectory,
                        repositoryStructure: context.repositoryStructure
                    },
                    timestamp: Date.now()
                });
            }

        } catch (error) {
            console.error('Failed to enhance with GitLab context:', error);
        }
    }

    /**
     * Extract repository context by navigating up the directory structure
     */
    async extractRepositoryContextFromPath(context, projectPath, branch, currentPath) {
        try {
            // Start from current directory and work backwards to find relevant context
            const pathSegments = currentPath.split('/').filter(Boolean);
            const contextPaths = [];
            
            // Generate paths going up the directory tree
            for (let i = pathSegments.length; i >= 0; i--) {
                const path = pathSegments.slice(0, i).join('/');
                contextPaths.push(path);
            }
            
            // Look for important files at each level
            const _importantFiles = [
                'package.json',
                'tsconfig.json',
                'jest.config.js',
                'jest.config.ts',
                'vitest.config.js',
                'vitest.config.ts',
                'cypress.config.js',
                'playwright.config.js',
                'README.md',
                '.gitignore',
                'yarn.lock',
                'package-lock.json'
            ];
            
            context.repositoryStructure = {
                projectPath,
                branch,
                currentPath,
                discoveredFiles: [],
                configFiles: [],
                testDirectories: []
            };
            
            // For now, we'll extract what we can from the current page
            // In a full implementation, we'd make API calls to GitLab to fetch these files
            this.extractVisibleRepositoryInfo(context);
            
        } catch (error) {
            console.error('Error extracting repository context from path:', error);
        }
    }

    /**
     * Extract visible repository information from the current GitLab page
     */
    extractVisibleRepositoryInfo(context) {
        try {
            // Look for breadcrumb navigation to understand repository structure
            const breadcrumbs = document.querySelectorAll('.breadcrumb-item, .breadcrumb-link');
            if (breadcrumbs.length > 0) {
                const breadcrumbPaths = Array.from(breadcrumbs)
                    .map(el => el.textContent?.trim())
                    .filter(Boolean);
                context.repositoryStructure.breadcrumbs = breadcrumbPaths;
            }
            
            // Look for file tree in sidebar or main content
            const fileTreeItems = document.querySelectorAll(
                '.tree-item-file-name, .file-row-name, .tree-item .str-truncated, [data-testid="file-tree-item"]'
            );
            
            if (fileTreeItems.length > 0) {
                const visibleFiles = Array.from(fileTreeItems)
                    .map(el => el.textContent?.trim())
                    .filter(Boolean)
                    .slice(0, 20); // Limit to avoid too much data
                
                context.repositoryStructure.discoveredFiles = visibleFiles;
                
                // Identify config and test files
                context.repositoryStructure.configFiles = visibleFiles.filter(file => 
                    file.includes('config') || file.includes('package.json') || file.includes('tsconfig')
                );
                
                context.repositoryStructure.testDirectories = visibleFiles.filter(file =>
                    file.includes('test') || file.includes('spec') || file.includes('__tests__')
                );
            }
            
            // Look for language information
            const languageStats = document.querySelectorAll('.language-color, [data-testid="repository-language"]');
            if (languageStats.length > 0) {
                const languages = Array.from(languageStats)
                    .map(el => el.getAttribute('data-language') || el.textContent?.trim())
                    .filter(Boolean);
                context.repositoryStructure.languages = languages;
            }
            
        } catch (error) {
            console.error('Error extracting visible repository info:', error);
        }
    }

    /**
     * Extract GitLab project info from the page
     */
    extractGitLabProjectInfo() {
        try {
            // Look for file tree or project files
            const fileTreeItems = document.querySelectorAll('.tree-item');
            const files = Array.from(fileTreeItems).map(item => {
                const link = item.querySelector('a');
                return link ? link.textContent.trim() : '';
            }).filter(Boolean);

            // Look for language stats
            const languageBar = document.querySelector('.repository-language-bar');
            const languages = [];
            if (languageBar) {
                const languageItems = languageBar.querySelectorAll('[data-qa-selector="repository-language"]');
                languageItems.forEach(item => {
                    const lang = item.getAttribute('data-qa-language');
                    if (lang) languages.push(lang.toLowerCase());
                });
            }

            return { files, languages };
        } catch (error) {
            console.error('Error extracting GitLab project info:', error);
            return null;
        }
    }

    /**
     * Detect testing framework from page info
     */
    detectTestingFrameworkFromPage(projectInfo) {
        if (!projectInfo || !projectInfo.files) return null;

        const { files } = projectInfo;
        
        // Check for common test config files
        if (files.some(f => f.includes('jest.config'))) return 'jest';
        if (files.some(f => f.includes('mocha.opts') || f === '.mocharc.js')) return 'mocha';
        if (files.some(f => f.includes('vitest.config'))) return 'vitest';
        if (files.some(f => f.includes('pytest.ini') || f === 'setup.cfg')) return 'pytest';
        if (files.some(f => f.includes('phpunit.xml'))) return 'phpunit';
        
        // Check for test directories
        if (files.some(f => f.includes('__tests__'))) return 'jest';
        if (files.some(f => f.includes('spec/') && projectInfo.languages?.includes('ruby'))) return 'rspec';
        
        return null;
    }

    /**
     * Detect project patterns from page info
     */
    detectProjectPatternsFromPage(projectInfo) {
        if (!projectInfo) return {};

        const { files, languages } = projectInfo;
        
        return {
            hasTypeScript: files.some(f => f.endsWith('.ts') || f.endsWith('.tsx')),
            hasReact: files.some(f => f.endsWith('.jsx') || f.endsWith('.tsx')),
            hasTests: files.some(f => f.includes('test') || f.includes('spec')),
            projectType: this.inferProjectTypeFromFiles(files, languages)
        };
    }

    /**
     * Infer project type from files
     */
    inferProjectTypeFromFiles(files, languages) {
        if (files.some(f => f === 'package.json')) {
            if (files.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'))) return 'react';
            if (files.some(f => f === 'angular.json')) return 'angular';
            if (files.some(f => f === 'vue.config.js')) return 'vue';
            return 'node';
        }
        
        if (languages?.includes('python')) return 'python';
        if (languages?.includes('java')) return 'java';
        if (languages?.includes('c#')) return 'csharp';
        if (languages?.includes('ruby')) return 'ruby';
        if (languages?.includes('go')) return 'go';
        
        return 'unknown';
    }

    /**
     * Resolve import path relative to current file
     */
    resolveImportPath(importPath, currentDir, _currentFile) {
        // Remove quotes if present
        importPath = importPath.replace(/['"]/g, '');
        
        // Handle different import patterns
        if (importPath.startsWith('./')) {
            importPath = importPath.substring(2);
        } else if (importPath.startsWith('../')) {
            // Handle parent directory imports
            const parts = currentDir.split('/');
            while (importPath.startsWith('../')) {
                parts.pop();
                importPath = importPath.substring(3);
            }
            currentDir = parts.join('/');
        }
        
        // Construct the full path
        const basePath = currentDir ? `${currentDir}/${importPath}` : importPath;
        
        // Try common extensions
        const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
        const possiblePaths = [
            basePath,
            `${basePath}/index`,
            ...extensions.map(ext => basePath + ext),
            ...extensions.map(ext => `${basePath}/index${ext}`)
        ];
        
        // Return the most likely path (without extension checking since we can't access the file system)
        return possiblePaths[0];
    }
    
    /**
     * Fetch files from GitHub
     */
    async fetchGitHubFiles(owner, repo, branch, filePaths, context) {
        const fetchedFiles = [];
        
        for (const filePath of filePaths.slice(0, 5)) { // Limit to 5 files
            if (!await this.rateLimiter.canMakeRequest()) break;
            
            try {
                const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
                const response = await fetch(fileUrl, {
                    headers: this.getGitHubHeaders()
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.content) {
                        const content = atob(data.content);
                        
                        // Only include if it doesn't exceed token limit
                        const tokens = this.estimateTokens(content);
                        if (context.tokenCount + tokens < this.MAX_CONTEXT_TOKENS) {
                            context.tokenCount += tokens;
                            fetchedFiles.push({
                                path: filePath,
                                content: this.extractRelevantParts(content, context.language)
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(`Failed to fetch ${filePath}:`, error);
            }
        }
        
        return fetchedFiles;
    }
    
    /**
     * Detect testing framework from package.json
     */
    async detectTestingFrameworkFromGitHub(context, owner, repo, branch) {
        try {
            const packageUrl = `https://api.github.com/repos/${owner}/${repo}/contents/package.json?ref=${branch}`;
            const response = await fetch(packageUrl, {
                headers: this.getGitHubHeaders()
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.content) {
                    const packageJson = JSON.parse(atob(data.content));
                    
                    // Check dependencies for testing frameworks
                    const allDeps = {
                        ...packageJson.dependencies,
                        ...packageJson.devDependencies
                    };
                    
                    if (allDeps.jest || allDeps['@jest/core']) {
                        context.testingFramework = 'jest';
                    } else if (allDeps.mocha) {
                        context.testingFramework = 'mocha';
                    } else if (allDeps.vitest) {
                        context.testingFramework = 'vitest';
                    } else if (allDeps['@testing-library/react']) {
                        context.testingFramework = 'jest'; // React Testing Library usually uses Jest
                    } else if (allDeps.jasmine) {
                        context.testingFramework = 'jasmine';
                    }
                    
                    // Also check test script
                    if (!context.testingFramework && packageJson.scripts?.test) {
                        const testScript = packageJson.scripts.test;
                        if (testScript.includes('jest')) context.testingFramework = 'jest';
                        else if (testScript.includes('mocha')) context.testingFramework = 'mocha';
                        else if (testScript.includes('vitest')) context.testingFramework = 'vitest';
                    }
                }
            }
        } catch (error) {
            console.error('Failed to detect testing framework from package.json:', error);
        }
    }
    
    /**
     * Fetch test examples from the repository
     */
    async fetchTestExamples(owner, repo, branch, testDir, language) {
        try {
            const testDirUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${testDir}?ref=${branch}`;
            const response = await fetch(testDirUrl, {
                headers: this.getGitHubHeaders()
            });
            
            if (!response.ok) return null;
            
            const files = await response.json();
            
            // Find test files matching the language
            const testFilePatterns = {
                javascript: /\.(test|spec)\.(js|jsx)$/,
                typescript: /\.(test|spec)\.(ts|tsx)$/,
                python: /_test\.py$|test_.*\.py$/,
                java: /Test\.java$/,
                csharp: /Tests?\.cs$/
            };
            
            const pattern = testFilePatterns[language] || testFilePatterns.javascript;
            const testFiles = files.filter(file => 
                file.type === 'file' && pattern.test(file.name)
            ).slice(0, 2); // Get up to 2 test examples
            
            if (testFiles.length === 0) return null;
            
            // Fetch one test file as an example
            const exampleUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${testFiles[0].path}?ref=${branch}`;
            const exampleResponse = await fetch(exampleUrl, {
                headers: this.getGitHubHeaders()
            });
            
            if (exampleResponse.ok) {
                const data = await exampleResponse.json();
                if (data.content) {
                    const content = atob(data.content);
                    return {
                        path: testFiles[0].path,
                        content: this.extractRelevantParts(content, language),
                        framework: this.detectTestingFrameworkFromCode(content)
                    };
                }
            }
        } catch (error) {
            console.error('Failed to fetch test examples:', error);
        }
        
        return null;
    }
    
    /**
     * Detect testing framework from code content
     */
    detectTestingFrameworkFromCode(code) {
        if (code.includes('describe(') && code.includes('it(')) return 'jest/mocha';
        if (code.includes('test(') && code.includes('expect(')) return 'jest';
        if (code.includes('@Test')) return 'junit';
        if (code.includes('def test_')) return 'pytest';
        if (code.includes('[Test]')) return 'nunit';
        return null;
    }

    /**
     * Enhance context with Bitbucket data
     */
    async enhanceWithBitbucketContext(context, url, _level) {
        try {
            // Add null/undefined check for url
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithBitbucketContext');
                return;
            }
            
            // Basic implementation for Bitbucket
            const urlParts = url.match(/bitbucket\.org\/([^/]+)\/([^/]+)(?:\/src\/([^/]+)\/(.+))?/);
            if (!urlParts) return;

            const [, owner, repo, branch = 'main', filePath] = urlParts;
            context.filePath = filePath;
            context.repository = { owner, repo, branch };
            
            // For now, just set basic context - can be enhanced with API calls later
            context.platform = 'bitbucket';
        } catch (error) {
            console.error('Failed to enhance with Bitbucket context:', error);
        }
    }

    /**
     * Enhance context with Azure DevOps data
     */
    async enhanceWithAzureContext(context, url, _level) {
        try {
            // Add null/undefined check for url
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithAzureContext');
                return;
            }
            
            // Basic implementation for Azure DevOps
            const urlParts = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/);
            if (!urlParts) return;

            const [, organization, project, repo] = urlParts;
            context.repository = { organization, project, repo };
            context.platform = 'azure';
        } catch (error) {
            console.error('Failed to enhance with Azure context:', error);
        }
    }

    /**
     * Enhance context with Codeberg data
     */
    async enhanceWithCodebergContext(context, url, _level) {
        try {
            // Add null/undefined check for url
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithCodebergContext');
                return;
            }
            
            // Basic implementation for Codeberg (Gitea-based)
            const urlParts = url.match(/codeberg\.org\/([^/]+)\/([^/]+)(?:\/src\/branch\/([^/]+)\/(.+))?/);
            if (!urlParts) return;

            const [, owner, repo, branch = 'main', filePath] = urlParts;
            context.filePath = filePath;
            context.repository = { owner, repo, branch };
            context.platform = 'codeberg';
        } catch (error) {
            console.error('Failed to enhance with Codeberg context:', error);
        }
    }

    /**
     * Enhance context with Gitea data
     */
    async enhanceWithGiteaContext(context, url, _level) {
        try {
            // Add null/undefined check for url
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithGiteaContext');
                return;
            }
            
            // Basic implementation for Gitea instances
            const urlParts = url.match(/\/([^/]+)\/([^/]+)(?:\/src\/branch\/([^/]+)\/(.+))?/);
            if (!urlParts) return;

            const [, owner, repo, branch = 'main', filePath] = urlParts;
            context.filePath = filePath;
            context.repository = { owner, repo, branch };
            context.platform = 'gitea';
        } catch (error) {
            console.error('Failed to enhance with Gitea context:', error);
        }
    }

    /**
     * Enhanced GitLab context with API support
     */
    async enhanceWithGitLabContextAPI(context, url, level, token) {
        try {
            if (!url) {
                console.warn('URL is null or undefined in enhanceWithGitLabContextAPI');
                return;
            }
            
            const urlParts = url.match(/gitlab\.com\/([^/]+\/[^/]+)(?:\/-\/(?:blob|tree|merge_requests|issues|commits)\/([^/]+)\/?(.*?))?(?:\?.*)?$/);
            if (!urlParts) {
                console.warn('GitLab URL pattern not recognized:', url);
                return;
            }

            const [, projectPath, branch, filePath] = urlParts;
            const projectId = encodeURIComponent(projectPath);
            
            if (!token) {
                console.log('No GitLab token provided, falling back to web scraping method');
                return await this.enhanceWithGitLabContext(context, url, level);
            }

            try {
                // Test token validity first
                const testResponse = await fetch(`https://gitlab.com/api/v4/user`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (!testResponse.ok) {
                    console.warn('GitLab token is invalid, falling back to web scraping');
                    return await this.enhanceWithGitLabContext(context, url, level);
                }

                // Get project information
                const projectResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectId}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (projectResponse.ok) {
                    const projectInfo = await projectResponse.json();
                    context.repositoryInfo = {
                        name: projectInfo.name,
                        description: projectInfo.description,
                        language: projectInfo.default_branch,
                        topics: projectInfo.topics || [],
                        visibility: projectInfo.visibility
                    };
                }

                // Get repository tree
                const treeResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/repository/tree?recursive=true&per_page=100`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (treeResponse.ok) {
                    const treeData = await treeResponse.json();
                    
                    // Extract important files
                    const importantFiles = treeData.filter(item => 
                        item.type === 'blob' && (
                            item.name === 'package.json' ||
                            item.name === 'tsconfig.json' ||
                            item.name.includes('jest.config') ||
                            item.name.includes('cypress.config') ||
                            item.name.includes('playwright.config') ||
                            item.path.includes('test') ||
                            item.path.includes('spec') ||
                            item.path.includes('__tests__')
                        )
                    );

                    // Fetch content of important files
                    const fileContents = await Promise.all(
                        importantFiles.slice(0, 10).map(async (file) => {
                            try {
                                const fileResponse = await fetch(
                                    `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(file.path)}/raw?ref=${branch || 'main'}`,
                                    {
                                        headers: {
                                            'Authorization': `Bearer ${token}`,
                                            'Content-Type': 'application/json'
                                        }
                                    }
                                );
                                
                                if (fileResponse.ok) {
                                    const content = await fileResponse.text();
                                    return {
                                        path: file.path,
                                        content: content,
                                        type: this.categorizeFile(file.path)
                                    };
                                }
                            } catch (error) {
                                console.warn(`Failed to fetch ${file.path}:`, error);
                            }
                            return null;
                        })
                    );

                    const validFiles = fileContents.filter(Boolean);
                    let testFiles = [];
                    
                    if (validFiles.length > 0) {
                        context.repositoryFiles = validFiles;
                        
                        // Analyze package.json for testing framework
                        const packageJson = validFiles.find(f => f.path === 'package.json');
                        if (packageJson) {
                            try {
                                const packageData = JSON.parse(packageJson.content);
                                context.testingFramework = this.detectTestingFrameworkFromPackage(packageData);
                                context.dependencies = {
                                    dependencies: packageData.dependencies || {},
                                    devDependencies: packageData.devDependencies || {}
                                };
                            } catch (error) {
                                console.warn('Failed to parse package.json:', error);
                            }
                        }

                        // Analyze existing test files
                        testFiles = validFiles.filter(f => f.type === 'test');
                        if (testFiles.length > 0) {
                            context.existingTestPatterns = this.analyzeTestPatterns(testFiles);
                        }
                    }
                
                    // Set current file context
                    if (filePath) {
                        context.filePath = filePath;
                        context.currentDirectory = filePath.substring(0, filePath.lastIndexOf('/'));
                    }

                    console.log('GitLab API enhancement completed successfully');
                    
                    // Add detailed logging for full context verification
                    if (level === 'full') {
                        console.log('🔍 FULL CONTEXT VERIFICATION - GitLab API Enhancement:');
                        console.log('📁 Repository Info:', context.repositoryInfo);
                        console.log('📋 Repository Files Analyzed:', validFiles.length);
                        console.log('🧪 Testing Framework Detected:', context.testingFramework);
                        console.log('📦 Dependencies Found:', Object.keys(context.dependencies?.dependencies || {}).length, 'production,', Object.keys(context.dependencies?.devDependencies || {}).length, 'dev');
                        console.log('🔬 Test Files Analyzed:', testFiles.length);
                        console.log('📄 Config Files:', validFiles.filter(f => f.type === 'config').map(f => f.path));
                        console.log('🧩 Test Patterns:', context.existingTestPatterns ? 'Extracted' : 'None found');
                        
                        // Store verification data for user inspection
                        context.fullContextVerification = {
                            timestamp: new Date().toISOString(),
                            method: 'GitLab API',
                            repositoryFilesCount: validFiles.length,
                            configFilesAnalyzed: validFiles.filter(f => f.type === 'config').map(f => f.path),
                            testFilesAnalyzed: testFiles.map(f => f.path),
                            testingFramework: context.testingFramework,
                            dependenciesCount: {
                                production: Object.keys(context.dependencies?.dependencies || {}).length,
                                development: Object.keys(context.dependencies?.devDependencies || {}).length
                            },
                            hasTestPatterns: !!context.existingTestPatterns,
                            repositoryInfo: !!context.repositoryInfo
                        };
                    }
                }

            } catch (apiError) {
                console.warn('GitLab API request failed, falling back to web scraping:', apiError);
                return await this.enhanceWithGitLabContext(context, url, level);
            }

        } catch (error) {
            console.error('Failed to enhance with GitLab API context:', error);
            // Fallback to regular method
            return await this.enhanceWithGitLabContext(context, url, level);
        }
    }

    /**
     * Categorize file type for better analysis
     */
    categorizeFile(filePath) {
        const path = filePath.toLowerCase();
        
        if (path.includes('test') || path.includes('spec') || path.includes('__tests__')) {
            return 'test';
        }
        if (path.includes('config') || path === 'package.json' || path === 'tsconfig.json') {
            return 'config';
        }
        if (path.endsWith('.md') || path.endsWith('.txt')) {
            return 'documentation';
        }
        if (path.endsWith('.js') || path.endsWith('.ts') || path.endsWith('.jsx') || path.endsWith('.tsx')) {
            return 'code';
        }
        
        return 'other';
    }

    /**
     * Detect testing framework from package.json
     */
    detectTestingFrameworkFromPackage(packageData) {
        const allDeps = {
            ...packageData.dependencies,
            ...packageData.devDependencies
        };

        if (allDeps.jest) return 'jest';
        if (allDeps.vitest) return 'vitest';
        if (allDeps.mocha) return 'mocha';
        if (allDeps.cypress) return 'cypress';
        if (allDeps.playwright) return 'playwright';
        if (allDeps['@testing-library/react']) return 'react-testing-library';
        if (allDeps.enzyme) return 'enzyme';
        
        return null;
    }

    /**
     * Analyze patterns from existing test files
     */
    analyzeTestPatterns(testFiles) {
        const patterns = {
            commonImports: [],
            testStructures: [],
            mockingPatterns: [],
            assertionStyles: []
        };

        testFiles.forEach(file => {
            const content = file.content;
            
            // Extract import patterns
            const imports = content.match(/import .+ from .+/g) || [];
            patterns.commonImports.push(...imports);
            
            // Extract test structures
            if (content.includes('describe(')) patterns.testStructures.push('describe-it');
            if (content.includes('test(')) patterns.testStructures.push('test-function');
            if (content.includes('beforeEach(')) patterns.testStructures.push('beforeEach');
            if (content.includes('afterEach(')) patterns.testStructures.push('afterEach');
            
            // Extract mocking patterns
            if (content.includes('jest.mock(')) patterns.mockingPatterns.push('jest.mock');
            if (content.includes('vi.mock(')) patterns.mockingPatterns.push('vitest.mock');
            if (content.includes('sinon.')) patterns.mockingPatterns.push('sinon');
            
            // Extract assertion styles
            if (content.includes('expect(')) patterns.assertionStyles.push('expect');
            if (content.includes('assert.')) patterns.assertionStyles.push('assert');
            if (content.includes('should.')) patterns.assertionStyles.push('should');
        });

        // Remove duplicates
        Object.keys(patterns).forEach(key => {
            patterns[key] = [...new Set(patterns[key])];
        });

        return patterns;
    }
}

/**
 * Simple rate limiter
 */
class RateLimiter {
    constructor() {
        this.requests = [];
        this.maxRequests = 60; // GitHub's rate limit
        this.windowMs = 3600000; // 1 hour
    }

    async canMakeRequest() {
        const now = Date.now();
        
        // Remove old requests
        this.requests = this.requests.filter(time => now - time < this.windowMs);
        
        if (this.requests.length < this.maxRequests) {
            this.requests.push(now);
            return true;
        }
        
        return false;
    }
}

// Export the ContextAnalyzer class
export { ContextAnalyzer };