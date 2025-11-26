/**
 * GitLabService - Fetch repository files from GitLab API
 */

export class GitLabService {
    constructor(token = null) {
        this.token = token;
        this.baseUrl = 'https://gitlab.com/api/v4';

        // Common code file extensions to index (same as GitHub)
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

        this.maxFiles = 500;
    }

    /**
     * Parse GitLab URL to extract project path
     * @param {string} url - GitLab URL
     * @returns {{projectPath: string, branch: string} | null}
     */
    parseGitLabUrl(url) {
        const patterns = [
            /gitlab\.com\/([^\/]+\/[^\/]+)/,
            /gitlab\.com\/([^\/]+\/[^\/]+)\/-\/tree\/([^\/]+)/,
            /gitlab\.com\/([^\/]+\/[^\/]+)\/-\/blob\/([^\/]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                return {
                    projectPath: match[1].replace(/\.git$/, ''),
                    branch: match[2] || 'main'
                };
            }
        }

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
                // Try master branch if main fails
                if (branch === 'main') {
                    return await this.fetchRepoTree(projectPath, 'master');
                }
                throw new Error(`GitLab API error: ${response.statusText}`);
            }

            return await response.json();
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
            .slice(0, this.maxFiles);
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
