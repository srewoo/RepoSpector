/**
 * Slash Command Parser for RepoSpector Chat
 *
 * Parses slash commands from user input and routes them
 * to the appropriate handler. Commands provide quick access
 * to analysis features directly from the chat interface.
 */

const SLASH_COMMANDS = {
    '/mindmap': {
        description: 'Generate a repo mindmap diagram',
        usage: '/mindmap',
        requiresIndex: true,
        handler: 'GENERATE_REPO_MINDMAP',
        category: 'diagrams'
    },
    '/docs': {
        description: 'Generate repository documentation',
        usage: '/docs [overview|api|architecture]',
        requiresIndex: true,
        handler: 'GENERATE_REPO_DOCS',
        category: 'docs',
        subcommands: ['overview', 'api', 'architecture']
    },
    '/impact': {
        description: 'Analyze impact of changing a symbol',
        usage: '/impact <function_or_class_name>',
        requiresIndex: true,
        handler: 'ANALYZE_IMPACT',
        category: 'analysis',
        requiresArg: true
    },
    '/diagram': {
        description: 'Generate a diagram from current context',
        usage: '/diagram [sequence|flowchart|class|architecture]',
        requiresIndex: false,
        handler: 'GENERATE_MERMAID_DIAGRAM',
        category: 'diagrams',
        subcommands: ['sequence', 'flowchart', 'class', 'architecture']
    },
    '/test': {
        description: 'Generate tests for current code',
        usage: '/test [unit|integration|e2e|security]',
        requiresIndex: false,
        handler: 'GENERATE_TESTS',
        category: 'testing',
        subcommands: ['unit', 'integration', 'e2e', 'security', 'api', 'performance']
    },
    '/review': {
        description: 'Review current PR or code',
        usage: '/review',
        requiresIndex: false,
        handler: 'MULTI_PASS_PR_REVIEW',
        category: 'review'
    },
    '/explain': {
        description: 'Explain the current code in detail',
        usage: '/explain [function_name]',
        requiresIndex: false,
        handler: 'CHAT_WITH_CODE',
        category: 'analysis'
    },
    '/security': {
        description: 'Run security analysis on current code',
        usage: '/security',
        requiresIndex: false,
        handler: 'SECURITY_REVIEW_PR',
        category: 'analysis'
    },
    '/callers': {
        description: 'Find all callers of a function',
        usage: '/callers <function_name>',
        requiresIndex: true,
        handler: 'ANALYZE_IMPACT',
        category: 'analysis',
        requiresArg: true,
        options: { direction: 'upstream' }
    },
    '/dependencies': {
        description: 'Show dependencies of a function',
        usage: '/dependencies <function_name>',
        requiresIndex: true,
        handler: 'ANALYZE_IMPACT',
        category: 'analysis',
        requiresArg: true,
        options: { direction: 'downstream' }
    },
    '/complexity': {
        description: 'Analyze code complexity',
        usage: '/complexity',
        requiresIndex: false,
        handler: 'CHAT_WITH_CODE',
        category: 'analysis'
    },
    '/dead-code': {
        description: 'Find potentially dead/unused code',
        usage: '/dead-code',
        requiresIndex: true,
        handler: 'ANALYZE_DEAD_CODE',
        category: 'analysis'
    },
    '/export': {
        description: 'Export chat or diagram',
        usage: '/export [markdown|png]',
        requiresIndex: false,
        handler: 'EXPORT',
        category: 'utility',
        subcommands: ['markdown', 'png']
    },
    '/compliance': {
        description: 'Check PR description compliance',
        usage: '/compliance',
        requiresIndex: false,
        handler: 'CHECK_PR_COMPLIANCE',
        category: 'review'
    },
    '/metrics': {
        description: 'Show review metrics dashboard',
        usage: '/metrics',
        requiresIndex: false,
        handler: 'GET_REVIEW_METRICS',
        category: 'utility'
    },
    '/repoinfo': {
        description: 'Generate RepoInfo.md',
        usage: '/repoinfo',
        requiresIndex: true,
        handler: 'GENERATE_REPO_INFO',
        category: 'docs'
    },
    '/changelog': {
        description: 'Generate changelog for current PR',
        usage: '/changelog',
        requiresIndex: false,
        handler: 'GENERATE_CHANGELOG',
        category: 'docs'
    },
    '/pr-desc': {
        description: 'Auto-generate PR description',
        usage: '/pr-desc',
        requiresIndex: false,
        handler: 'GENERATE_PR_DESCRIPTION',
        category: 'review'
    },
    '/help': {
        description: 'Show available commands',
        usage: '/help',
        requiresIndex: false,
        handler: 'HELP',
        category: 'utility'
    }
};

export class SlashCommandParser {
    /**
     * Parse user input for slash commands
     * @param {string} input - User input text
     * @returns {Object|null} Parsed command or null if not a slash command
     */
    static parse(input) {
        if (!input || !input.startsWith('/')) return null;

        const trimmed = input.trim();
        const parts = trimmed.split(/\s+/);
        const commandName = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ').trim();

        const command = SLASH_COMMANDS[commandName];
        if (!command) {
            // Check for partial matches
            const matches = Object.keys(SLASH_COMMANDS).filter(c => c.startsWith(commandName));
            if (matches.length === 1) {
                return SlashCommandParser.parse(trimmed.replace(commandName, matches[0]));
            }
            return {
                isCommand: true,
                valid: false,
                command: commandName,
                error: `Unknown command: ${commandName}. Type /help to see available commands.`
            };
        }

        // Check if argument is required but missing
        if (command.requiresArg && !args) {
            return {
                isCommand: true,
                valid: false,
                command: commandName,
                error: `${commandName} requires an argument. Usage: ${command.usage}`
            };
        }

        // Parse subcommand if applicable
        let subcommand = null;
        let remainingArgs = args;
        if (command.subcommands && args) {
            const firstArg = args.split(/\s+/)[0].toLowerCase();
            if (command.subcommands.includes(firstArg)) {
                subcommand = firstArg;
                remainingArgs = args.split(/\s+/).slice(1).join(' ').trim();
            }
        }

        return {
            isCommand: true,
            valid: true,
            command: commandName,
            handler: command.handler,
            args: remainingArgs || args,
            subcommand,
            category: command.category,
            requiresIndex: command.requiresIndex,
            description: command.description,
            options: command.options || {}
        };
    }

    /**
     * Get autocomplete suggestions for partial input
     * @param {string} input - Partial input
     * @returns {Array} Matching commands with descriptions
     */
    static getSuggestions(input) {
        if (!input || !input.startsWith('/')) return [];

        const partial = input.toLowerCase().trim();
        return Object.entries(SLASH_COMMANDS)
            .filter(([cmd]) => cmd.startsWith(partial))
            .map(([cmd, config]) => ({
                command: cmd,
                description: config.description,
                usage: config.usage,
                category: config.category,
                requiresIndex: config.requiresIndex
            }))
            .slice(0, 8);
    }

    /**
     * Get help text for all commands
     * @returns {string} Formatted help text
     */
    static getHelpText() {
        const categories = {};
        for (const [cmd, config] of Object.entries(SLASH_COMMANDS)) {
            if (cmd === '/help') continue;
            if (!categories[config.category]) {
                categories[config.category] = [];
            }
            categories[config.category].push({
                command: cmd,
                description: config.description,
                usage: config.usage,
                requiresIndex: config.requiresIndex
            });
        }

        const categoryLabels = {
            diagrams: 'Diagrams & Visualization',
            docs: 'Documentation',
            analysis: 'Code Analysis',
            testing: 'Testing',
            review: 'Code Review',
            utility: 'Utilities'
        };

        let help = '## Available Slash Commands\n\n';
        for (const [category, commands] of Object.entries(categories)) {
            help += `### ${categoryLabels[category] || category}\n`;
            for (const cmd of commands) {
                help += `- \`${cmd.usage}\` — ${cmd.description}`;
                if (cmd.requiresIndex) help += ' *(requires indexed repo)*';
                help += '\n';
            }
            help += '\n';
        }
        help += '*Tip: Commands can be autocompleted as you type.*';
        return help;
    }

    /**
     * Build the message payload for a slash command to send to background
     * @param {Object} parsed - Parsed command result
     * @param {Object} context - { repoId, tabUrl, tabId, isRepoIndexed, isPRPage }
     * @returns {Object} { messageType, payload, displayMessage }
     */
    static buildPayload(parsed, context = {}) {
        const { command, handler, args, subcommand, options } = parsed;
        const { repoId, tabUrl, tabId, isRepoIndexed, isPRPage } = context;

        switch (handler) {
            case 'GENERATE_REPO_MINDMAP':
                return {
                    messageType: 'GENERATE_REPO_MINDMAP',
                    payload: { repoId, url: tabUrl },
                    displayMessage: 'Generating repo mindmap...',
                    responseType: 'mindmap'
                };

            case 'GENERATE_REPO_DOCS':
                return {
                    messageType: 'GENERATE_REPO_DOCS',
                    payload: {
                        repoId,
                        url: tabUrl,
                        docType: subcommand || 'overview'
                    },
                    displayMessage: `Generating ${subcommand || 'overview'} documentation...`,
                    responseType: 'repoinfo'
                };

            case 'ANALYZE_IMPACT':
                return {
                    messageType: 'ANALYZE_IMPACT',
                    payload: {
                        repoId,
                        targetName: args,
                        direction: options.direction || 'both'
                    },
                    displayMessage: `Analyzing impact of "${args}"...`,
                    responseType: 'text'
                };

            case 'GENERATE_MERMAID_DIAGRAM': {
                const diagramType = subcommand || 'sequence';
                return {
                    messageType: 'GENERATE_MERMAID_DIAGRAM',
                    payload: {
                        prUrl: tabUrl,
                        diagramType,
                        repoId
                    },
                    displayMessage: `Generating ${diagramType} diagram...`,
                    responseType: 'mindmap'
                };
            }

            case 'GENERATE_TESTS':
                return {
                    messageType: 'GENERATE_TESTS',
                    payload: {
                        tabId,
                        options: {
                            testType: subcommand || 'unit',
                            contextLevel: 'smart',
                            userPrompt: `Generate ${subcommand || 'unit'} tests for this code${args ? `: ${args}` : ''}`
                        },
                        useDeepContext: isRepoIndexed
                    },
                    displayMessage: `Generating ${subcommand || 'unit'} tests...`,
                    responseType: 'streaming'
                };

            case 'MULTI_PASS_PR_REVIEW':
                return {
                    messageType: 'MULTI_PASS_PR_REVIEW',
                    payload: { prUrl: tabUrl },
                    displayMessage: 'Running comprehensive PR review...',
                    responseType: 'text'
                };

            case 'CHAT_WITH_CODE': {
                let question = args;
                if (command === '/explain') {
                    question = args ? `Explain the function/class "${args}" in detail` : 'Explain this code in detail, including its purpose, logic flow, and any patterns used';
                } else if (command === '/complexity') {
                    question = 'Analyze the complexity of this code. Include cyclomatic complexity, cognitive complexity, and suggestions for simplification';
                }
                return {
                    messageType: 'CHAT_WITH_CODE',
                    payload: {
                        tabId,
                        question,
                        useDeepContext: isRepoIndexed
                    },
                    displayMessage: command === '/complexity' ? 'Analyzing code complexity...' : 'Analyzing code...',
                    responseType: 'streaming'
                };
            }

            case 'SECURITY_REVIEW_PR':
                return {
                    messageType: 'SECURITY_REVIEW_PR',
                    payload: { prUrl: tabUrl },
                    displayMessage: 'Running security analysis...',
                    responseType: 'text'
                };

            case 'ANALYZE_DEAD_CODE':
                return {
                    messageType: 'ANALYZE_DEAD_CODE',
                    payload: { repoId },
                    displayMessage: 'Searching for dead code...',
                    responseType: 'text'
                };

            case 'EXPORT':
                return {
                    messageType: 'EXPORT',
                    payload: { format: subcommand || 'markdown' },
                    displayMessage: `Exporting as ${subcommand || 'markdown'}...`,
                    responseType: 'export'
                };

            case 'CHECK_PR_COMPLIANCE':
                return {
                    messageType: 'CHECK_PR_COMPLIANCE',
                    payload: { prUrl: tabUrl, repoId },
                    displayMessage: 'Checking PR description compliance...',
                    responseType: 'text'
                };

            case 'GET_REVIEW_METRICS':
                return {
                    messageType: 'GET_REVIEW_METRICS',
                    payload: { repoId },
                    displayMessage: 'Loading review metrics...',
                    responseType: 'metrics'
                };

            case 'GENERATE_REPO_INFO':
                return {
                    messageType: 'GENERATE_REPO_INFO',
                    payload: { repoId, url: tabUrl },
                    displayMessage: 'Generating RepoInfo.md...',
                    responseType: 'repoinfo'
                };

            case 'GENERATE_CHANGELOG':
                return {
                    messageType: 'GENERATE_CHANGELOG',
                    payload: { prUrl: tabUrl },
                    displayMessage: 'Generating changelog...',
                    responseType: 'text'
                };

            case 'GENERATE_PR_DESCRIPTION':
                return {
                    messageType: 'GENERATE_PR_DESCRIPTION',
                    payload: { prUrl: tabUrl },
                    displayMessage: 'Generating PR description...',
                    responseType: 'pr-description'
                };

            case 'HELP':
                return {
                    messageType: 'HELP',
                    payload: {},
                    displayMessage: null,
                    responseType: 'help'
                };

            default:
                return null;
        }
    }
}

export { SLASH_COMMANDS };
