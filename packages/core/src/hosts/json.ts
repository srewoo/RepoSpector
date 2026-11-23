/** Parses one JSON value, or several concatenated (paginated CLI output such as `[...][...]`). */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '{') {
      if (depth++ === 0) start = i;
    } else if ((ch === ']' || ch === '}') && --depth === 0) out.push(JSON.parse(text.slice(start, i + 1)));
  }
  return out;
}

/** Flattens paginated array output (`[[...],[...]]` from --slurp, or `[...][...]`) into one list. */
export function pages<T>(text: string): T[] {
  return parseJsonStream(text).flatMap((v) => (Array.isArray(v) ? v.flatMap((p) => (Array.isArray(p) ? p : [p])) : [v])) as T[];
}
