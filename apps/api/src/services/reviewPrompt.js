/**
 * Per-chunk prompt construction + LLM output parsing.
 *
 * The orchestrator calls `BackendDeepEngine.execute(chunkPrData, ...)` once
 * per chunk. This module builds the user/system messages and parses the
 * LLM JSON response into Findings.
 *
 * Prompt shape is JSON-mode for deterministic parsing. The output schema is
 * a strict subset of the canonical Finding shape so toCanonicalFinding can
 * lift it without loss.
 */

const SYSTEM_PROMPT = `You are a senior software engineer performing a focused code review.

Rules:
1. Review ONLY the diff hunks provided. Do not invent code that isn't shown.
2. Be specific: every finding must reference a file path and a line number from the diff.
3. Severity must be one of: blocking | suggestion | nitpick.
   - blocking: bug, security vuln, data loss, breaking change
   - suggestion: real improvement worth making before merge
   - nitpick: style/preference, optional
4. Category must be one of: security | logic | performance | architecture | lint | conventions | coverage | dependencies | secrets | docs
5. Output JSON exactly matching the schema. No prose outside the JSON object.

JSON schema:
{
  "summary": "<one-paragraph plain-English summary of the change>",
  "findings": [
    {
      "severity": "blocking|suggestion|nitpick",
      "category": "security|logic|performance|architecture|lint|conventions|coverage|dependencies|secrets|docs",
      "file": "<relative path from the diff>",
      "line": <integer line number>,
      "title": "<short title>",
      "suggestion": "<what to change and why>",
      "rule": "<short rule id, e.g. logic:null-check or sec:sql-injection>"
    }
  ]
}`;

/**
 * Build the user prompt for a chunk. Inlines the shared mr_brief and the
 * chunk's per-file diffs.
 */
export function buildChunkUserPrompt({ chunk, brief, mrContext, dismissedRules }) {
    const briefLines = [];
    if (brief?.removed_exports?.length)     briefLines.push(`Removed exports: ${brief.removed_exports.join(', ')}`);
    if (brief?.added_exports?.length)       briefLines.push(`Added exports: ${brief.added_exports.join(', ')}`);
    if (brief?.changed_signatures?.length)  briefLines.push(`Changed signatures: ${brief.changed_signatures.join(', ')}`);
    if (brief?.shared_contracts?.length)    briefLines.push(`Shared contracts touched: ${brief.shared_contracts.join(', ')}`);
    if (brief?.rename_pairs?.length)        briefLines.push(`Renames: ${brief.rename_pairs.map((r) => `${r.from} → ${r.to}`).join(', ')}`);

    const dismissedNote = dismissedRules?.length
        ? `\n\nThis tenant has previously dismissed the following rules — do NOT re-emit findings for them unless they apply to a clearly different code path:\n${dismissedRules.map((r) => `- ${r.rule} (dismissed ${r.count} time(s))`).join('\n')}`
        : '';

    const fileBlocks = (chunk?.files ?? []).map((f) => {
        const path = f.filename ?? f.new_path ?? f.path;
        const patch = f.patch ?? f.diff ?? '';
        return `### ${path}\n\`\`\`diff\n${patch}\n\`\`\``;
    });

    return [
        mrContext ? `MR context:\n${mrContext}\n` : '',
        briefLines.length ? `Cross-cutting brief (shared across all chunks):\n${briefLines.join('\n')}\n` : '',
        dismissedNote,
        '',
        `Chunk ${chunk?.index ?? 1}/${chunk?.total ?? 1} — ${chunk?.files?.length ?? 0} file(s):\n`,
        ...fileBlocks,
        '',
        'Return JSON only. If the chunk has no issues worth raising, return `{"summary": "...", "findings": []}`.',
    ].filter(Boolean).join('\n');
}

/**
 * Parse the LLM's JSON response into raw findings. Returns
 * { summary, findings } — findings still need toCanonicalFinding lifting
 * by the orchestrator's PHASE.DEEP tagging.
 *
 * Robust to common LLM output flaws: fences (```json), leading prose, BOM.
 */
export function parseLLMReviewJson(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return { summary: '', findings: [] };
    }
    const stripped = text
        .replace(/^﻿/, '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

    // If there's leading prose, try to locate the first { ... } JSON object.
    let json;
    try {
        json = JSON.parse(stripped);
    } catch {
        const m = stripped.match(/\{[\s\S]*\}$/);
        if (!m) return { summary: '', findings: [], _parseError: true };
        try { json = JSON.parse(m[0]); }
        catch { return { summary: '', findings: [], _parseError: true }; }
    }

    const findings = Array.isArray(json.findings) ? json.findings : [];
    return {
        summary: typeof json.summary === 'string' ? json.summary : '',
        findings: findings.filter(Boolean),
    };
}

export const PROMPTS = { SYSTEM_PROMPT };
