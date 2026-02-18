/**
 * GitLabService - Fetch repository files from GitLab API
 */

export class GitLabService {
    constructor(token = null) {
        this.token = token;
        this.baseUrl = 'https://gitlab.com/api/v4';

        // Code file extensions to index (including documentation) - matches GitHubService
        this.codeExtensions = [
            // JavaScript/TypeScript
            'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
            // Python
            'py', 'pyw', 'pyx', 'pyi',
            // Java/JVM
            'java', 'kt', 'scala', 'groovy',
            // Go
            'go',
            // Rust
            'rs',
            // Ruby
            'rb', 'rake',
            // PHP
            'php', 'phtml',
            // C/C++
            'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
            // C#/.NET
            'cs', 'vb', 'fs',
            // Swift
            'swift',
            // Dart
            'dart',
            // Shell scripts
            'sh', 'bash', 'zsh',
            // Config files (useful for context)
            'yaml', 'yml', 'json', 'toml', 'ini',
            // Query languages
            'sql', 'graphql',
            // Web frameworks
            'vue', 'svelte',
            // Documentation (IMPORTANT for context!)
            'md', 'markdown', 'mdx', 'txt', 'rst',
            // Other useful files
            'proto', 'thrift', 'gradle', 'cmake'
        ];

        // File extensions to EXCLUDE (ignore these completely)
        this.excludeExtensions = [
            // Styles
            'css', 'scss', 'sass', 'less', 'styl',
            // Images
            'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'bmp', 'tiff',
            // Media
            'mp4', 'avi', 'mov', 'wmv', 'flv', 'mp3', 'wav', 'ogg',
            // Archives
            'zip', 'tar', 'gz', 'rar', '7z', 'bz2',
            // Databases
            'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
            // Binary/Compiled
            'exe', 'dll', 'so', 'dylib', 'o', 'obj', 'class', 'jar', 'war',
            // Lock files
            'lock', 'lockb',
            // Map files
            'map',
            // Fonts
            'woff', 'woff2', 'ttf', 'eot', 'otf',
            // Other binary/non-code
            'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
        ];

        // Directories to exclude
        this.excludeDirs = [
            'node_modules',
            'vendor',
            'dist',
            'build',
            '.git',
            '.gitlab',
            'coverage',
            '__pycache__',
            '.pytest_cache',
            '.venv',
            'venv',
            'env',
            '.idea',
            '.vscode',
            'target',  // Maven/Rust
            'out',
            'bin'
        ];

        // No hard file cap — extension/directory filters and MAX_FILE_SIZE
        // are the natural limits. All matching code files get indexed.
    }

    /**
     * Parse GitLab URL to extract project path
     * @param {string} url - GitLab URL
     * @returns {{projectPath: string, branch: string} | null}
     */
    parseGitLabUrl(url) {
        // GitLab supports nested groups: gitlab.com/group/subgroup/project
        // We need to match everything before /-/ or end of URL
        console.log('🔍 Parsing GitLab URL:', url);

        const patterns = [
            // With branch (tree or blob): gitlab.com/path/to/project/-/tree/branch or /-/blob/branch
            /gitlab\.com\/(.+?)\/-\/(?:tree|blob)\/([^\/]+)/,
            // Without branch but with /-/: gitlab.com/path/to/project/-/
            /gitlab\.com\/(.+?)\/-\//,
            // Simple format: gitlab.com/path/to/project (no /-/)
            /gitlab\.com\/([^?#]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                let projectPath = match[1].replace(/\.git$/, '').trim();

                // Remove trailing slashes
                projectPath = projectPath.replace(/\/$/, '');

                // If branch not in URL, leave as null to auto-detect default branch
                const branch = match[2] || null;

                console.log('✅ Parsed GitLab URL:', {
                    projectPath,
                    branch: branch || '(will auto-detect)',
                    pattern: pattern.toString()
                });

                return {
                    projectPath: projectPath,
                    branch: branch
                };
            }
        }

        console.warn('❌ Failed to parse GitLab URL');
        return null;
    }

    /**
     * Encode project path for API
     * @param {string} projectPath
     * @returns {string}
     */
    encodeProjectPath(projectPath) {
        return encodeURIComponent(projectPath);
    }

    /**
     * Get repository default branch
     * @param {string} projectPath
     * @returns {Promise<string>}
     */
    async getDefaultBranch(projectPath) {
        const encoded = this.encodeProjectPath(projectPath);
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.token) {
            headers['PRIVATE-TOKEN'] = this.token;
        }

        try {
            const response = await fetch(
                `${this.baseUrl}/projects/${encoded}`,
                { headers }
            );

            if (response.ok) {
                const project = await response.json();
                const defaultBranch = project.default_branch;
                console.log('📌 Repository default branch:', defaultBranch);
                return defaultBranch || 'main';
            }
        } catch (error) {
            console.warn('Failed to fetch default branch, using fallback:', error);
        }

        return 'main';
    }

    /**
     * Fetch repository tree
     * @param {string} projectPath
     * @param {string} branch
     * @returns {Promise<Array>}
     */
    async fetchRepoTree(projectPath, branch = null) {
        // If no branch specified, get the default branch
        if (!branch) {
            branch = await this.getDefaultBranch(projectPath);
        }

        const encoded = this.encodeProjectPath(projectPath);
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.token) {
            headers['PRIVATE-TOKEN'] = this.token;
            console.log('🔑 Using GitLab token:', this.token.substring(0, 10) + '...');
        } else {
            console.warn('⚠️ No GitLab token configured!');
        }

        console.log('📡 Fetching tree for:', { projectPath, branch, encoded });

        try {
            // Paginate to fetch ALL tree entries (GitLab caps per_page at 100 for tree)
            const allItems = [];
            let page = 1;
            const maxPages = 50; // Safety limit: 50 pages × 100 = 5,000 entries

            while (page <= maxPages) {
                const response = await fetch(
                    `${this.baseUrl}/projects/${encoded}/repository/tree?recursive=true&ref=${branch}&per_page=100&page=${page}`,
                    { headers }
                );

                if (!response.ok) {
                    // Try to get detailed error message
                    let errorMessage = `GitLab API error (${response.status}): ${response.statusText}`;
                    try {
                        const errorData = await response.json();
                        if (errorData.message) {
                            errorMessage = `GitLab API error: ${errorData.message}`;
                        } else if (errorData.error) {
                            errorMessage = `GitLab API error: ${errorData.error}`;
                        }
                    } catch (e) {
                        // If JSON parsing fails, use status text
                    }

                    // Add helpful context to error
                    if (response.status === 401) {
                        errorMessage += '\n\n💡 Tip: This might be a private repository. Add your GitLab token in Settings.';
                    } else if (response.status === 404) {
                        errorMessage += '\n\n💡 Tip: Repository not found. Check the URL or add GitLab token for private repos.';
                    } else if (response.status === 403) {
                        errorMessage += '\n\n💡 Tip: Access forbidden. Your GitLab token might not have the required permissions (read_api, read_repository).';
                    }

                    throw new Error(errorMessage);
                }

                const data = await response.json();
                if (!Array.isArray(data) || data.length === 0) break;
                allItems.push(...data);

                // Check for next page
                const nextPage = response.headers.get('X-Next-Page');
                if (!nextPage || nextPage === '') break;
                page = parseInt(nextPage, 10);
            }

            console.log(`📂 Fetched ${allItems.length} tree entries across ${page} page(s)`);
            return allItems;
        } catch (error) {
            console.error('Error fetching repo tree:', error);
            throw error;
        }
    }

    /**
     * Filter files by extension and directory (matches GitHubService)
     * @param {Array} tree
     * @returns {Array}
     */
    filterCodeFiles(tree) {
        return tree
            .filter(item => item.type === 'blob') // Only files, not directories
            .filter(item => {
                // Check if file is in excluded directory
                const pathParts = item.path.split('/');
                const isInExcludedDir = pathParts.some(part =>
                    this.excludeDirs.includes(part)
                );
                if (isInExcludedDir) {
                    return false;
                }

                // Get file extension
                const ext = item.path.split('.').pop().toLowerCase();

                // First check exclusion list (explicit deny)
                if (this.excludeExtensions.includes(ext)) {
                    return false;
                }

                // Then check inclusion list (explicit allow)
                return this.codeExtensions.includes(ext);
            });
    }

    /**
     * Fetch file content
     * @param {string} projectPath
     * @param {string} filePath
     * @param {string} branch
     * @returns {Promise<string>}
     */
    async fetchFileContent(projectPath, filePath, branch = 'main') {
        const encoded = this.encodeProjectPath(projectPath);
        const encodedPath = encodeURIComponent(filePath);
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.token) {
            headers['PRIVATE-TOKEN'] = this.token;
        }

        const url = `${this.baseUrl}/projects/${encoded}/repository/files/${encodedPath}/raw?ref=${branch}`;

        try {
            const response = await fetch(url, { headers });

            if (!response.ok) {
                const errorText = await response.text().catch(() => response.statusText);
                console.error(`❌ Failed to fetch ${filePath}:`, {
                    status: response.status,
                    statusText: response.statusText,
                    error: errorText,
                    url: url,
                    hasToken: !!this.token,
                    branch: branch
                });
                throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            return await response.text();
        } catch (error) {
            console.error(`❌ Error fetching file ${filePath}:`, error.message, {
                url: url,
                hasToken: !!this.token,
                branch: branch
            });
            return '';
        }
    }

    /**
     * Fetch all code files from repository
     * PERFORMANCE: Uses parallel downloads with concurrency limit (5x faster)
     *
     * @param {string} url - GitLab URL
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Array<{path: string, content: string}>>}
     */
    async fetchRepositoryFiles(url, onProgress = null) {
        const parsed = this.parseGitLabUrl(url);
        if (!parsed) {
            throw new Error('Invalid GitLab URL');
        }

        let { projectPath, branch } = parsed;
        console.log('🌿 Detected branch from URL:', branch || '(will auto-detect)');

        // Resolve the branch if not specified
        if (!branch) {
            branch = await this.getDefaultBranch(projectPath);
            console.log('📌 Using resolved branch:', branch);
        }

        // Fetch tree
        if (onProgress) onProgress({ status: 'fetching_tree', message: 'Fetching repository structure...' });
        const tree = await this.fetchRepoTree(projectPath, branch);

        // Filter code files
        const codeFiles = this.filterCodeFiles(tree);
        if (onProgress) {
            onProgress({
                status: 'filtered',
                message: `Found ${codeFiles.length} code files`,
                total: codeFiles.length
            });
        }

        // PERFORMANCE: Parallel download with concurrency limit
        const CONCURRENCY = 5;  // Download 5 files at a time
        const files = [];
        let completed = 0;
        let failed = 0;

        const startTime = performance.now();

        // Process files in batches
        for (let i = 0; i < codeFiles.length; i += CONCURRENCY) {
            const batch = codeFiles.slice(i, Math.min(i + CONCURRENCY, codeFiles.length));

            // Download batch in parallel with retry
            const batchPromises = batch.map(async (file) => {
                try {
                    const content = await this.fetchFileContentWithRetry(projectPath, file.path, branch);
                    if (content) {
                        return { path: file.path, content };
                    }
                } catch (error) {
                    console.warn(`⚠️ Failed to fetch ${file.path}:`, error.message);
                    failed++;
                }
                return null;
            });

            const batchResults = await Promise.all(batchPromises);

            // Collect successful results
            for (const result of batchResults) {
                if (result) {
                    files.push(result);
                }
                completed++;
            }

            if (onProgress) {
                onProgress({
                    status: 'downloading',
                    message: `Downloaded ${completed}/${codeFiles.length} files${failed > 0 ? ` (${failed} failed)` : ''}`,
                    current: completed,
                    total: codeFiles.length,
                    failed
                });
            }

            // Small delay between batches to avoid rate limiting
            if (i + CONCURRENCY < codeFiles.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        console.log(`📥 Downloaded ${files.length} files (${failed} failed) from ${projectPath} in ${elapsed}s`);
        return files;
    }

    /**
     * Fetch file content with retry logic
     * RELIABILITY: Retries up to 3 times with exponential backoff
     */
    async fetchFileContentWithRetry(projectPath, path, branch, maxRetries = 3) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const content = await this.fetchFileContent(projectPath, path, branch);
                return content;
            } catch (error) {
                lastError = error;

                // Don't retry on 404 (file doesn't exist)
                if (error.message?.includes('404') || error.message?.includes('Not Found')) {
                    throw error;
                }

                // Exponential backoff: 100ms, 200ms, 400ms
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt - 1) * 100;
                    console.log(`⏳ Retry ${attempt}/${maxRetries} for ${path} in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError;
    }

    /**
     * Get repository ID from URL
     * @param {string} url
     * @returns {string}
     */
    getRepoId(url) {
        const parsed = this.parseGitLabUrl(url);
        if (!parsed) return null;
        return parsed.projectPath;
    }
}
