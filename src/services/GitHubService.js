/**
 * GitHubService - Fetch repository files from GitHub API
 */

export class GitHubService {
    constructor(token = null) {
        this.token = token;
        this.baseUrl = 'https://api.github.com';

        // Common code file extensions to index
        this.codeExtensions = [
            'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
            'py', 'pyw',
            'java', 'kt', 'scala',
            'go', 'rs',
            'rb', 'php',
            'c', 'cpp', 'cc', 'h', 'hpp',
            'cs', 'vb',
            'swift', 'dart',
            'sh', 'bash', 'zsh',
            'yaml', 'yml', 'json', 'xml',
            'sql', 'graphql',
            'vue', 'svelte'
        ];

        this.maxFiles = 500; // Limit to avoid excessive indexing
    }

    /**
     * Parse GitHub URL to extract owner and repo
     * @param {string} url - GitHub URL
     * @returns {{owner: string, repo: string, branch: string} | null}
     */
    parseGitHubUrl(url) {
        const patterns = [
            /github\.com\/([^\/]+)\/([^\/]+)/,
            /github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)/,
            /github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return {
                    owner: match[1],
                    repo: match[2].replace(/\.git$/, ''),
                    branch: match[3] || 'main' // Default to main
                };
            }
        }

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
                throw new Error(`GitHub API error: ${response.statusText}`);
            }

            const data = await response.json();
            return data.tree || [];
        } catch (error) {
            console.error('Error fetching repo tree:', error);
            throw error;
        }
    }

    /**
     * Filter files by extension
     * @param {Array} tree
     * @returns {Array}
     */
    filterCodeFiles(tree) {
        return tree
            .filter(item => item.type === 'blob') // Only files
            .filter(item => {
                const ext = item.path.split('.').pop().toLowerCase();
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
