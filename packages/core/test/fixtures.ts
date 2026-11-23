export const validFinding = {
  file: 'src/a.ts',
  startLine: 3,
  endLine: 4,
  severity: 'high',
  category: 'logic',
  reasoning: 'b is read before assignment on the error path',
  claim: 'Null dereference when fetch fails',
  evidence: [{ file: 'src/a.ts', startLine: 3, endLine: 4 }],
  confidence: 0.8,
} as const;
