/**
 * PullRequestService - Comprehensive PR/MR analysis for GitHub and GitLab
 *
 * Fetches PR details, file changes, commits, and comments for analysis
 */

import { detectLanguageFromPath } from '../utils/languageMap.js';
import { PRIORITY } from '../utils/callBudget.js';
import { formatInlineComments } from '../utils/inlineCommentFormatter.js';
import { buildCommentableLineMap, oldLineForNewLine } from '../utils/patchLines.js';
import { githubApiBase, gitlabApiBase, rememberGitLabHost, detectPlatform, PLATFORM } from '../utils/gitHosts.js';

export class PullRequestService {
    constructor(options = {}) {
        this.githubToken = options.githubToken || null;
        this.gitlabToken = options.gitlabToken || null;

        this.githubBaseUrl = githubApiBase();
        this.gitlabBaseUrl = gitlabApiBase();
    }

    /**
     * API base for the instance this URL lives on.
     *
     * Resolved per call rather than fixed in the constructor: one service
     * instance handles URLs from several hosts in a session, and a
     * constructor-time base is necessarily the wrong one for all but the first.
     *
     * @param {string} url - a PR or MR URL
     * @returns {string}
     */
    resolveApiBase(url) {
        return detectPlatform(url) === PLATFORM.GITLAB
            ? gitlabApiBase(url)
            : githubApiBase(url);
    }

    /**
     * Fetch all pages from a paginated GitHub API endpoint.
     * Follows Link header rel="next" to iterate through pages.
     */
    async fetchAllPagesGitHub(url, headers, maxPages = 30) {
        const allResults = [];
        let nextUrl = url.includes('per_page=') ? url : `${url}${url.includes('?') ? '&' : '?'}per_page=100`;
        let page = 0;

        while (nextUrl && page < maxPages) {
            const response = await fetch(nextUrl, { headers });
            if (!response.ok) break;

            const data = await response.json();
            if (Array.isArray(data)) {
                allResults.push(...data);
                if (data.length < 100) break; // Last page
            } else {
                return data;
            }

            nextUrl = this.parseNextLink(response.headers.get('Link'));
            page++;
        }

        return allResults;
    }

    /**
     * Fetch all pages from a paginated GitLab API endpoint.
     * Follows X-Next-Page header or Link header.
     */
    async fetchAllPagesGitLab(url, headers, maxPages = 30) {
        const allResults = [];
        let nextUrl = url.includes('per_page=') ? url : `${url}${url.includes('?') ? '&' : '?'}per_page=100`;
        let page = 0;

        while (nextUrl && page < maxPages) {
            const response = await fetch(nextUrl, { headers });
            if (!response.ok) break;

            const data = await response.json();
            if (Array.isArray(data)) {
                allResults.push(...data);
                if (data.length < 100) break; // Last page
            } else {
                return data;
            }

            const nextPage = response.headers.get('X-Next-Page');
            if (nextPage && nextPage !== '') {
                const baseUrl = nextUrl.replace(/([?&])page=\d+/, '$1').replace(/[?&]$/, '');
                nextUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${nextPage}`;
            } else {
                nextUrl = this.parseNextLink(response.headers.get('Link'));
            }
            page++;
        }

        return allResults;
    }

    /**
     * Parse Link header to find rel="next" URL
     */
    parseNextLink(linkHeader) {
        if (!linkHeader) return null;
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        return match ? match[1] : null;
    }

    /**
     * Detect platform and PR info from URL
     */
    parsePullRequestUrl(url) {
        // GitHub PR on ANY host: https://<host>/owner/repo/pull/123
        //
        // `/pull/<n>` is not a structural proof the way `/-/` is for GitLab —
        // Codeberg, Gitea and others use the same or a near-identical shape —
        // so this match is gated on `detectPlatform`, which only returns
        // PLATFORM.GITHUB for github.com or a host already configured as GHE.
        // An unregistered host (enterprise or otherwise) still returns null:
        // registration stays configuration-only, never inferred from a URL.
        const githubMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
        if (githubMatch && detectPlatform(url) === PLATFORM.GITHUB) {
            return {
                platform: 'github',
                host: githubMatch[1],
                owner: githubMatch[2],
                repo: githubMatch[3],
                prNumber: parseInt(githubMatch[4]),
                apiBase: githubApiBase(url)
            };
        }

        // GitLab MR on ANY host: https://<host>/<group>/<...>/repo/-/merge_requests/123
        //
        // The host used to be pinned to gitlab.com, so a self-hosted MR fell
        // through to `return null` and the caller reported "unsupported URL".
        // `/-/merge_requests/` is a GitLab route wherever it is served, which
        // makes the project path everything between the origin and that marker —
        // nested groups included, with no separate nested-group branch needed.
        const gitlabMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
        if (gitlabMatch) {
            const host = gitlabMatch[1];
            const projectPath = gitlabMatch[2];
            const pathParts = projectPath.split('/');

            // Remember the instance so later repo-only URLs from it (indexing,
            // cross-repo impact) are recognised without configuration.
            rememberGitLabHost(host);

            return {
                platform: 'gitlab',
                host,
                apiBase: gitlabApiBase(url),
                projectPath,
                owner: pathParts.slice(0, -1).join('/'),
                repo: pathParts[pathParts.length - 1],
                mrNumber: parseInt(gitlabMatch[3])
            };
        }

        return null;
    }

    /**
     * API base for a parsed GitLab MR.
     *
     * Falls back to the instance-wide default so callers that constructed a
     * prInfo by hand (tests, older paths) keep working.
     */
    gitlabApiFor(prInfo) {
        return prInfo?.apiBase || this.gitlabBaseUrl;
    }

    /**
     * API base for a parsed GitHub PR.
     *
     * Mirrors `gitlabApiFor`: `apiBase` is resolved once at parse time from the
     * PR URL itself, so a hand-built prInfo (tests, older paths) still falls
     * back to the instance-wide default rather than throwing.
     */
    githubApiFor(prInfo) {
        return prInfo?.apiBase || this.githubBaseUrl;
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
            const base = `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/pulls/${prNumber}`;

            // Fetch PR details (single object, no pagination needed)
            const prResponse = await fetch(base, { headers });
            if (!prResponse.ok) {
                throw new Error(`GitHub API error: ${prResponse.status} ${prResponse.statusText}`);
            }
            const prData = await prResponse.json();

            // Fetch paginated endpoints in parallel (per_page=100, follows Link headers)
            const [filesData, commitsData, reviewsData, comments] = await Promise.all([
                this.fetchAllPagesGitHub(`${base}/files`, headers),
                this.fetchAllPagesGitHub(`${base}/commits`, headers),
                this.fetchAllPagesGitHub(`${base}/reviews`, headers),
                this.fetchAllPagesGitHub(`${base}/comments`, headers)
            ]);

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

            // Revision identity — what incremental re-review diffs against to
            // decide whether the PR moved since the last review.
            headSha: pr.head?.sha || null,
            baseSha: pr.base?.sha || null,

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
        const api = this.gitlabApiFor(mrInfo);

        const headers = {
            'Content-Type': 'application/json'
        };

        if (this.gitlabToken) {
            headers['PRIVATE-TOKEN'] = this.gitlabToken;
        }

        try {
            const base = `${api}/projects/${projectId}/merge_requests/${mrNumber}`;

            // Fetch MR details (single object, no pagination)
            const mrResponse = await fetch(base, { headers });
            if (!mrResponse.ok) {
                throw new Error(`GitLab API error: ${mrResponse.status} ${mrResponse.statusText}`);
            }
            const mrData = await mrResponse.json();

            // Changes returns all diffs in one response (no pagination needed)
            // Commits and notes may paginate on large MRs
            const [changesData, commitsData, notesData] = await Promise.all([
                fetch(`${base}/changes`, { headers }).then(r => r.ok ? r.json() : { changes: [] }),
                this.fetchAllPagesGitLab(`${base}/commits`, headers),
                this.fetchAllPagesGitLab(`${base}/notes`, headers)
            ]);

            // Fetch approvals (single response, no pagination)
            let approvals = null;
            try {
                const approvalsResponse = await fetch(`${base}/approvals`, { headers });
                if (approvalsResponse.ok) {
                    approvals = await approvalsResponse.json();
                }
            } catch (e) {
                console.warn('Failed to fetch MR approvals:', e);
            }

            // Which CI jobs actually failed. "pipeline: failed" alone tells the
            // reviewer nothing actionable; the job names are what let it reason
            // about whether this diff explains the failure. Only fetched when the
            // pipeline is red, so the happy path costs no extra call.
            const failedJobs = await this._fetchFailedJobNames(projectId, mrData?.head_pipeline, headers, api);

            return this.normalizeGitLabMR(mrData, changesData, commitsData, notesData, approvals, failedJobs);
        } catch (error) {
            console.error('Error fetching GitLab MR:', error);
            throw error;
        }
    }

    /**
     * Names of the failed jobs in an MR's head pipeline.
     *
     * Soft in every direction — an unreadable pipeline yields `[]` and the
     * review proceeds without the detail. Never throws.
     *
     * @returns {Promise<string[]>}
     */
    async _fetchFailedJobNames(projectId, headPipeline, headers, apiBase = this.gitlabBaseUrl) {
        if (!headPipeline?.id || headPipeline.status !== 'failed') return [];
        try {
            const resp = await fetch(
                `${apiBase}/projects/${projectId}/pipelines/${headPipeline.id}/jobs?scope[]=failed&per_page=20`,
                { headers }
            );
            if (!resp.ok) return [];
            const jobs = await resp.json();
            if (!Array.isArray(jobs)) return [];
            // `allow_failure` jobs are red by design and are not a review signal.
            return jobs
                .filter(j => j && j.allow_failure !== true)
                .map(j => j.name)
                .filter(Boolean);
        } catch (e) {
            console.warn('Failed to fetch failed pipeline jobs:', e.message);
            return [];
        }
    }

    /**
     * Normalize GitLab MR data to common format
     */
    normalizeGitLabMR(mr, changes, commits, notes, approvals, failedJobs = []) {
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

            // Revision identity — head SHA drives incremental re-review; diffRefs
            // are also what inline diff notes must be positioned against.
            headSha: mr.diff_refs?.head_sha || mr.sha || null,
            baseSha: mr.diff_refs?.base_sha || null,
            diffRefs: mr.diff_refs || null,

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

            // Names of jobs that failed in the head pipeline (empty when green).
            failedJobs,

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
        return detectLanguageFromPath(filename, { fallback: 'text' });
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
     * Estimate review effort on a 1-5 scale
     * @param {Object} prData - Normalized PR data
     * @returns {Object} { score, label, reasons, estimatedMinutes }
     */
    estimateReviewEffort(prData) {
        let score = 0;
        const reasons = [];

        const totalChanges = (prData.stats?.additions || 0) + (prData.stats?.deletions || 0);
        const fileCount = prData.files?.length || 0;

        // Size-based scoring
        if (totalChanges > 1000) { score += 2; reasons.push('Very large changeset (1000+ lines)'); }
        else if (totalChanges > 500) { score += 1.5; reasons.push('Large changeset (500+ lines)'); }
        else if (totalChanges > 200) { score += 1; reasons.push('Medium changeset (200+ lines)'); }
        else { score += 0.5; reasons.push('Small changeset'); }

        // File count
        if (fileCount > 20) { score += 1.5; reasons.push(`${fileCount} files changed`); }
        else if (fileCount > 10) { score += 1; reasons.push(`${fileCount} files changed`); }
        else if (fileCount > 5) { score += 0.5; }

        // Security-sensitive files
        const securityPatterns = [/auth/i, /login/i, /password/i, /secret/i, /token/i, /crypto/i, /\.env/, /permission/i];
        const securityFiles = (prData.files || []).filter(f =>
            securityPatterns.some(p => p.test(f.filename))
        );
        if (securityFiles.length > 0) {
            score += 1;
            reasons.push(`${securityFiles.length} security-sensitive file(s)`);
        }

        // Config/infra files
        const configFiles = (prData.files || []).filter(f =>
            /(?:docker|terraform|k8s|helm|ci|cd|pipeline|deploy|\.ya?ml$|\.toml$|Makefile)/i.test(f.filename)
        );
        if (configFiles.length > 2) {
            score += 0.5;
            reasons.push('Infrastructure/config changes');
        }

        // Language diversity (more languages = harder)
        const languages = new Set((prData.files || []).map(f => f.language).filter(Boolean));
        if (languages.size > 3) {
            score += 0.5;
            reasons.push(`${languages.size} different languages`);
        }

        // Clamp to 1-5
        const clampedScore = Math.max(1, Math.min(5, Math.round(score)));

        const labels = {
            1: 'Quick glance',
            2: 'Light review',
            3: 'Moderate review',
            4: 'Thorough review',
            5: 'Deep review required'
        };

        const minuteEstimates = { 1: 5, 2: 15, 3: 30, 4: 60, 5: 90 };

        return {
            score: clampedScore,
            label: labels[clampedScore],
            reasons,
            estimatedMinutes: minuteEstimates[clampedScore]
        };
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
     * Categorize PR files by type
     */
    categorizeFiles(files) {
        const categories = {
            features: [], tests: [], config: [], docs: [], styles: [], other: []
        };

        for (const file of (files || [])) {
            const name = file.filename || '';
            if (/\.(test|spec|e2e)\.[^.]+$|__tests__|test\//i.test(name)) {
                categories.tests.push(file);
            } else if (/\.(md|txt|rst)$|README|CHANGELOG|docs\//i.test(name)) {
                categories.docs.push(file);
            } else if (/\.(json|ya?ml|toml|lock|env)$|config|\.rc$|Makefile|Dockerfile/i.test(name)) {
                categories.config.push(file);
            } else if (/\.(css|scss|sass|less)$/i.test(name)) {
                categories.styles.push(file);
            } else if (/\.(js|jsx|ts|tsx|py|java|go|rb|rs|c|cpp|cs|php)$/i.test(name)) {
                categories.features.push(file);
            } else {
                categories.other.push(file);
            }
        }

        return categories;
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

    // ==========================================
    // PR Description & Metadata Methods
    // ==========================================

    /**
     * Update PR description on GitHub/GitLab
     */
    async updatePRDescription(url, description) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) throw new Error(`Unsupported PR URL: ${url}`);

        if (prInfo.platform === 'github') {
            return this.updateGitHubPRDescription(prInfo, description);
        } else if (prInfo.platform === 'gitlab') {
            return this.updateGitLabMRDescription(prInfo, description);
        }
        throw new Error(`Updating description not supported for: ${prInfo.platform}`);
    }

    // ==========================================
    // Persistent summary comment
    // ==========================================

    /**
     * The PR's top-level comments, enough to find our own summary among them.
     *
     * Deliberately just `{id, body, author}` — the caller needs to match a marker
     * and edit by id, and returning whole API objects would invite consumers to
     * depend on host-shaped fields.
     *
     * Never throws: an unreadable comment list means "no existing summary", and
     * the caller posts a new one. Worst case is a duplicate comment, not a lost
     * review.
     *
     * @param {string} url
     * @returns {Promise<Array<{id:*, body:string, author:string|null}>>}
     */
    async fetchIssueComments(url) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) return [];

        try {
            if (prInfo.platform === 'github') {
                const { owner, repo, prNumber } = prInfo;
                const resp = await fetch(
                    `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
                    {
                        headers: {
                            Accept: 'application/vnd.github.v3+json',
                            ...(this.githubToken ? { Authorization: `token ${this.githubToken}` } : {}),
                        },
                    },
                );
                if (!resp.ok) return [];
                return ((await resp.json()) || []).map(c => ({
                    id: c.id, body: c.body || '', author: c.user?.login || null,
                }));
            }

            if (prInfo.platform === 'gitlab') {
                const { owner, repo, mrNumber, projectPath } = prInfo;
                const projectId = encodeURIComponent(projectPath || `${owner}/${repo}`);
                const resp = await fetch(
                    `${this.gitlabApiFor(prInfo)}/projects/${projectId}/merge_requests/${mrNumber}/notes?per_page=100&sort=asc`,
                    { headers: this.gitlabToken ? { 'PRIVATE-TOKEN': this.gitlabToken } : {} },
                );
                if (!resp.ok) return [];
                return ((await resp.json()) || [])
                    // System notes ("added 3 commits") are not comments and can
                    // never be ours.
                    .filter(n => n && n.system !== true)
                    .map(n => ({ id: n.id, body: n.body || '', author: n.author?.username || null }));
            }
        } catch (e) {
            console.warn('Could not read PR comments:', e.message);
        }
        return [];
    }

    /**
     * Edit one existing top-level comment.
     *
     * @param {string} url
     * @param {string|number} commentId
     * @param {string} body
     */
    async updateIssueComment(url, commentId, body) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) throw new Error(`Unsupported PR URL: ${url}`);

        if (prInfo.platform === 'github') {
            const { owner, repo } = prInfo;
            if (!this.githubToken) throw new Error('GitHub token required to update a comment');
            const resp = await fetch(
                `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/issues/comments/${commentId}`,
                {
                    method: 'PATCH',
                    headers: {
                        Accept: 'application/vnd.github.v3+json',
                        Authorization: `token ${this.githubToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ body }),
                },
            );
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(`GitHub API error (${resp.status}): ${err.message || resp.statusText}`);
            }
            return { success: true, platform: 'github', updated: commentId };
        }

        if (prInfo.platform === 'gitlab') {
            const { owner, repo, mrNumber, projectPath } = prInfo;
            if (!this.gitlabToken) throw new Error('GitLab token required to update a note');
            const projectId = encodeURIComponent(projectPath || `${owner}/${repo}`);
            const resp = await fetch(
                `${this.gitlabApiFor(prInfo)}/projects/${projectId}/merge_requests/${mrNumber}/notes/${commentId}`,
                {
                    method: 'PUT',
                    headers: { 'PRIVATE-TOKEN': this.gitlabToken, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ body }),
                },
            );
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(`GitLab API error (${resp.status}): ${err.message || resp.statusText}`);
            }
            return { success: true, platform: 'gitlab', updated: commentId };
        }

        throw new Error(`Updating a comment is not supported for: ${prInfo.platform}`);
    }

    // ==========================================
    // External scanner reports (SARIF / rdjson)
    // ==========================================

    /**
     * Annotations from every check run on a commit (GitHub only).
     *
     * This is the zero-configuration source of deterministic findings: any CI
     * check that reports annotations already exposes them here — reviewdog's
     * `github-pr-check` reporter, CodeQL uploads, Actions problem matchers.
     *
     * Two API calls per check run (list runs, then annotations per run), so it is
     * capped: a repo with thirty checks is not worth sixty calls on a review's
     * critical path, and the checks that annotate are almost always the first few.
     *
     * Never throws — an unreadable check list yields [].
     *
     * @param {string} url
     * @param {string|null} sha - the commit to read; the PR head when omitted
     * @returns {Promise<Array<{path,startLine,endLine,level,title,message,checkName,detailsUrl}>>}
     */
    async fetchCheckAnnotations(url, sha = null) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo || prInfo.platform !== 'github') return [];

        const { owner, repo } = prInfo;
        const api = this.githubApiFor(prInfo);
        const headers = {
            Accept: 'application/vnd.github.v3+json',
            ...(this.githubToken ? { Authorization: `token ${this.githubToken}` } : {}),
        };

        const MAX_RUNS = 10;
        const MAX_ANNOTATIONS = 200;

        try {
            let ref = sha;
            if (!ref) {
                const pr = await fetch(`${api}/repos/${owner}/${repo}/pulls/${prInfo.prNumber}`, { headers });
                if (!pr.ok) return [];
                ref = (await pr.json())?.head?.sha;
            }
            if (!ref) return [];

            const runsResp = await fetch(
                `${api}/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=${MAX_RUNS}`,
                { headers },
            );
            if (!runsResp.ok) return [];

            const runs = (await runsResp.json())?.check_runs || [];
            const out = [];

            for (const run of runs) {
                if (out.length >= MAX_ANNOTATIONS) break;
                // `output.annotations_count` saves a call per check that has none,
                // which is most of them.
                if (!run?.id || !run?.output?.annotations_count) continue;

                try {
                    const annResp = await fetch(
                        `${api}/repos/${owner}/${repo}/check-runs/${run.id}/annotations?per_page=100`,
                        { headers },
                    );
                    if (!annResp.ok) continue;

                    for (const a of (await annResp.json()) || []) {
                        if (out.length >= MAX_ANNOTATIONS) break;
                        out.push({
                            path: a.path || null,
                            startLine: Number.isInteger(a.start_line) ? a.start_line : null,
                            endLine: Number.isInteger(a.end_line) ? a.end_line : null,
                            level: a.annotation_level || null,
                            title: a.title || null,
                            message: a.message || null,
                            checkName: run.name || null,
                            detailsUrl: run.details_url || run.html_url || null,
                        });
                    }
                } catch (e) {
                    console.warn(`Check annotations for run ${run.id}: ${e.message}`);
                }
            }

            return out;
        } catch (e) {
            console.warn('Failed to fetch check annotations:', e.message);
            return [];
        }
    }

    /**
     * One file out of a CI job's artifacts.
     *
     * GitLab only, and deliberately so. GitLab serves a single artifact file by
     * path (`/jobs/:id/artifacts/:path`), which is a plain fetch. GitHub only
     * serves artifacts as a ZIP of the whole upload, which an MV3 service worker
     * cannot unpack without shipping an inflate implementation — and GitHub users
     * have `fetchCheckAnnotations`, which needs no configuration at all. Adding a
     * ZIP decoder to serve a source that is already covered is not worth the
     * bundle.
     *
     * The artifact is taken from the pipeline for `ref` (the head SHA under
     * review). An artifact from an older pipeline describes code that is not in
     * this diff.
     *
     * @param {string} url
     * @param {Object} opts - {job, path, ref}
     * @returns {Promise<string>} the file's text
     */
    async fetchJobArtifact(url, { job = null, path, ref = null } = {}) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) throw new Error(`Unsupported PR URL: ${url}`);
        if (prInfo.platform !== 'gitlab') {
            throw new Error('Artifact fetching is GitLab-only; GitHub findings come from check annotations');
        }
        if (!path) throw new Error('An artifact path is required');
        if (!this.gitlabToken) throw new Error('GitLab token required to read job artifacts');

        const { owner, repo, projectPath, mrNumber } = prInfo;
        const api = this.gitlabApiFor(prInfo);
        const projectId = encodeURIComponent(projectPath || `${owner}/${repo}`);
        const headers = { 'PRIVATE-TOKEN': this.gitlabToken };

        // Find the pipeline for the commit under review. Falling back to "latest
        // pipeline" would silently read an artifact built from different code.
        let pipelineId = null;

        if (ref) {
            const byShaResp = await fetch(
                `${api}/projects/${projectId}/pipelines?sha=${encodeURIComponent(ref)}&per_page=1`,
                { headers },
            );
            if (byShaResp.ok) {
                const list = await byShaResp.json();
                pipelineId = Array.isArray(list) && list[0]?.id ? list[0].id : null;
            }
        }

        if (!pipelineId) {
            // MR pipelines can be attached to a merge-result commit that is not
            // the source-branch SHA, so the MR's own head_pipeline is the fallback
            // rather than the project's latest.
            const mrResp = await fetch(
                `${api}/projects/${projectId}/merge_requests/${mrNumber}`,
                { headers },
            );
            if (!mrResp.ok) throw new Error(`Could not read MR pipeline (${mrResp.status})`);
            pipelineId = (await mrResp.json())?.head_pipeline?.id || null;
        }

        if (!pipelineId) throw new Error('No pipeline found for this MR');

        const jobsResp = await fetch(
            `${api}/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`,
            { headers },
        );
        if (!jobsResp.ok) throw new Error(`Could not list pipeline jobs (${jobsResp.status})`);

        const jobs = await jobsResp.json();
        if (!Array.isArray(jobs) || !jobs.length) throw new Error('Pipeline has no jobs');

        // Named job, or the most recent job that produced any artifacts.
        const target = job
            ? jobs.find(j => j?.name === job)
            : jobs.find(j => Array.isArray(j?.artifacts) && j.artifacts.length);

        if (!target?.id) {
            throw new Error(job ? `No job named "${job}" in the pipeline` : 'No job with artifacts');
        }

        const artifactResp = await fetch(
            `${api}/projects/${projectId}/jobs/${target.id}/artifacts/${path.split('/').map(encodeURIComponent).join('/')}`,
            { headers },
        );
        if (!artifactResp.ok) {
            throw new Error(`Artifact "${path}" not found in job "${target.name}" (${artifactResp.status})`);
        }

        return await artifactResp.text();
    }

    /**
     * Replace the PR/MR label set.
     *
     * Both hosts model labels as a full-set write, not an append — there is no
     * "add one label" endpoint on the MR resource — so callers must pass the
     * labels they want to KEEP as well. `LabelGeneratorService.apply` does that
     * merge; going through it is what stops a review from deleting a triager's
     * own labels.
     *
     * @param {string} url
     * @param {string[]} labels - the complete desired set
     */
    async setLabels(url, labels = []) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) throw new Error(`Unsupported PR URL: ${url}`);

        const clean = [...new Set(
            (labels || []).map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
        )];

        if (prInfo.platform === 'github') {
            const { owner, repo, prNumber } = prInfo;
            if (!this.githubToken) throw new Error('GitHub token required to set labels');
            // Labels live on the ISSUE resource, not the pull resource — a PATCH
            // to /pulls/:n silently ignores a `labels` field.
            const response = await fetch(
                `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/issues/${prNumber}/labels`,
                {
                    method: 'PUT',
                    headers: {
                        'Accept': 'application/vnd.github.v3+json',
                        'Authorization': `token ${this.githubToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ labels: clean })
                }
            );
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`GitHub API error (${response.status}): ${err.message || response.statusText}`);
            }
            return { success: true, platform: 'github', labels: clean };
        }

        if (prInfo.platform === 'gitlab') {
            const { owner, repo, mrNumber, projectPath } = prInfo;
            if (!this.gitlabToken) throw new Error('GitLab token required to set labels');
            const encodedProject = encodeURIComponent(projectPath || `${owner}/${repo}`);
            const response = await fetch(
                `${this.gitlabApiFor(prInfo)}/projects/${encodedProject}/merge_requests/${mrNumber}`,
                {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'PRIVATE-TOKEN': this.gitlabToken
                    },
                    // GitLab takes a comma-separated string here, not an array.
                    body: JSON.stringify({ labels: clean.join(',') })
                }
            );
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`GitLab API error (${response.status}): ${err.message || response.statusText}`);
            }
            return { success: true, platform: 'gitlab', labels: clean };
        }

        throw new Error(`Setting labels not supported for: ${prInfo.platform}`);
    }

    async updateGitHubPRDescription(prInfo, description) {
        const { owner, repo, prNumber } = prInfo;
        if (!this.githubToken) throw new Error('GitHub token required to update PR description');

        const response = await fetch(
            `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/pulls/${prNumber}`,
            {
                method: 'PATCH',
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${this.githubToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ body: description })
            }
        );

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`GitHub API error (${response.status}): ${err.message || response.statusText}`);
        }

        return { success: true, platform: 'github' };
    }

    async updateGitLabMRDescription(prInfo, description) {
        const { owner, repo, mrNumber, projectPath } = prInfo;
        if (!this.gitlabToken) throw new Error('GitLab token required to update MR description');

        const encodedProject = encodeURIComponent(projectPath || `${owner}/${repo}`);
        const response = await fetch(
            `${this.gitlabApiFor(prInfo)}/projects/${encodedProject}/merge_requests/${mrNumber}`,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'PRIVATE-TOKEN': this.gitlabToken
                },
                body: JSON.stringify({ description })
            }
        );

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`GitLab API error (${response.status}): ${err.message || response.statusText}`);
        }

        return { success: true, platform: 'gitlab' };
    }

    // ==========================================
    // PR Comment Posting Methods
    // ==========================================

    /**
     * Fetch full file content (not just patch/diff) for a PR file
     * This enables deeper analysis by providing complete file context
     * @param {string} prUrl - PR URL
     * @param {string} filePath - File path within the repo
     * @param {string} ref - Git ref (branch/commit) to fetch from
     * @returns {Object} { content, filePath }
     */
    async fetchFullFileContent(prUrl, filePath, ref = null) {
        const prInfo = this.parsePullRequestUrl(prUrl);
        if (!prInfo) throw new Error('Invalid PR URL');

        if (prInfo.platform === 'github') {
            const { owner, repo } = prInfo;
            const headers = {
                'Accept': 'application/vnd.github.v3.raw',
                ...(this.githubToken ? { 'Authorization': `token ${this.githubToken}` } : {})
            };
            const url = `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}${ref ? `?ref=${ref}` : ''}`;
            const response = await fetch(url, { headers });
            if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
            const content = await response.text();
            return { content, filePath };
        } else if (prInfo.platform === 'gitlab') {
            const { owner, repo, projectPath: fullProjectPath } = prInfo;
            const projectPath = encodeURIComponent(fullProjectPath || `${owner}/${repo}`);
            const encodedPath = encodeURIComponent(filePath);
            const headers = this.gitlabToken ? { 'PRIVATE-TOKEN': this.gitlabToken } : {};
            // NOTE: the 'main' fallback returns the TARGET branch's version of the file,
            // not the merge request's — callers should always pass an explicit ref.
            // ReviewFileContextService already does this.
            const url = `${gitlabApiBase(prUrl)}/projects/${projectPath}/repository/files/${encodedPath}/raw${ref ? `?ref=${ref}` : '?ref=main'}`;
            const response = await fetch(url, { headers });
            if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
            const content = await response.text();
            return { content, filePath };
        }

        throw new Error(`Unsupported platform: ${prInfo.platform}`);
    }

    /**
     * Enhance PR files data with full file content for key files
     * Fetches full content for modified files (not added/deleted) up to a limit
     * @param {string} prUrl - PR URL
     * @param {Array} files - PR files array
     * @param {Object} options - { maxFiles, ref }
     * @returns {Array} Enhanced files array with fullContent property
     */
    async enhanceFilesWithFullContent(prUrl, files, options = {}) {
        const { maxFiles = 10, ref = null } = options;

        // Prioritize modified files (most benefit from full context)
        const modifiedFiles = files
            .filter(f => f.status === 'modified' && !f.filename?.endsWith('.lock'))
            .slice(0, maxFiles);

        const enhanced = await Promise.allSettled(
            modifiedFiles.map(async (file) => {
                try {
                    const result = await this.fetchFullFileContent(prUrl, file.filename, ref);
                    return { filename: file.filename, fullContent: result.content };
                } catch (err) {
                    console.warn(`Failed to fetch full content for ${file.filename}:`, err.message);
                    return { filename: file.filename, fullContent: null };
                }
            })
        );

        // Merge full content back into files array
        const contentMap = new Map();
        for (const result of enhanced) {
            if (result.status === 'fulfilled' && result.value.fullContent) {
                contentMap.set(result.value.filename, result.value.fullContent);
            }
        }

        return files.map(f => ({
            ...f,
            fullContent: contentMap.get(f.filename) || null
        }));
    }

    /**
     * Post a review to a PR (summary comment + optional inline comments)
     * @param {string} url - PR URL
     * @param {Object} options - { summary, inlineComments, event }
     * @returns {Object} Result with posted comment IDs
     */
    async postReview(url, options = {}) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) {
            throw new Error(`Unsupported PR URL: ${url}`);
        }

        if (prInfo.platform === 'github') {
            return this.postGitHubReview(prInfo, options);
        } else if (prInfo.platform === 'gitlab') {
            return this.postGitLabReview(prInfo, options);
        }

        throw new Error(`Posting comments is not supported for platform: ${prInfo.platform}`);
    }

    /**
     * Post a review to GitHub PR
     * Uses the Pull Request Review API for atomic summary + inline comments
     */
    async postGitHubReview(prInfo, options = {}) {
        const { owner, repo, prNumber } = prInfo;
        const { summary, inlineComments = [], event = 'COMMENT' } = options;

        if (!this.githubToken) {
            throw new Error('GitHub token is required to post PR comments. Add it in Settings.');
        }

        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `token ${this.githubToken}`,
            'Content-Type': 'application/json'
        };

        const toApiComment = (c) => ({
            path: c.path,
            line: c.line,
            side: 'RIGHT',
            body: c.body,
            ...(c.startLine ? { start_line: c.startLine, start_side: 'RIGHT' } : {})
        });

        const apiBase = this.githubApiFor(prInfo);
        const reviewsUrl = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

        const submit = async (comments) => {
            const response = await fetch(reviewsUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    body: summary || '',
                    event,
                    comments: comments.map(toApiComment)
                })
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const err = new Error(`GitHub API error (${response.status}): ${errorData.message || response.statusText}`);
                err.status = response.status;
                err.details = errorData;
                throw err;
            }
            return response.json();
        };

        // The Reviews API is atomic: ONE comment on a line outside the diff 422s
        // the whole request, losing the summary too. The formatter validates line
        // positions up front, but a race (a push between fetch and post) or an
        // unparsed patch can still slip through — so on a 422 we degrade to
        // summary-only rather than losing the entire review, then re-attach the
        // comments individually so the good ones still land.
        let result;
        let rejectedComments = [];
        try {
            result = await submit(inlineComments);
        } catch (e) {
            if (e.status !== 422 || inlineComments.length === 0) throw e;
            console.warn(`GitHub rejected the batched review (${e.details?.message || '422'}); falling back to summary + per-comment posting`);
            result = await submit([]);
            rejectedComments = inlineComments;
        }

        let commentsPosted = rejectedComments.length ? 0 : inlineComments.length;

        if (rejectedComments.length) {
            const commentsUrl = `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
            const commitId = await this._getGitHubHeadSha(owner, repo, prNumber, headers, apiBase).catch(() => null);
            for (const c of rejectedComments) {
                try {
                    const resp = await fetch(commentsUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ ...toApiComment(c), commit_id: commitId })
                    });
                    if (resp.ok) commentsPosted++;
                    else console.warn(`Skipped inline comment on ${c.path}:${c.line} (${resp.status})`);
                } catch (err) {
                    console.warn(`Skipped inline comment on ${c.path}:${c.line}:`, err.message);
                }
            }
        }

        return {
            success: true,
            platform: 'github',
            reviewId: result.id,
            htmlUrl: result.html_url,
            commentsPosted,
            commentsAttempted: inlineComments.length,
            degraded: rejectedComments.length > 0,
            hasSummary: !!summary
        };
    }

    /**
     * Inline discussions on THIS PR that were started by one of our own comments,
     * each with its thread replies.
     *
     * This is the read side of the feedback flywheel: the bot note carries the
     * tick-box footer, the replies carry the author's reasoning. Mirrors
     * pr-agent's `fetch_bot_inline_discussions`.
     *
     * Returns `[]` on any failure — a feedback outage must never block a review.
     *
     * @param {string} url - PR/MR URL
     * @param {string} marker - substring identifying our comments (the footer marker)
     * @returns {Promise<Array<{
     *   botNote: {id, body, author, createdAt},
     *   replies: Array<{id, body, author, createdAt}>,
     *   file: string|null, line: number|null
     * }>>}
     */
    async fetchBotInlineDiscussions(url, marker) {
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo || !marker) return [];

        try {
            if (prInfo.platform === 'gitlab') return await this._fetchGitLabBotDiscussions(prInfo, marker);
            if (prInfo.platform === 'github') return await this._fetchGitHubBotDiscussions(prInfo, marker);
        } catch (e) {
            console.warn('[Feedback] Could not fetch bot discussions:', e.message);
        }
        return [];
    }

    async _fetchGitLabBotDiscussions(prInfo, marker) {
        if (!this.gitlabToken) return [];
        const project = encodeURIComponent(prInfo.projectPath || `${prInfo.owner}/${prInfo.repo}`);
        const headers = { 'PRIVATE-TOKEN': this.gitlabToken };

        // GitLab models a thread as a `discussion` with an ordered `notes` array —
        // the first note starts the thread, the rest are replies. That structure
        // is exactly what we need, so no reply-stitching is required here.
        const discussions = await this.fetchAllPagesGitLab(
            `${this.gitlabApiFor(prInfo)}/projects/${project}/merge_requests/${prInfo.mrNumber}/discussions?per_page=100`,
            headers
        );

        const out = [];
        for (const d of discussions || []) {
            const notes = d?.notes || [];
            if (!notes.length) continue;

            const first = notes[0];
            if (!first?.body?.includes(marker)) continue;

            out.push({
                discussionId: d.id,
                botNote: {
                    id: first.id,
                    body: first.body || '',
                    author: first.author?.username || '',
                    authorId: first.author?.id ?? null,
                    createdAt: first.created_at,
                },
                replies: notes.slice(1).map(n => ({
                    id: n.id,
                    body: n.body || '',
                    author: n.author?.username || '',
                    authorId: n.author?.id ?? null,
                    createdAt: n.created_at,
                    system: n.system || false,
                })),
                file: first.position?.new_path || first.position?.old_path || null,
                line: first.position?.new_line ?? first.position?.old_line ?? null,
                resolved: !!d.notes?.[0]?.resolved,
            });
        }
        return out;
    }

    async _fetchGitHubBotDiscussions(prInfo, marker) {
        if (!this.githubToken) return [];
        const { owner, repo, prNumber } = prInfo;
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `token ${this.githubToken}`,
        };

        // GitHub has no thread object on the REST review-comments API: replies are
        // flat comments carrying `in_reply_to_id`. Stitch them back together.
        const comments = await this.fetchAllPagesGitHub(
            `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
            headers
        );

        const repliesByRoot = new Map();
        for (const c of comments || []) {
            if (c.in_reply_to_id == null) continue;
            const list = repliesByRoot.get(c.in_reply_to_id) || [];
            list.push(c);
            repliesByRoot.set(c.in_reply_to_id, list);
        }

        const out = [];
        for (const c of comments || []) {
            if (c.in_reply_to_id != null) continue;      // a reply, not a thread root
            if (!c.body?.includes(marker)) continue;

            out.push({
                discussionId: c.id,
                botNote: {
                    id: c.id,
                    body: c.body || '',
                    author: c.user?.login || '',
                    authorId: c.user?.id ?? null,
                    createdAt: c.created_at,
                },
                replies: (repliesByRoot.get(c.id) || []).map(r => ({
                    id: r.id,
                    body: r.body || '',
                    author: r.user?.login || '',
                    authorId: r.user?.id ?? null,
                    createdAt: r.created_at,
                    system: false,
                })),
                file: c.path || null,
                line: c.line ?? c.original_line ?? null,
                resolved: false,
            });
        }
        return out;
    }

    /**
     * Review comments across a repository's RECENT merge/pull requests.
     *
     * Feeds ConventionMiner: a team's conventions are only recoverable from what
     * its reviewers have actually asked for. Deliberately bounded — this walks a
     * handful of recent MRs, not the whole history — because it runs in the
     * background of a review and must not turn into a crawl.
     *
     * @param {string} url - any PR/MR URL in the repo
     * @param {object} [opts] - { maxRequests, perRequest }
     * @returns {Promise<Array<{author:string, body:string, file:string|null, line:number|null}>>}
     */
    async fetchReviewComments(url, opts = {}) {
        const { maxRequests = 15 } = opts;
        const prInfo = this.parsePullRequestUrl(url);
        if (!prInfo) return [];

        if (prInfo.platform === 'gitlab') {
            if (!this.gitlabToken) return [];
            const project = encodeURIComponent(prInfo.projectPath || `${prInfo.owner}/${prInfo.repo}`);
            const headers = { 'PRIVATE-TOKEN': this.gitlabToken };
            const listRes = await fetch(
                `${this.gitlabApiFor(prInfo)}/projects/${project}/merge_requests?state=merged&order_by=updated_at&per_page=${maxRequests}`,
                { headers }
            );
            if (!listRes.ok) return [];
            const mrs = await listRes.json();

            const all = await Promise.all((mrs || []).map(async (mr) => {
                try {
                    const r = await fetch(
                        `${this.gitlabApiFor(prInfo)}/projects/${project}/merge_requests/${mr.iid}/notes?per_page=100`,
                        { headers }
                    );
                    if (!r.ok) return [];
                    const notes = await r.json();
                    return (notes || [])
                        .filter(n => !n.system)
                        .map(n => ({
                            author: n.author?.username || '',
                            body: n.body || '',
                            file: n.position?.new_path || n.position?.old_path || null,
                            line: n.position?.new_line ?? n.position?.old_line ?? null,
                        }));
                } catch { return []; }
            }));
            return all.flat();
        }

        if (prInfo.platform === 'github') {
            if (!this.githubToken) return [];
            const { owner, repo } = prInfo;
            const headers = {
                Accept: 'application/vnd.github.v3+json',
                Authorization: `token ${this.githubToken}`,
            };
            // One call gets recent review comments across the whole repo.
            const res = await fetch(
                `${this.githubApiFor(prInfo)}/repos/${owner}/${repo}/pulls/comments?per_page=100&sort=updated&direction=desc`,
                { headers }
            );
            if (!res.ok) return [];
            const comments = await res.json();
            return (comments || []).map(c => ({
                author: c.user?.login || '',
                body: c.body || '',
                file: c.path || null,
                line: c.line ?? c.original_line ?? null,
            }));
        }

        return [];
    }

    /** Head SHA of a PR — required as `commit_id` when posting standalone comments. */
    async _getGitHubHeadSha(owner, repo, prNumber, headers, apiBase = this.githubBaseUrl) {
        const resp = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
        if (!resp.ok) throw new Error(`GitHub API error: ${resp.status}`);
        return (await resp.json())?.head?.sha || null;
    }

    /**
     * Post a review to GitLab MR
     * Posts summary as a note and inline comments as diff notes
     */
    async postGitLabReview(prInfo, options = {}) {
        const { owner, repo, mrNumber, projectPath } = prInfo;
        const { summary, inlineComments = [] } = options;

        if (!this.gitlabToken) {
            throw new Error('GitLab token is required to post MR comments. Add it in Settings.');
        }

        const encodedProject = encodeURIComponent(projectPath || `${owner}/${repo}`);
        const api = this.gitlabApiFor(prInfo);
        const headers = {
            'Content-Type': 'application/json',
            'PRIVATE-TOKEN': this.gitlabToken
        };

        const results = { summaryNoteId: null, inlineNoteIds: [] };

        // Post summary as a general note
        if (summary) {
            const noteResponse = await fetch(
                `${api}/projects/${encodedProject}/merge_requests/${mrNumber}/notes`,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ body: summary })
                }
            );

            if (!noteResponse.ok) {
                const errorData = await noteResponse.json().catch(() => ({}));
                throw new Error(`GitLab API error (${noteResponse.status}): ${errorData.message || noteResponse.statusText}`);
            }

            const noteResult = await noteResponse.json();
            results.summaryNoteId = noteResult.id;
        }

        // GitLab diff notes REQUIRE base_sha/start_sha/head_sha from the MR's
        // diff_refs. These were previously read off each comment object, which
        // never carried them — so `position` was all-undefined and every inline
        // note was rejected with a 400. Fetch the refs once for the whole batch.
        const diffRefs = options.diffRefs
            || await this._getGitLabDiffRefs(encodedProject, mrNumber, headers, api).catch(e => {
                console.warn('Could not fetch GitLab diff_refs; skipping inline notes:', e.message);
                return null;
            });

        // Post inline comments as diff notes
        for (const comment of (diffRefs ? inlineComments : [])) {
            try {
                // GitLab's rule for a text position:
                //   added line     -> new_line only  (old_line MUST be absent)
                //   unchanged line -> both old_line and new_line
                // Sending new_line alone for an unchanged line is a 400, which is
                // how every context-line comment used to be silently lost. The
                // formatter resolves `oldLine` from the patch and leaves it unset
                // for added lines, so presence is the whole decision here.
                const diffNoteBody = {
                    body: comment.body,
                    position: {
                        base_sha: diffRefs.base_sha,
                        start_sha: diffRefs.start_sha,
                        head_sha: diffRefs.head_sha,
                        position_type: 'text',
                        new_path: comment.path,
                        old_path: comment.oldPath || comment.path,
                        new_line: comment.line,
                        ...(comment.oldLine != null ? { old_line: comment.oldLine } : {})
                    }
                };

                const diffResponse = await fetch(
                    `${api}/projects/${encodedProject}/merge_requests/${mrNumber}/discussions`,
                    {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(diffNoteBody)
                    }
                );

                if (diffResponse.ok) {
                    const diffResult = await diffResponse.json();
                    results.inlineNoteIds.push(diffResult.id);
                } else {
                    const err = await diffResponse.json().catch(() => ({}));
                    console.warn(`GitLab rejected inline note on ${comment.path}:${comment.line} (${diffResponse.status}): ${err.message || ''}`);
                }
            } catch (e) {
                console.warn(`Failed to post inline comment on ${comment.path}:${comment.line}:`, e.message);
            }
        }

        return {
            success: true,
            platform: 'gitlab',
            summaryNoteId: results.summaryNoteId,
            inlineNoteIds: results.inlineNoteIds,
            commentsPosted: results.inlineNoteIds.length,
            commentsAttempted: inlineComments.length,
            degraded: !diffRefs && inlineComments.length > 0,
            hasSummary: !!summary
        };
    }

    /** MR diff refs (base/start/head SHA) — mandatory for positioning diff notes. */
    async _getGitLabDiffRefs(encodedProject, mrNumber, headers, apiBase = this.gitlabBaseUrl) {
        const resp = await fetch(
            `${apiBase}/projects/${encodedProject}/merge_requests/${mrNumber}`,
            { headers }
        );
        if (!resp.ok) throw new Error(`GitLab API error: ${resp.status}`);
        const mr = await resp.json();
        if (!mr?.diff_refs?.head_sha) throw new Error('MR response has no diff_refs');
        return mr.diff_refs;
    }

    /**
     * Format analysis findings as a PR review comment body (Markdown)
     */
    formatReviewSummary(analysisResult, aiSummary, options = {}) {
        const { findings = [], summary = {}, riskScore = {}, recommendation } = analysisResult || {};
        const lines = [];

        lines.push('## RepoSpector Analysis');
        lines.push('');

        // AI Summary
        if (aiSummary) {
            lines.push('### Summary');
            lines.push(aiSummary);
            lines.push('');
        }

        // Risk Score
        if (riskScore?.level) {
            const emoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
            lines.push(`**Risk Level:** ${emoji[riskScore.level] || '⚪'} ${riskScore.level.toUpperCase()} (${riskScore.score || 'N/A'}/100)`);
            lines.push('');
        }

        // Recommendation
        if (recommendation) {
            lines.push(`**Recommendation:** ${recommendation}`);
            lines.push('');
        }

        // Findings summary
        if (summary.bySeverity) {
            lines.push('### Findings');
            const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
            const severityEmoji = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: 'ℹ️' };

            for (const sev of severityOrder) {
                const count = summary.bySeverity[sev];
                if (count > 0) {
                    lines.push(`- ${severityEmoji[sev]} **${sev.charAt(0).toUpperCase() + sev.slice(1)}:** ${count}`);
                }
            }
            lines.push('');
        }

        // Top findings (limit to avoid huge comments).
        //
        // Matched the display vocabulary (`critical|high|medium`) literally, so any
        // finding carrying a CANONICAL severity was silently omitted from the table
        // — including every cross-repo impact finding, which is emitted as
        // `blocking`/`suggestion`. Normalize before comparing.
        const maxFindings = options.maxFindings || 25;
        const SUMMARY_SEVERITIES = new Set([
            'critical', 'high', 'medium',          // display
            'blocking', 'blocker', 'error',        // canonical / prose → blocking
            'suggestion', 'warning', 'should',     // canonical / prose → medium
        ]);
        const topFindings = findings
            .filter(f => SUMMARY_SEVERITIES.has(String(f?.severity ?? '').toLowerCase()))
            .slice(0, maxFindings);

        if (topFindings.length > 0) {
            lines.push('### Key Findings');
            lines.push('');
            lines.push('| Severity | File | Line | Issue |');
            lines.push('|----------|------|------|-------|');
            for (const f of topFindings) {
                const fileName = (f.filePath || f.file || 'Unknown').split('/').pop();
                const sev = f.severity?.charAt(0).toUpperCase() + f.severity?.slice(1);
                const msg = (f.message || '').substring(0, 80);
                lines.push(`| ${sev} | \`${fileName}\` | ${f.line || '?'} | ${msg} |`);
            }
            lines.push('');
        }

        lines.push('---');
        lines.push('*Generated by [RepoSpector](https://github.com/nicholasgriffintn/RepoSpector) - AI-powered code analysis*');

        return lines.join('\n');
    }

    /**
     * Format findings as inline review comments.
     *
     * Delegates to the shared formatter, which understands every producer's
     * finding shape (static `filePath`, LLM `file`, per-file containers) and
     * validates each target line against the diff. Pass `prData` (or a prebuilt
     * `commentableLines` map) to enable that validation — without it, an
     * out-of-diff line makes GitHub reject the entire review.
     *
     * @param {Array<Object>} findings
     * @param {Object} options - { maxInlineComments, prData, commentableLines }
     */
    formatInlineComments(findings, options = {}) {
        const commentableLines = options.commentableLines
            || (options.prData?.files ? buildCommentableLineMap(options.prData.files) : null);

        const comments = formatInlineComments(findings, {
            ...options,
            maxInlineComments: options.maxInlineComments || 30,
            commentableLines,
        });

        // Resolve the old-side line for every comment that targets an UNCHANGED
        // line. GitLab rejects a diff note on a context line unless it carries
        // old_line as well as new_line, and those rejections were invisible —
        // one `console.warn` per lost comment. Added lines resolve to null,
        // which is the correct signal to omit the field entirely.
        const patches = new Map(
            (options.prData?.files || [])
                .map(f => [f.filename || f.new_path || f.path, f.patch ?? f.diff ?? ''])
                .filter(([name, patch]) => name && patch)
        );
        if (patches.size === 0) return comments;

        return comments.map((c) => {
            const oldLine = oldLineForNewLine(patches.get(c.path) || '', c.line);
            return oldLine == null ? c : { ...c, oldLine };
        });
    }

    /**
     * Generate fix suggestions for findings using LLM
     * Produces GitHub-compatible suggestion blocks
     * @param {Array} findings - Findings with code context
     * @param {Object} llmService - LLM service instance
     * @param {Object} settings - LLM settings
     * @returns {Array} Findings with suggestedFix property populated
     */
    async generateFixSuggestions(findings, llmService, settings) {
        // Read the location and evidence through the same aliases every other
        // consumer uses. This filtered on `f.filePath` and `f.codeSnippet` only —
        // keys that ONLY static-analysis findings carry — so for verified LLM
        // findings (which use `file`, and carry evidence as `evidence`) the filter
        // matched nothing and this whole pass was dead code. Same bug class the
        // inline formatter documents having already fixed.
        const locationOf = f => f?.filePath || f?.file || f?.path || null;
        const snippetOf = f => f?.codeSnippet || f?.evidence || null;
        const isBlocking = f => ['critical', 'high', 'blocking', 'blocker', 'error']
            .includes(String(f?.severity ?? '').toLowerCase());

        const fixableFindings = findings.filter(f =>
            locationOf(f) && f.line && snippetOf(f) && isBlocking(f)
        ).slice(0, 25); // Limit to control API costs

        for (const finding of fixableFindings) {
            const snippet = snippetOf(finding);
            try {
                const response = await llmService.streamChat(
                    [
                        { role: 'system', content: 'You are a code fixer. Given a code issue, output ONLY the fixed line(s) of code. No explanation, no markdown, no code fences. Just the corrected code that should replace the problematic line.' },
                        { role: 'user', content: `File: ${locationOf(finding)}\nLine ${finding.line}: ${snippet}\n\nIssue: ${finding.message || finding.title || finding.description || ''}\n\nOutput the fixed code:` }
                    ],
                    {
                        provider: settings.provider,
                        model: settings.model,
                        apiKey: settings.apiKey,
                        stream: false,
                        // Metered like every other pass. This loop is up to 25
                        // sequential calls on the user's own key and carried no
                        // budget label, so "Post to PR" could silently cost more
                        // than the review it was posting. OPTIONAL: a suggestion
                        // block is a convenience on top of a finding that is
                        // already written and about to be posted.
                        budgetStage: 'inline-fixes',
                        budgetPriority: PRIORITY.OPTIONAL,
                    }
                );

                const fix = (response.content || response).trim();
                if (fix && fix !== String(snippet).trim()) {
                    finding.suggestedFix = fix;
                }
            } catch (e) {
                // Silently skip failed fix generation
            }
        }

        return findings;
    }
}
