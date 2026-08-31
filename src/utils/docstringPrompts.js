/**
 * Prompts for DocstringService.
 *
 * The instruction that matters most is the negative one: describe what the code
 * DOES, never what it should do. A docstring that states an intention the code
 * does not implement is worse than a missing docstring — the next reader trusts
 * it and stops reading the body.
 */

export const DOCSTRING_SYSTEM_PROMPT = `You write documentation comments for existing code.

Rules:
1. Describe what the code ACTUALLY does. Never document intended, ideal, or
   assumed behaviour. If the implementation looks wrong, document it as written —
   reporting bugs is not your job here.
2. Say WHY where the code cannot: a non-obvious ordering, a bound that exists for
   a reason, an error deliberately swallowed. Skip the why when it is obvious.
3. Never restate the signature in prose. "Takes a string and returns a number"
   is already in the code and wastes the reader's time.
4. Document every parameter, the return value, and anything thrown — but only
   what the language's convention covers.
5. Match the file's existing documentation style and voice exactly.
6. No prose outside the comment. No examples unless the usage is genuinely
   non-obvious.

Length: 1-2 sentences of summary for a simple function; more only when the code
is genuinely subtle. A long docstring on a short function reads as padding.

Respond with ONLY a JSON object:
{"docstrings": [{"name": "<declaration name>", "docstring": "<the complete comment, including its comment markers, no indentation>"}]}`;

/** Comment syntax reminders, so the model does not have to infer the dialect. */
const STYLE_HINT = Object.freeze({
    jsdoc: 'JSDoc: /** ... */ with @param {type} name, @returns {type}, @throws.',
    javadoc: 'Javadoc: /** ... */ with @param name, @return, @throws.',
    xmldoc: 'XML doc: /// <summary>...</summary>, /// <param name="x">...</param>, /// <returns>...</returns>.',
    godoc: 'Go doc comment: // lines starting with the declaration name, e.g. "// LoadUser returns ...".',
    rustdoc: 'Rustdoc: /// lines, with # Errors / # Panics sections where they apply.',
    docstring: 'Python docstring: """ ... """ with Args:, Returns:, Raises: sections.',
    doxygen: 'Doxygen: /** ... */ with @brief, @param, @return.',
});

/**
 * @param {string} filename
 * @param {Array<{name, kind, docStyle, language, startLine, endLine, source, isExported}>} declarations
 * @returns {string}
 */
export function buildDocstringPrompt(filename, declarations = []) {
    const style = declarations[0]?.docStyle;
    const language = declarations[0]?.language || '';

    let out = `# Write docstrings — ${filename}\n\n`;
    out += `Language: ${language}\n`;
    if (STYLE_HINT[style]) out += `Convention: ${STYLE_HINT[style]}\n`;
    out += `\nEach declaration below was added or changed by this pull request and has no\n`;
    out += `documentation comment. Write one for each.\n\n`;

    for (const d of declarations) {
        out += `---\n\n## ${d.name} (${d.kind}${d.isExported ? ', exported' : ''}) — lines ${d.startLine}-${d.endLine}\n\n`;
        out += `\`\`\`${language}\n${d.source}\n\`\`\`\n\n`;
    }

    out += `---\n\nRespond with JSON only: {"docstrings": [{"name": "...", "docstring": "..."}]}\n`;
    out += `Use the exact names above. Omit any declaration you cannot document honestly.\n`;

    return out;
}

export default { DOCSTRING_SYSTEM_PROMPT, buildDocstringPrompt };
