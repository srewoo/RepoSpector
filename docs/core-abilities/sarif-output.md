# SARIF output & the persistent summary

Two ways the review survives past the moment it is posted.

## SARIF output

**Module:** `src/utils/sarifExport.js` · **UI:** PR tab → *Export SARIF*

`externalFindings.js` reads other tools' SARIF; this is the same idea in reverse.
Upload the file to GitHub code scanning
(`github/codeql-action/upload-sarif`, or `POST /repos/{o}/{r}/code-scanning/sarifs`)
and every finding lands in the Security tab and inline on the files.

Three reasons that matters more than a download:

1. **Alerts persist.** A review in a PR comment is gone the moment the PR merges.
2. **It is a better feedback channel than the tick-box footer.** Code scanning has
   native *dismiss with reason* — false positive / won't fix / used in tests. That
   is a deliberate structured verdict, given in a UI the team already uses, and it
   feeds `PriorFindingService` and `AdaptiveLearningService` the labelled data
   they are starved of. Most footer threads never get a tick.
3. **SARIF is what their other scanners already emit**, so it drops into whatever
   dashboard exists.

### Fingerprints are the load-bearing part

GitHub uses `partialFingerprints.primaryLocationLineHash` to decide whether an
alert in run N is the same alert as in run N−1. Get it wrong and every re-review
resurrects every dismissed alert, which teaches people to ignore the whole feed.

So the fingerprint is FNV-1a over `rule + file + normalised code` — deliberately
**not** the line number. An alert survives the code moving; it does not survive
the code changing. Reindentation does not resurrect it either.

### Other details that are decisions, not defaults

- **`automationDetails.id: 'repospector/review'`** — without this, uploading a
  RepoSpector run would clear the repo's CodeQL alerts.
- **Provenance in the tags.** `deterministic` vs `ai-generated`, plus `relayed`
  for a finding we merely passed on. That is the first distinction a triager
  needs.
- **A relayed finding keeps its original `helpUri` and attribution**, so a CodeQL
  alert uploaded by us does not read as ours.
- **No `region` for a line-less finding.** SARIF cannot say "about the file";
  omitting the region is how GitHub renders exactly that.
- Round-trips through our own parser — what we emit, we can read (tested).

## The persistent summary comment

**Module:** `src/utils/persistentSummary.js` · **Setting:** Review Quality →
*One Summary Comment per PR* (`reviewSettings.persistentSummary`, default on)

Every run used to post a **new** summary. A PR reviewed five times accumulated
five, four of which described code that no longer existed, and the reader had to
work out which was current from timestamps. pr-agent solves this with
`persistent_comment`; this is that.

**Found by marker, not by author.** `SUMMARY_MARKER` is an explicit claim of
ownership over one comment. "The most recent comment by this user" would
eventually overwrite something a person wrote, because the token may be a human's
PAT that also writes ordinary comments.

**The previous body is kept, collapsed.** Replacing it outright destroys what the
review said about an earlier commit — and anyone reading the replies attached to
it is left responding to text that no longer exists. It is folded into a
`<details>` block instead, labelled by the commit it described, capped at three
revisions with a count of what was dropped, and truncated so a PR reviewed thirty
times cannot grow an unbounded comment.

**Inline comments are unaffected.** Those are per-line and already deduped by
`commentDedupe`; only the summary is persistent.

Failure is soft: an unreadable comment list or a rejected edit falls back to
posting a fresh summary. Worst case is a duplicate comment, never a lost review.
