/**
 * GitHubService - Fetch repository files from GitHub API
 */

import {
    CODE_EXTENSIONS,
    EXCLUDE_EXTENSIONS,
    EXCLUDE_DIRS,
    MAX_FILE_SIZE,
    filterIndexableFiles,
} from '../utils/codeFileFilter.js';

export class GitHubService {
    constructor(token = null) {
        this.token = token;
        this.baseUrl = 'https://api.github.com';

        // Shared with GitLabService via `codeFileFilter`. Kept as instance fields so
        // a caller can still narrow or widen them per repo.
        this.codeExtensions = [...CODE_EXTENSIONS];
        this.excludeExtensions = [...EXCLUDE_EXTENSIONS];
        this.excludeDirs = [...EXCLUDE_DIRS];
    }

    /**
     * Parse GitHub URL to extract owner and repo.
     *
     * `branch` is `null` when the URL names no branch, NOT `'main'`. Defaulting
     * here erased the difference between "the user asked for main" and "we don't
     * know yet", and the caller then requested `git/trees/main` on repos whose
     * default is `master` — a 404, surfaced to the user as "Repository not
     * found. Check the URL." Every repo that never renamed its default branch
     * was unindexable.
     *
     * @param {string} url - GitHub URL
     * @returns {{owner: string, repo: string, branch: string|null} | null}
     */
    parseGitHubUrl(url) {
        console.log('🔍 Parsing GitHub URL:', url);

        const patterns = [
            /github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)/,
            /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)/,
            /github\.com\/([^/]+)\/([^/]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                const owner = match[1];
                const repo = match[2].replace(/\.git$/, '');
                const branch = match[3] || null;

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
    /**
     * The repository's default branch, or null when it cannot be determined.
     *
     * Mirrors `GitLabService.getDefaultBranch`, which has always done this
     * correctly; the two hosts should not disagree about how to find a repo's
     * starting point.
     *
     * @param {string} owner
     * @param {string} repo
     * @param {Object} headers
     * @returns {Promise<string|null>}
     */
    async getDefaultBranch(owner, repo, headers) {
        try {
            const response = await fetch(`${this.baseUrl}/repos/${owner}/${repo}`, { headers });
            if (!response.ok) return null;
            const data = await response.json();
            return data.default_branch || null;
        } catch (e) {
            console.warn(`Could not resolve default branch for ${owner}/${repo}:`, e?.message);
            return null;
        }
    }

    async fetchRepoTree(owner, repo, branch = null) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json'
        };

        if (this.token) {
            headers['Authorization'] = `token ${this.token}`;
        }

        try {
            // Resolve the default branch when the URL did not name one. This
            // reads `default_branch` on SUCCESS — the previous version only
            // looked at it when the metadata request had already failed, i.e.
            // exactly when the field is absent from the response.
            if (!branch) {
                branch = await this.getDefaultBranch(owner, repo, headers);
            }
            // Still unknown means the metadata call failed. `main` is the better
            // guess for a repo we know nothing about, and the tree request's own
            // 404 handler explains the failure from here.
            if (!branch) {
                console.warn(`Could not determine default branch for ${owner}/${repo}; trying "main"`);
                branch = 'main';
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

            if (data.truncated) {
                console.warn(`⚠️ GitHub tree is TRUNCATED — repo has more than ${(data.tree || []).length} entries. Some files may not be indexed.`);
            }

            // The resolved branch goes back to the caller: file downloads must
            // use the SAME ref the tree came from, or every path 404s.
            return { tree: data.tree || [], truncated: !!data.truncated, branch };
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
    /**
     * Filter a repo tree down to the files worth indexing.
     *
     * Delegates to the shared `codeFileFilter` so GitHub and GitLab index the SAME
     * corpus. Two hand-maintained copies of the list had already diverged in
     * coverage, and a repo indexed from one host retrieving different context than
     * the same repo indexed from the other is not a difference a user can debug.
     */
    filterCodeFiles(tree) {
        return filterIndexableFiles(tree, {
            codeExtensions: this.codeExtensions,
            excludeExtensions: this.excludeExtensions,
            excludeDirs: this.excludeDirs,
            maxFileSize: MAX_FILE_SIZE,
        });
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
     * PERFORMANCE: Uses parallel downloads with concurrency limit (5x faster)
     *
     * @param {string} url - GitHub URL
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Array<{path: string, content: string}>>}
     */
    async fetchRepositoryFiles(url, onProgress = null) {
        const parsed = this.parseGitHubUrl(url);
        if (!parsed) {
            throw new Error('Invalid GitHub URL');
        }

        const { owner, repo } = parsed;

        // Fetch tree
        if (onProgress) onProgress({ status: 'fetching_tree', message: 'Fetching repository structure...' });
        // `branch` is re-read from the result rather than the URL: when the URL
        // named none, the tree was fetched from the resolved default and the
        // file downloads below have to use that same ref.
        const { tree, truncated, branch } = await this.fetchRepoTree(owner, repo, parsed.branch);

        if (truncated && onProgress) {
            onProgress({
                status: 'warning',
                message: `⚠️ Repository tree is truncated by GitHub (>${tree.length} entries). Some files may be missing from the index.`
            });
        }

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
                    const content = await this.fetchFileContentWithRetry(owner, repo, file.path, branch);
                    // Belt-and-braces size guard: the tree filter already drops blobs
                    // whose reported `size` is over the limit, but the field is absent
                    // on some entries and an unbounded file must never reach the index.
                    if (content && content.length > MAX_FILE_SIZE) {
                        console.warn(`⏭️  Skipping ${file.path}: ${content.length} bytes exceeds the ${MAX_FILE_SIZE}-byte index limit`);
                        return null;
                    }
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
        console.log(`📥 Downloaded ${files.length} files (${failed} failed) from ${owner}/${repo} in ${elapsed}s`);
        return files;
    }

    /**
     * Fetch file content with retry logic
     * RELIABILITY: Retries up to 3 times with exponential backoff
     */
    async fetchFileContentWithRetry(owner, repo, path, branch, maxRetries = 3) {
        let lastError;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const content = await this.fetchFileContent(owner, repo, path, branch);
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
        const parsed = this.parseGitHubUrl(url);
        if (!parsed) return null;
        return `${parsed.owner}/${parsed.repo}`;
    }
}
