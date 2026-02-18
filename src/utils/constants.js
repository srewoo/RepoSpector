// Enhanced constants with multi-LLM support and comprehensive configuration

const LLM_PROVIDERS = {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    COHERE: 'cohere',
    MISTRAL: 'mistral',
    PERPLEXITY: 'perplexity',
    GROQ: 'groq',
    HUGGINGFACE: 'huggingface',
    LOCAL: 'local'
};

const API_ENDPOINTS = {
    [LLM_PROVIDERS.OPENAI]: {
        baseUrl: 'https://api.openai.com/v1',
        chat: 'https://api.openai.com/v1/chat/completions',
        models: 'https://api.openai.com/v1/models'
    },
    [LLM_PROVIDERS.ANTHROPIC]: {
        baseUrl: 'https://api.anthropic.com/v1',
        chat: 'https://api.anthropic.com/v1/messages',
        models: 'https://api.anthropic.com/v1/models'
    },
    [LLM_PROVIDERS.GOOGLE]: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        chat: 'https://generativelanguage.googleapis.com/v1beta/models/{{model}}:generateContent',
        models: 'https://generativelanguage.googleapis.com/v1beta/models'
    },
    [LLM_PROVIDERS.COHERE]: {
        baseUrl: 'https://api.cohere.ai/v1',
        chat: 'https://api.cohere.ai/v1/chat',
        models: 'https://api.cohere.ai/v1/models'
    },
    [LLM_PROVIDERS.MISTRAL]: {
        baseUrl: 'https://api.mistral.ai/v1',
        chat: 'https://api.mistral.ai/v1/chat/completions',
        models: 'https://api.mistral.ai/v1/models'
    },
    [LLM_PROVIDERS.PERPLEXITY]: {
        baseUrl: 'https://api.perplexity.ai',
        chat: 'https://api.perplexity.ai/chat/completions',
        models: 'https://api.perplexity.ai/models'
    },
    [LLM_PROVIDERS.GROQ]: {
        baseUrl: 'https://api.groq.com/openai/v1',
        chat: 'https://api.groq.com/openai/v1/chat/completions',
        models: 'https://api.groq.com/openai/v1/models'
    },
    [LLM_PROVIDERS.HUGGINGFACE]: {
        baseUrl: 'https://api-inference.huggingface.co',
        chat: 'https://api-inference.huggingface.co/models/{{model}}',
        models: 'https://api-inference.huggingface.co/models'
    },
    [LLM_PROVIDERS.LOCAL]: {
        baseUrl: 'http://localhost:11434',
        chat: 'http://localhost:11434/api/chat',
        models: 'http://localhost:11434/api/tags'
    },
    GITHUB_API: 'https://api.github.com',
    GITLAB_API: 'https://gitlab.com/api/v4',
    BITBUCKET_API: 'https://api.bitbucket.org/2.0',
    AZURE_API: 'https://dev.azure.com',
    CODEBERG_API: 'https://codeberg.org/api/v1'
};

const MODELS = {
    // OpenAI Models (Latest 2024-2025)
    'openai:gpt-4.1': {
        name: 'GPT-4.1',
        provider: LLM_PROVIDERS.OPENAI,
        modelId: 'gpt-4.1',
        maxTokens: 16384,
        contextWindow: 128000,
        costPer1kTokens: { input: 0.0025, output: 0.01 },
        supportsImages: true,
        supportsCode: true,
        quality: 'premium'
    },
    'openai:gpt-4.1-mini': {
        name: 'GPT-4.1 Mini',
        provider: LLM_PROVIDERS.OPENAI,
        modelId: 'gpt-4.1-mini',
        maxTokens: 16384,
        contextWindow: 128000,
        costPer1kTokens: { input: 0.00015, output: 0.0006 },
        supportsImages: true,
        supportsCode: true,
        quality: 'high'
    },
    'openai:o1-mini': {
        name: 'o1-mini (Reasoning)',
        provider: LLM_PROVIDERS.OPENAI,
        modelId: 'o1-mini',
        maxTokens: 65536,
        contextWindow: 128000,
        costPer1kTokens: { input: 0.003, output: 0.012 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        reasoning: true
    },

    // Anthropic Models (Latest 2024-2025)
    'anthropic:claude-sonnet-4': {
        name: 'Claude Sonnet 4',
        provider: LLM_PROVIDERS.ANTHROPIC,
        modelId: 'claude-sonnet-4-20250514',
        maxTokens: 16000,
        contextWindow: 200000,
        costPer1kTokens: { input: 0.003, output: 0.015 },
        supportsImages: true,
        supportsCode: true,
        quality: 'premium'
    },
    'anthropic:claude-3.5-haiku': {
        name: 'Claude 3.5 Haiku',
        provider: LLM_PROVIDERS.ANTHROPIC,
        modelId: 'claude-3-5-haiku-20241022',
        maxTokens: 8192,
        contextWindow: 200000,
        costPer1kTokens: { input: 0.0008, output: 0.004 },
        supportsImages: true,
        supportsCode: true,
        quality: 'high'
    },
    'anthropic:claude-opus-4': {
        name: 'Claude Opus 4',
        provider: LLM_PROVIDERS.ANTHROPIC,
        modelId: 'claude-opus-4-20250514',
        maxTokens: 16000,
        contextWindow: 200000,
        costPer1kTokens: { input: 0.015, output: 0.075 },
        supportsImages: true,
        supportsCode: true,
        quality: 'ultra'
    },

    // Google Gemini Models (Latest 2024-2025)
    'google:gemini-2.0-flash': {
        name: 'Gemini 2.0 Flash',
        provider: LLM_PROVIDERS.GOOGLE,
        modelId: 'gemini-2.0-flash',
        maxTokens: 8192,
        contextWindow: 1000000,
        costPer1kTokens: { input: 0.0001, output: 0.0004 },
        supportsImages: true,
        supportsCode: true,
        quality: 'premium',
        speed: 'fast'
    },
    'google:gemini-2.0-pro': {
        name: 'Gemini 2.0 Pro',
        provider: LLM_PROVIDERS.GOOGLE,
        modelId: 'gemini-2.0-pro-exp',
        maxTokens: 8192,
        contextWindow: 2000000,
        costPer1kTokens: { input: 0.00125, output: 0.005 },
        supportsImages: true,
        supportsCode: true,
        quality: 'ultra'
    },
    'google:gemini-2.0-flash-lite': {
        name: 'Gemini 2.0 Flash Lite',
        provider: LLM_PROVIDERS.GOOGLE,
        modelId: 'gemini-2.0-flash-lite',
        maxTokens: 8192,
        contextWindow: 1000000,
        costPer1kTokens: { input: 0.000075, output: 0.0003 },
        supportsImages: true,
        supportsCode: true,
        quality: 'high',
        speed: 'ultrafast'
    },

    // Groq Models (Ultra Fast - Latest 2024-2025)
    'groq:llama-3.3-70b': {
        name: 'Llama 3.3 70B',
        provider: LLM_PROVIDERS.GROQ,
        modelId: 'llama-3.3-70b-versatile',
        maxTokens: 32768,
        contextWindow: 128000,
        costPer1kTokens: { input: 0.00059, output: 0.00079 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        speed: 'ultrafast'
    },
    'groq:deepseek-r1-distill-llama-70b': {
        name: 'DeepSeek R1 70B',
        provider: LLM_PROVIDERS.GROQ,
        modelId: 'deepseek-r1-distill-llama-70b',
        maxTokens: 16384,
        contextWindow: 128000,
        costPer1kTokens: { input: 0.00075, output: 0.00099 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        speed: 'ultrafast',
        reasoning: true
    },
    'groq:mixtral-8x7b': {
        name: 'Mixtral 8x7B',
        provider: LLM_PROVIDERS.GROQ,
        modelId: 'mixtral-8x7b-32768',
        maxTokens: 32768,
        contextWindow: 32768,
        costPer1kTokens: { input: 0.00024, output: 0.00024 },
        supportsImages: false,
        supportsCode: true,
        quality: 'high',
        speed: 'ultrafast'
    },

    // Mistral Models (Latest 2024-2025)
    'mistral:mistral-large': {
        name: 'Mistral Large 2',
        provider: LLM_PROVIDERS.MISTRAL,
        modelId: 'mistral-large-latest',
        maxTokens: 32000,
        contextWindow: 128000,
        costPer1kTokens: { input: 0.002, output: 0.006 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium'
    },
    'mistral:codestral': {
        name: 'Codestral',
        provider: LLM_PROVIDERS.MISTRAL,
        modelId: 'codestral-latest',
        maxTokens: 32000,
        contextWindow: 32000,
        costPer1kTokens: { input: 0.001, output: 0.003 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        specialization: 'code'
    },
    'mistral:mistral-small': {
        name: 'Mistral Small',
        provider: LLM_PROVIDERS.MISTRAL,
        modelId: 'mistral-small-latest',
        maxTokens: 32000,
        contextWindow: 32000,
        costPer1kTokens: { input: 0.0002, output: 0.0006 },
        supportsImages: false,
        supportsCode: true,
        quality: 'high',
        speed: 'fast'
    },

    // Local Models (Ollama - Latest 2024-2025)
    'local:llama3.3': {
        name: 'Llama 3.3 (Local)',
        provider: LLM_PROVIDERS.LOCAL,
        modelId: 'llama3.3',
        maxTokens: 8192,
        contextWindow: 128000,
        costPer1kTokens: { input: 0, output: 0 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        requiresLocal: true
    },
    'local:deepseek-coder-v2': {
        name: 'DeepSeek Coder V2 (Local)',
        provider: LLM_PROVIDERS.LOCAL,
        modelId: 'deepseek-coder-v2',
        maxTokens: 8192,
        contextWindow: 128000,
        costPer1kTokens: { input: 0, output: 0 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        requiresLocal: true,
        specialization: 'code'
    },
    'local:qwen2.5-coder': {
        name: 'Qwen 2.5 Coder 32B (Local)',
        provider: LLM_PROVIDERS.LOCAL,
        modelId: 'qwen2.5-coder:32b',
        maxTokens: 8192,
        contextWindow: 32000,
        costPer1kTokens: { input: 0, output: 0 },
        supportsImages: false,
        supportsCode: true,
        quality: 'premium',
        requiresLocal: true,
        specialization: 'code'
    }
};

const ERROR_MESSAGES = {
    NO_API_KEY: 'Please configure API keys for at least one LLM provider in settings.',
    INVALID_API_KEY: 'Invalid API key for the selected provider. Please check your configuration.',
    NO_CODE_FOUND: 'No code found on this page. Please select some code or navigate to a page with code.',
    API_ERROR: 'Failed to generate test cases. Please try again.',
    NETWORK_ERROR: 'Network error. Please check your internet connection.',
    TIMEOUT_ERROR: 'Request timed out. Please try again with a smaller code snippet.',
    RATE_LIMIT: 'Rate limit exceeded. Please wait a moment and try again.',
    PROVIDER_UNAVAILABLE: 'Selected LLM provider is currently unavailable. Please try another provider.',
    MODEL_NOT_FOUND: 'Selected model is not available. Please choose a different model.',
    INSUFFICIENT_CREDITS: 'Insufficient credits for the selected provider.',
    CONTEXT_TOO_LARGE: 'Code context exceeds model limits. Try reducing context level or splitting the code.',
    VALIDATION_FAILED: 'Generated test validation failed. Tests may need manual review.',
    COMPILATION_ERROR: 'Generated tests contain compilation errors.',
    OFFLINE_MODE: 'Offline mode is not available for this provider.',
    LOCAL_SERVER_UNAVAILABLE: 'Local LLM server is not running or accessible.'
};

const CACHE_CONFIG = {
    TTL: 3600000, // 1 hour in milliseconds
    MAX_SIZE: 100, // Maximum number of cached items
    COMPRESSION: true, // Enable compression for large cache entries
    PERSISTENCE: true, // Persist cache across browser sessions
    VALIDATION_TTL: 86400000, // 24 hours for test validation cache
    ANALYSIS_TTL: 1800000, // 30 minutes for code analysis cache
    CLEANUP_INTERVAL: 300000 // 5 minutes cleanup interval
};

// Test quality metrics configuration
const TEST_QUALITY_CONFIG = {
    MIN_COVERAGE_SCORE: 70, // Minimum acceptable coverage percentage
    MIN_MAINTAINABILITY_SCORE: 60, // Minimum maintainability score
    MIN_READABILITY_SCORE: 50, // Minimum readability score
    MAX_CYCLOMATIC_COMPLEXITY: 10, // Maximum acceptable complexity per test
    REQUIRED_TEST_TYPES: ['positive', 'negative', 'edge'], // Required test categories
    VALIDATION_TIMEOUT: 15000, // 15 seconds for test validation
    COMPILATION_TIMEOUT: 10000 // 10 seconds for compilation check
};

// Advanced code analysis configuration
const ANALYSIS_CONFIG = {
    MAX_FILE_SIZE: 1048576, // 1MB max file size for analysis
    MAX_CONTEXT_FILES: 50, // Maximum files to include in context
    AST_PARSING_TIMEOUT: 5000, // 5 seconds for AST parsing
    SEMANTIC_ANALYSIS_DEPTH: 3, // Maximum depth for semantic analysis
    FUNCTION_COMPLEXITY_THRESHOLD: 15, // Complexity threshold for prioritization
    DEPENDENCY_ANALYSIS_DEPTH: 2, // Depth for dependency analysis
    PATTERN_MATCHING_CONFIDENCE: 0.8, // Minimum confidence for pattern matching
    BATCH_SIZE: 5, // Files to process in parallel
    RETRY_ATTEMPTS: 3, // Retry attempts for failed analysis
    FALLBACK_TIMEOUT: 30000 // Fallback to simple analysis after timeout
};

// Security configuration
const SECURITY_CONFIG = {
    ENCRYPTION_ALGORITHM: 'AES-GCM', // Strong encryption for API keys
    KEY_DERIVATION_ITERATIONS: 100000, // PBKDF2 iterations
    TOKEN_EXPIRY: 86400000, // 24 hours token expiry
    MAX_API_KEY_LENGTH: 200, // Maximum API key length
    AUDIT_LOG_SIZE: 1000, // Maximum audit log entries
    SECURE_HEADERS: {
        'Content-Security-Policy': "default-src 'self'; connect-src https: wss:; script-src 'self' 'unsafe-eval'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block'
    },
    SANITIZATION_RULES: {
        MAX_CODE_LENGTH: 500000, // 500KB max code input
        BLOCKED_PATTERNS: [/eval\s*\(/gi, /Function\s*\(/gi, /setTimeout\s*\(/gi],
        ALLOWED_DOMAINS: ['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com']
    }
};

// Performance optimization configuration
const PERFORMANCE_CONFIG = {
    DEBOUNCE_DELAY: 300, // Debounce delay for UI interactions
    CHUNK_SIZE: 50000, // Characters per chunk for large code
    PARALLEL_REQUESTS: 3, // Maximum parallel API requests
    MEMORY_LIMIT: 134217728, // 128MB memory limit
    GARBAGE_COLLECTION_INTERVAL: 60000, // 1 minute GC interval
    LAZY_LOADING: true, // Enable lazy loading for components
    VIRTUALIZATION_THRESHOLD: 100, // Items threshold for virtualization
    COMPRESSION_THRESHOLD: 10000, // Characters threshold for compression
    PREFETCH_MODELS: ['openai:gpt-4.1-mini', 'anthropic:claude-3-haiku'], // Models to prefetch
    BACKGROUND_PROCESSING: true // Enable background processing
};

const CODE_SELECTORS = [
    // GitHub (updated for 2024/2025 UI)
    '[data-testid="code-editor"]',
    '[data-testid="blob-viewer-file-content"]',
    '[data-hpc="true"]', // GitHub's new code view
    '.react-code-text',
    '.react-blob-view-code-line-content',
    '#fileHolder',
    '#read-only-cursor-text-area',
    '.blob-code-inner',
    '.blob-code-content',
    'td.blob-code',
    '.js-file-line-container',
    '.diff-table',
    '.file-diff',
    '[data-split-pane="blob-content"]',

    // GitLab (updated selectors)
    '[data-testid="blob-content"] pre code',
    '[data-testid="blob-content"] pre',
    '[data-testid="source-viewer"] pre',
    '[data-testid="source-editor"]',
    '.blob-content pre code',
    '.blob-content pre',
    '.source-viewer pre',
    '.highlight pre code',
    '.code.highlight',
    '.diff-content',
    '.gl-diff-file-content',

    // Bitbucket
    '.refract-content-container',
    '.source',
    '[data-qa="bui-code-block"]',

    // Azure DevOps
    '.monaco-editor',
    '.file-content',

    // Generic code blocks
    'pre code',
    'pre.highlight',
    'div.highlight pre',
    '.hljs',
    '.language-javascript',
    '.language-python',
    '.language-java',
    '.language-typescript',
    '.language-cpp',
    '.language-csharp',
    '.language-go',
    '.language-rust',
    '.language-php',
    '.language-ruby',
    '.language-swift',

    // CodeMirror
    '.CodeMirror-code',
    '.cm-content',

    // Monaco Editor
    '.monaco-editor .view-lines',
    '.monaco-editor-background',

    // Ace Editor
    '.ace_content',

    // Generic
    'code',
    'pre',
    'textarea.code-input',
    '.code-container'
];

const SUPPORTED_LANGUAGES = {
    javascript: { extensions: ['.js', '.jsx', '.mjs'], frameworks: ['jest', 'mocha', 'jasmine'] },
    typescript: { extensions: ['.ts', '.tsx'], frameworks: ['jest', 'mocha', 'jasmine'] },
    python: { extensions: ['.py'], frameworks: ['pytest', 'unittest', 'nose'] },
    java: { extensions: ['.java'], frameworks: ['junit', 'testng'] },
    csharp: { extensions: ['.cs'], frameworks: ['nunit', 'xunit', 'mstest'] },
    ruby: { extensions: ['.rb'], frameworks: ['rspec', 'minitest'] },
    php: { extensions: ['.php'], frameworks: ['phpunit', 'codeception'] },
    go: { extensions: ['.go'], frameworks: ['testing'] }
};

const CONTEXT_LEVELS = {
    MINIMAL: { name: 'Minimal', description: 'Code only', maxTokens: 4000 },
    SMART: { name: 'Smart', description: 'Code + imports + structure', maxTokens: 8000 },
    FULL: { name: 'Full', description: 'Complete repository context', maxTokens: 16000 }
};

const STORAGE_KEYS = {
    API_KEY: 'apiKey',
    API_KEY_ENCRYPTED: 'apiKeyEncrypted',
    CUSTOM_SELECTORS: 'customSelectors',
    ERROR_LOG: 'errorLog',
    CACHE: 'testCaseCache'
};

const DEFAULT_SELECTORS = CODE_SELECTORS;

const SUCCESS_MESSAGES = {
    API_KEY_SAVED: 'API key saved successfully!',
    SETTINGS_SAVED: 'Settings saved successfully!',
    TEST_CASES_GENERATED: 'Test cases generated successfully!',
    COPIED_TO_CLIPBOARD: 'Copied to clipboard!'
};

const TEST_CASE_PROMPTS = {
    DEFAULT: 'Generate comprehensive test cases',
    UNIT: 'Generate unit tests',
    INTEGRATION: 'Generate integration tests',
    E2E: 'Generate end-to-end tests'
};

// Enhanced platform detection patterns
const PLATFORM_PATTERNS = {
    github: {
        domain: 'github.com',
        fileUrl: /github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/.+/,
        diffUrl: /github\.com\/[^/]+\/[^/]+\/(?:pull\/\d+|commit\/[a-f0-9]+|compare\/)/,
        repoUrl: /github\.com\/[^/]+\/[^/]+(?:\/tree\/[^/]+)?$/,
        apiBase: 'https://api.github.com',
        selectors: {
            code: '.blob-code-inner, .blob-code-content, td.blob-code',
            diff: '.diff-table, .js-diff-table',
            fileName: '.file-info a, .file-header .file-title'
        }
    },
    gitlab: {
        domain: 'gitlab.com',
        fileUrl: /gitlab\.com\/[^/]+\/[^/]+\/-\/blob\/[^/]+\/.+/,
        diffUrl: /gitlab\.com\/[^/]+\/[^/]+\/-\/(?:merge_requests\/\d+|commit\/[a-f0-9]+)/,
        repoUrl: /gitlab\.com\/[^/]+\/[^/]+(?:\/-\/tree\/[^/]+)?$/,
        apiBase: 'https://gitlab.com/api/v4',
        selectors: {
            // Modern GitLab MR diff selectors (2024+)
            code: '[data-diff-file] .line_content, .diff-content .code, .code.highlight, .diff-tr .line_content',
            diff: '[data-diff-file], .diff-file, .diff-files-holder, .diff-content, .diffs, .diffs-batch',
            fileName: '.diff-file-header .file-title-name, [data-path], .file-header-content .file-path, .file-title',
            addedLines: '.diff-tr.line_holder.new .line_content, td.line_content.new, .line_content.new',
            removedLines: '.diff-tr.line_holder.old .line_content, td.line_content.old, .line_content.old'
        }
    },
    bitbucket: {
        domain: 'bitbucket.org',
        fileUrl: /bitbucket\.org\/[^/]+\/[^/]+\/src\/[^/]+\/.+/,
        diffUrl: /bitbucket\.org\/[^/]+\/[^/]+\/(?:pull-requests\/\d+|commits\/[a-f0-9]+)/,
        repoUrl: /bitbucket\.org\/[^/]+\/[^/]+(?:\/src\/[^/]+)?$/,
        apiBase: 'https://api.bitbucket.org/2.0',
        selectors: {
            code: '.refract-content-container, .source',
            diff: '.refract-content-container, .bb-udiff',
            fileName: '.filename'
        }
    },
    azure: {
        domain: 'dev.azure.com',
        fileUrl: /dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+\?path=.+/,
        diffUrl: /dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+\/(?:pullrequest\/\d+|commit\/[a-f0-9]+)/,
        repoUrl: /dev\.azure\.com\/[^/]+\/[^/]+\/_git\/[^/]+/,
        apiBase: 'https://dev.azure.com',
        selectors: {
            code: '.repos-code-content, .code-line-content',
            diff: '.repos-diff-container',
            fileName: '.repos-file-name'
        }
    },
    sourceforge: {
        domain: 'sourceforge.net',
        fileUrl: /sourceforge\.net\/p\/[^/]+\/[^/]+\/ci\/[^/]+\/tree\/.+/,
        diffUrl: /sourceforge\.net\/p\/[^/]+\/[^/]+\/ci\/[a-f0-9]+/,
        repoUrl: /sourceforge\.net\/p\/[^/]+\/[^/]+/,
        apiBase: 'https://sourceforge.net/rest',
        selectors: {
            code: '.code-container, pre',
            diff: '.diff-container',
            fileName: '.path-element'
        }
    },
    codeberg: {
        domain: 'codeberg.org',
        fileUrl: /codeberg\.org\/[^/]+\/[^/]+\/src\/branch\/[^/]+\/.+/,
        diffUrl: /codeberg\.org\/[^/]+\/[^/]+\/(?:pulls\/\d+|commit\/[a-f0-9]+)/,
        repoUrl: /codeberg\.org\/[^/]+\/[^/]+/,
        apiBase: 'https://codeberg.org/api/v1',
        selectors: {
            code: '.file-view .code-inner',
            diff: '.diff-file-box',
            fileName: '.file-header .file-name'
        }
    },
    gitea: {
        domain: /gitea\./,
        fileUrl: /\/[^/]+\/[^/]+\/src\/branch\/[^/]+\/.+/,
        diffUrl: /\/[^/]+\/[^/]+\/(?:pulls\/\d+|commit\/[a-f0-9]+)/,
        repoUrl: /\/[^/]+\/[^/]+$/,
        apiBase: '/api/v1',
        selectors: {
            code: '.file-view .code-inner',
            diff: '.diff-file-box',
            fileName: '.file-header .file-name'
        }
    }
};

// Enhanced SCM platform capabilities
const PLATFORM_CAPABILITIES = {
    github: {
        hasAPI: true,
        supportsDiff: true,
        supportsRawFiles: true,
        supportsTree: true,
        requiresAuth: false,
        rateLimit: { requests: 60, window: 3600 }
    },
    gitlab: {
        hasAPI: true,
        supportsDiff: true,
        supportsRawFiles: true,
        supportsTree: true,
        requiresAuth: false,
        rateLimit: { requests: 300, window: 3600 }
    },
    bitbucket: {
        hasAPI: true,
        supportsDiff: true,
        supportsRawFiles: true,
        supportsTree: true,
        requiresAuth: false,
        rateLimit: { requests: 1000, window: 3600 }
    },
    azure: {
        hasAPI: true,
        supportsDiff: true,
        supportsRawFiles: true,
        supportsTree: true,
        requiresAuth: true,
        rateLimit: { requests: 200, window: 3600 }
    },
    sourceforge: {
        hasAPI: true,
        supportsDiff: false,
        supportsRawFiles: true,
        supportsTree: false,
        requiresAuth: false,
        rateLimit: { requests: 100, window: 3600 }
    },
    codeberg: {
        hasAPI: true,
        supportsDiff: true,
        supportsRawFiles: true,
        supportsTree: true,
        requiresAuth: false,
        rateLimit: { requests: 60, window: 3600 }
    },
    gitea: {
        hasAPI: true,
        supportsDiff: true,
        supportsRawFiles: true,
        supportsTree: true,
        requiresAuth: false,
        rateLimit: { requests: 60, window: 3600 }
    }
};

export {
    LLM_PROVIDERS,
    API_ENDPOINTS,
    MODELS,
    ERROR_MESSAGES,
    CACHE_CONFIG,
    TEST_QUALITY_CONFIG,
    ANALYSIS_CONFIG,
    SECURITY_CONFIG,
    PERFORMANCE_CONFIG,
    CODE_SELECTORS,
    SUPPORTED_LANGUAGES,
    CONTEXT_LEVELS,
    STORAGE_KEYS,
    DEFAULT_SELECTORS,
    SUCCESS_MESSAGES,
    TEST_CASE_PROMPTS,
    PLATFORM_PATTERNS,
    PLATFORM_CAPABILITIES
}; 