import { INDEX_REPO_TOOL } from './index_repo.js';
import { SEARCH_CODE_TOOL, GET_SYMBOL_TOOL, FIND_CALLERS_TOOL } from './search.js';
import { IMPACT_OF_CHANGE_TOOL, REPO_OVERVIEW_TOOL } from './impact.js';
import { GET_DIFF_CONTEXT_TOOL } from './diff.js';
import { REVIEW_PR_TOOL } from './review.js';
import {
    GET_REVIEW_CANDIDATES_TOOL,
    SUBMIT_REVIEW_VERIFICATION_TOOL,
} from './verification.js';
import { SUBMIT_REVIEW_FINDINGS_TOOL } from './delegation.js';

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
    // P1-8. `review_pr` keeps its existing contract — evidence only. These two
    // are the candidate exchange: RepoSpector's own candidates out, the host
    // assistant's verdicts back. Neither posts a comment or approves anything.
    GET_REVIEW_CANDIDATES_TOOL,
    SUBMIT_REVIEW_VERIFICATION_TOOL,
    // The return half of `review_pr`. This server runs no model, so the host
    // agent is the reasoning pass; this is where its conclusions come back and
    // the only thing that closes the review's completeness contract.
    SUBMIT_REVIEW_FINDINGS_TOOL,
];
