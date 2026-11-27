import { createHash } from 'node:crypto';
import type { LlmClient } from './llm.js';

/** Martian's judge prompt (offline/code_review_benchmark/step3_judge_comments.py), verbatim. */
export const JUDGE_PROMPT = `You are evaluating AI code review tools.
Determine if the candidate issue matches the golden (expected) comment.

Golden Comment (the issue we're looking for):
{golden_comment}

Candidate Issue (from the tool's review):
{candidate}

Instructions:
- Determine if the candidate identifies the SAME underlying issue as the golden comment
- Accept semantic matches - different wording is fine if it's the same problem
- Focus on whether they point to the same bug, concern, or code issue

Respond with ONLY a JSON object:
{"reasoning": "brief explanation", "match": true/false, "confidence": 0.0-1.0}`;

export interface JudgeVerdict {
  readonly match: boolean;
  readonly confidence: number;
  readonly reasoning: string;
}

export interface ReviewJudgement {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly errors: number;
  readonly pairs: number;
  readonly matched: { golden: string; candidate: string; confidence: number }[];
  /** Every pair the judge called a match (a candidate can match several goldens); used for top-N metrics. */
  readonly matches: { golden: string; candidate: string }[];
}

export function parseJudgeReply(text: string): JudgeVerdict | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v = JSON.parse(body) as Partial<JudgeVerdict>;
    if (typeof v.match !== 'boolean') return null;
    return { match: v.match, confidence: typeof v.confidence === 'number' ? v.confidence : 0, reasoning: String(v.reasoning ?? '') };
  } catch {
    return null;
  }
}

function render(golden: string, candidate: string): string {
  return JUDGE_PROMPT.replace('{golden_comment}', golden).replace('{candidate}', candidate);
}

/**
 * Judge every golden x candidate pair and count like Martian: a golden is a TP if any candidate
 * matches; a candidate is marked matched only when it raises that golden's best confidence;
 * unmatched candidates are FPs. Parse failures are counted as errors, never silently as misses.
 */
/** One judge call for a pair, cached. Vote 0 uses the original single-vote key, so old caches stay valid. */
async function judgeOnce(prompt: string, vote: number, llm: LlmClient, model: string, cache: Map<string, string>): Promise<JudgeVerdict | null> {
  const key = createHash('sha256').update(vote === 0 ? `${model}\0${prompt}` : `${model}\0${prompt}\0vote ${vote}`).digest('hex');
  const cached = cache.get(key);
  if (cached !== undefined) return parseJudgeReply(cached);
  let text: string;
  try {
    text = (await llm.complete(prompt, { model })).text;
  } catch {
    return null;
  }
  const parsed = parseJudgeReply(text);
  if (parsed) cache.set(key, text);
  return parsed;
}

/** Majority of `votes` independent calls; null if any call is unreadable. Confidence: mean of the agreeing calls. */
async function judgePair(prompt: string, votes: number, llm: LlmClient, model: string, cache: Map<string, string>): Promise<JudgeVerdict | null> {
  const all = await Promise.all(Array.from({ length: votes }, (_, k) => judgeOnce(prompt, k, llm, model, cache)));
  if (all.some((v) => v === null)) return null;
  const vs = all as JudgeVerdict[];
  const yes = vs.filter((v) => v.match);
  const match = yes.length * 2 > vs.length;
  const agreeing = match ? yes : vs.filter((v) => !v.match);
  return { match, confidence: agreeing.reduce((n, v) => n + v.confidence, 0) / agreeing.length, reasoning: agreeing[0]?.reasoning ?? '' };
}

/**
 * Judge every golden x candidate pair and count like Martian: a golden is a TP if any candidate
 * matches; a candidate is marked matched only when it raises that golden's best confidence;
 * unmatched candidates are FPs. Parse failures are counted as errors, never silently as misses.
 * With votes > 1 each pair is the majority of that many judge calls (single calls flip ~4% of pairs).
 */
export async function judgeReview(
  golden: readonly string[],
  candidates: readonly string[],
  llm: LlmClient,
  model: string,
  cache: Map<string, string> = new Map(),
  votes = 1,
): Promise<ReviewJudgement> {
  const tasks = golden.flatMap((g) => candidates.map((c) => ({ g, c })));
  const verdicts = await Promise.all(tasks.map(({ g, c }) => judgePair(render(g, c), votes, llm, model, cache)));

  const best = new Map<string, { confidence: number; candidate: string }>();
  const candidateMatched = new Set<string>();
  const matches: { golden: string; candidate: string }[] = [];
  let errors = 0;
  tasks.forEach(({ g, c }, i) => {
    const v = verdicts[i];
    if (!v) return void errors++;
    if (v.match) matches.push({ golden: g, candidate: c });
    const current = best.get(g)?.confidence ?? 0;
    if (v.match && v.confidence > current) {
      best.set(g, { confidence: v.confidence, candidate: c });
      candidateMatched.add(c);
    }
  });

  const tp = golden.filter((g) => best.has(g)).length;
  return {
    tp,
    fp: candidates.filter((c) => !candidateMatched.has(c)).length,
    fn: golden.length - tp,
    errors,
    pairs: tasks.length,
    matched: [...best].map(([g, b]) => ({ golden: g, candidate: b.candidate, confidence: b.confidence })),
    matches,
  };
}

export function totalsOf(rows: readonly { tp: number; fp: number; fn: number }[]) {
  const tp = rows.reduce((n, r) => n + r.tp, 0);
  const fp = rows.reduce((n, r) => n + r.fp, 0);
  const fn = rows.reduce((n, r) => n + r.fn, 0);
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}
