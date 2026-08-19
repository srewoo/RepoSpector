# Precision, GitHub Enterprise, Convention Warm-up & Hunk Windowing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps the repo's own eval harness and source headers admit to: precision is unmeasured, GitHub Enterprise is unsupported, ConventionMiner never contributes to a first review, and large-file diffs enter one prompt whole.

**Architecture:** Four independent workstreams. Item 1 changes only `eval/` (offline, no network). Item 2 extends the existing `gitHosts.js` abstraction to GitHub and routes ~20 hardcoded URL call sites through it. Item 3 adds an in-flight registry plus a bounded await to `ConventionMiner`. Item 4 adds a new `HunkWindower` service behind a default-off flag. Nothing in items 2–4 changes review output by default except item 3's bounded wait.

**Tech Stack:** Vanilla ESM JavaScript, Chrome MV3, Jest 29 + jsdom, Babel transform. No new runtime dependencies — the extension ships none beyond what `package.json` already lists.

**Spec:** `docs/superpowers/specs/2026-08-18-precision-ghe-conventions-windowing-design.md`

## Global Constraints

- **Tests are CommonJS.** Babel resolves no presets for `test/`, so `import` in a test file fails to parse. Every test uses `require(...)`. Source files stay ESM.
- **No new runtime dependencies.** Dev dependencies only, and prefer none.
- **`adjudications[].source`**: absent means `'human'`. Never migrate existing corpora to add it explicitly.
- **Human and LLM precision are never pooled into one rate.** This is the whole point of item 1.
- **`eval/corpus/**` and `eval/results/**` stay gitignored** — they hold real diffs and review comments. Never `git add` them.
- **The existing suite is 100 files / 1509 tests and must stay green.** Run `npx jest` before every commit.
- **Item 4 ships default-off**: `HUNK_WINDOWING: false`.
- **GHE detection is configuration-only.** Do not add a structural `/pull/<n>` signal — it collides with Gitea and Codeberg, which are also in the manifest.
- No file over 300 lines; no function over 50 lines.

---

# Item 1 — Precision, measured and labeled

### Task 1: Partition precision by verdict source

**Files:**
- Modify: `eval/lib/scoring.js:95-118` (`scorePrecision` unchanged), add `scorePrecisionBySource`, modify `scoreRun:195-234`
- Test: `test/unit/evalScoring.test.js`

**Interfaces:**
- Consumes: existing `scorePrecision(predictions, adjudications, tolerance)`, `wilson`, `sameLocation`
- Produces:
  - `scorePrecisionBySource(predictions, adjudications, tolerance) -> { human: PrecisionResult, llm: PrecisionResult }`
  - `scoreRun(...)` result gains `precisionLlm: PrecisionResult`; its existing `precision` field becomes **human-only**
  - `PrecisionResult` is the existing shape: `{ truePositives, falsePositives, unadjudicated, adjudicated, predicted, rate, low, high, n }`

**Why `precision` becomes human-only rather than staying pooled:** pooling is the exact mechanism by which an LLM-derived number acquires the authority of a measured one. Existing corpora have no `source` field, so every current verdict reads as `'human'` and this change is a no-op for `eval/baseline.json` and every committed fixture.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/evalScoring.test.js`:

```js
const { scorePrecisionBySource } = require('../../eval/lib/scoring.js');

describe('scorePrecisionBySource', () => {
    const predictions = [
        { file: 'src/a.js', line: 10 },
        { file: 'src/b.js', line: 20 },
        { file: 'src/c.js', line: 30 },
    ];

    it('treats a verdict with no source as human', () => {
        const out = scorePrecisionBySource(predictions, [
            { file: 'src/a.js', line: 10, verdict: 'true_positive' },
        ]);
        expect(out.human.adjudicated).toBe(1);
        expect(out.human.truePositives).toBe(1);
        expect(out.llm.adjudicated).toBe(0);
        expect(out.llm.rate).toBeNull();
    });

    it('keeps human and llm verdicts in separate samples', () => {
        const out = scorePrecisionBySource(predictions, [
            { file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'human' },
            { file: 'src/b.js', line: 20, verdict: 'false_positive', source: 'llm' },
            { file: 'src/c.js', line: 30, verdict: 'true_positive', source: 'llm' },
        ]);
        expect(out.human.adjudicated).toBe(1);
        expect(out.human.rate).toBe(1);
        expect(out.llm.adjudicated).toBe(2);
        expect(out.llm.rate).toBe(0.5);
    });

    it('never pools the two samples', () => {
        const out = scorePrecisionBySource(predictions, [
            { file: 'src/a.js', line: 10, verdict: 'false_positive', source: 'human' },
            { file: 'src/b.js', line: 20, verdict: 'true_positive', source: 'llm' },
        ]);
        // Pooled would be 1/2 = 50%. Neither sample may report that.
        expect(out.human.rate).toBe(0);
        expect(out.llm.rate).toBe(1);
    });
});

describe('scoreRun precision sourcing', () => {
    it('reports human-only in `precision` and llm separately', () => {
        const result = scoreRun([{
            id: 'case-1',
            predictions: [{ file: 'src/a.js', line: 10 }, { file: 'src/b.js', line: 20 }],
            adjudications: [
                { file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'human' },
                { file: 'src/b.js', line: 20, verdict: 'false_positive', source: 'llm' },
            ],
            humanComments: [],
        }]);
        expect(result.precision.adjudicated).toBe(1);
        expect(result.precision.rate).toBe(1);
        expect(result.precisionLlm.adjudicated).toBe(1);
        expect(result.precisionLlm.rate).toBe(0);
    });

    it('leaves `precision` unmeasured when only llm verdicts exist', () => {
        const result = scoreRun([{
            id: 'case-1',
            predictions: [{ file: 'src/a.js', line: 10 }],
            adjudications: [{ file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'llm' }],
            humanComments: [],
        }]);
        expect(result.precision.rate).toBeNull();
        expect(result.precisionLlm.rate).toBe(1);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/evalScoring.test.js -t 'scorePrecisionBySource'`
Expected: FAIL — `scorePrecisionBySource is not a function`

- [ ] **Step 3: Write minimal implementation**

In `eval/lib/scoring.js`, after `scorePrecision`:

```js
/** A verdict with no explicit source predates the field and was human-made. */
function sourceOf(adjudication) {
    return adjudication?.source === 'llm' ? 'llm' : 'human';
}

/**
 * Precision, split by who judged.
 *
 * The two rates are returned separately and are never combined. An LLM
 * adjudicator has no demonstrated relationship to correctness on this task —
 * the pipeline's own verifier passed 42 of 42 findings human adjudication then
 * rejected — so pooling them would launder an unfalsifiable number into the
 * project's headline figure.
 */
export function scorePrecisionBySource(predictions = [], adjudications = [], tolerance = DEFAULT_LINE_TOLERANCE) {
    const human = adjudications.filter(a => sourceOf(a) === 'human');
    const llm = adjudications.filter(a => sourceOf(a) === 'llm');
    return {
        human: scorePrecision(predictions, human, tolerance),
        llm: scorePrecision(predictions, llm, tolerance),
    };
}
```

In `scoreRun`, replace the pooled precision line:

```js
    const split = scorePrecisionBySource(allPredictions, allAdjudications, tolerance);
    const precision = split.human;
    const precisionLlm = split.llm;
    const recall = scoreRecall(allPredictions, allHumanComments, tolerance);
```

and add `precisionLlm` to the returned object, immediately after `precision`:

```js
        precision,
        precisionLlm,
```

Also update the per-case loop to use the human sample, so `perCase` and the pooled figure agree:

```js
        const precision = scorePrecisionBySource(predictions, adjudications, tolerance).human;
```

Add `scorePrecisionBySource` to the `export default` block.

- [ ] **Step 4: Run the full eval test file**

Run: `npx jest test/unit/evalScoring.test.js`
Expected: PASS, including the pre-existing tests — they use no `source` field, so they exercise the human path unchanged.

- [ ] **Step 5: Confirm the committed baseline still scores identically**

Run: `node eval/score.js --corpus eval/fixtures/synthetic.json`
Expected: precision 75.0%, recall 25.0% — the values in `eval/baseline.json`. If they moved, the human-default is wrong.

- [ ] **Step 6: Commit**

```bash
git add eval/lib/scoring.js test/unit/evalScoring.test.js
git commit -m "feat(eval): partition precision by verdict source

Human and LLM verdicts are scored as separate samples and never pooled.
An LLM adjudicator has no demonstrated relationship to correctness here,
so pooling would give an unfalsifiable number the authority of a measured
one. Verdicts without a source field read as human, so every existing
corpus and the committed baseline score exactly as before."
```

---

### Task 2: Label LLM precision in reports and protect the baseline

**Files:**
- Modify: `eval/lib/scoring.js:242-262` (`formatReport`)
- Modify: `eval/score.js:22-36` (arg parsing), `eval/score.js:145-167` (baseline write)
- Test: `test/unit/evalScoring.test.js`

**Interfaces:**
- Consumes: `scoreRun` result with `precision` and `precisionLlm` from Task 1
- Produces: `formatReport(result)` emits an `LLM-adjudicated — not authoritative` line when `precisionLlm.adjudicated > 0`; `score.js` accepts `--allow-llm-baseline`

**The precise refusal rule.** Because `precision` is already human-only, an LLM verdict can never reach `thresholds.precisionLow` — so a blanket refusal would be theatre. The real hazard is different: writing a baseline when the human sample is *empty* records `precisionLow: 0` while the report on screen shows a healthy LLM number, so the next reader concludes precision was measured and the bar is 0. Therefore: **refuse when the human sample is empty and LLM verdicts exist**, unless `--allow-llm-baseline`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/evalScoring.test.js`:

```js
const { formatReport } = require('../../eval/lib/scoring.js');

describe('formatReport LLM labeling', () => {
    function runWith(adjudications) {
        return scoreRun([{
            id: 'c1',
            predictions: [{ file: 'src/a.js', line: 10 }],
            adjudications,
            humanComments: [],
        }]);
    }

    it('labels the llm rate and never presents it as Precision', () => {
        const text = formatReport(runWith([
            { file: 'src/a.js', line: 10, verdict: 'true_positive', source: 'llm' },
        ]));
        expect(text).toContain('LLM-adjudicated — not authoritative');
        // The authoritative line must still read as unmeasured.
        expect(text).toMatch(/Precision \(human\):\s+n\/a/);
    });

    it('omits the llm line entirely when no llm verdicts exist', () => {
        const text = formatReport(runWith([
            { file: 'src/a.js', line: 10, verdict: 'true_positive' },
        ]));
        expect(text).not.toContain('LLM-adjudicated');
    });
});

describe('baseline protection', () => {
    const { refuseLlmBaseline } = require('../../eval/score.js');

    it('refuses when the human sample is empty but llm verdicts exist', () => {
        const result = { precision: { adjudicated: 0 }, precisionLlm: { adjudicated: 12 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: false })).toBe(true);
    });

    it('permits when the human sample is non-empty', () => {
        const result = { precision: { adjudicated: 30 }, precisionLlm: { adjudicated: 12 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: false })).toBe(false);
    });

    it('permits when explicitly allowed', () => {
        const result = { precision: { adjudicated: 0 }, precisionLlm: { adjudicated: 12 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: true })).toBe(false);
    });

    it('permits an ordinary run with no adjudications at all', () => {
        const result = { precision: { adjudicated: 0 }, precisionLlm: { adjudicated: 0 } };
        expect(refuseLlmBaseline(result, { allowLlmBaseline: false })).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/evalScoring.test.js -t 'LLM labeling'`
Expected: FAIL — the report says `Precision:` not `Precision (human):`, and `refuseLlmBaseline` is not exported.

- [ ] **Step 3: Implement the report change**

Replace the precision line in `formatReport` (`eval/lib/scoring.js`) and add the LLM line:

```js
export function formatReport(result) {
    const { precision: p, recall: r } = result;
    const llm = result.precisionLlm;
    const tagLines = (result.byTag ?? []).length
        ? ['', 'Detection by defect class:',
            ...result.byTag.map(t =>
                `  ${t.key.padEnd(24)} ${String(t.matched).padStart(2)}/${String(t.total).padEnd(2)}  ${pct(t.rate)}`)]
        : [];
    // Only rendered when someone actually ran an LLM pass. The suffix is not
    // optional and has no verbosity flag: this number's whole failure mode is
    // being quoted without it.
    const llmLines = llm && llm.adjudicated > 0
        ? [`Precision (LLM):    ${pct(llm.rate)}  [${pct(llm.low)} – ${pct(llm.high)}]   ` +
           `${llm.truePositives}/${llm.adjudicated}   LLM-adjudicated — not authoritative`]
        : [];
    return [
        `MRs scored:        ${result.cases}   (line tolerance ±${result.tolerance})`,
        '',
        `Precision (human): ${pct(p.rate)}  [${pct(p.low)} – ${pct(p.high)}]   ` +
            `${p.truePositives}/${p.adjudicated} adjudicated findings correct`,
        ...llmLines,
        `Recall:            ${pct(r.rate)}  [${pct(r.low)} – ${pct(r.high)}]   ` +
            `${r.matched}/${r.reference} human comments matched`,
        `F1:                ${pct(result.f1)}`,
        '',
        `Findings produced: ${p.predicted}   (${p.unadjudicated} not yet adjudicated)`,
        ...tagLines,
    ].join('\n');
}
```

- [ ] **Step 4: Implement the baseline guard**

In `eval/score.js`, add to `parseArgs` alongside the other flags:

```js
        else if (a === '--allow-llm-baseline') args.allowLlmBaseline = true;
```

Add the exported predicate near `gate`:

```js
/**
 * Should `--write-baseline` refuse?
 *
 * `precision` is human-only, so an LLM verdict cannot move the threshold
 * directly. The hazard is subtler: recording a baseline from an EMPTY human
 * sample stamps `precisionLow: 0` into the file while the report on screen
 * shows a healthy LLM figure, and the next reader concludes precision was
 * measured and the bar is zero.
 */
export function refuseLlmBaseline(result, args = {}) {
    if (args.allowLlmBaseline) return false;
    const humanJudged = result?.precision?.adjudicated ?? 0;
    const llmJudged = result?.precisionLlm?.adjudicated ?? 0;
    return humanJudged === 0 && llmJudged > 0;
}
```

And at the top of the `if (args.writeBaseline)` block:

```js
    if (args.writeBaseline) {
        if (refuseLlmBaseline(result, args)) {
            console.error(
                `\nRefusing to write a baseline: ${result.precisionLlm.adjudicated} finding(s) are ` +
                `LLM-adjudicated and none are human-adjudicated.\n` +
                `The gate must be anchored to human judgment. Adjudicate a human sample, or pass ` +
                `--allow-llm-baseline if you accept a baseline whose precision floor is unmeasured.`
            );
            process.exit(1);
        }
```

Also add `allowLlmBaseline: false` to the `args` initialiser object and mention the flag in the `USAGE` string.

- [ ] **Step 5: Run the tests**

Run: `npx jest test/unit/evalScoring.test.js`
Expected: PASS

- [ ] **Step 6: Verify the CLI end to end**

Run: `node eval/score.js --corpus eval/fixtures/synthetic.json`
Expected: report shows `Precision (human): 75.0%` and no `LLM-adjudicated` line.

Run: `npm run eval:gate`
Expected: `No regression.`

- [ ] **Step 7: Commit**

```bash
git add eval/lib/scoring.js eval/score.js test/unit/evalScoring.test.js
git commit -m "feat(eval): label LLM precision and refuse an unanchored baseline

The report renders the LLM rate on its own line with a suffix that has no
off switch, and --write-baseline refuses when the human sample is empty
while LLM verdicts exist, since that would stamp precisionLow: 0 into the
baseline while showing a healthy number on screen."
```

---

### Task 3: Adjudication worksheet with real diff context

**Files:**
- Create: `eval/lib/hunks.js`
- Modify: `eval/adjudicate.js` (args, `doExport`, `doImport`)
- Test: `test/unit/evalHunks.test.js` (create)

**Interfaces:**
- Consumes: corpus cases with `prData.files[].patch` (verified present for all 129 files in the 22-case corpus)
- Produces:
  - `hunkForLine(patch, line) -> { header, text, newStart, newEnd } | null`
  - `splitHunks(patch) -> Array<{ header, text, newStart, newEnd, oldStart, lines }>`
  - `eval/adjudicate.js --export-context <file.md>` and `--import <csv> --source llm`

**Why markdown for context, CSV for verdicts:** `csvCell` flattens newlines to spaces, which destroys a diff. A finding is unjudgeable without the diff laid out in lines, so context goes to markdown for reading and the CSV stays the machine-readable verdict carrier.

- [ ] **Step 1: Write the failing test**

Create `test/unit/evalHunks.test.js`:

```js
/**
 * The adjudication worksheet is only as good as the code it shows. A hunk
 * slicer that returns the wrong window makes every verdict it informs wrong,
 * and silently — the reader has no way to tell they judged the wrong lines.
 */
const { splitHunks, hunkForLine } = require('../../eval/lib/hunks.js');

const PATCH = [
    '@@ -1,4 +1,5 @@',
    ' context a',
    '-removed b',
    '+added b',
    '+added c',
    ' context d',
    '@@ -100,3 +101,4 @@ func doThing() {',
    ' context e',
    '+added f',
    ' context g',
].join('\n');

describe('splitHunks', () => {
    it('splits on hunk headers and records the new-side range', () => {
        const hunks = splitHunks(PATCH);
        expect(hunks).toHaveLength(2);
        expect(hunks[0].newStart).toBe(1);
        expect(hunks[0].newEnd).toBe(5);
        expect(hunks[1].newStart).toBe(101);
        expect(hunks[1].newEnd).toBe(104);
        expect(hunks[1].header).toContain('func doThing()');
    });

    it('returns an empty array for an absent or empty patch', () => {
        expect(splitHunks(null)).toEqual([]);
        expect(splitHunks('')).toEqual([]);
    });

    it('handles a header with no count, which means one line', () => {
        const hunks = splitHunks('@@ -5 +5 @@\n-x\n+y');
        expect(hunks[0].newStart).toBe(5);
        expect(hunks[0].newEnd).toBe(5);
    });
});

describe('hunkForLine', () => {
    it('finds the hunk containing a new-side line', () => {
        expect(hunkForLine(PATCH, 102).header).toContain('func doThing()');
        expect(hunkForLine(PATCH, 3).newStart).toBe(1);
    });

    it('returns null when no hunk covers the line', () => {
        expect(hunkForLine(PATCH, 50)).toBeNull();
    });

    it('returns null for a missing line number rather than guessing', () => {
        expect(hunkForLine(PATCH, null)).toBeNull();
    });

    it('includes the diff body, not just the header', () => {
        expect(hunkForLine(PATCH, 102).text).toContain('+added f');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/evalHunks.test.js`
Expected: FAIL — `Cannot find module '../../eval/lib/hunks.js'`

- [ ] **Step 3: Implement the hunk slicer**

Create `eval/lib/hunks.js`:

```js
/**
 * hunks — slice a single file's patch into hunks.
 *
 * Corpus cases store `prData.files[].patch` and no pre-parsed hunks, so
 * adjudication has to find the window around a finding's line itself.
 *
 * This does not use `src/utils/diffParser.js`: that class consumes a whole
 * multi-file diff, which is the wrong input granularity, and pulling a
 * thousand-line parser in to find `@@` boundaries in one patch would be the
 * more complex option rather than the simpler one. The header regex is
 * deliberately the same shape it uses.
 */

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * @param {string} patch
 * @returns {Array<{header:string, text:string, newStart:number, newEnd:number, oldStart:number, lines:string[]}>}
 */
export function splitHunks(patch) {
    if (!patch || typeof patch !== 'string') return [];

    const hunks = [];
    let current = null;

    for (const line of patch.split('\n')) {
        const match = line.match(HUNK_HEADER);
        if (match) {
            if (current) hunks.push(current);
            const oldStart = Number(match[1]);
            const newStart = Number(match[3]);
            // An omitted count means 1 — `@@ -5 +5 @@` is a single-line hunk.
            const newCount = match[4] === undefined ? 1 : Number(match[4]);
            current = {
                header: line,
                lines: [],
                oldStart,
                newStart,
                // A zero-length hunk (pure deletion) must not report an end
                // before its start, or no line can ever fall inside it.
                newEnd: newStart + Math.max(newCount, 1) - 1,
            };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) hunks.push(current);

    return hunks.map(h => ({ ...h, text: [h.header, ...h.lines].join('\n') }));
}

/**
 * The hunk covering `line` on the new side, or null.
 *
 * Null is the honest answer for a finding whose line is outside every hunk —
 * showing an arbitrary neighbouring hunk would invite a verdict on code the
 * finding was not about.
 *
 * @param {string} patch
 * @param {number|null|undefined} line
 */
export function hunkForLine(patch, line) {
    if (line == null || Number.isNaN(Number(line))) return null;
    const n = Number(line);
    return splitHunks(patch).find(h => n >= h.newStart && n <= h.newEnd) ?? null;
}

export default { splitHunks, hunkForLine };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/unit/evalHunks.test.js`
Expected: PASS (10 assertions across 7 tests)

- [ ] **Step 5: Add `--export-context` and `--source` to adjudicate.js**

In `parseArgs`, extend the initialiser and the loop:

```js
    const args = {
        corpus: 'eval/corpus/public-prs.json',
        export: null, exportContext: null, import: null,
        postedOnly: false, source: 'human',
    };
```

```js
        else if (a === '--export-context') args.exportContext = argv[++i];
        else if (a === '--source') args.source = argv[++i];
```

Add the import at the top of the file:

```js
import { hunkForLine } from './lib/hunks.js';
```

Add the markdown writer:

```js
/**
 * A markdown worksheet with the actual diff beside each finding.
 *
 * The CSV cannot carry this: `csvCell` flattens newlines to spaces, and a diff
 * with its line structure removed is not something anyone can judge. So the
 * markdown is for reading and the CSV stays the verdict carrier.
 */
function doExportContext(args) {
    const { cases } = loadCorpus(resolve(args.corpus));
    const out = [
        '# Adjudication worksheet',
        '',
        'For each finding: is it real, judged **against the diff below** and not',
        'against whether the wording sounds plausible? Record verdicts in the CSV',
        'worksheet — this file is for reading.',
        '',
    ];

    let count = 0;
    let noHunk = 0;
    for (const kase of cases) {
        const byName = new Map((kase.prData?.files ?? []).map(f => [f.filename, f]));
        for (const p of kase.predictions ?? []) {
            if (args.postedOnly && !p.posted) continue;
            count++;
            const hunk = hunkForLine(byName.get(p.file)?.patch, p.line);
            if (!hunk) noHunk++;
            out.push(
                `## ${kase.id} — \`${p.file}:${p.line ?? '?'}\``,
                '',
                `- **severity**: ${p.severity ?? '?'}  ·  **rule**: ${p.rule ?? '?'}  ·  **posted**: ${p.posted ? 'inline' : 'summary'}`,
                `- **title**: ${p.title ?? ''}`,
                `- **description**: ${(p.description ?? '').replace(/\s+/g, ' ')}`,
                `- **suggestion**: ${(p.suggestion ?? '').replace(/\s+/g, ' ')}`,
                '',
                hunk ? '```diff' : '_No hunk in the stored patch covers this line._',
                ...(hunk ? [hunk.text, '```'] : []),
                '',
            );
        }
    }

    writeFileSync(resolve(args.exportContext), `${out.join('\n')}\n`);
    console.log(`Wrote ${count} finding(s) with diff context to ${args.exportContext}`);
    if (noHunk) console.log(`${noHunk} finding(s) had no covering hunk — judge those from the file path alone, or skip them.`);
}
```

In `doExport`, make the pre-filled verdict lookup source-aware so a re-export after an LLM pass does not silently present LLM verdicts as human ones — add the source as a column. Change `COLUMNS`:

```js
const COLUMNS = ['case', 'file', 'line', 'severity', 'posted', 'rule', 'title', 'suggestion', 'verdict', 'source'];
```

and the row push in `doExport`:

```js
            lines.push([
                kase.id, p.file, p.line ?? '', p.severity ?? '', p.posted ? 'inline' : 'summary',
                p.rule ?? '', p.title ?? '', p.suggestion ?? '', existing?.verdict ?? '',
                existing?.source ?? '',
            ].map(csvCell).join(','));
```

In `doImport`, stamp the source. Replace the write-back block:

```js
        const rowSource = (row[idx.source] ?? '').trim().toLowerCase();
        const source = rowSource === 'llm' || rowSource === 'human' ? rowSource : args.source;
        if (source !== 'human' && source !== 'llm') {
            throw new Error(`Unrecognised source "${source}". Use human or llm.`);
        }

        kase.adjudications = kase.adjudications ?? [];
        const existing = kase.adjudications.find(a => a.file === file && Number(a.line) === Number(line));
        if (existing) {
            existing.verdict = verdict;
            // Absent means human; only ever write the field for llm, so existing
            // corpora keep their exact committed shape.
            if (source === 'llm') existing.source = 'llm';
            else delete existing.source;
        } else {
            kase.adjudications.push({
                file,
                ...(line == null ? {} : { line }),
                verdict,
                ...(source === 'llm' ? { source: 'llm' } : {}),
            });
        }
        applied++;
```

Update `main` and `USAGE`:

```js
    if (args.help || (!args.export && !args.exportContext && !args.import)) {
        console.log('Usage: node eval/adjudicate.js --corpus <file> (--export <csv> | --export-context <md> | --import <csv> [--source human|llm]) [--posted-only]');
        process.exit(args.help ? 0 : 2);
    }
    if (args.exportContext) doExportContext(args);
    if (args.export) doExport(args);
    if (args.import) doImport(args);
```

- [ ] **Step 6: Verify the worksheet against the real corpus**

```bash
node eval/adjudicate.js --corpus eval/corpus/public-prs.json \
  --export-context eval/results/worksheet-public.md
node eval/adjudicate.js --corpus eval/corpus/injected.json \
  --export-context eval/results/worksheet-injected.md
head -40 eval/results/worksheet-public.md
```

Expected: 152 findings for `public-prs`, 120 for `injected`, each with a fenced `diff` block. Confirm the first entry's hunk actually contains the reported line.

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: 101 suites pass (100 existing + `evalHunks`), 0 failures.

- [ ] **Step 8: Commit**

Do **not** add anything under `eval/results/` or `eval/corpus/` — both are gitignored and hold real diffs.

```bash
git add eval/lib/hunks.js eval/adjudicate.js test/unit/evalHunks.test.js
git commit -m "feat(eval): adjudication worksheet with real diff context

Findings cannot be judged from a title. --export-context emits each
finding beside the hunk that contains its line, sliced from the patches
already stored in the corpus, so adjudication needs no API calls. The CSV
gains a source column so an LLM pass can never be re-imported as human."
```

---

### Task 4: Adjudicate all 272 findings and record the result

**Files:**
- Modify: `eval/corpus/public-prs.json`, `eval/corpus/injected.json` (gitignored — verdicts only, never committed)
- Modify: `eval/README.md` ("Still open" §1 and a new measured subsection)

**Interfaces:**
- Consumes: `--export-context` worksheets from Task 3, `refuseLlmBaseline` from Task 2
- Produces: `precisionLlm` figures for both corpora, recorded in `eval/README.md`

**Standing constraint for this task:** judge against the diff in the worksheet, not against whether the finding reads plausibly. That distinction is the one the retired LLM verifier failed — it passed 42 of 42 findings humans then rejected. A finding that describes a real problem on the wrong line is a false positive; so is one whose premise is contradicted by a line visible in the hunk.

- [ ] **Step 1: Generate both worksheets**

```bash
node eval/adjudicate.js --corpus eval/corpus/public-prs.json --export-context eval/results/worksheet-public.md
node eval/adjudicate.js --corpus eval/corpus/public-prs.json --export eval/results/verdicts-public.csv
node eval/adjudicate.js --corpus eval/corpus/injected.json --export-context eval/results/worksheet-injected.md
node eval/adjudicate.js --corpus eval/corpus/injected.json --export eval/results/verdicts-injected.csv
```

- [ ] **Step 2: Adjudicate `public-prs` (152 findings)**

Read `eval/results/worksheet-public.md` in full. For each finding fill the `verdict` column of `eval/results/verdicts-public.csv` with `true_positive` or `false_positive`, leaving `source` blank (the `--source llm` flag stamps it at import). Leave a verdict blank only when the worksheet reports no covering hunk and the file path alone cannot settle it.

Work in batches of ~25 findings and keep a running tally, so the pass is auditable rather than one opaque sweep.

- [ ] **Step 3: Adjudicate `injected` (120 findings)**

Same process against `eval/results/worksheet-injected.md`. Note that in this corpus a *planted* defect being reported is a true positive; findings about anything else still need judging on their own merits.

- [ ] **Step 4: Import both, stamped as LLM**

```bash
node eval/adjudicate.js --corpus eval/corpus/public-prs.json --import eval/results/verdicts-public.csv --source llm
node eval/adjudicate.js --corpus eval/corpus/injected.json --import eval/results/verdicts-injected.csv --source llm
```

Expected: "Applied N verdict(s)" with N matching your tally.

- [ ] **Step 5: Score and confirm the labeling holds**

```bash
node eval/score.js --corpus eval/corpus/public-prs.json
node eval/score.js --corpus eval/corpus/injected.json
```

Expected on both: `Precision (human): n/a` and a `Precision (LLM): …  LLM-adjudicated — not authoritative` line.

- [ ] **Step 6: Confirm the baseline guard fires**

Run: `node eval/score.js --corpus eval/corpus/public-prs.json --write-baseline`
Expected: exit 1, refusing because the human sample is empty. **Do not** pass `--allow-llm-baseline` — the committed baseline stays where it is.

- [ ] **Step 7: Record the numbers in `eval/README.md`**

Under "Still open", replace item 1 with the measured LLM figure, its Wilson interval, and an explicit statement that it is not authoritative and that the gate remains anchored to human judgment. Add the two rates (public-prs and injected) with `n/N` counts. State the count of findings left blank for want of a covering hunk.

Keep the existing warning about LLM adjudication in `eval/adjudicate.js` — it is the reason the number carries the label, not a stale note to clean up.

- [ ] **Step 8: Commit the README only**

```bash
git add eval/README.md
git commit -m "docs(eval): record LLM-adjudicated precision for both corpora

272 findings judged against their stored diff hunks. Reported as
LLM-adjudicated and excluded from the gate: the figure exists so the
false-positive rate is no longer entirely unknown, not so it can be
quoted as measured precision. Corpora stay gitignored."
```

---

# Item 2 — GitHub Enterprise

### Task 5: GHE primitives in gitHosts

**Files:**
- Modify: `src/utils/gitHosts.js` (host set, `detectPlatform:104-124`, new exports, default export block)
- Test: `test/unit/gitHosts.test.js`

**Interfaces:**
- Consumes: existing `toUrl`, `hostOf`, `PLATFORM`
- Produces:
  - `githubApiBase(url) -> string` — `github.com` → `https://api.github.com`; else `https://<host>/api/v3`
  - `githubRawBase(url) -> string` — `github.com` → `https://raw.githubusercontent.com`; else `https://<host>`
  - `setGitHubHosts(hosts)`, `rememberGitHubHost(hostOrUrl)`, `getGitHubHosts()`, `resetGitHubHosts()`, `isKnownGitHubHost(hostOrUrl)`
  - `detectPlatform` additionally returns `'github'` for a configured GHE host

- [ ] **Step 1: Write the failing test**

Append to `test/unit/gitHosts.test.js`:

```js
const {
    githubApiBase,
    githubRawBase,
    setGitHubHosts,
    rememberGitHubHost,
    getGitHubHosts,
    resetGitHubHosts,
    isKnownGitHubHost,
    detectPlatform,
    setGitLabHosts,
    resetGitLabHosts,
} = require('../../src/utils/gitHosts.js');

describe('githubApiBase', () => {
    afterEach(() => resetGitHubHosts());

    it('maps the public instance to api.github.com', () => {
        expect(githubApiBase('https://github.com/o/r/pull/1')).toBe('https://api.github.com');
        expect(githubApiBase()).toBe('https://api.github.com');
    });

    it('maps an enterprise host to its /api/v3 root', () => {
        expect(githubApiBase('https://github.acme.com/o/r/pull/1')).toBe('https://github.acme.com/api/v3');
    });

    it('preserves a non-default port and an http scheme', () => {
        expect(githubApiBase('http://ghe.internal:8080/o/r')).toBe('http://ghe.internal:8080/api/v3');
    });
});

describe('githubRawBase', () => {
    it('maps the public instance to raw.githubusercontent.com', () => {
        expect(githubRawBase('https://github.com/o/r')).toBe('https://raw.githubusercontent.com');
    });

    it('serves raw content from the enterprise host itself', () => {
        expect(githubRawBase('https://github.acme.com/o/r')).toBe('https://github.acme.com');
    });
});

describe('GitHub host configuration', () => {
    afterEach(() => resetGitHubHosts());

    it('always retains github.com', () => {
        setGitHubHosts(['github.acme.com']);
        expect(getGitHubHosts()).toContain('github.com');
        expect(getGitHubHosts()).toContain('github.acme.com');
    });

    it('accepts a full URL as well as a bare host', () => {
        setGitHubHosts(['https://github.acme.com/o/r/pull/3']);
        expect(isKnownGitHubHost('github.acme.com')).toBe(true);
    });

    it('matches subdomains of a configured suffix', () => {
        setGitHubHosts(['acme.com']);
        expect(isKnownGitHubHost('github.acme.com')).toBe(true);
    });

    it('does not match an unconfigured host', () => {
        expect(isKnownGitHubHost('github.other.com')).toBe(false);
    });

    it('remembers a host discovered at runtime', () => {
        rememberGitHubHost('https://ghe.acme.com/o/r/pull/9');
        expect(isKnownGitHubHost('ghe.acme.com')).toBe(true);
    });
});

describe('detectPlatform with GHE', () => {
    afterEach(() => { resetGitHubHosts(); resetGitLabHosts(); });

    it('detects a configured enterprise host as github', () => {
        setGitHubHosts(['github.acme.com']);
        expect(detectPlatform('https://github.acme.com/o/r/pull/4')).toBe('github');
    });

    it('returns null for an unconfigured enterprise host', () => {
        // Configuration-only by design: /pull/<n> is also Gitea's and
        // Codeberg's shape, so inferring GitHub from it would misroute them.
        expect(detectPlatform('https://github.acme.com/o/r/pull/4')).toBeNull();
    });

    it('still returns null for other forges', () => {
        expect(detectPlatform('https://codeberg.org/o/r/pulls/4')).toBeNull();
    });

    it('lets a GitLab route win on a host configured as both', () => {
        setGitHubHosts(['devtools.acme.com']);
        setGitLabHosts(['devtools.acme.com']);
        expect(detectPlatform('https://devtools.acme.com/g/p/-/merge_requests/7')).toBe('gitlab');
    });

    it('leaves github.com behaviour unchanged', () => {
        expect(detectPlatform('https://github.com/o/r/pull/1')).toBe('github');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/gitHosts.test.js`
Expected: FAIL — `githubApiBase is not a function`

- [ ] **Step 3: Implement**

In `src/utils/gitHosts.js`, beside the GitLab host set:

```js
const DEFAULT_GITHUB_HOSTS = ['github.com'];

/** Configured GitHub hosts, lower-cased. Seeded with the public instance. */
let githubHosts = new Set(DEFAULT_GITHUB_HOSTS);
```

Add the management functions, mirroring the GitLab ones exactly:

```js
/**
 * Replace the configured GitHub Enterprise host list.
 *
 * Always keeps github.com, so enabling an enterprise instance never breaks
 * review of a public PR.
 *
 * @param {string|string[]|null|undefined} hosts - hostnames or full URLs
 */
export function setGitHubHosts(hosts) {
    const next = new Set(DEFAULT_GITHUB_HOSTS);
    const list = Array.isArray(hosts) ? hosts : (hosts ? [hosts] : []);
    for (const entry of list) {
        const host = hostOf(entry);
        if (host) next.add(host);
    }
    githubHosts = next;
}

/** Register a GitHub host discovered at runtime (e.g. from a parsed PR URL). */
export function rememberGitHubHost(hostOrUrl) {
    const host = hostOf(hostOrUrl);
    if (host) githubHosts.add(host);
}

/** The currently configured GitHub hosts, for display and diagnostics. */
export function getGitHubHosts() {
    return [...githubHosts];
}

/** Reset to defaults. Test seam — production code has no reason to call this. */
export function resetGitHubHosts() {
    githubHosts = new Set(DEFAULT_GITHUB_HOSTS);
}

/** Is this host a configured GitHub instance (exact match or subdomain)? */
export function isKnownGitHubHost(hostOrUrl) {
    const host = hostOf(hostOrUrl);
    if (!host) return false;
    for (const known of githubHosts) {
        if (host === known || host.endsWith(`.${known}`)) return true;
    }
    return false;
}

/**
 * REST API base for the GitHub instance serving `url`.
 *
 * GHE Server roots its REST API at `/api/v3` on the instance itself, unlike
 * github.com which uses a separate api. subdomain.
 *
 * @param {string} [url] - any URL on the instance; defaults to github.com
 * @returns {string}
 */
export function githubApiBase(url) {
    const parsed = toUrl(url);
    if (!parsed) return 'https://api.github.com';
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com' || host === 'www.github.com' || host === 'api.github.com') {
        return 'https://api.github.com';
    }
    // Scheme and a non-default port are preserved: internal instances run on both.
    return `${parsed.protocol}//${parsed.host}/api/v3`;
}

/**
 * Base for raw file content on the instance serving `url`.
 *
 * github.com serves raw content from a dedicated host; GHE serves it from the
 * instance, so callers append `/<owner>/<repo>/raw/<ref>/<path>`.
 */
export function githubRawBase(url) {
    const parsed = toUrl(url);
    if (!parsed) return 'https://raw.githubusercontent.com';
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com' || host === 'www.github.com') {
        return 'https://raw.githubusercontent.com';
    }
    return `${parsed.protocol}//${parsed.host}`;
}
```

In `detectPlatform`, add the configured-GitHub branch **after** the GitLab structural check, and extend the header comment:

```js
    if (isKnownGitLabHost(host)) return PLATFORM.GITLAB;

    // GHE is configuration-only, and deliberately so. GitLab earns structural
    // detection because `/-/` is a route marker unique to GitLab. GitHub's
    // `/pull/<n>` is NOT unique — Codeberg, Gitea and other forges listed in
    // the manifest use the same or a near-identical shape — so inferring GitHub
    // from path structure would route those hosts to the GitHub API and 404.
    // The cost is that an enterprise host must be registered in settings before
    // its first review; the alternative is misrouting other forges silently.
    if (isKnownGitHubHost(host)) return PLATFORM.GITHUB;

    return null;
```

Note the ordering requirement: the GitLab structural test runs first, so a host configured as both resolves a `/-/merge_requests/` URL to GitLab.

Add all six new functions to the `export default` block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/unit/gitHosts.test.js`
Expected: PASS, including all pre-existing cases in the file.

- [ ] **Step 5: Commit**

```bash
git add src/utils/gitHosts.js test/unit/gitHosts.test.js
git commit -m "feat(hosts): GitHub Enterprise detection and API base

Mirrors the existing GitLab host machinery: a configured host list, an
api/v3 REST root, and a raw-content base served from the instance. GHE
detection is configuration-only because /pull/<n> is not unique to
GitHub — Gitea and Codeberg share it — so a structural signal would
misroute forges the manifest already matches."
```

---

### Task 6: Route the service layer through the host abstraction

**Files:**
- Modify: `src/utils/constants.js:61-62,503,515`
- Modify: `src/services/GitHubService.js:16`
- Modify: `src/services/PullRequestService.js:17-18,829`
- Modify: `src/services/LinkedIssueService.js:206-207`
- Modify: `src/background/handlers/prReviewHandlers.js:2393`
- Test: `test/unit/gheRouting.test.js` (create)

**Interfaces:**
- Consumes: `githubApiBase`, `gitlabApiBase` from Task 5 and the existing module
- Produces: each service resolves its API base from the PR/repo URL rather than a constructor-time constant

**Pattern to apply.** These classes set the base once in the constructor, before any URL is known. Replace the fixed field with a per-call resolution, keeping the field as the default so no caller breaks:

```js
// before
this.githubBaseUrl = 'https://api.github.com';
// after — field stays as the fallback, calls resolve from the URL they were given
this.githubBaseUrl = githubApiBase();
...
const base = githubApiBase(prUrl);
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/gheRouting.test.js`:

```js
/**
 * A wrong API base fails in the most expensive way available: the request goes
 * to a real server that answers 404, so the error says "not found" rather than
 * "wrong host", and the user concludes their PR is unreadable.
 */
const { PullRequestService } = require('../../src/services/PullRequestService.js');
const { LinkedIssueService } = require('../../src/services/LinkedIssueService.js');
const { setGitHubHosts, resetGitHubHosts } = require('../../src/utils/gitHosts.js');

describe('PullRequestService API base resolution', () => {
    beforeEach(() => setGitHubHosts(['github.acme.com']));
    afterEach(() => resetGitHubHosts());

    it('resolves the enterprise base from a PR URL', () => {
        const svc = new PullRequestService();
        expect(svc.resolveApiBase('https://github.acme.com/o/r/pull/7'))
            .toBe('https://github.acme.com/api/v3');
    });

    it('resolves the public base from a github.com URL', () => {
        const svc = new PullRequestService();
        expect(svc.resolveApiBase('https://github.com/o/r/pull/7'))
            .toBe('https://api.github.com');
    });

    it('resolves a self-hosted GitLab base from an MR URL', () => {
        const svc = new PullRequestService();
        expect(svc.resolveApiBase('https://gitlab.acme.com/g/p/-/merge_requests/3'))
            .toBe('https://gitlab.acme.com/api/v4');
    });

    it('falls back to the public bases when given no URL', () => {
        const svc = new PullRequestService();
        expect(svc.githubBaseUrl).toBe('https://api.github.com');
        expect(svc.gitlabBaseUrl).toBe('https://gitlab.com/api/v4');
    });
});

describe('LinkedIssueService API base resolution', () => {
    beforeEach(() => setGitHubHosts(['github.acme.com']));
    afterEach(() => resetGitHubHosts());

    it('honours an explicit override before falling back to the URL', () => {
        const svc = new LinkedIssueService({ githubBaseUrl: 'https://override.example/api/v3' });
        expect(svc.githubBaseUrl).toBe('https://override.example/api/v3');
    });

    it('resolves the enterprise base from an issue URL', () => {
        const svc = new LinkedIssueService();
        expect(svc.resolveGitHubBase('https://github.acme.com/o/r/issues/2'))
            .toBe('https://github.acme.com/api/v3');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/gheRouting.test.js`
Expected: FAIL — `svc.resolveApiBase is not a function`

- [ ] **Step 3: Implement in `PullRequestService`**

Add the import and a resolver method; keep the constructor fields as defaults:

```js
import { githubApiBase, gitlabApiBase, detectPlatform, PLATFORM } from '../utils/gitHosts.js';
```

```js
        this.githubBaseUrl = githubApiBase();
        this.gitlabBaseUrl = gitlabApiBase();
```

```js
    /**
     * API base for the instance this URL lives on.
     *
     * Resolved per call rather than fixed in the constructor: one service
     * instance handles URLs from several hosts in a session, and a
     * constructor-time base is necessarily the wrong one for all but the first.
     *
     * @param {string} url - a PR or MR URL
     * @returns {string}
     */
    resolveApiBase(url) {
        return detectPlatform(url) === PLATFORM.GITLAB
            ? gitlabApiBase(url)
            : githubApiBase(url);
    }
```

Then replace every use of `this.githubBaseUrl` / `this.gitlabBaseUrl` inside request-building methods with `this.resolveApiBase(prUrl)` where a URL is in scope. At `PullRequestService.js:829`, replace the hardcoded template:

```js
            const url = `${gitlabApiBase(prUrl)}/projects/${projectPath}/repository/files/${encodedPath}/raw${ref ? `?ref=${ref}` : '?ref=main'}`;
```

If `prUrl` is not in scope at that call site, thread it in from the caller rather than reaching for a module-level default — a silent fallback to gitlab.com is the bug being fixed.

- [ ] **Step 4: Implement in `LinkedIssueService`**

```js
        this.githubBaseUrl = opts.githubBaseUrl || githubApiBase();
        this.gitlabBaseUrl = opts.gitlabBaseUrl || gitlabApiBase();
        this._githubOverridden = Boolean(opts.githubBaseUrl);
        this._gitlabOverridden = Boolean(opts.gitlabBaseUrl);
```

```js
    /** An explicit constructor override always wins; otherwise resolve per URL. */
    resolveGitHubBase(url) {
        return this._githubOverridden ? this.githubBaseUrl : githubApiBase(url);
    }

    resolveGitLabBase(url) {
        return this._gitlabOverridden ? this.gitlabBaseUrl : gitlabApiBase(url);
    }
```

Replace in-method uses of the fields with these resolvers where a URL is available.

- [ ] **Step 5: Implement in `GitHubService` and `constants.js`**

`GitHubService.js:16` — `this.baseUrl = githubApiBase();` plus a `setHost(url)` that re-resolves, or per-call resolution if the class already receives URLs.

`constants.js` — leave `GITHUB_API` / `GITLAB_API` and the two `apiBase` entries as the public-instance defaults, and add a comment above each stating they are defaults only and that host-aware code must call `githubApiBase()` / `gitlabApiBase()`. Do not delete them; other call sites still read them and Task 7 finishes that migration.

`prReviewHandlers.js:2393` — thread the PR URL in and replace:

```js
                const url = `${githubApiBase(prUrl)}/repos/${repoId}/contents/${encodeURIComponent(filePath)}${ref ? `?ref=${ref}` : ''}`;
```

- [ ] **Step 6: Run the tests**

Run: `npx jest test/unit/gheRouting.test.js test/unit/PullRequestServicePosting.test.js test/unit/LinkedIssueService.test.js`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: all suites pass. `PullRequestServicePosting` and `reviewToPost` are the ones most likely to catch a threading mistake.

- [ ] **Step 8: Commit**

```bash
git add src/utils/constants.js src/services/GitHubService.js src/services/PullRequestService.js src/services/LinkedIssueService.js src/background/handlers/prReviewHandlers.js test/unit/gheRouting.test.js
git commit -m "fix(hosts): resolve API bases per URL in the service layer

These services fixed their API base in the constructor, before any URL
was known, so one instance handling URLs from several hosts used the
wrong base for all but the first. Bases now resolve from the URL each
call was given, with the public instances as the fallback."
```

---

### Task 7: Route contextAnalyzer and StandardsSyncService

**Files:**
- Modify: `src/utils/contextAnalyzer.js:393,534,820,1108,1142,1189,1215,1374,1388,1407,1436`
- Modify: `src/services/StandardsSyncService.js:76`
- Test: `test/unit/gheContextRouting.test.js` (create)

**Interfaces:**
- Consumes: `githubApiBase`, `githubRawBase`, `gitlabApiBase`
- Produces: no signature changes; the analyzer's fetches target the instance in the URL it was given

**Why this task is not optional.** Without it GHE reviews a PR but fails every full-file fetch, repo-tree walk and `package.json` read, because those eleven call sites still point at `api.github.com`. That is a support story that looks like a bug: the review runs, the context is silently empty, and findings quality drops with no error.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gheContextRouting.test.js`:

```js
/**
 * Context fetches are the half of GHE support that fails silently: the review
 * still runs, the context is just empty, and nothing in the UI says so.
 */
const { setGitHubHosts, resetGitHubHosts } = require('../../src/utils/gitHosts.js');

describe('contextAnalyzer host routing', () => {
    let fetchMock;

    beforeEach(() => {
        setGitHubHosts(['github.acme.com']);
        fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ tree: [], content: '', encoding: 'utf-8' }),
            text: async () => '',
        });
        global.fetch = fetchMock;
    });

    afterEach(() => { resetGitHubHosts(); jest.resetAllMocks(); });

    /** Every host a run touched, for asserting nothing leaked to the wrong one. */
    function hostsCalled() {
        return [...new Set(fetchMock.mock.calls.map(c => new URL(c[0]).host))];
    }

    it('never calls api.github.com for an enterprise PR URL', async () => {
        const { ContextAnalyzer } = require('../../src/utils/contextAnalyzer.js');
        const analyzer = new ContextAnalyzer();
        await analyzer.fetchRepoTree?.('https://github.acme.com/o/r/pull/5', 'main')
            ?.catch(() => {});
        expect(hostsCalled()).not.toContain('api.github.com');
    });

    it('still calls api.github.com for a github.com URL', async () => {
        const { ContextAnalyzer } = require('../../src/utils/contextAnalyzer.js');
        const analyzer = new ContextAnalyzer();
        await analyzer.fetchRepoTree?.('https://github.com/o/r/pull/5', 'main')
            ?.catch(() => {});
        expect(hostsCalled()).toContain('api.github.com');
    });
});
```

Adjust the method name in the two `analyzer.fetchRepoTree?.(...)` calls to whatever `contextAnalyzer.js:393` actually exposes — read the enclosing function signature first and use its real name and argument order. The assertion (which host was called) is the part that matters and stays as written.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/gheContextRouting.test.js`
Expected: FAIL — `api.github.com` appears in the calls for the enterprise URL.

- [ ] **Step 3: Implement**

Add to `contextAnalyzer.js`:

```js
import { githubApiBase, gitlabApiBase, githubRawBase } from './gitHosts.js';
```

Then at each of the eleven sites, replace the literal with a resolution from whatever URL that method already has in scope. The three shapes:

```js
// GitHub API — was `https://api.github.com/repos/...`
const treeUrl = `${githubApiBase(sourceUrl)}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
const fileUrl = `${githubApiBase(sourceUrl)}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

// GitLab API — was `https://gitlab.com/api/v4/...`
const projectResponse = await fetch(`${gitlabApiBase(sourceUrl)}/projects/${projectId}`, { ... });
```

Where a method has no URL parameter, add one and thread it from the caller. Do **not** add a module-level "current host" variable: a mutable ambient host is exactly the bug class this abstraction exists to remove, and it breaks as soon as two repos are in flight.

For `StandardsSyncService.js:76`, make the raw URL host-aware:

```js
        if (source.type === 'github') {
            const rawBase = githubRawBase(source.host ? `https://${source.host}` : undefined);
            // github.com serves raw from a dedicated host with no /raw/ segment;
            // GHE serves it from the instance and needs one.
            return rawBase === 'https://raw.githubusercontent.com'
                ? `${rawBase}/${source.owner}/${source.repo}/${ref}/${base}/${rel}`
                : `${rawBase}/${source.owner}/${source.repo}/raw/${ref}/${base}/${rel}`;
        }
```

Extend the `source` shape docs at `StandardsSyncService.js:60` with the optional `host` field.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/unit/gheContextRouting.test.js`
Expected: PASS

- [ ] **Step 5: Verify no literals remain**

```bash
grep -rn "api\.github\.com\|gitlab\.com/api/v4\|raw\.githubusercontent\.com" src --include='*.js' --include='*.jsx'
```

Expected: hits only in `src/utils/gitHosts.js` (the mapping itself), `src/utils/constants.js` (documented defaults), and comments. Any other hit is an unrouted call site.

- [ ] **Step 6: Run the full suite**

Run: `npx jest`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/contextAnalyzer.js src/services/StandardsSyncService.js test/unit/gheContextRouting.test.js
git commit -m "fix(hosts): route context and standards fetches per instance

Eleven call sites in contextAnalyzer and the raw-content URL in
StandardsSyncService pointed at api.github.com and gitlab.com
unconditionally, so on an enterprise host the review ran with silently
empty context and no error. URLs now resolve from the URL each call was
given, threaded as a parameter rather than held in ambient state."
```

---

### Task 8: Settings field and host permission grant for GHE

**Files:**
- Modify: `src/background/handlers/settingsHandlers.js:44-81` (`ensureHostAccess`)
- Modify: `src/popup/components/Settings.jsx`
- Modify: `src/background/index.js` (seed `setGitHubHosts` on settings load, beside `setGitLabHosts`)
- Test: `test/unit/settingsHandlers.test.js`

**Interfaces:**
- Consumes: `parseHostList` (existing), `setGitHubHosts`, `getGitHubHosts`
- Produces: `ensureHostAccess({ gitlabHosts, githubHosts })` accepting both lists; settings key `githubEnterpriseHosts`

**Signature change.** `ensureHostAccess(value)` currently takes one value and filters `h !== 'gitlab.com'`. It becomes `ensureHostAccess({ gitlabHosts, githubHosts })` and filters both public hosts. Keep accepting a bare string or array as the GitLab list so existing callers keep working.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/settingsHandlers.test.js`:

```js
const { ensureHostAccess, parseHostList } = require('../../src/background/handlers/settingsHandlers.js');

describe('ensureHostAccess with both forges', () => {
    beforeEach(() => {
        global.chrome = {
            permissions: {
                contains: jest.fn().mockResolvedValue(false),
                request: jest.fn().mockResolvedValue(true),
            },
            scripting: {
                unregisterContentScripts: jest.fn().mockResolvedValue(undefined),
                registerContentScripts: jest.fn().mockResolvedValue(undefined),
            },
        };
    });

    it('requests origins for both host lists', async () => {
        const out = await ensureHostAccess({
            gitlabHosts: 'gitlab.acme.com',
            githubHosts: 'github.acme.com',
        });
        expect(out.granted).toBe(true);
        expect(chrome.permissions.request).toHaveBeenCalledWith({
            origins: expect.arrayContaining([
                'https://gitlab.acme.com/*',
                'https://github.acme.com/*',
            ]),
        });
    });

    it('filters the public hosts of both forges', async () => {
        const out = await ensureHostAccess({
            gitlabHosts: 'gitlab.com',
            githubHosts: 'github.com',
        });
        expect(out.hosts).toEqual([]);
        expect(chrome.permissions.request).not.toHaveBeenCalled();
    });

    it('still accepts a bare GitLab list, as before', async () => {
        const out = await ensureHostAccess('gitlab.acme.com');
        expect(out.granted).toBe(true);
        expect(out.hosts).toEqual(['gitlab.acme.com']);
    });

    it('does not fail the save when the user rejects the prompt', async () => {
        chrome.permissions.request.mockResolvedValue(false);
        const out = await ensureHostAccess({ githubHosts: 'github.acme.com' });
        expect(out.granted).toBe(false);
        expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/settingsHandlers.test.js -t 'both forges'`
Expected: FAIL — the object form is treated as a single value and yields no hosts.

- [ ] **Step 3: Implement**

Replace `ensureHostAccess` in `settingsHandlers.js`:

```js
/**
 * Ask Chrome for access to the user's own GitLab and/or GitHub Enterprise
 * instances.
 *
 * Self-hosted hostnames cannot be listed in the manifest at publish time, so
 * they are `optional_host_permissions` granted at runtime. Also registers the
 * content script for the hosts, which is what puts the review overlay on the
 * MR/PR page — without it the extension works only from the popup.
 *
 * Best-effort by design: a rejected prompt must not fail the settings save.
 *
 * @param {string|string[]|{gitlabHosts?:string|string[], githubHosts?:string|string[]}} input
 *        A bare string or array is read as the GitLab list, which is how this
 *        was called before GHE support.
 */
export async function ensureHostAccess(input) {
    const spec = (typeof input === 'string' || Array.isArray(input))
        ? { gitlabHosts: input }
        : (input || {});

    // The public instances are in the manifest already; requesting them at
    // runtime would prompt the user for access they have had all along.
    const PUBLIC = new Set(['gitlab.com', 'github.com', 'www.github.com']);
    const hosts = [
        ...parseHostList(spec.gitlabHosts),
        ...parseHostList(spec.githubHosts),
    ].map(hostOf).filter(h => h && !PUBLIC.has(h));

    const unique = [...new Set(hosts)];
    if (unique.length === 0) return { granted: false, hosts: [] };

    const origins = unique.map(h => `https://${h}/*`);

    let granted = false;
    try {
        granted = await chrome.permissions.contains({ origins });
        if (!granted) granted = await chrome.permissions.request({ origins });
    } catch (e) {
        console.warn('Host permission request failed:', e?.message);
        return { granted: false, hosts: unique };
    }
    if (!granted) return { granted: false, hosts: unique };

    // Content script for the granted hosts. Re-registering an existing id
    // throws, so unregister first and ignore "not found".
    try {
        await chrome.scripting.unregisterContentScripts({ ids: ['repospector-selfhosted'] }).catch(() => {});
        await chrome.scripting.registerContentScripts([{
            id: 'repospector-selfhosted',
            matches: origins,
            js: ['assets/content.js'],
            runAt: 'document_idle',
            allFrames: false,
        }]);
        console.log(`🔧 Content script registered for ${unique.join(', ')}`);
    } catch (e) {
        console.warn('Could not register content script for self-hosted host:', e?.message);
    }

    return { granted: true, hosts: unique };
}
```

Update the internal caller in the settings-save path to pass both lists from `settings.gitlabHosts` and `settings.githubEnterpriseHosts`.

- [ ] **Step 4: Seed the host list on settings load**

In `src/background/index.js`, wherever `setGitLabHosts` is called, add the GitHub equivalent:

```js
        setGitLabHosts(settings.gitlabHosts);
        setGitHubHosts(settings.githubEnterpriseHosts);
```

- [ ] **Step 5: Add the Settings field**

In `src/popup/components/Settings.jsx`, add a text input beside the existing GitLab hosts field, bound to `githubEnterpriseHosts`, following that field's existing markup and change-handler pattern exactly. Helper text:

> GitHub Enterprise hostnames, comma-separated (e.g. `github.acme.com`). Required before RepoSpector can review PRs on an enterprise instance — unlike GitLab, an enterprise GitHub host cannot be detected from the URL alone.

- [ ] **Step 6: Run the tests**

Run: `npx jest test/unit/settingsHandlers.test.js`
Expected: PASS

- [ ] **Step 7: Build and load the extension**

```bash
npm run build
```

Load `dist/` unpacked, open Settings, enter a GHE hostname, save, and confirm Chrome shows the permission prompt. Then check `chrome://extensions` → service worker console for `🔧 Content script registered for github.acme.com`.

- [ ] **Step 8: Commit**

```bash
git add src/background/handlers/settingsHandlers.js src/background/index.js src/popup/components/Settings.jsx test/unit/settingsHandlers.test.js
git commit -m "feat(settings): register GitHub Enterprise hosts

ensureHostAccess now takes both host lists, filters the public instances
of either forge, and requests one permission set covering both. The
Settings field states that GHE must be registered explicitly, since it
cannot be inferred from a URL the way a GitLab route can."
```

---

# Item 3 — ConventionMiner warm-up

### Task 9: Prewarm with an in-flight registry and a bounded await

**Files:**
- Modify: `src/services/ConventionMiner.js` (registry, `prewarm`, export)
- Modify: `src/background/handlers/prReviewHandlers.js:1399-1416`
- Modify: `src/background/handlers/indexingHandlers.js:153-165`
- Modify: `src/utils/constants.js`
- Test: `test/unit/ConventionMinerPrewarm.test.js` (create)

**Interfaces:**
- Consumes: existing `getCached(repoId)`, `mine(repoId, notes, opts)`
- Produces:
  - `ConventionMiner.prototype.prewarm(repoId, notesFetcher, opts) -> Promise<MinedConventions|null>` — `notesFetcher` is `() => Promise<Array<{author,body,file?}>>`
  - `ConventionMiner.inFlight(repoId) -> Promise|null` (static)
  - `ConventionMiner.resetInFlight()` (static, test seam)
  - `CONVENTION_WARM_DEADLINE_MS = 15000` in `constants.js`

**Why a module-level registry rather than an instance field:** `prReviewHandlers` constructs a fresh `ConventionMiner` per review (`prReviewHandlers.js:1401`), so an instance field would never see the prewarm started by the indexing handler. The registry has to outlive the instance.

- [ ] **Step 1: Write the failing test**

Create `test/unit/ConventionMinerPrewarm.test.js`:

```js
/**
 * The miner is the highest-leverage recall component and, before this, it never
 * ran in time to affect the review that needed it. The failure mode a test can
 * actually catch is the opposite one: warming twice, or blocking a review
 * forever on a mine that never settles.
 */
const { ConventionMiner } = require('../../src/services/ConventionMiner.js');

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

describe('ConventionMiner prewarm', () => {
    let storage;

    beforeEach(() => {
        ConventionMiner.resetInFlight();
        const data = {};
        storage = {
            get: jest.fn(async (key) => ({ [key]: data[key] })),
            set: jest.fn(async (items) => { Object.assign(data, items); }),
        };
    });

    it('collapses concurrent prewarms into one mine', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        const mine = jest.spyOn(miner, 'mine').mockResolvedValue({ repoId: 'r', rules: [], minedAt: Date.now() });
        const fetcher = jest.fn().mockResolvedValue([{ author: 'a', body: 'use tenant_id' }]);

        await Promise.all([
            miner.prewarm('r', fetcher),
            miner.prewarm('r', fetcher),
            miner.prewarm('r', fetcher),
        ]);

        expect(mine).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('exposes the in-flight promise to a later, separate instance', async () => {
        const first = new ConventionMiner({ storage, llmService: {} });
        const gate = deferred();
        jest.spyOn(first, 'mine').mockReturnValue(gate.promise);

        first.prewarm('r', async () => []);
        expect(ConventionMiner.inFlight('r')).not.toBeNull();

        gate.resolve({ repoId: 'r', rules: [], minedAt: Date.now() });
        await ConventionMiner.inFlight('r');
    });

    it('clears the registry entry once mining settles', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        jest.spyOn(miner, 'mine').mockResolvedValue({ repoId: 'r', rules: [], minedAt: Date.now() });
        await miner.prewarm('r', async () => []);
        expect(ConventionMiner.inFlight('r')).toBeNull();
    });

    it('clears the registry entry when mining rejects, so a retry is possible', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        jest.spyOn(miner, 'mine').mockRejectedValue(new Error('provider down'));
        await expect(miner.prewarm('r', async () => [])).resolves.toBeNull();
        expect(ConventionMiner.inFlight('r')).toBeNull();
    });

    it('skips mining entirely when the cache is warm', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        jest.spyOn(miner, 'getCached').mockResolvedValue({ repoId: 'r', rules: [{ rule: 'x' }], minedAt: Date.now() });
        const mine = jest.spyOn(miner, 'mine');
        const out = await miner.prewarm('r', async () => []);
        expect(mine).not.toHaveBeenCalled();
        expect(out.rules).toHaveLength(1);
    });

    it('resolves null rather than throwing when the notes fetch fails', async () => {
        const miner = new ConventionMiner({ storage, llmService: {} });
        await expect(
            miner.prewarm('r', async () => { throw new Error('403'); })
        ).resolves.toBeNull();
    });
});

describe('awaitWarm', () => {
    beforeEach(() => ConventionMiner.resetInFlight());

    it('returns the mined result when it beats the deadline', async () => {
        const miner = new ConventionMiner({ storage: { get: async () => ({}), set: async () => {} }, llmService: {} });
        jest.spyOn(miner, 'mine').mockResolvedValue({ repoId: 'r', rules: [{ rule: 'x' }], minedAt: Date.now() });
        miner.prewarm('r', async () => []);
        const out = await ConventionMiner.awaitWarm('r', 1000);
        expect(out.rules).toHaveLength(1);
    });

    it('gives up at the deadline instead of blocking the review', async () => {
        const miner = new ConventionMiner({ storage: { get: async () => ({}), set: async () => {} }, llmService: {} });
        jest.spyOn(miner, 'mine').mockReturnValue(new Promise(() => {})); // never settles
        miner.prewarm('r', async () => []);
        const out = await ConventionMiner.awaitWarm('r', 20);
        expect(out).toBeNull();
    });

    it('returns null immediately when nothing is in flight', async () => {
        expect(await ConventionMiner.awaitWarm('nobody', 1000)).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/ConventionMinerPrewarm.test.js`
Expected: FAIL — `ConventionMiner.resetInFlight is not a function`

- [ ] **Step 3: Implement the registry and prewarm**

In `src/services/ConventionMiner.js`, above the class:

```js
/**
 * Mines in progress, keyed by repoId.
 *
 * Module-level rather than an instance field on purpose: `prReviewHandlers`
 * constructs a fresh miner for every review, so an instance field could never
 * see the prewarm the indexing handler started moments earlier — which is the
 * entire point of warming.
 */
const inFlightMines = new Map();
```

Inside the class:

```js
    /**
     * Ensure conventions for `repoId` are mined, or being mined.
     *
     * Idempotent and safe to call from several places: a prewarm triggered by
     * indexing and a review starting a second later collapse to one LLM call.
     *
     * Never throws. A failed prewarm must not break the thing that triggered
     * it — indexing and review both proceed fine without conventions.
     *
     * @param {string} repoId
     * @param {() => Promise<Array<{author:string, body:string, file?:string}>>} notesFetcher
     * @param {object} [opts] - forwarded to `mine`
     * @returns {Promise<object|null>} the mined conventions, or null on failure
     */
    async prewarm(repoId, notesFetcher, opts = {}) {
        if (!repoId) return null;

        const cached = await this.getCached(repoId).catch(() => null);
        if (cached) return cached;

        const existing = inFlightMines.get(repoId);
        if (existing) return existing;

        const task = (async () => {
            const notes = await notesFetcher();
            return this.mine(repoId, notes || [], opts);
        })()
            .catch((e) => {
                console.warn(`ConventionMiner: prewarm for ${repoId} failed:`, e?.message);
                return null;
            })
            .finally(() => {
                // Cleared on both paths so a transient provider failure does not
                // wedge the repo into "permanently mining".
                inFlightMines.delete(repoId);
            });

        inFlightMines.set(repoId, task);
        return task;
    }

    /** The in-flight mine for a repo, or null. */
    static inFlight(repoId) {
        return inFlightMines.get(repoId) ?? null;
    }

    /** Clear the registry. Test seam. */
    static resetInFlight() {
        inFlightMines.clear();
    }

    /**
     * Wait for an in-flight mine, but not past `deadlineMs`.
     *
     * A review must never be blocked indefinitely on convention mining. Losing
     * the race costs nothing beyond the wait: the caller falls back to the
     * generic standards, which is exactly the pre-warm-up behaviour.
     *
     * @param {string} repoId
     * @param {number} deadlineMs
     * @returns {Promise<object|null>}
     */
    static async awaitWarm(repoId, deadlineMs) {
        const pending = inFlightMines.get(repoId);
        if (!pending) return null;

        let timer;
        try {
            return await Promise.race([
                pending,
                new Promise((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/unit/ConventionMinerPrewarm.test.js`
Expected: PASS (10 tests)

- [ ] **Step 5: Add the deadline constant**

In `src/utils/constants.js`:

```js
/**
 * How long a review will wait for convention mining already in progress.
 *
 * Only ever paid on a cold repo whose mine is still running. Losing the race
 * falls back to the generic standards — the behaviour before warm-up existed —
 * so the worst case is this much added latency, once.
 */
export const CONVENTION_WARM_DEADLINE_MS = 15000;
```

- [ ] **Step 6: Rewrite the review-path branch**

Replace the body of the `if (conventionsEnabled)` block at `prReviewHandlers.js:1399-1416`:

```js
            let conventionBlock = '';
            if (conventionsEnabled) {
                try {
                    const miner = new ConventionMiner({ llmService: svc.llmService });
                    const mineOpts = {
                        settings: { provider: settings.provider, model: multiPassModel, apiKey: settings.apiKey },
                    };

                    let mined = await miner.getCached(repoId);

                    // A mine started at index time or on page detection is
                    // probably already done or nearly so. Waiting briefly for it
                    // is what makes conventions available on a FIRST review —
                    // previously they arrived only in time for the second one,
                    // which is why the component was never measurable.
                    if (!mined && ConventionMiner.inFlight(repoId)) {
                        mined = await ConventionMiner.awaitWarm(repoId, CONVENTION_WARM_DEADLINE_MS);
                    }

                    if (!mined) {
                        // Nothing warm and nothing running: start it for next time,
                        // exactly as before. Not awaited — a cold first review
                        // should not pay a full round-trip plus a comment fetch.
                        miner.prewarm(
                            repoId,
                            () => svc.pullRequestService.fetchReviewComments?.(prUrl) ?? Promise.resolve([]),
                            mineOpts,
                        );
                    }

                    if (mined?.rules?.length) {
                        conventionBlock = ConventionMiner.renderBlock(mined);
                    }
                } catch (e) {
                    console.warn('Convention mining (non-fatal):', e?.message);
                }
            }
```

Import `CONVENTION_WARM_DEADLINE_MS` from `../../utils/constants.js`.

- [ ] **Step 7: Trigger prewarm at index completion**

In `src/background/handlers/indexingHandlers.js`, after `await svc.saveRepoMetadata(...)` (around line 153) and before the `status: 'complete'` message:

```js
            // Warm team conventions now. Indexing already took a while and the
            // user is not waiting on this, so the mine is free here — and being
            // warm is what lets the FIRST review use the repo's own conventions.
            try {
                const miner = new ConventionMiner({ llmService: svc.llmService });
                miner.prewarm(
                    repoId,
                    () => svc.pullRequestService?.fetchRepoReviewComments?.(url) ?? Promise.resolve([]),
                    { settings: await svc.getStoredSettings().catch(() => ({})) },
                );
            } catch (e) {
                console.warn('Convention prewarm at index time:', e?.message);
            }
```

Import `ConventionMiner`. If `fetchRepoReviewComments` does not exist on `PullRequestService`, use whichever method fetches review comments for a repository rather than a single PR; if only the per-PR method exists, skip the index-time trigger for this task and note it — do not invent a method name.

- [ ] **Step 8: Run the affected suites**

Run: `npx jest test/unit/ConventionMinerPrewarm.test.js test/unit/ConventionMiner.test.js test/unit/prReviewHandlers.test.js test/unit/indexingHandlers.test.js`
Expected: PASS

- [ ] **Step 9: Run the full suite**

Run: `npx jest`
Expected: all suites pass.

- [ ] **Step 10: Commit**

```bash
git add src/services/ConventionMiner.js src/background/handlers/prReviewHandlers.js src/background/handlers/indexingHandlers.js src/utils/constants.js test/unit/ConventionMinerPrewarm.test.js
git commit -m "feat(conventions): warm the miner so a first review can use it

Mining started at index time, deduped through a module-level in-flight
registry that outlives the per-review miner instance, and awaited for at
most 15s when a review finds one already running. Conventions were
previously guaranteed absent from every first review, which made the
highest-leverage recall component impossible to evaluate at all."
```

---

# Item 4 — Hunk windowing for large files

### Task 10: The HunkWindower

**Files:**
- Create: `src/services/HunkWindower.js`
- Test: `test/unit/HunkWindower.test.js` (create)

**Interfaces:**
- Consumes: `prData.files[]` entries — `{ filename, status, additions, deletions, patch }`. **No `hunks` array exists on these objects**; the patch text is the input.
- Produces:
  - `WINDOW_DEFAULTS = { minLocToSplit: 250, maxLocPerWindow: 200, overlapLines: 20 }`
  - `windowFile(file, opts) -> Array<{ filename, patch, windowIndex, windowTotal, additions, deletions, siblingNote }>` — a single-element array when the file is below threshold, so callers need no special case

**Design constraints.** A window never splits an individual hunk: half a hunk is a diff the model cannot reason about. A hunk larger than `maxLocPerWindow` therefore becomes its own oversized window — accepted, because the alternative is worse. `siblingNote` exists so the model does not report "the rest of this file is missing" as a finding, which is the obvious failure mode of showing it a partial file.

- [ ] **Step 1: Write the failing test**

Create `test/unit/HunkWindower.test.js`:

```js
/**
 * The eval harness found misses concentrating in large files while the same
 * defect classes were caught 100% of the time in small ones, and read it as
 * attention dilution. Windowing is the response. The risk it introduces is
 * showing the model a fragment it mistakes for the whole file, so the tests
 * pin the boundaries and the sibling note as much as the splitting.
 */
const { windowFile, WINDOW_DEFAULTS } = require('../../src/services/HunkWindower.js');

/** A patch with `count` hunks of `linesEach` added lines apiece. */
function makePatch(count, linesEach) {
    const out = [];
    for (let h = 0; h < count; h++) {
        const start = 1 + h * 1000;
        out.push(`@@ -${start},${linesEach} +${start},${linesEach} @@`);
        for (let i = 0; i < linesEach; i++) out.push(`+line ${h}-${i}`);
    }
    return out.join('\n');
}

describe('windowFile', () => {
    it('returns the file unchanged in a single window when below threshold', () => {
        const file = { filename: 'src/small.js', patch: makePatch(2, 10), additions: 20, deletions: 0 };
        const windows = windowFile(file);
        expect(windows).toHaveLength(1);
        expect(windows[0].windowTotal).toBe(1);
        expect(windows[0].patch).toBe(file.patch);
        expect(windows[0].siblingNote).toBe('');
    });

    it('splits a large file into multiple windows', () => {
        const file = { filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 };
        const windows = windowFile(file);
        expect(windows.length).toBeGreaterThan(1);
        expect(windows.every(w => w.filename === 'src/big.go')).toBe(true);
        expect(windows.map(w => w.windowIndex)).toEqual(windows.map((_, i) => i + 1));
        expect(new Set(windows.map(w => w.windowTotal))).toEqual(new Set([windows.length]));
    });

    it('never splits an individual hunk', () => {
        const file = { filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 };
        for (const w of windowFile(file)) {
            const headers = w.patch.split('\n').filter(l => l.startsWith('@@'));
            expect(headers.length).toBeGreaterThan(0);
            // Every line before the first header would be an orphaned hunk body.
            expect(w.patch.split('\n')[0].startsWith('@@')).toBe(true);
        }
    });

    it('keeps a single oversized hunk whole in its own window', () => {
        const file = { filename: 'src/huge.js', patch: makePatch(1, 900), additions: 900, deletions: 0 };
        const windows = windowFile(file);
        expect(windows).toHaveLength(1);
        expect(windows[0].patch.split('\n').filter(l => l.startsWith('@@'))).toHaveLength(1);
    });

    it('covers every hunk across the windows, losing none', () => {
        const file = { filename: 'src/big.go', patch: makePatch(9, 55), additions: 495, deletions: 0 };
        const seen = windowFile(file)
            .flatMap(w => w.patch.split('\n').filter(l => l.startsWith('@@')));
        const original = file.patch.split('\n').filter(l => l.startsWith('@@'));
        expect(new Set(seen)).toEqual(new Set(original));
    });

    it('tells the model that sibling windows exist', () => {
        const windows = windowFile({ filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 });
        expect(windows[0].siblingNote).toContain('window 1 of');
        expect(windows[0].siblingNote).toMatch(/not.*missing|other windows|reviewed separately/i);
    });

    it('respects overrides', () => {
        const file = { filename: 'src/big.go', patch: makePatch(10, 60), additions: 600, deletions: 0 };
        expect(windowFile(file, { minLocToSplit: 100000 })).toHaveLength(1);
    });

    it('handles a file with no patch without throwing', () => {
        const windows = windowFile({ filename: 'bin/blob.png', additions: 0, deletions: 0 });
        expect(windows).toHaveLength(1);
        expect(windows[0].patch).toBe('');
    });

    it('exposes its defaults', () => {
        expect(WINDOW_DEFAULTS.minLocToSplit).toBe(250);
        expect(WINDOW_DEFAULTS.maxLocPerWindow).toBe(200);
        expect(WINDOW_DEFAULTS.overlapLines).toBe(20);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/HunkWindower.test.js`
Expected: FAIL — `Cannot find module '../../src/services/HunkWindower.js'`

- [ ] **Step 3: Implement**

Create `src/services/HunkWindower.js`:

```js
/**
 * HunkWindower — split one large file's diff into reviewable windows.
 *
 * `FileGroupingStrategy` already gives a large or high-risk file a SOLO review
 * unit, but nothing split the file itself, so a 900-line diff entered a single
 * prompt whole. The eval harness found misses concentrating in exactly those
 * files — react `store.js`, prometheus `head_wal.go`, kubernetes
 * `scheduling_queue.go` — while the same defect classes were caught 100% of the
 * time in small files, and read the pattern as attention dilution rather than a
 * rule gap. This is the response to that reading.
 *
 * Two rules shape the output:
 *
 *   1. A window never splits an individual hunk. Half a hunk is a diff nobody
 *      can reason about, model or human.
 *   2. Every window says it is one of several. Without that, the obvious
 *      failure mode is the model reporting "the rest of this file is missing"
 *      as a finding.
 *
 * `prData.files[]` carries `patch` and no pre-parsed hunks, so the patch text
 * is the input.
 */

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export const WINDOW_DEFAULTS = Object.freeze({
    /** Below this many changed lines, the file is not split at all. */
    minLocToSplit: 250,
    /** Target lines per window. A single larger hunk still gets its own window. */
    maxLocPerWindow: 200,
    /**
     * Trailing lines of the previous window repeated as leading context.
     * Costs a little duplication to avoid a defect falling exactly on a seam;
     * the resulting duplicate findings are removed by the existing per-line
     * dedupe on the way to being posted.
     */
    overlapLines: 20,
});

/** Split a patch into hunk blocks, each starting with its `@@` header. */
function splitIntoHunks(patch) {
    if (!patch || typeof patch !== 'string') return [];
    const hunks = [];
    let current = null;
    for (const line of patch.split('\n')) {
        if (HUNK_HEADER.test(line)) {
            if (current) hunks.push(current);
            current = { header: line, lines: [] };
            continue;
        }
        if (current) current.lines.push(line);
    }
    if (current) hunks.push(current);
    return hunks.map(h => ({ ...h, loc: h.lines.length + 1, text: [h.header, ...h.lines].join('\n') }));
}

function noteFor(index, total) {
    if (total <= 1) return '';
    return `This is window ${index} of ${total} of the changes to this file. ` +
        `The other windows are being reviewed separately — code you cannot see here is ` +
        `not missing, so do not report it as absent or incomplete.`;
}

/**
 * Split one file's diff into windows.
 *
 * Always returns at least one window, so callers need no below-threshold
 * special case.
 *
 * @param {{filename:string, patch?:string, additions?:number, deletions?:number}} file
 * @param {Partial<typeof WINDOW_DEFAULTS>} [opts]
 * @returns {Array<{filename:string, patch:string, windowIndex:number, windowTotal:number,
 *                  additions:number, deletions:number, siblingNote:string}>}
 */
export function windowFile(file, opts = {}) {
    const o = { ...WINDOW_DEFAULTS, ...opts };
    const patch = typeof file?.patch === 'string' ? file.patch : '';
    const changed = (file?.additions ?? 0) + (file?.deletions ?? 0);

    const single = () => ([{
        filename: file?.filename,
        patch,
        windowIndex: 1,
        windowTotal: 1,
        additions: file?.additions ?? 0,
        deletions: file?.deletions ?? 0,
        siblingNote: '',
    }]);

    if (!patch || changed < o.minLocToSplit) return single();

    const hunks = splitIntoHunks(patch);
    if (hunks.length <= 1) return single();

    // Pack hunks into windows, never breaking one. A hunk that alone exceeds
    // the target starts and ends its own window rather than being cut.
    const groups = [];
    let group = [];
    let groupLoc = 0;
    for (const hunk of hunks) {
        if (group.length && groupLoc + hunk.loc > o.maxLocPerWindow) {
            groups.push(group);
            group = [];
            groupLoc = 0;
        }
        group.push(hunk);
        groupLoc += hunk.loc;
    }
    if (group.length) groups.push(group);

    if (groups.length <= 1) return single();

    return groups.map((groupHunks, i) => {
        const body = groupHunks.map(h => h.text).join('\n');
        // Overlap is rendered as a comment block, not as diff lines: appending
        // real diff lines would corrupt the hunk line accounting the reviewer
        // uses to attribute a finding to a line number.
        let overlap = '';
        if (i > 0 && o.overlapLines > 0) {
            const prev = groups[i - 1].map(h => h.text).join('\n').split('\n');
            const tail = prev.slice(-o.overlapLines).join('\n');
            if (tail.trim()) {
                overlap = `# Preceding context from the previous window (already reviewed there):\n${tail}\n\n`;
            }
        }
        return {
            filename: file.filename,
            patch: `${overlap}${body}`,
            windowIndex: i + 1,
            windowTotal: groups.length,
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            siblingNote: noteFor(i + 1, groups.length),
        };
    });
}

export default { windowFile, WINDOW_DEFAULTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/unit/HunkWindower.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/HunkWindower.js test/unit/HunkWindower.test.js
git commit -m "feat(review): add HunkWindower for large-file diffs

Splits one file's patch into windows on hunk boundaries, never cutting a
hunk, and labels each window so the model does not report unseen code as
missing. Not wired in yet — integration and the flag follow."
```

---

### Task 11: Wire windowing into grouping, behind a default-off flag

**Files:**
- Modify: `src/services/FileGroupingStrategy.js:43-56` (the solo pass)
- Modify: `src/utils/constants.js`
- Test: `test/unit/HunkWindowerIntegration.test.js` (create)

**Interfaces:**
- Consumes: `windowFile`, `WINDOW_DEFAULTS` from Task 10
- Produces: `FileGroupingStrategy` accepts `options.hunkWindowing` (boolean); solo units for oversize files expand into `type: 'solo-window'` units carrying `windowIndex`, `windowTotal`, `siblingNote`
- `HUNK_WINDOWING = false` in `constants.js`

**Why default off:** windowing multiplies LLM calls on precisely the largest files, so it costs the most where it is least wanted. It ships off until Task 12's measurement justifies it — the same discipline `reviewContextBudget.js` already documents for its own raised limits.

- [ ] **Step 1: Write the failing test**

Create `test/unit/HunkWindowerIntegration.test.js`:

```js
/**
 * Windowing changes how many LLM calls a review makes, so the flag being
 * genuinely off by default matters as much as the splitting working.
 */
const { FileGroupingStrategy } = require('../../src/services/FileGroupingStrategy.js');

function bigFile(filename, hunks = 10, linesEach = 60) {
    const out = [];
    for (let h = 0; h < hunks; h++) {
        const start = 1 + h * 1000;
        out.push(`@@ -${start},${linesEach} +${start},${linesEach} @@`);
        for (let i = 0; i < linesEach; i++) out.push(`+line ${h}-${i}`);
    }
    return {
        filename,
        patch: out.join('\n'),
        additions: hunks * linesEach,
        deletions: 0,
        language: 'go',
    };
}

describe('FileGroupingStrategy with hunk windowing', () => {
    it('produces one solo unit for a large file when the flag is off', () => {
        const strategy = new FileGroupingStrategy();
        const units = strategy.group([bigFile('tsdb/head_wal.go')]);
        const forFile = units.filter(u => u.primaryFile === 'tsdb/head_wal.go');
        expect(forFile).toHaveLength(1);
        expect(forFile[0].type).toBe('solo');
    });

    it('is off by default even when not passed explicitly', () => {
        const strategy = new FileGroupingStrategy({});
        expect(strategy.hunkWindowing).toBe(false);
    });

    it('expands a large file into windowed units when the flag is on', () => {
        const strategy = new FileGroupingStrategy({ hunkWindowing: true });
        const units = strategy.group([bigFile('tsdb/head_wal.go')]);
        const forFile = units.filter(u => u.primaryFile === 'tsdb/head_wal.go');
        expect(forFile.length).toBeGreaterThan(1);
        expect(forFile.every(u => u.type === 'solo-window')).toBe(true);
        expect(forFile.map(u => u.windowIndex)).toEqual(forFile.map((_, i) => i + 1));
        expect(forFile[0].siblingNote).toContain('window 1 of');
    });

    it('leaves a small file as a single unit even with the flag on', () => {
        const strategy = new FileGroupingStrategy({ hunkWindowing: true });
        const units = strategy.group([bigFile('src/small.js', 2, 10)]);
        const forFile = units.filter(u => u.primaryFile === 'src/small.js');
        expect(forFile).toHaveLength(1);
    });

    it('keeps grouped small files untouched with the flag on', () => {
        const strategy = new FileGroupingStrategy({ hunkWindowing: true });
        const small = [
            { filename: 'src/a.js', patch: '@@ -1,2 +1,2 @@\n+a', additions: 2, deletions: 0, language: 'javascript' },
            { filename: 'src/b.js', patch: '@@ -1,2 +1,2 @@\n+b', additions: 2, deletions: 0, language: 'javascript' },
        ];
        const units = new FileGroupingStrategy({ hunkWindowing: true }).group(small);
        expect(units.some(u => u.type === 'group')).toBe(true);
        expect(units.some(u => u.type === 'solo-window')).toBe(false);
        expect(strategy.hunkWindowing).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/unit/HunkWindowerIntegration.test.js`
Expected: FAIL — `strategy.hunkWindowing` is undefined and no `solo-window` units are produced.

- [ ] **Step 3: Implement**

In `FileGroupingStrategy.js`, add the import and the option:

```js
import { windowFile } from './HunkWindower.js';
```

`FileGroupingStrategy` does **not** import the flag. It takes `hunkWindowing` as
an option and defaults it to `false`, so the class stays a pure function of its
arguments and the tests need no module mocking. The flag constant is read at the
two construction sites in Step 4.

```js
        this.hunkWindowing = options.hunkWindowing ?? false;
```

Replace the solo push in Pass 1:

```js
            if (file._riskScore >= this.soloRiskThreshold || file._changeSize > this.soloChangeThreshold) {
                // A large file used to become one unit with its whole diff in a
                // single prompt. Windowing splits it on hunk boundaries so the
                // model reads a few hundred lines at a time rather than a
                // thousand — the attention-dilution fix the eval harness
                // pointed at. Off by default: it multiplies LLM calls on
                // exactly the biggest files.
                const windows = this.hunkWindowing ? windowFile(file) : [];
                if (windows.length > 1) {
                    for (const w of windows) {
                        units.push({
                            type: 'solo-window',
                            primaryFile: file.filename,
                            files: [{ ...file, patch: w.patch }],
                            totalChanges: file._changeSize,
                            riskScore: file._riskScore,
                            windowIndex: w.windowIndex,
                            windowTotal: w.windowTotal,
                            siblingNote: w.siblingNote,
                        });
                    }
                } else {
                    units.push({
                        type: 'solo',
                        primaryFile: file.filename,
                        files: [file],
                        totalChanges: file._changeSize,
                        riskScore: file._riskScore
                    });
                }
                assigned.add(file.filename);
            }
```

- [ ] **Step 4: Add the flag constant and read it where the strategy is constructed**

In `src/utils/constants.js`:

```js
/**
 * Split a large file's diff into hunk windows for review.
 *
 * OFF until the targeted eval justifies it. Windowing multiplies LLM calls on
 * exactly the largest files, so a wrong default is expensive in the case that
 * matters most. Override per-run with REPOSPECTOR_HUNK_WINDOWING=1 in the eval
 * harness, mirroring REPOSPECTOR_CONTEXT_PROFILE.
 */
export const HUNK_WINDOWING = false;
```

There are exactly two construction sites — `src/services/MultiPassReviewEngine.js:67`
and `src/services/MRChunker.js:195` — and both currently pass no options. Import
the flag from `../utils/constants.js` at each and pass it through, letting a user
setting override the compiled default:

```js
        const groupingStrategy = new FileGroupingStrategy({
            hunkWindowing: settings?.hunkWindowing ?? HUNK_WINDOWING,
        });
```

`MRChunker.js:195` is inside a module-level function with no `settings` in
scope. Add an options parameter to that function and thread the flag from its
caller rather than importing settings into the chunker — `MRChunker` is
documented as pure diff analysis and reading ambient settings would end that.

- [ ] **Step 5: Make sure the sibling note reaches the prompt**

`buildPerFileReviewPrompt` (`src/utils/multiPassPrompts.js`) receives the unit. Render `unit.siblingNote` immediately before the diff section, when present:

```js
    if (unit.siblingNote) {
        preamble += `> ${unit.siblingNote}\n\n`;
    }
```

Place it after the standards sections and before the diff, so it is the last thing read before the code — and note that it deliberately sits *after* the cacheable prefix, since it differs per window and would otherwise defeat prompt caching for the whole per-file pass (the same trap documented at `multiPassPrompts.js` §1).

- [ ] **Step 6: Run the tests**

Run: `npx jest test/unit/HunkWindowerIntegration.test.js test/unit/reviewContextBudget.test.js test/unit/promptPrefixStability.test.js`
Expected: PASS. `promptPrefixStability` is the one that will catch it if the note landed inside the cacheable prefix.

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: all suites pass, with no change in behaviour anywhere since the flag is off.

- [ ] **Step 8: Commit**

```bash
git add src/services/FileGroupingStrategy.js src/utils/constants.js src/utils/multiPassPrompts.js test/unit/HunkWindowerIntegration.test.js
git commit -m "feat(review): wire hunk windowing behind a default-off flag

Large files expand into per-window solo units when enabled; the sibling
note sits after the cacheable prompt prefix so per-window text does not
defeat prompt caching for the whole per-file pass. Default off until the
targeted eval justifies the extra LLM calls."
```

---

### Task 12: Measure windowing on the known-miss cases

**Files:**
- Create: `eval/corpus/large-files.json` (gitignored — derived subset)
- Modify: `eval/run.js` (read `REPOSPECTOR_HUNK_WINDOWING`)
- Modify: `eval/README.md`
- Modify: `src/utils/constants.js` (only if the numbers support flipping the default)

**Interfaces:**
- Consumes: `HUNK_WINDOWING` from Task 11, `eval/corpus/injected.json`
- Produces: a recorded before/after detection rate on the large-file cases, and a justified default

**Budget constraint:** this is the targeted subset run, not a full A/B. Only the cases carrying the known large-file misses are re-run — roughly 5–10% of a full run's token cost.

- [ ] **Step 1: Identify the cases to re-run**

```bash
node -e "
const c=require('./eval/corpus/injected.json');
for (const k of c.cases) {
  const big=(k.prData.files||[]).filter(f=>((f.additions||0)+(f.deletions||0))>=250);
  if (big.length) console.log(k.id, big.map(f=>f.filename+':'+((f.additions||0)+(f.deletions||0))).join(' '));
}"
```

Expected: the cases containing react `store.js`, prometheus `head_wal.go` and kubernetes `scheduling_queue.go`, plus any other file at or above the 250-line split threshold.

- [ ] **Step 2: Build the subset corpus**

```bash
node -e "
const {writeFileSync}=require('fs');
const c=require('./eval/corpus/injected.json');
const ids=process.argv.slice(1);
const cases=c.cases.filter(k=>ids.includes(k.id));
if (cases.length !== ids.length) throw new Error('missing case id');
writeFileSync('eval/corpus/large-files.json', JSON.stringify({cases},null,2)+'\n');
console.log('subset:',cases.length,'cases');
" <case-id-1> <case-id-2> <case-id-3>
```

- [ ] **Step 3: Teach the runner to read the flag**

In `eval/run.js`, read the env var and pass it into the review options alongside the existing context-profile handling:

```js
const hunkWindowing = process.env.REPOSPECTOR_HUNK_WINDOWING === '1';
```

Thread it to wherever `run.js` builds the review configuration, and log which setting the run used — an A/B whose arms are not labeled in the output is not a comparison.

- [ ] **Step 4: Run the control arm**

```bash
node eval/run.js --corpus eval/corpus/large-files.json
node eval/score.js --corpus eval/corpus/large-files.json --misses | tee eval/results/large-files-off.txt
```

- [ ] **Step 5: Run the treatment arm**

```bash
REPOSPECTOR_HUNK_WINDOWING=1 node eval/run.js --corpus eval/corpus/large-files.json
node eval/score.js --corpus eval/corpus/large-files.json --misses | tee eval/results/large-files-on.txt
```

- [ ] **Step 6: Compare honestly**

Compare detection on the planted defects in these cases, and record the token cost of both arms. With a handful of cases the Wilson intervals will overlap heavily — say so rather than reporting a point-estimate improvement as a result. The three outcomes and what each means:

- **Detection clearly up, cost acceptable** → flip `HUNK_WINDOWING` to `true` in `constants.js` and record why.
- **No detectable difference** → leave the default off and record the dilution hypothesis as unsupported by this experiment. This is a real result, not a failed task.
- **Detection down** → leave off, and record that the mr_brief-free window loses cross-hunk context the whole-file prompt had.

- [ ] **Step 7: Record the outcome in `eval/README.md`**

Under "What the misses say", add the experiment: the subset used, both arms' detection rates with intervals, token cost, and the resulting default. State the sample size plainly — this is a targeted probe, not a benchmark.

- [ ] **Step 8: Run the full suite**

Run: `npx jest`
Expected: all suites pass. If step 6 flipped the default, several review-path suites now exercise windowing — read any failure as information about windowing, not as a test to loosen.

- [ ] **Step 9: Commit**

```bash
git add eval/run.js eval/README.md src/utils/constants.js
git commit -m "test(eval): measure hunk windowing on the large-file cases

Targeted subset A/B on the cases carrying the known large-file misses,
with both arms' rates, intervals and token cost recorded. The default
follows the numbers."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: Item 1 → Tasks 1–4 (schema and partitioned scoring, labeling and baseline refusal, worksheet, the adjudication pass). Item 2 → Tasks 5–8 (primitives, service layer, contextAnalyzer/StandardsSync, settings and permissions). Item 3 → Task 9. Item 4 → Tasks 10–12 (module, integration behind the flag, measurement). The spec's "Testing" table is distributed across the tasks that own each area.

**Deviation from the spec, recorded deliberately.** The spec described the baseline guard as "refuse when any contributing verdict is `source: 'llm'`". Because Task 1 makes `precision` human-only, an LLM verdict can never contribute to `thresholds.precisionLow`, so that rule would never fire and would be dead code. Task 2 implements the rule that catches the actual hazard instead: refuse when the human sample is empty while LLM verdicts exist, which is the case where a baseline records `precisionLow: 0` beside a healthy on-screen LLM figure. Same intent, live implementation.

**Placeholder scan.** No TBD/TODO. Two steps deliberately instruct the implementer to read a real signature before writing a call rather than inventing one — `contextAnalyzer`'s tree-fetch method name (Task 7 Step 1) and `PullRequestService`'s repo-level comment fetch (Task 9 Step 7). Both name the failure mode to avoid and say what to do if the method does not exist. That is a guardrail against a fabricated identifier, not a missing detail.

**Type consistency.** `windowFile` is the name in Tasks 10 and 11 (the spec's prose said `windowSoloFile`; `windowFile` is what the code and both test suites use, since the function does not care whether its caller called the unit solo). `hunkForLine`/`splitHunks` in Task 3 are distinct from `windowFile`/`splitIntoHunks` in Task 10 — the eval helper reports line ranges for adjudication, the review helper packs hunks for prompting, and they share no consumer. `precisionLlm` is the field name in Tasks 1, 2 and 4. `resolveApiBase` (PullRequestService) and `resolveGitHubBase`/`resolveGitLabBase` (LinkedIssueService) differ because the latter must honour constructor overrides that the former has no concept of.
