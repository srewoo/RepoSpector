/**
 * contextPort — where the new lenses get repository history and discussion.
 *
 * The extension answers from the GitHub/GitLab API; the MCP server answers from
 * local git and arguments the host passed in. Every method resolves — never
 * rejects — to `{status:'ok', ...payload}` or `{status:'not-run', reason}`, so
 * a missing token or a 403 becomes a reported gap, never "no findings".
 *
 * @typedef {{
 *   blame(path:string, opts:{ref?:string, startLine?:number, endLine?:number}): Promise<{status:string, reason?:string, ranges?:Array<{start:number,end:number,sha:string,message:string,date:string}>}>,
 *   recentCommits(path:string, opts:{ref?:string, limit?:number}): Promise<{status:string, reason?:string, commits?:Array<{sha:string,message:string,date:string}>}>,
 *   priorPrComments(path:string, opts:{limitPrs?:number}): Promise<{status:string, reason?:string, comments?:Array<{path:string,prRef:string,author:string,body:string,line?:number|null}>}>,
 *   fileContent(path:string, ref?:string): Promise<{status:string, reason?:string, text?:string}>
 * }} ContextPort
 */

export const CONTEXT_STATUS = Object.freeze({ OK: 'ok', NOT_RUN: 'not-run' });

export function ctxOk(payload = {}) {
    return { ...payload, status: CONTEXT_STATUS.OK };
}

export function ctxNotRun(reason) {
    return { status: CONTEXT_STATUS.NOT_RUN, reason: String(reason || 'context not available') };
}

export default { CONTEXT_STATUS, ctxOk, ctxNotRun };
