# Precision: a verifier that groups, checks premises and ranks (extension + MCP)

Date: 2026-11-26 · Status: draft for review · Owner: RepoSpector

## Problem

Extension F1 on Martian held-out is ~46–49 (P ~40, R ~53); the best tool is ~57 (P ~54, R ~61). MCP is lower (F1 ~32–34, 15 PRs) and ranks worse.

## What we measured before designing (2026-11-26, offline, $0 + one classification agent)

1. **Confidence cutoffs do not help.** On every stored run with verifier confidence, publishing everything had the best or equal F1 (pilot 51.7 / 53.4; held-out 45.6 vs 47.0 at top-3, inside noise). Real findings average confidence 61–69, false positives 44–61: too much overlap.
2. **Pilot false positives (48 entries, ~25 distinct claims), classified against the PR code:**
   golden near-miss 12 (conf 68) · speculative 9 (41) · low-value nit 8 (43) · real but unlabelled 6 (58) · intended by the PR 6 (44) · wrong 6 (36) · pre-existing 1 (12).
   - 18/48 are benchmark artefacts; 30/48 are reviewer errors at conf 36–44.
   - Biggest artefact: one root cause reported at several call sites (cal.com#8087: 5 entries) → 4 extra false positives.
   - Biggest error: claims about other files the reviewer never checked ("assumed such consumers exist"), labelled `verified` by a diff-only verifier.
3. **Word-overlap grouping** (Jaccard ≥ 0.2) merges only 1–3 findings per run (+0.7 to +1.9 F1, no recall loss): same-root-cause claims are worded differently, so grouping needs the model.
4. **MCP's verifier returns keep/reason only, no confidence**; MCP ranks by the specialist's own confidence. That is why its ranking is weaker.

## Goal and non-goals

- Goal: raise F1 of the full list on Martian without lowering recall by more than noise (~3 points), for the extension and MCP. Precision target on held-out ≥ 47 (from ~40).
- Recall-first rule stays: nothing is deleted except exact duplicates of a root cause, which are folded into one finding that lists every site.
- Non-goal: changing the review pass, adding passes, or a new benchmark (separate work item: grow the golden set).

## Design

### 1. Verifier v2 prompt (core, shared)

One new prompt `VERIFY_PROMPT_V2` in `core/src/review/measured.ts` (the old one stays, pinned, for reproduction). Changes against v1:

- **Same root cause:** "If two or more findings describe the same defect (same cause, same fix pattern), even at different lines or files, give every one after the first `sameAs: <index of the first>`." Output field `sameAs?: number`.
- **Premise check:** "When a finding depends on code it does not show (other callers, implementations, consumers, config), and the diff/context does not show that code exists and behaves as claimed, set confidence ≤ 35 and say what is unconfirmed." Demotes, never refutes.
- **Intended trade-offs and nits:** "If the PR title, description or code comments show the behaviour is a deliberate trade-off, or the finding is a defensive or robustness suggestion without a concrete failing input, set confidence ≤ 30." Keeps v1's rule that intent does not disprove a defect in how it is implemented.
- keep/confidence/impact/reason unchanged.

Schema: `VerdictsSchema` gains `sameAs: z.number().int().nonnegative().optional().catch(undefined)`; a `sameAs` that points to itself, forward, out of range, or to a finding with its own `sameAs` is ignored (no chains, no cycles).

### 2. Folding groups (core, pure)

`foldSameCause(findings, verdicts)` in `core/src/review/group.ts`: returns findings where each group is one finding (the head: the highest-confidence member) with `alsoAt: {file, line}[]` for the others. Deterministic, tested. The head keeps its own claim; sites are appended only in display/post text, never into the claim the judge sees.

### 3. Extension

- `engine.ts` uses `VERIFY_PROMPT_V2` and folds groups after labelling, before `byConfidence`.
- The verifier also receives the repository-context text when present (`<definitions>`), used only to confirm or demote premises. This is arm B for the extension.
- Side panel: a finding with `alsoAt` shows "Also at: file:line, …"; posting puts the comment on the head line and lists the other sites in it.
- `RunRecord.findings[].alsoAt` optional; old saved runs read fine.

### 4. MCP

- `verifierPrompt()` gets the same three rules and asks for `confidence` (0–100) and optional `sameAs` (a finding id).
- `VerdictInputSchema` gains optional `confidence` and `sameAs`; old clients that omit them still work.
- `judge()` ranks by verifier confidence when present (else specialist confidence), and folds `sameAs` groups with the same rules as core.
- The MCP verifier already reads the repo, so the premise rule there is backed by real lookups.

### 5. Measurement (fixed before running)

- Harness: `rank rerank` re-verifies the **stored findings** of a run, so only the verifier varies. Add `--prompt v2` and `--context` flags and record the prompt sha in the manifest. Score with the cached Sonnet 4.5 Martian judge (head claims are already-judged texts → cache hits).
- Tuning: pilot 13 PRs, findings from `pilot-ext-s55-base` and `pilot-ext-s55-recall`, 2 verifier runs per arm. Arms: v1 (control), v2, v2 + context.
- Metrics: F1 / P / R of the folded full list; AUC of confidence (real vs false positive); top-1 / top-3 precision; then the cutoff sweep again.
- Adopt v2 when pilot mean F1 rises ≥ 2 and recall drops ≤ 2. Then one held-out confirmation on `heldout-ext-s55-recall` findings (37 PRs) and a regression-set recall check (`regr-ext-s55-recall`, must not lose > 1 of 30). Held-out is not used to change the prompt.
- MCP: one confirmation on the 15-PR held-out subset after the core change (orchestrator Opus 5.5), compared against `h15-mcp-v3-recall-opus55`.
- Budget: ~$15–20 list price total; stop and report if a run exceeds $8.

## Error handling

- Unreadable verifier reply: unchanged (findings shown unchecked, note added).
- Invalid `sameAs`: ignored per finding; the finding stays on its own.
- A fold never removes a finding's site from the output; post and display list all sites.

## Testing

- Core: schema accepts/ignores `sameAs`, cycle and chain rejection, fold order and head choice, prompt sha pinned in `measured.test.ts`.
- Extension engine: grouped findings fold; context passed to verifier; old records without `alsoAt` render.
- MCP: verdict without confidence still finalizes; judge ranks by verifier confidence; `sameAs` folds; negative test for `sameAs` to an unknown id.
- Eval: rerank flags write prompt sha; fold applied before scoring.

## Rollback

v1 prompt and code path stay; `reviewPrompt`-style dependency `verifyPrompt` on `EngineDeps` selects the prompt, so a revert is one default change.
