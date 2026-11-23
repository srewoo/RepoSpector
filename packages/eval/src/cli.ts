#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatZodError } from '@repospector/core';
import { GoldenCaseSchema, PredictionsFileSchema, type GoldenCase } from './golden.js';
import { scoreRun, type RunScore } from './score.js';

const USAGE = `usage: repospector-eval score --cases <cases.json> --predictions <predictions.json>
                        [--tolerance <lines, default 5>] [--split tuning|heldout] [--json]`;

class InputError extends Error {}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (e) {
    throw new InputError(`cannot read ${path}: ${(e as Error).message}`);
  }
}

async function loadCases(path: string): Promise<GoldenCase[]> {
  const raw = await readJson(path);
  if (!Array.isArray(raw)) throw new InputError(`${path}: expected an array of cases`);
  const cases = raw.map((c, i) => {
    const parsed = GoldenCaseSchema.safeParse(c);
    if (!parsed.success) throw new InputError(`${path}: case ${i}: ${formatZodError(parsed.error)}`);
    return parsed.data;
  });
  const dupes = cases.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length > 0) throw new InputError(`${path}: duplicate case ids: ${dupes.join(', ')}`);
  return cases;
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function summary(r: RunScore): string {
  const t = r.totals;
  const lines = [
    `cases      ${r.cases.length} (tolerance ±${r.tolerance} lines)`,
    `TP/FP/FN   ${t.truePositives}/${t.falsePositives}/${t.falseNegatives}`,
    `precision  ${pct(t.precision)}`,
    `recall     ${pct(t.recall)}`,
    `F1         ${pct(t.f1)}`,
  ];
  if (r.missingPredictions.length > 0) lines.push(`warning: no predictions for ${r.missingPredictions.join(', ')}`);
  if (r.unknownCases.length > 0) lines.push(`warning: predictions for unknown cases ${r.unknownCases.join(', ')}`);
  return lines.join('\n');
}

export async function runCli(argv: readonly string[], print: (s: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'score') {
    print(USAGE);
    return 2;
  }
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        cases: { type: 'string' },
        predictions: { type: 'string' },
        tolerance: { type: 'string', default: '5' },
        split: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      strict: true,
    });
    const tolerance = Number(values.tolerance);
    if (!values.cases || !values.predictions || !Number.isInteger(tolerance) || tolerance < 0) {
      print(USAGE);
      return 2;
    }
    if (values.split !== undefined && values.split !== 'tuning' && values.split !== 'heldout') {
      throw new InputError('--split must be tuning or heldout');
    }
    const cases = await loadCases(values.cases);
    const preds = PredictionsFileSchema.safeParse(await readJson(values.predictions));
    if (!preds.success) throw new InputError(`${values.predictions}: ${formatZodError(preds.error)}`);
    const report = scoreRun(cases, preds.data, values.split ? { tolerance, split: values.split } : { tolerance });
    print(values.json ? JSON.stringify(report, null, 2) : summary(report));
    return 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      print(`error: ${(e as Error).message}`);
      return 1;
    }
    throw e;
  }
}

/** True when run as a program, including through npm's bin symlink. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await runCli(process.argv.slice(2), (s) => console.log(s));
}
