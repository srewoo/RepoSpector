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

        this.maxFiles = 500;
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

                const branch = match[2] || 'main';

                console.log('✅ Parsed GitLab URL:', {
                    projectPath,
                    branch,
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
     * Fetch repository tree
     * @param {string} projectPath
     * @param {string} branch
     * @returns {Promise<Array>}
     */
    async fetchRepoTree(projectPath, branch = 'main') {
        const encoded = this.encodeProjectPath(projectPath);
        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.token) {
            headers['PRIVATE-TOKEN'] = this.token;
        }

        try {
            const response = await fetch(
                `${this.baseUrl}/projects/${encoded}/repository/tree?recursive=true&ref=${branch}&per_page=1000`,
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

                // Try master branch if main fails (404 or branch not found)
                if (branch === 'main' && (response.status === 404 || errorMessage.includes('branch'))) {
                    console.log('Branch "main" not found, trying "master"...');
                    return await this.fetchRepoTree(projectPath, 'master');
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

            return await response.json();
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
            })
            .slice(0, this.maxFiles); // Limit number of files
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

        try {
            const response = await fetch(
                `${this.baseUrl}/projects/${encoded}/repository/files/${encodedPath}/raw?ref=${branch}`,
                { headers }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch ${filePath}: ${response.statusText}`);
            }

            return await response.text();
        } catch (error) {
            console.error(`Error fetching file ${filePath}:`, error);
            return '';
        }
    }

    /**
     * Fetch all code files from repository
     * @param {string} url - GitLab URL
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Array<{path: string, content: string}>>}
     */
    async fetchRepositoryFiles(url, onProgress = null) {
        const parsed = this.parseGitLabUrl(url);
        if (!parsed) {
            throw new Error('Invalid GitLab URL');
        }

        const { projectPath, branch } = parsed;

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

        // Fetch file contents
        const files = [];
        for (let i = 0; i < codeFiles.length; i++) {
            const file = codeFiles[i];

            if (onProgress) {
                onProgress({
                    status: 'downloading',
                    message: `Downloading ${file.path}...`,
                    current: i + 1,
                    total: codeFiles.length
                });
            }

            const content = await this.fetchFileContent(projectPath, file.path, branch);
            if (content) {
                files.push({
                    path: file.path,
                    content
                });
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return files;
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
