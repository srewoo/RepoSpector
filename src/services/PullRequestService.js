/**
 * PullRequestService - Comprehensive PR/MR analysis for GitHub and GitLab
 *
 * Fetches PR details, file changes, commits, and comments for analysis
 */

export class PullRequestService {
    constructor(options = {}) {
        this.githubToken = options.githubToken || null;
        this.gitlabToken = options.gitlabToken || null;

        this.githubBaseUrl = 'https://api.github.com';
        this.gitlabBaseUrl = 'https://gitlab.com/api/v4';
    }

    /**
     * Detect platform and PR info from URL
     */
    parsePullRequestUrl(url) {
        // GitHub PR: https://github.com/owner/repo/pull/123
        const githubMatch = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
        if (githubMatch) {
            return {
                platform: 'github',
                owner: githubMatch[1],
                repo: githubMatch[2],
                prNumber: parseInt(githubMatch[3])
            };
        }

        // GitLab MR: https://gitlab.com/owner/repo/-/merge_requests/123
        const gitlabMatch = url.match(/gitlab\.com\/([^\/]+)\/([^\/]+)\/-\/merge_requests\/(\d+)/);
        if (gitlabMatch) {
            return {
                platform: 'gitlab',
                owner: gitlabMatch[1],
                repo: gitlabMatch[2],
                mrNumber: parseInt(gitlabMatch[3])
            };
        }

        // GitLab with nested groups: https://gitlab.com/group/subgroup/repo/-/merge_requests/123
        const gitlabNestedMatch = url.match(/gitlab\.com\/(.+)\/-\/merge_requests\/(\d+)/);
        if (gitlabNestedMatch) {
            const pathParts = gitlabNestedMatch[1].split('/');
            return {
                platform: 'gitlab',
                projectPath: gitlabNestedMatch[1],
                owner: pathParts.slice(0, -1).join('/'),
                repo: pathParts[pathParts.length - 1],
                mrNumber: parseInt(gitlabNestedMatch[2])
            };
        }

        return null;
    }

    /**
     * Fetch complete PR/MR data for analysis
     */
    async fetchPullRequest(url) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) {
            throw new Error('Invalid PR/MR URL. Supported: GitHub and GitLab');
        }

        if (prInfo.platform === 'github') {
            return await this.fetchGitHubPR(prInfo);
        } else if (prInfo.platform === 'gitlab') {
            return await this.fetchGitLabMR(prInfo);
        }

        throw new Error(`Unsupported platform: ${prInfo.platform}`);
    }

    /**
     * Fetch GitHub PR details
     */
    async fetchGitHubPR(prInfo) {
        const { owner, repo, prNumber } = prInfo;
        const headers = {
            'Accept': 'application/vnd.github.v3+json'
        };

        if (this.githubToken) {
            headers['Authorization'] = `token ${this.githubToken}`;
        }

        try {
            // Fetch PR details, files, and commits in parallel
            const [prResponse, filesResponse, commitsResponse, reviewsResponse] = await Promise.all([
                fetch(`${this.githubBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers }),
                fetch(`${this.githubBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/files`, { headers }),
                fetch(`${this.githubBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/commits`, { headers }),
                fetch(`${this.githubBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, { headers })
            ]);

            // Check for errors
            if (!prResponse.ok) {
                throw new Error(`GitHub API error: ${prResponse.status} ${prResponse.statusText}`);
            }

            const [prData, filesData, commitsData, reviewsData] = await Promise.all([
                prResponse.json(),
                filesResponse.ok ? filesResponse.json() : [],
                commitsResponse.ok ? commitsResponse.json() : [],
                reviewsResponse.ok ? reviewsResponse.json() : []
            ]);

            // Fetch inline comments (review comments)
            let comments = [];
            try {
                const commentsResponse = await fetch(
                    `${this.githubBaseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
                    { headers }
                );
                if (commentsResponse.ok) {
                    comments = await commentsResponse.json();
                }
            } catch (e) {
                console.warn('Failed to fetch PR comments:', e);
            }

            return this.normalizeGitHubPR(prData, filesData, commitsData, reviewsData, comments);
        } catch (error) {
            console.error('Error fetching GitHub PR:', error);
            throw error;
        }
    }

    /**
     * Normalize GitHub PR data to common format
     */
    normalizeGitHubPR(pr, files, commits, reviews, comments) {
        return {
            platform: 'github',
            id: pr.id,
            number: pr.number,
            title: pr.title,
            description: pr.body || '',
            state: pr.state,
            isDraft: pr.draft || false,
            merged: pr.merged || false,
            mergeable: pr.mergeable,

            // Author info
            author: {
                login: pr.user?.login,
                avatarUrl: pr.user?.avatar_url
            },

            // Branch info
            branches: {
                source: pr.head?.ref,
                target: pr.base?.ref,
                sourceRepo: pr.head?.repo?.full_name,
                targetRepo: pr.base?.repo?.full_name
            },

            // Stats
            stats: {
                additions: pr.additions || 0,
                deletions: pr.deletions || 0,
                changedFiles: pr.changed_files || files.length,
                commits: commits.length
            },

            // Labels
            labels: (pr.labels || []).map(l => l.name),

            // Files with changes
            files: files.map(f => ({
                filename: f.filename,
                status: f.status, // added, removed, modified, renamed
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch || '',
                previousFilename: f.previous_filename,
                language: this.detectLanguage(f.filename)
            })),

            // Commits
            commits: commits.map(c => ({
                sha: c.sha,
                message: c.commit?.message,
                author: c.commit?.author?.name,
                date: c.commit?.author?.date
            })),

            // Reviews
            reviews: reviews.map(r => ({
                id: r.id,
                state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED, PENDING
                body: r.body,
                author: r.user?.login,
                submittedAt: r.submitted_at
            })),

            // Inline comments
            comments: comments.map(c => ({
                id: c.id,
                path: c.path,
                line: c.line || c.original_line,
                body: c.body,
                author: c.user?.login,
                createdAt: c.created_at
            })),

            // Timestamps
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at,

            // URLs
            url: pr.html_url,
            diffUrl: pr.diff_url,
            patchUrl: pr.patch_url
        };
    }

    /**
     * Fetch GitLab MR details
     */
    async fetchGitLabMR(mrInfo) {
        const { projectPath, owner, repo, mrNumber } = mrInfo;
        const projectId = encodeURIComponent(projectPath || `${owner}/${repo}`);

        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.gitlabToken) {
            headers['PRIVATE-TOKEN'] = this.gitlabToken;
        }

        try {
            // Fetch MR details, changes, and commits in parallel
            const [mrResponse, changesResponse, commitsResponse, notesResponse] = await Promise.all([
                fetch(`${this.gitlabBaseUrl}/projects/${projectId}/merge_requests/${mrNumber}`, { headers }),
                fetch(`${this.gitlabBaseUrl}/projects/${projectId}/merge_requests/${mrNumber}/changes`, { headers }),
                fetch(`${this.gitlabBaseUrl}/projects/${projectId}/merge_requests/${mrNumber}/commits`, { headers }),
                fetch(`${this.gitlabBaseUrl}/projects/${projectId}/merge_requests/${mrNumber}/notes`, { headers })
            ]);

            if (!mrResponse.ok) {
                throw new Error(`GitLab API error: ${mrResponse.status} ${mrResponse.statusText}`);
            }

            const [mrData, changesData, commitsData, notesData] = await Promise.all([
                mrResponse.json(),
                changesResponse.ok ? changesResponse.json() : { changes: [] },
                commitsResponse.ok ? commitsResponse.json() : [],
                notesResponse.ok ? notesResponse.json() : []
            ]);

            // Fetch approvals
            let approvals = null;
            try {
                const approvalsResponse = await fetch(
                    `${this.gitlabBaseUrl}/projects/${projectId}/merge_requests/${mrNumber}/approvals`,
                    { headers }
                );
                if (approvalsResponse.ok) {
                    approvals = await approvalsResponse.json();
                }
            } catch (e) {
                console.warn('Failed to fetch MR approvals:', e);
            }

            return this.normalizeGitLabMR(mrData, changesData, commitsData, notesData, approvals);
        } catch (error) {
            console.error('Error fetching GitLab MR:', error);
            throw error;
        }
    }

    /**
     * Normalize GitLab MR data to common format
     */
    normalizeGitLabMR(mr, changes, commits, notes, approvals) {
        // Filter inline comments (diff notes) from general notes
        const inlineComments = notes.filter(n => n.position?.new_path || n.position?.old_path);
        const generalComments = notes.filter(n => !n.position);

        // Count additions/deletions from changes
        let totalAdditions = 0;
        let totalDeletions = 0;

        (changes.changes || []).forEach(file => {
            const diff = file.diff || '';
            const lines = diff.split('\n');
            lines.forEach(line => {
                if (line.startsWith('+') && !line.startsWith('+++')) totalAdditions++;
                if (line.startsWith('-') && !line.startsWith('---')) totalDeletions++;
            });
        });

        return {
            platform: 'gitlab',
            id: mr.id,
            iid: mr.iid,
            number: mr.iid,
            title: mr.title,
            description: mr.description || '',
            state: mr.state,
            isDraft: mr.work_in_progress || mr.draft || false,
            merged: mr.state === 'merged',
            mergeable: mr.merge_status === 'can_be_merged',

            // Author info
            author: {
                login: mr.author?.username,
                avatarUrl: mr.author?.avatar_url
            },

            // Branch info
            branches: {
                source: mr.source_branch,
                target: mr.target_branch,
                sourceRepo: mr.source_project_id,
                targetRepo: mr.target_project_id
            },

            // Stats
            stats: {
                additions: totalAdditions,
                deletions: totalDeletions,
                changedFiles: (changes.changes || []).length,
                commits: commits.length
            },

            // Labels
            labels: mr.labels || [],

            // Files with changes
            files: (changes.changes || []).map(f => ({
                filename: f.new_path || f.old_path,
                status: f.new_file ? 'added' : f.deleted_file ? 'removed' : f.renamed_file ? 'renamed' : 'modified',
                additions: (f.diff || '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
                deletions: (f.diff || '').split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length,
                changes: (f.diff || '').split('\n').length,
                patch: f.diff || '',
                previousFilename: f.old_path !== f.new_path ? f.old_path : undefined,
                language: this.detectLanguage(f.new_path || f.old_path)
            })),

            // Commits
            commits: commits.map(c => ({
                sha: c.id,
                message: c.message,
                author: c.author_name,
                date: c.created_at
            })),

            // Reviews/Approvals
            reviews: approvals?.approved_by?.map(a => ({
                id: a.user?.id,
                state: 'APPROVED',
                author: a.user?.username,
                submittedAt: null
            })) || [],

            // Inline comments
            comments: inlineComments.map(n => ({
                id: n.id,
                path: n.position?.new_path || n.position?.old_path,
                line: n.position?.new_line || n.position?.old_line,
                body: n.body,
                author: n.author?.username,
                createdAt: n.created_at,
                resolved: n.resolved || false
            })),

            // General discussion
            discussion: generalComments.map(n => ({
                id: n.id,
                body: n.body,
                author: n.author?.username,
                createdAt: n.created_at,
                system: n.system || false
            })),

            // Pipeline status
            pipeline: mr.head_pipeline ? {
                status: mr.head_pipeline.status,
                webUrl: mr.head_pipeline.web_url
            } : null,

            // Timestamps
            createdAt: mr.created_at,
            updatedAt: mr.updated_at,
            mergedAt: mr.merged_at,

            // URLs
            url: mr.web_url,
            diffUrl: `${mr.web_url}/diffs`
        };
    }

    /**
     * Detect language from filename
     */
    detectLanguage(filename) {
        if (!filename) return 'text';

        const ext = filename.split('.').pop()?.toLowerCase();
        const languageMap = {
            'js': 'javascript', 'jsx': 'javascript', 'ts': 'typescript', 'tsx': 'typescript',
            'py': 'python', 'java': 'java', 'kt': 'kotlin', 'go': 'go', 'rs': 'rust',
            'rb': 'ruby', 'php': 'php', 'c': 'c', 'cpp': 'cpp', 'cs': 'csharp',
            'swift': 'swift', 'dart': 'dart', 'scala': 'scala', 'vue': 'vue',
            'svelte': 'svelte', 'html': 'html', 'css': 'css', 'scss': 'scss',
            'json': 'json', 'yaml': 'yaml', 'yml': 'yaml', 'md': 'markdown',
            'sql': 'sql', 'graphql': 'graphql', 'sh': 'bash', 'bash': 'bash'
        };

        return languageMap[ext] || 'text';
    }

    /**
     * Get formatted diff for a specific file
     */
    getFileDiff(prData, filename) {
        const file = prData.files.find(f => f.filename === filename);
        if (!file) return null;

        return {
            filename: file.filename,
            language: file.language,
            status: file.status,
            patch: file.patch,
            additions: file.additions,
            deletions: file.deletions
        };
    }

    /**
     * Get all file patches combined
     */
    getAllDiffs(prData) {
        return prData.files.map(f => ({
            filename: f.filename,
            language: f.language,
            status: f.status,
            patch: f.patch
        }));
    }

    /**
     * Generate summary statistics
     */
    generatePRSummary(prData) {
        const filesByStatus = {
            added: prData.files.filter(f => f.status === 'added').length,
            modified: prData.files.filter(f => f.status === 'modified').length,
            removed: prData.files.filter(f => f.status === 'removed').length,
            renamed: prData.files.filter(f => f.status === 'renamed').length
        };

        const languageStats = {};
        prData.files.forEach(f => {
            languageStats[f.language] = (languageStats[f.language] || 0) + 1;
        });

        const reviewStatus = {
            approved: prData.reviews.filter(r => r.state === 'APPROVED').length,
            changesRequested: prData.reviews.filter(r => r.state === 'CHANGES_REQUESTED').length,
            commented: prData.reviews.filter(r => r.state === 'COMMENTED').length
        };

        return {
            title: prData.title,
            author: prData.author.login,
            state: prData.state,
            isDraft: prData.isDraft,
            merged: prData.merged,

            stats: prData.stats,
            filesByStatus,
            languageStats,
            reviewStatus,

            hasUnresolvedComments: prData.comments.some(c => !c.resolved),
            commentCount: prData.comments.length,
            commitCount: prData.commits.length,

            daysSinceCreated: Math.floor((Date.now() - new Date(prData.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
            daysSinceUpdated: Math.floor((Date.now() - new Date(prData.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
        };
    }

    /**
     * Get files that need attention (high change count or security-sensitive)
     */
    getHighRiskFiles(prData) {
        const securityPatterns = [
            /auth/i, /login/i, /password/i, /secret/i, /token/i, /api.?key/i,
            /permission/i, /role/i, /admin/i, /crypto/i, /encrypt/i, /decrypt/i,
            /\.env/, /config/i, /credential/i, /session/i, /cookie/i
        ];

        return prData.files
            .filter(f => {
                // High change count
                if (f.additions + f.deletions > 100) return true;

                // Security-sensitive file
                if (securityPatterns.some(p => p.test(f.filename))) return true;

                // Config files
                if (/\.(env|config|secret|key)/.test(f.filename)) return true;

                return false;
            })
            .map(f => ({
                ...f,
                riskReasons: [
                    f.additions + f.deletions > 100 && 'Large change count',
                    securityPatterns.some(p => p.test(f.filename)) && 'Security-sensitive file',
                    /\.(env|config|secret|key)/.test(f.filename) && 'Configuration file'
                ].filter(Boolean)
            }));
    }
}
