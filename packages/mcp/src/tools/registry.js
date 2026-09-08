import { INDEX_REPO_TOOL } from './index_repo.js';
import { SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL } from './search.js';
import { IMPACT_OF_CHANGE_TOOL, REPO_OVERVIEW_TOOL } from './impact.js';
import { GET_DIFF_CONTEXT_TOOL } from './diff.js';
import { REVIEW_PR_TOOL } from './review.js';

/**
 * Tool name → definition. Later tasks push into this list.
 *
 * A single registry rather than registration scattered through the server:
 * the wire contract is the tool names and schemas, and one list is what makes
 * that contract reviewable in one place.
 *
 * Each entry: { name, description, inputSchema, handler }
 * `handler(args, ctx) → Promise<{content: [{type: 'text', text: string}]}>`
 */
export const TOOLS = [
    REPO_OVERVIEW_TOOL,
    INDEX_REPO_TOOL,
    SEARCH_CODE_TOOL,
    GET_SYMBOL_TOOL,
    FIND_CALLERS_TOOL,
    IMPACT_OF_CHANGE_TOOL,
    GET_DIFF_CONTEXT_TOOL,
    REVIEW_PR_TOOL,
];
