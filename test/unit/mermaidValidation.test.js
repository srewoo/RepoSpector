/**
 * Tests for the pure Mermaid helpers extracted from BackgroundService
 * (src/background/mermaidValidation.js) — now unit-testable in isolation.
 */

const {
    validateMermaidSyntax,
    sanitizeMermaidCode,
} = require('../../src/background/mermaidValidation.js');

describe('validateMermaidSyntax', () => {
    it('should accept a well-formed sequence diagram', () => {
        const code = 'sequenceDiagram\n  Alice->>Bob: hi\n  Bob-->>Alice: hello';
        const res = validateMermaidSyntax(code, 'sequence');
        expect(res.valid).toBe(true);
        expect(res.errors).toEqual([]);
    });

    it('should flag a missing/mismatched header', () => {
        const code = 'notADiagram\n  a\n  b';
        const res = validateMermaidSyntax(code, 'sequence');
        expect(res.valid).toBe(false);
        expect(res.errors.some(e => /header/i.test(e))).toBe(true);
    });

    it('should flag markdown code fences', () => {
        const code = '```mermaid\nsequenceDiagram\n  A->>B: x\n```';
        const res = validateMermaidSyntax(code, 'sequence');
        expect(res.errors.some(e => /fence/i.test(e))).toBe(true);
    });

    it('should flag unmatched double quotes', () => {
        const code = 'flowchart TD\n  A["unterminated\n  B[ok]';
        const res = validateMermaidSyntax(code, 'sequence');
        expect(res.errors.some(e => /quote/i.test(e))).toBe(true);
    });

    it('should flag a diagram that is too short', () => {
        const res = validateMermaidSyntax('sequenceDiagram', 'sequence');
        expect(res.errors.some(e => /too short/i.test(e))).toBe(true);
    });
});

describe('sanitizeMermaidCode', () => {
    it('should convert <br> to \\n in sequence diagrams', () => {
        const code = 'sequenceDiagram\n  A->>B: line1<br>line2';
        const out = sanitizeMermaidCode(code);
        expect(out).toContain('line1\\nline2');
        expect(out).not.toMatch(/<br\s*\/?>/i);
    });

    it('should strip quotes from flowchart edge labels', () => {
        const out = sanitizeMermaidCode('flowchart TD\n  A -->|"go to"| B');
        expect(out).toContain('A -->|go to| B');
    });

    it('should normalize sequence-style arrows to flowchart arrows', () => {
        const out = sanitizeMermaidCode('flowchart TD\n  A ->> B');
        expect(out).toContain('A --> B');
    });

    it('should collapse whitespace in class-statement id lists', () => {
        const code = 'flowchart TD\n  class A, B, C hub';
        const out = sanitizeMermaidCode(code);
        expect(out).toContain('class A,B,C hub');
    });

    it('should leave already-clean flowchart edges untouched', () => {
        const code = 'flowchart TD\n  A --> B\n  B --> C';
        const out = sanitizeMermaidCode(code);
        expect(out).toContain('A --> B');
        expect(out).toContain('B --> C');
    });
});
