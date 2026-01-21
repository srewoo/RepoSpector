/**
 * Query Expander for RepoSpector
 *
 * Expands search queries with synonyms, related terms,
 * and context-aware variations for better search recall.
 */

/**
 * Code-specific synonyms and related terms
 */
const CODE_SYNONYMS = {
    // Common programming terms
    'function': ['method', 'func', 'fn', 'procedure', 'routine', 'handler'],
    'method': ['function', 'func', 'procedure', 'operation'],
    'class': ['type', 'struct', 'interface', 'model', 'entity'],
    'variable': ['var', 'const', 'let', 'field', 'property', 'attribute'],
    'constant': ['const', 'static', 'final', 'immutable'],
    'array': ['list', 'collection', 'slice', 'vector', 'items'],
    'object': ['dict', 'dictionary', 'map', 'hash', 'record', 'struct'],
    'string': ['str', 'text', 'char'],
    'number': ['int', 'integer', 'float', 'double', 'num', 'digit'],
    'boolean': ['bool', 'flag', 'toggle'],

    // Actions
    'create': ['make', 'build', 'construct', 'generate', 'initialize', 'init', 'new'],
    'delete': ['remove', 'destroy', 'dispose', 'clear', 'drop', 'purge'],
    'update': ['modify', 'change', 'edit', 'set', 'alter', 'patch'],
    'read': ['get', 'fetch', 'retrieve', 'load', 'find', 'query'],
    'send': ['emit', 'dispatch', 'post', 'publish', 'transmit'],
    'receive': ['get', 'accept', 'handle', 'consume', 'subscribe'],
    'validate': ['check', 'verify', 'ensure', 'assert', 'confirm'],
    'parse': ['extract', 'decode', 'deserialize', 'convert'],
    'format': ['serialize', 'encode', 'stringify', 'render'],
    'log': ['print', 'debug', 'trace', 'output', 'console'],

    // Concepts
    'error': ['exception', 'failure', 'fault', 'issue', 'problem'],
    'handler': ['listener', 'callback', 'hook', 'subscriber', 'observer'],
    'config': ['configuration', 'settings', 'options', 'preferences', 'params'],
    'auth': ['authentication', 'authorization', 'security', 'login'],
    'user': ['account', 'profile', 'member', 'client', 'customer'],
    'api': ['endpoint', 'service', 'route', 'controller'],
    'database': ['db', 'store', 'repository', 'persistence', 'storage'],
    'cache': ['memo', 'buffer', 'store', 'memory'],
    'async': ['asynchronous', 'promise', 'await', 'concurrent'],
    'sync': ['synchronous', 'blocking', 'sequential'],

    // Testing
    'test': ['spec', 'unittest', 'suite', 'case'],
    'mock': ['stub', 'fake', 'spy', 'double'],
    'assert': ['expect', 'verify', 'should', 'check'],

    // Web
    'request': ['req', 'call', 'query', 'fetch'],
    'response': ['res', 'reply', 'result', 'output'],
    'route': ['path', 'endpoint', 'url', 'uri'],
    'component': ['widget', 'element', 'module', 'view'],
    'state': ['store', 'data', 'context', 'model'],
    'prop': ['property', 'attribute', 'param', 'arg'],
    'event': ['action', 'trigger', 'signal', 'notification']
};

/**
 * Abbreviation expansions
 */
const ABBREVIATIONS = {
    'fn': 'function',
    'func': 'function',
    'auth': 'authentication',
    'config': 'configuration',
    'db': 'database',
    'err': 'error',
    'msg': 'message',
    'req': 'request',
    'res': 'response',
    'ctx': 'context',
    'env': 'environment',
    'id': 'identifier',
    'idx': 'index',
    'val': 'value',
    'var': 'variable',
    'num': 'number',
    'str': 'string',
    'obj': 'object',
    'arr': 'array',
    'param': 'parameter',
    'arg': 'argument',
    'args': 'arguments',
    'util': 'utility',
    'utils': 'utilities',
    'lib': 'library',
    'pkg': 'package',
    'dep': 'dependency',
    'deps': 'dependencies',
    'init': 'initialize',
    'impl': 'implementation',
    'tmp': 'temporary',
    'prev': 'previous',
    'curr': 'current',
    'max': 'maximum',
    'min': 'minimum',
    'src': 'source',
    'dest': 'destination',
    'ref': 'reference',
    'doc': 'document',
    'docs': 'documentation'
};

/**
 * Query context patterns
 */
const CONTEXT_PATTERNS = [
    {
        pattern: /how\s+to\s+(\w+)/i,
        handler: (match) => {
            const action = match[1].toLowerCase();
            return {
                type: 'howto',
                action,
                related: CODE_SYNONYMS[action] || []
            };
        }
    },
    {
        pattern: /where\s+is\s+(\w+)/i,
        handler: (match) => {
            const target = match[1].toLowerCase();
            return {
                type: 'location',
                target,
                addTerms: ['define', 'implement', 'class', 'function', target]
            };
        }
    },
    {
        pattern: /(\w+)\s+error/i,
        handler: (match) => {
            const context = match[1].toLowerCase();
            return {
                type: 'error',
                context,
                addTerms: ['error', 'exception', 'catch', 'throw', 'handle', context]
            };
        }
    },
    {
        pattern: /test\s+(\w+)/i,
        handler: (match) => {
            const target = match[1].toLowerCase();
            return {
                type: 'test',
                target,
                addTerms: ['test', 'spec', 'mock', 'assert', 'expect', target]
            };
        }
    }
];

/**
 * Expand a query with synonyms and related terms
 */
export function expandQuery(query, options = {}) {
    const {
        maxExpansions = 3,        // Max synonyms per term
        includeSynonyms = true,
        includeAbbreviations = true,
        includeContextual = true,
        preserveOriginal = true
    } = options;

    const result = {
        originalQuery: query,
        expandedQuery: '',
        terms: [],
        expansions: [],
        context: null
    };

    // Tokenize query
    const tokens = query.toLowerCase()
        .split(/\s+/)
        .filter(t => t.length >= 2);

    const allTerms = new Set(preserveOriginal ? tokens : []);

    // Analyze context
    if (includeContextual) {
        for (const { pattern, handler } of CONTEXT_PATTERNS) {
            const match = query.match(pattern);
            if (match) {
                result.context = handler(match);
                if (result.context.addTerms) {
                    result.context.addTerms.forEach(t => allTerms.add(t));
                }
                break;
            }
        }
    }

    // Expand each token
    for (const token of tokens) {
        result.terms.push(token);

        // Expand abbreviations
        if (includeAbbreviations && ABBREVIATIONS[token]) {
            const expanded = ABBREVIATIONS[token];
            allTerms.add(expanded);
            result.expansions.push({
                original: token,
                expansion: expanded,
                type: 'abbreviation'
            });
        }

        // Add synonyms
        if (includeSynonyms && CODE_SYNONYMS[token]) {
            const synonyms = CODE_SYNONYMS[token].slice(0, maxExpansions);
            for (const syn of synonyms) {
                allTerms.add(syn);
                result.expansions.push({
                    original: token,
                    expansion: syn,
                    type: 'synonym'
                });
            }
        }

        // Check if token is an abbreviation of something
        if (includeAbbreviations) {
            for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
                if (full === token) {
                    allTerms.add(abbr);
                    result.expansions.push({
                        original: token,
                        expansion: abbr,
                        type: 'abbreviation-reverse'
                    });
                }
            }
        }
    }

    // Build expanded query
    result.expandedQuery = Array.from(allTerms).join(' ');

    return result;
}

/**
 * Generate query variations for better recall
 */
export function generateQueryVariations(query, options = {}) {
    const { maxVariations = 5 } = options;
    const variations = new Set([query]);

    // CamelCase variations
    const camelCased = query.replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
    variations.add(camelCased);

    // snake_case variations
    const snakeCased = query.replace(/\s+/g, '_').toLowerCase();
    variations.add(snakeCased);

    // kebab-case variations
    const kebabCased = query.replace(/\s+/g, '-').toLowerCase();
    variations.add(kebabCased);

    // PascalCase
    const pascalCased = query
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('');
    variations.add(pascalCased);

    // Add with common prefixes
    const prefixes = ['get', 'set', 'is', 'has', 'handle', 'on', 'create', 'update', 'delete'];
    const mainTerm = query.split(/\s+/).pop();

    for (const prefix of prefixes) {
        if (!query.toLowerCase().startsWith(prefix)) {
            const prefixed = `${prefix}${mainTerm.charAt(0).toUpperCase()}${mainTerm.slice(1)}`;
            variations.add(prefixed);
            if (variations.size >= maxVariations + 5) break;
        }
    }

    return Array.from(variations).slice(0, maxVariations + 5);
}

/**
 * Extract key concepts from a query
 */
export function extractKeyConcepts(query) {
    const concepts = [];
    const tokens = query.toLowerCase().split(/\s+/);

    // Action concepts
    const actions = ['create', 'read', 'update', 'delete', 'get', 'set', 'find', 'search', 'filter', 'sort', 'validate', 'parse', 'format', 'handle', 'process'];
    for (const token of tokens) {
        if (actions.includes(token) || CODE_SYNONYMS[token]?.some(s => actions.includes(s))) {
            concepts.push({ type: 'action', value: token });
        }
    }

    // Entity concepts
    const entities = ['user', 'account', 'product', 'order', 'item', 'data', 'file', 'message', 'request', 'response', 'event', 'error', 'result'];
    for (const token of tokens) {
        if (entities.includes(token)) {
            concepts.push({ type: 'entity', value: token });
        }
    }

    // Technical concepts
    const technical = ['async', 'sync', 'api', 'database', 'cache', 'auth', 'test', 'mock', 'config', 'state', 'component', 'function', 'class'];
    for (const token of tokens) {
        if (technical.includes(token)) {
            concepts.push({ type: 'technical', value: token });
        }
    }

    return concepts;
}

/**
 * Build search query from concepts
 */
export function buildSearchQuery(concepts, options = {}) {
    const {
        includeVariations = true,
        maxTerms = 10
    } = options;

    const terms = new Set();

    for (const concept of concepts) {
        terms.add(concept.value);

        // Add synonyms for concepts
        const synonyms = CODE_SYNONYMS[concept.value];
        if (synonyms) {
            synonyms.slice(0, 2).forEach(s => terms.add(s));
        }

        // Add variations
        if (includeVariations) {
            const variations = generateQueryVariations(concept.value, { maxVariations: 2 });
            variations.forEach(v => terms.add(v));
        }
    }

    return Array.from(terms).slice(0, maxTerms).join(' ');
}

/**
 * Smart query expansion with context awareness
 */
export function smartExpand(query, context = {}) {
    const {
        language = 'javascript',
        fileType = null,
        projectType = null
    } = context;

    // Start with basic expansion
    const expanded = expandQuery(query);

    // Add language-specific terms
    const languageTerms = {
        javascript: ['js', 'node', 'npm', 'module', 'export', 'import'],
        typescript: ['ts', 'type', 'interface', 'generic'],
        python: ['py', 'pip', 'def', 'import', 'class'],
        java: ['class', 'interface', 'import', 'public', 'private'],
        go: ['func', 'package', 'import', 'struct', 'interface']
    };

    if (languageTerms[language]) {
        // Check if query mentions language concepts
        const terms = query.toLowerCase().split(/\s+/);
        for (const term of terms) {
            if (languageTerms[language].includes(term)) {
                // Add related language terms
                languageTerms[language].forEach(t => expanded.terms.push(t));
                break;
            }
        }
    }

    // Add file type context
    if (fileType) {
        const fileTypeTerms = {
            'test': ['test', 'spec', 'mock', 'describe', 'it', 'expect'],
            'component': ['component', 'render', 'props', 'state', 'jsx'],
            'service': ['service', 'api', 'endpoint', 'request', 'response'],
            'model': ['model', 'schema', 'entity', 'type', 'interface'],
            'util': ['util', 'helper', 'common', 'shared', 'utils']
        };

        if (fileTypeTerms[fileType]) {
            fileTypeTerms[fileType].forEach(t => expanded.terms.push(t));
        }
    }

    // Rebuild expanded query with new terms
    expanded.expandedQuery = [...new Set(expanded.terms)].join(' ');

    return expanded;
}

export default {
    expandQuery,
    generateQueryVariations,
    extractKeyConcepts,
    buildSearchQuery,
    smartExpand,
    CODE_SYNONYMS,
    ABBREVIATIONS
};
