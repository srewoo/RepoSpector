const { SlashCommandParser, SLASH_COMMANDS } = require('../../src/services/SlashCommandParser.js');

describe('SlashCommandParser', () => {
    describe('parse() base commands', () => {
        const availableCommands = [
            '/mindmap', '/docs', '/diagram', '/test', '/review', '/explain',
            '/security', '/complexity', '/dead-code', '/export', '/compliance',
            '/metrics', '/repoinfo', '/changelog', '/pr-desc', '/help'
        ];

        it.each(availableCommands)('should successfully parse %s command', (command) => {
            const result = SlashCommandParser.parse(command);
            expect(result).not.toBeNull();
            expect(result.valid).toBe(true);
            expect(result.command).toBe(command);
            expect(result.handler).toBe(SLASH_COMMANDS[command].handler);
        });

        it('should require arguments for commands that specify requiresArg: true', () => {
            const noArgResult = SlashCommandParser.parse('/impact');
            expect(noArgResult.valid).toBe(false);
            expect(noArgResult.error).toContain('requires an argument');

            const withArgResult = SlashCommandParser.parse('/impact SomeFunction');
            expect(withArgResult.valid).toBe(true);
            expect(withArgResult.command).toBe('/impact');
            expect(withArgResult.args).toBe('SomeFunction');
        });

        it('should correctly handle partial match/auto-complete in parsing', () => {
            // Typing "/dead" should resolve to "/dead-code"
            const result = SlashCommandParser.parse('/dead');
            expect(result.valid).toBe(true);
            expect(result.command).toBe('/dead-code');
        });

        it('should appropriately parse subcommands', () => {
            const result = SlashCommandParser.parse('/diagram sequence');
            expect(result.valid).toBe(true);
            expect(result.subcommand).toBe('sequence');
            expect(result.args).toBe('sequence');
        });

        it('should return null for non-command input', () => {
            expect(SlashCommandParser.parse('Not a command')).toBeNull();
            expect(SlashCommandParser.parse(' /space at start')).toBeNull();
        });

        it('should report invalid for unknown command', () => {
            const result = SlashCommandParser.parse('/doesnotexist');
            expect(result.valid).toBe(false);
            expect(result.isCommand).toBe(true);
            expect(result.error).toContain('Unknown command');
        });
    });

    describe('getSuggestions()', () => {
        it('should return matching commands for partial input', () => {
            const suggestions = SlashCommandParser.getSuggestions('/di');
            expect(suggestions.length).toBeGreaterThan(0);
            expect(suggestions[0].command).toBe('/diagram');
        });

        it('should return empty array for non-slash strings', () => {
            expect(SlashCommandParser.getSuggestions('hello')).toEqual([]);
        });
    });

    describe('buildPayload()', () => {
        const mockContext = {
            repoId: 'test/repo',
            tabUrl: 'https://github.com/test/repo/pull/1',
            tabId: 123,
            isRepoIndexed: true,
            isPRPage: true
        };

        it('should build payload for GENERATE_REPO_MINDMAP', () => {
            const parsed = SlashCommandParser.parse('/mindmap');
            const payload = SlashCommandParser.buildPayload(parsed, mockContext);
            expect(payload.messageType).toBe('GENERATE_REPO_MINDMAP');
            expect(payload.payload.repoId).toBe('test/repo');
        });

        it('should build payload for CHAT_WITH_CODE including extra context for /explain', () => {
            const parsed = SlashCommandParser.parse('/explain myFunction');
            const payload = SlashCommandParser.buildPayload(parsed, mockContext);
            expect(payload.messageType).toBe('CHAT_WITH_CODE');
            expect(payload.payload.question).toContain('myFunction');
        });

        it('should use default subcommand if none provided for diagram', () => {
            const parsed = SlashCommandParser.parse('/diagram');
            const payload = SlashCommandParser.buildPayload(parsed, mockContext);
            expect(payload.messageType).toBe('GENERATE_MERMAID_DIAGRAM');
            expect(payload.payload.diagramType).toBe('sequence');
        });

        it('should capture options set by commands like /callers and pass correctly', () => {
            const parsed = SlashCommandParser.parse('/callers myFunc');
            const payload = SlashCommandParser.buildPayload(parsed, mockContext);
            expect(payload.messageType).toBe('ANALYZE_IMPACT');
            expect(payload.payload.direction).toBe('upstream');
            expect(payload.payload.targetName).toBe('myFunc');
        });
    });
});
