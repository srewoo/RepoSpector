/**
 * modelPort — the one contract the shared review core uses to ask a model
 * anything.
 *
 * The extension answers with its own LLMService; the MCP server answers with
 * host sampling, or hands the request back to the host when sampling is
 * unavailable. The core never knows which, so it can never import either.
 *
 * A port NEVER throws. Every outcome is one of three results:
 *   ok        — the model answered
 *   not-run   — it could not answer (budget exhausted, provider error, refused)
 *   delegated — the host must answer later; the request travels with the result
 *
 * @typedef {{status:'ok', text:string, usage?:{input:number,output:number}}
 *          | {status:'not-run', reason:string}
 *          | {status:'delegated', request:{id:string, stage:string, messages:Array<{role:string,content:string}>, schema:object}}} ModelResult
 *
 * @typedef {(messages:Array<{role:'system'|'user'|'assistant',content:string}>,
 *            opts:{stage:string, priority:string, schema?:object, requestId?:string}) => Promise<ModelResult>} ModelPort
 */

export const MODEL_STATUS = Object.freeze({ OK: 'ok', NOT_RUN: 'not-run', DELEGATED: 'delegated' });

/** @returns {ModelResult} */
export function okResult(text, usage) {
    const result = { status: MODEL_STATUS.OK, text: typeof text === 'string' ? text : String(text ?? '') };
    if (usage) result.usage = { input: Number(usage.input) || 0, output: Number(usage.output) || 0 };
    return result;
}

/** @returns {ModelResult} */
export function notRun(reason) {
    return { status: MODEL_STATUS.NOT_RUN, reason: String(reason || 'model call did not run') };
}

/** @returns {ModelResult} */
export function delegated(request) {
    return { status: MODEL_STATUS.DELEGATED, request };
}

export default { MODEL_STATUS, okResult, notRun, delegated };
