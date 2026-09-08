/**
 * Wrap a tool handler so a thrown error becomes a structured, actionable
 * result instead of an uncaught exception.
 *
 * A thrown error from a tool handler is not something an MCP client can act
 * on — it just breaks the call. Every tool handler in this package uses this
 * wrapper so a failure comes back as a normal `{isError: true, content}`
 * result the caller can read and react to, the same as any other tool
 * outcome.
 *
 * Shared here (rather than duplicated per tool file) because every tool
 * needs the identical wrapper, and duplicating it multiplies with each new
 * tool file added.
 */
export function guarded(name, fn) {
    return async (args, ctx) => {
        try {
            return await fn(args, ctx);
        } catch (error) {
            return {
                isError: true,
                content: [{ type: 'text', text: `${name} failed: ${error.message}` }],
            };
        }
    };
}
