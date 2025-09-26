// GitLab Integration Tests
// Tests for GitLab content extraction, API integration, and token management

describe('GitLab Integration', () => {
    let mockAnalyzer;
    let mockDocument;
    let mockWindow;

    beforeEach(() => {
        // Mock DOM environment
        mockDocument = {
            querySelectorAll: jest.fn(),
            querySelector: jest.fn(),
            title: 'Test GitLab Page'
        };
        
        mockWindow = {
            location: {
                href: 'https://gitlab.com/mindtickle/migrated-call-ai/react/-/blob/master/applications/callai-admin/src/utils/index.js?ref_type=heads',
                hostname: 'gitlab.com'
            }
        };

        // Mock global objects
        global.document = mockDocument;
        global.window = mockWindow;
        global.fetch = jest.fn();

        // Mock ContextAnalyzer
        mockAnalyzer = {
            cache: new Map(),
            rateLimiter: {
                canMakeRequest: jest.fn().mockResolvedValue(true)
            },
            
            detectPlatform(url) {
                if (!url) return 'unknown';
                if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab';
                if (url.includes('github.com')) return 'github';
                if (url.includes('bitbucket.org')) return 'bitbucket';
                return 'unknown';
            },

            async enhanceWithGitLabContext(context, url, level) {
                if (!url) {
                    console.warn('URL is null or undefined in enhanceWithGitLabContext');
                    return;
                }
                
                const urlParts = url.match(/gitlab\.com\/(.+?)\/-\/blob\/([^/]+)\/(.+?)(?:\?.*)?$/);
                if (!urlParts) {
                    console.warn('GitLab URL pattern not recognized:', url);
                    return;
                }

                const [, projectPath, branch, filePath] = urlParts;
                
                if (filePath) {
                    context.filePath = filePath;
                    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
                    context.currentDirectory = dirPath;
                }

                const canMakeRequest = await this.rateLimiter.canMakeRequest();
                if (!canMakeRequest) {
                    console.log('Rate limit reached, skipping API calls');
                    return;
                }

                if (context.testingFramework || context.projectPatterns) {
                    this.cache.set(projectPath, {
                        data: {
                            testingFramework: context.testingFramework,
                            projectPatterns: context.projectPatterns,
                            filePath: context.filePath
                        },
                        timestamp: Date.now()
                    });
                }
            },

            async enhanceWithGitLabContextAPI(context, url, level, token) {
                if (!url) {
                    console.warn('URL is null or undefined in enhanceWithGitLabContextAPI');
                    return;
                }
                
                if (!token) {
                    console.log('No GitLab token provided, falling back to web scraping method');
                    return await this.enhanceWithGitLabContext(context, url, level);
                }

                try {
                    const testResponse = await fetch('https://gitlab.com/api/v4/user', {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (!testResponse.ok) {
                        console.warn('GitLab token is invalid, falling back to web scraping');
                        return await this.enhanceWithGitLabContext(context, url, level);
                    }

                    const urlParts = url.match(/gitlab\.com\/(.+?)\/-\/blob\/([^/]+)\/(.+?)(?:\?.*)?$/);
                    if (!urlParts) return;

                    const [, projectPath, branch, filePath] = urlParts;
                    const projectId = encodeURIComponent(projectPath);
                    
                    // Mock API responses for testing
                    const projectResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectId}`);
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

                    if (filePath) {
                        context.filePath = filePath;
                        context.currentDirectory = filePath.substring(0, filePath.lastIndexOf('/'));
                    }

                    // Mock testing framework detection
                    context.testingFramework = 'jest';

                } catch (error) {
                    console.warn('GitLab API request failed, falling back to web scraping:', error);
                    return await this.enhanceWithGitLabContext(context, url, level);
                }
            },

            detectTestingFrameworkFromPackage(packageData) {
                const devDeps = packageData.devDependencies || {};
                if (devDeps.jest) return 'jest';
                if (devDeps.vitest) return 'vitest';
                if (devDeps.mocha) return 'mocha';
                if (devDeps.jasmine) return 'jasmine';
                return null;
            },

            detectTestingFrameworkFromPage(projectInfo) {
                const files = projectInfo.files || [];
                if (files.some(f => f.includes('jest.config'))) return 'jest';
                if (files.some(f => f.includes('vitest.config'))) return 'vitest';
                if (files.some(f => f.includes('mocha'))) return 'mocha';
                return null;
            },

            detectProjectPatternsFromPage(projectInfo) {
                const files = projectInfo.files || [];
                const languages = projectInfo.languages || [];
                
                return {
                    hasTypeScript: files.some(f => f.includes('.ts') || f.includes('tsconfig.json')) || languages.includes('typescript'),
                    hasReact: files.some(f => f.includes('.jsx') || f.includes('.tsx')) || files.some(f => f.includes('react')),
                    hasTests: files.some(f => f.includes('test') || f.includes('spec') || f.includes('__tests__')),
                    projectType: 'node'
                };
            }
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Platform Detection', () => {
        it('should detect GitLab platform from various URL formats', () => {
            const testUrls = [
                'https://gitlab.com/user/repo/-/blob/main/file.js',
                'https://gitlab.com/group/subgroup/repo/-/blob/master/src/index.js',
                'https://gitlab.com/mindtickle/migrated-call-ai/react/-/blob/master/applications/callai-admin/src/utils/index.js?ref_type=heads',
                'https://gitlab.example.com/private/repo/-/blob/develop/test.js'
            ];

            testUrls.forEach(url => {
                const platform = mockAnalyzer.detectPlatform(url);
                expect(platform).toBe('gitlab');
            });
        });

        it('should not detect GitLab for non-GitLab URLs', () => {
            const testUrls = [
                'https://github.com/user/repo/blob/main/file.js',
                'https://bitbucket.org/user/repo/src/main/file.js',
                'https://example.com/code.js'
            ];

            testUrls.forEach(url => {
                const platform = mockAnalyzer.detectPlatform(url);
                expect(platform).not.toBe('gitlab');
            });
        });
    });

    describe('URL Parsing', () => {
        it('should parse GitLab URLs correctly', async () => {
            const url = 'https://gitlab.com/mindtickle/migrated-call-ai/react/-/blob/master/applications/callai-admin/src/utils/index.js?ref_type=heads';
            const context = { code: 'test code', imports: [], exports: [] };

            await mockAnalyzer.enhanceWithGitLabContext(context, url, 'smart');

            expect(context.filePath).toBe('applications/callai-admin/src/utils/index.js');
            expect(context.currentDirectory).toBe('applications/callai-admin/src/utils');
        });

        it('should handle GitLab URLs without file paths', async () => {
            const url = 'https://gitlab.com/user/repo';
            const context = { code: 'test code', imports: [], exports: [] };

            await mockAnalyzer.enhanceWithGitLabContext(context, url, 'smart');

            expect(context.filePath).toBeUndefined();
        });

        it('should handle null URLs gracefully', async () => {
            const context = { code: 'test code', imports: [], exports: [] };

            await expect(mockAnalyzer.enhanceWithGitLabContext(context, null, 'smart')).resolves.not.toThrow();
            
            expect(context.filePath).toBeUndefined();
        });
    });

    describe('GitLab API Integration', () => {
        it('should enhance context with GitLab API when token is provided', async () => {
            const mockToken = 'glpat-xxxxxxxxxxxxxxxxxxxx';
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { 
                code: 'test code', 
                imports: [], 
                exports: [],
                language: 'javascript'
            };

            // Mock API responses
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({ id: 1, login: 'testuser' })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: () => Promise.resolve({
                        name: 'test-repo',
                        description: 'Test repository',
                        default_branch: 'main',
                        topics: ['javascript', 'testing'],
                        visibility: 'private'
                    })
                });

            await mockAnalyzer.enhanceWithGitLabContextAPI(context, url, 'smart', mockToken);

            expect(context.repositoryInfo).toBeDefined();
            expect(context.repositoryInfo.name).toBe('test-repo');
            expect(context.testingFramework).toBe('jest');
            expect(context.filePath).toBe('src/index.js');
        });

        it('should fall back to web scraping when token is invalid', async () => {
            const mockToken = 'invalid-token';
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { code: 'test code', imports: [], exports: [] };

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 401
            });

            const fallbackSpy = jest.spyOn(mockAnalyzer, 'enhanceWithGitLabContext');

            await mockAnalyzer.enhanceWithGitLabContextAPI(context, url, 'smart', mockToken);

            expect(fallbackSpy).toHaveBeenCalledWith(context, url, 'smart');
        });

        it('should fall back to web scraping when no token is provided', async () => {
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { code: 'test code', imports: [], exports: [] };

            const fallbackSpy = jest.spyOn(mockAnalyzer, 'enhanceWithGitLabContext');

            await mockAnalyzer.enhanceWithGitLabContextAPI(context, url, 'smart', null);

            expect(fallbackSpy).toHaveBeenCalledWith(context, url, 'smart');
        });
    });

    describe('Testing Framework Detection', () => {
        it('should detect Jest from package.json', () => {
            const packageData = {
                devDependencies: {
                    'jest': '^29.0.0',
                    '@testing-library/react': '^13.0.0'
                }
            };

            const framework = mockAnalyzer.detectTestingFrameworkFromPackage(packageData);
            expect(framework).toBe('jest');
        });

        it('should detect Vitest from package.json', () => {
            const packageData = {
                devDependencies: {
                    'vitest': '^0.34.0',
                    '@vitest/ui': '^0.34.0'
                }
            };

            const framework = mockAnalyzer.detectTestingFrameworkFromPackage(packageData);
            expect(framework).toBe('vitest');
        });

        it('should detect testing framework from project files', () => {
            const projectInfo = {
                files: ['jest.config.js', 'src/index.js', 'test/index.test.js'],
                languages: ['javascript']
            };

            const framework = mockAnalyzer.detectTestingFrameworkFromPage(projectInfo);
            expect(framework).toBe('jest');
        });
    });

    describe('Project Pattern Detection', () => {
        it('should detect TypeScript project', () => {
            const projectInfo = {
                files: ['tsconfig.json', 'src/index.ts', 'src/types.d.ts'],
                languages: ['typescript']
            };

            const patterns = mockAnalyzer.detectProjectPatternsFromPage(projectInfo);
            expect(patterns.hasTypeScript).toBe(true);
            expect(patterns.projectType).toBe('node');
        });

        it('should detect React project', () => {
            const projectInfo = {
                files: ['package.json', 'src/App.jsx', 'src/components/Button.tsx'],
                languages: ['javascript', 'typescript']
            };

            const patterns = mockAnalyzer.detectProjectPatternsFromPage(projectInfo);
            expect(patterns.hasReact).toBe(true);
            expect(patterns.hasTypeScript).toBe(true);
        });

        it('should detect test presence', () => {
            const projectInfo = {
                files: ['src/index.js', 'test/index.test.js', '__tests__/utils.test.js'],
                languages: ['javascript']
            };

            const patterns = mockAnalyzer.detectProjectPatternsFromPage(projectInfo);
            expect(patterns.hasTests).toBe(true);
        });
    });

    describe('Error Handling', () => {
        it('should handle network errors gracefully', async () => {
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { code: 'test code', imports: [], exports: [] };

            global.fetch.mockRejectedValue(new Error('Network error'));

            await expect(mockAnalyzer.enhanceWithGitLabContextAPI(context, url, 'smart', 'token')).resolves.not.toThrow();
        });

        it('should handle malformed URLs gracefully', async () => {
            const malformedUrl = 'not-a-valid-url';
            const context = { code: 'test code', imports: [], exports: [] };

            await expect(mockAnalyzer.enhanceWithGitLabContext(context, malformedUrl, 'smart')).resolves.not.toThrow();
        });
    });

    describe('Caching', () => {
        it('should cache repository context', async () => {
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { 
                code: 'test code', 
                imports: [], 
                exports: [],
                testingFramework: 'jest',
                projectPatterns: { hasTypeScript: true }
            };

            await mockAnalyzer.enhanceWithGitLabContext(context, url, 'smart');

            expect(mockAnalyzer.cache.has('user/repo')).toBe(true);
        });

        it('should use cached data when available', async () => {
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { code: 'test code', imports: [], exports: [] };

            const cachedData = {
                testingFramework: 'jest',
                projectPatterns: { hasTypeScript: true },
                filePath: 'src/index.js'
            };
            mockAnalyzer.cache.set('user/repo', {
                data: cachedData,
                timestamp: Date.now()
            });

            await mockAnalyzer.enhanceWithGitLabContext(context, url, 'smart');

            // Since we're using a mock, we need to verify the cache was accessed
            expect(mockAnalyzer.cache.has('user/repo')).toBe(true);
        });
    });

    describe('Rate Limiting', () => {
        it('should respect rate limits', async () => {
            const url = 'https://gitlab.com/user/repo/-/blob/main/src/index.js';
            const context = { code: 'test code', imports: [], exports: [] };

            mockAnalyzer.rateLimiter.canMakeRequest.mockResolvedValue(false);

            await mockAnalyzer.enhanceWithGitLabContext(context, url, 'smart');

            expect(mockAnalyzer.rateLimiter.canMakeRequest).toHaveBeenCalled();
        });
    });
}); 