/**
 * The gate's job is to stop Nano being handed a 40-file review and answering
 * from a truncated prompt. The reason string is part of the contract: it quotes
 * the live quota, so it stays true when Chrome changes the number.
 */
const { LLM_PROVIDERS } = require('../../src/utils/constants.js');
const {
    TASKS,
    TASK_MIN_CONTEXT_TOKENS,
    isTaskSupported,
    taskGateReason,
} = require('../../src/utils/taskCapabilities.js');

const CHROME = LLM_PROVIDERS.CHROME_AI;

describe('taskCapabilities', () => {
    test('every task declares a minimum context', () => {
        for (const task of Object.values(TASKS)) {
            expect(typeof TASK_MIN_CONTEXT_TOKENS[task]).toBe('number');
        }
    });

    test('unconstrained providers support every task', () => {
        for (const task of Object.values(TASKS)) {
            expect(isTaskSupported(LLM_PROVIDERS.OPENAI, task, null)).toBe(true);
            expect(taskGateReason(LLM_PROVIDERS.OPENAI, task, null)).toBeNull();
        }
    });

    test('chrome-ai supports the cheap tasks', () => {
        for (const task of [
            TASKS.FILE_SUMMARY, TASKS.COMMIT_MESSAGE,
            TASKS.LABEL_GENERATION, TASKS.DOCSTRING, TASKS.SINGLE_FILE_CHAT,
        ]) {
            expect(isTaskSupported(CHROME, task, null)).toBe(true);
        }
    });

    test('chrome-ai is gated out of the expensive tasks', () => {
        for (const task of [TASKS.PR_REVIEW, TASKS.MULTI_PASS_AUDIT, TASKS.REPO_CHAT]) {
            expect(isTaskSupported(CHROME, task, null)).toBe(false);
        }
    });

    test('the reason quotes the live quota, not a hardcoded number', () => {
        const reason = taskGateReason(CHROME, TASKS.PR_REVIEW, 4096);
        expect(reason).toContain('4k');
        expect(reason).not.toContain('6k');
    });

    test('the reason names the requirement as well as the shortfall', () => {
        const reason = taskGateReason(CHROME, TASKS.PR_REVIEW, null);
        const needK = Math.round(TASK_MIN_CONTEXT_TOKENS[TASKS.PR_REVIEW] / 1024);
        expect(reason).toContain(`${needK}k`);
        expect(reason).toContain('6k');
    });

    test('a larger live quota can un-gate a task', () => {
        const need = TASK_MIN_CONTEXT_TOKENS[TASKS.PR_REVIEW];
        expect(isTaskSupported(CHROME, TASKS.PR_REVIEW, need + 1024)).toBe(true);
        expect(taskGateReason(CHROME, TASKS.PR_REVIEW, need + 1024)).toBeNull();
    });

    test('an unknown task is permitted rather than silently blocked', () => {
        expect(isTaskSupported(CHROME, 'brand_new_task', null)).toBe(true);
    });
});
