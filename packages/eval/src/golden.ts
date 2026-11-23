import { CATEGORIES, SEVERITIES, isSafeRepoPath } from '@repospector/core';
import { z } from 'zod';

const RepoPath = z.string().refine(isSafeRepoPath, 'must be a repo-relative path');
const Line = z.number().int().min(1);
const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-char commit SHA');

export const GoldenIssueSchema = z
  .object({
    id: z.string().min(1).max(64),
    file: RepoPath,
    line: Line,
    endLine: Line,
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES).optional(),
    description: z.string().min(1).max(2000),
  })
  .strict()
  .refine((i) => i.endLine >= i.line, 'endLine must be >= line');

export const GoldenCaseSchema = z
  .object({
    id: z.string().min(1).max(128),
    repo: z.string().min(1).max(200),
    baseSha: Sha,
    headSha: Sha,
    /** Tuning cases may be used for prompts and calibration; held-out cases never are. */
    split: z.enum(['tuning', 'heldout']),
    labelSource: z.enum(['human', 'fix-commit', 'synthetic']),
    verifiedBy: z.string().max(200).optional(),
    issues: z.array(GoldenIssueSchema).max(100),
  })
  .strict()
  .refine((c) => new Set(c.issues.map((i) => i.id)).size === c.issues.length, 'issue ids must be unique within a case');

export const PredictionSchema = z
  .object({
    file: RepoPath,
    startLine: Line,
    endLine: Line,
    claim: z.string().max(4000),
  })
  .passthrough()
  .refine((p) => p.endLine >= p.startLine, 'endLine must be >= startLine');

export const PredictionsFileSchema = z.record(z.string(), z.array(PredictionSchema));

export type GoldenIssue = z.infer<typeof GoldenIssueSchema>;
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type Prediction = z.infer<typeof PredictionSchema>;
