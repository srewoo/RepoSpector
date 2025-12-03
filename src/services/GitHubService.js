/**
 * GitHubService - Fetch repository files from GitHub API
 */

export class GitHubService {
    constructor(token = null) {
        this.token = token;
        this.baseUrl = 'https://api.github.com';

        // Code file extensions to index (including documentation)
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
            '.github',
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

        this.maxFiles = 500; // Limit to avoid excessive indexing
    }

    /**
     * Parse GitHub URL to extract owner and repo
     * @param {string} url - GitHub URL
     * @returns {{owner: string, repo: string, branch: string} | null}
     */
    parseGitHubUrl(url) {
        console.log('🔍 Parsing GitHub URL:', url);

        const patterns = [
            /github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)/,
            /github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)/,
            /github\.com\/([^\/]+)\/([^\/]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                const owner = match[1];
                const repo = match[2].replace(/\.git$/, '');
                const branch = match[3] || 'main';

                console.log('✅ Parsed GitHub URL:', {
                    owner,
                    repo,
                    branch,
                    pattern: pattern.toString()
                });

                return {
                    owner,
                    repo,
                    branch
                };
            }
        }

        console.warn('❌ Failed to parse GitHub URL');
        return null;
    }

    /**
     * Fetch repository tree
     * @param {string} owner
     * @param {string} repo
     * @param {string} branch
     * @returns {Promise<Array>}
     */
    async fetchRepoTree(owner, repo, branch = 'main') {
        const headers = {
            'Accept': 'application/vnd.github.v3+json'
        };

        if (this.token) {
            headers['Authorization'] = `token ${this.token}`;
        }

        try {
            // Get default branch if 'main' doesn't exist
            const repoResponse = await fetch(`${this.baseUrl}/repos/${owner}/${repo}`, { headers });
            if (!repoResponse.ok && branch === 'main') {
                const repoData = await repoResponse.json();
                branch = repoData.default_branch || 'master';
            }

            // Fetch tree recursively
            const response = await fetch(
                `${this.baseUrl}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
                { headers }
            );

            if (!response.ok) {
                // Try to get detailed error message
                let errorMessage = `GitHub API error (${response.status}): ${response.statusText}`;
                try {
                    const errorData = await response.json();
                    if (errorData.message) {
                        errorMessage = `GitHub API error: ${errorData.message}`;
                    }
                } catch (e) {
                    // If JSON parsing fails, use status text
                }

                // Add helpful context to error
                if (response.status === 401) {
                    errorMessage += '\n\n💡 Tip: This might be a private repository. Add your GitHub token in Settings.';
                } else if (response.status === 404) {
                    errorMessage += '\n\n💡 Tip: Repository not found. Check the URL or add GitHub token for private repos.';
                } else if (response.status === 403) {
                    if (errorMessage.includes('rate limit')) {
                        errorMessage += '\n\n💡 Tip: Rate limit exceeded (60 req/hour). Add your GitHub token to increase to 5000 req/hour.';
                    } else {
                        errorMessage += '\n\n💡 Tip: Access forbidden. Your GitHub token might not have the required permissions (repo scope).';
                    }
                }

                throw new Error(errorMessage);
            }

            const data = await response.json();
            return data.tree || [];
        } catch (error) {
            console.error('Error fetching repo tree:', error);
            throw error;
        }
    }

    /**
     * Filter files by extension and directory
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
     * @param {string} owner
     * @param {string} repo
     * @param {string} path
     * @param {string} branch
     * @returns {Promise<string>}
     */
    async fetchFileContent(owner, repo, path, branch = 'main') {
        const headers = {
            'Accept': 'application/vnd.github.v3.raw'
        };

        if (this.token) {
            headers['Authorization'] = `token ${this.token}`;
        }

        try {
            const response = await fetch(
                `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
                { headers }
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
            }

            return await response.text();
        } catch (error) {
            console.error(`Error fetching file ${path}:`, error);
            return ''; // Return empty string on error
        }
    }

    /**
     * Fetch all code files from repository
     * @param {string} url - GitHub URL
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Array<{path: string, content: string}>>}
     */
    async fetchRepositoryFiles(url, onProgress = null) {
        const parsed = this.parseGitHubUrl(url);
        if (!parsed) {
            throw new Error('Invalid GitHub URL');
        }

        const { owner, repo, branch } = parsed;

        // Fetch tree
        if (onProgress) onProgress({ status: 'fetching_tree', message: 'Fetching repository structure...' });
        const tree = await this.fetchRepoTree(owner, repo, branch);

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

            const content = await this.fetchFileContent(owner, repo, file.path, branch);
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
        const parsed = this.parseGitHubUrl(url);
        if (!parsed) return null;
        return `${parsed.owner}/${parsed.repo}`;
    }
}
