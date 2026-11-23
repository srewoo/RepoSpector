import { z } from 'zod';

export const SEVERITIES = ['high', 'medium', 'low', 'nit'] as const;
export const CATEGORIES = ['logic', 'security', 'concurrency', 'requirements', 'rules', 'duplication', 'tests'] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];

/** A repo-relative POSIX path with no traversal, no absolute or drive prefix, no backslashes. */
export function isSafeRepoPath(p: string): boolean {
  if (p.length === 0 || p.length > 500) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg !== '.git');
}

const RepoPath = z.string().refine(isSafeRepoPath, 'must be a repo-relative path without ".." segments');
const Line = z.number().int().min(1).max(10_000_000);

export const LineRangeSchema = z
  .object({ file: RepoPath, startLine: Line, endLine: Line })
  .strict()
  .refine((r) => r.endLine >= r.startLine, 'endLine must be >= startLine');

export const FindingInputSchema = z
  .object({
    file: RepoPath,
    startLine: Line,
    endLine: Line,
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES),
    reasoning: z.string().trim().min(1).max(4000),
    claim: z.string().trim().min(1).max(1000),
    evidence: z.array(LineRangeSchema).min(1).max(10),
    confidence: z.number().min(0).max(1),
    symbol: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((f) => f.endLine >= f.startLine, 'endLine must be >= startLine');

export const VerdictInputSchema = z
  .object({
    findingId: z.string().min(1).max(64),
    keep: z.boolean(),
    reason: z.string().trim().min(1).max(2000),
    citation: LineRangeSchema,
  })
  .strict();

export type LineRange = z.infer<typeof LineRangeSchema>;
export type FindingInput = z.infer<typeof FindingInputSchema>;
export type VerdictInput = z.infer<typeof VerdictInputSchema>;

export interface Finding extends FindingInput {
  readonly id: string;
  readonly specialist: Category;
  readonly fingerprint: string;
}

export type FindingStatus = 'verified' | 'suspected';

export interface JudgedFinding extends Finding {
  readonly verdict: VerdictInput;
  /** Null until a calibration table exists for this model and category. */
  readonly expectedPrecision: number | null;
  /** verified: survived the verifier and threshold. suspected: refuted or low confidence, shown last. */
  readonly status: FindingStatus;
  readonly suspectedBecause?: string;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
