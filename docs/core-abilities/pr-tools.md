# PR tools

**Handlers:** `src/background/handlers/prToolHandlers.js`

Four PR-scoped commands that are not the review. Each is the RepoSpector version
of a pr-agent tool, with the scope narrowed where narrowing makes the output more
trustworthy.

---

## `/labels [apply]`

**Service:** `LabelGeneratorService` · pr-agent equivalent: `/generate_labels`

Suggests labels, and applies them with `apply`. **No model call**, which is the
main design decision here.

pr-agent asks a model to pick from label descriptions in config. But almost every
label a reviewer wants is a *fact* about the diff, not a judgement about it:
whether it touches a migration, whether it ships tests, whether it moves a
lockfile, how big it is, whether the security scanners fired. Deriving those
deterministically means:

- **free** — labels are the cheapest useful output in a PR UI and should not cost
  a call on a user's own key;
- **reproducible** — a label that changes between two runs of the same commit is a
  label nobody can filter a board on;
- **auditable** — `reasons[label]` names the files that produced it, so a wrong
  label is a rule to fix rather than a prompt to re-roll.

Built-in labels: `size/XS…XL`, `tests`, `needs-tests`, `database`,
`dependencies`, `ci`, `infrastructure`, `api`, `documentation`, `configuration`,
`security`, `review/blocking`, `migration/no-rollback`.

`needs-tests` fires only when *production* code changed — a docs-only PR has no
business being asked for tests. `documentation` and `configuration` are claims
about the whole diff, so they require every path to match.

Custom labels come from the repo's own config:

```yaml
# .repospector.yaml
labels:
  - name: team/billing
    pattern: '^src/billing/'
  - name: touches/stripe
    pattern: 'STRIPE'
    target: content    # matches ADDED lines only, never removed ones
```

An invalid regex or a missing `pattern` is reported in `skipped`, not dropped
silently.

**Applying is additive.** `apply()` merges with the existing set rather than
replacing it. Replacing would delete a triager's `priority/p1` or a release
manager's `cherry-pick` the first time a review ran, and a tool that quietly
undoes human curation gets turned off.

---

## `/add-docs`

**Service:** `DocstringService` · pr-agent equivalent: `pr_add_docs`

Writes documentation comments for declarations this PR added or changed. Two rules
decide what it touches, both about keeping the output reviewable:

1. **Only touched declarations.** Documenting a file's untouched functions
   produces a diff nobody asked for, buried in a review of something else.
2. **Only declarations with no doc comment already.** Rewriting an existing
   docstring is an opinion about someone's prose; adding a missing one fills a
   gap. The first starts arguments, the second gets merged.

Also skipped: declarations under 3 lines (a docstring longer than the function is
noise), and any language whose comment syntax is not in `DOC_STYLES` — a docstring
in the wrong dialect is worse than none.

Detection is deterministic; the model writes prose and nothing else. It is given
each declaration's **full source**, not the hunk, because a docstring must
describe parameters, returns and thrown errors, none of which are reliably visible
in a diff. One call per file rather than per declaration: a file's functions share
vocabulary, and the model writes more consistent prose seeing them together.

Placement is computed, not asked for: above the declaration, or *inside* the body
for Python. Exported declarations are documented first — a missing docstring on a
public symbol costs every caller.

Runs at `optional` priority against the [call budget](call-budget.md).

---

## `/ask-line <file>:<line> <question>`

**Service:** `LineQuestionService` · pr-agent equivalent: `pr_line_questions`

Answers a question about one line. `PRThreadManager` already handles follow-up on
a *finding*; this handles a line the review said nothing about — which is the
question people actually ask on a PR.

Worth a service rather than a chat message with a line number in it because the
context is assembled from the line outward, deterministically: the line, then its
enclosing declaration (via the same expansion the review uses), then the diff. Not
whatever the retriever returned for the words in the question.

It refuses rather than guesses. A file the PR does not change, a line past the end
of the file, unreadable content — each returns a refusal saying what is missing,
without calling the model. It also states when the line is **not** part of the
diff, because the reader usually assumes it is.

Runs at `essential` priority: a question the user is waiting for outranks any
background polish pass.

---

## `/history`

**Service:** `PriorFindingService` · pr-agent equivalent: `/similar_issue`

pr-agent indexes past issues in a vector DB to find related discussion. The more
useful question for a reviewer is not "which issue looks like this" but: **this
finding was raised on this code before — did the team accept it?**

RepoSpector can answer that and a hosted tool cannot, because
`FeedbackCollectorService` already accumulates the team's own verdicts: every
inline comment carries a tick-box footer, and each tick becomes a ledger row of
`{rule, file, line, weight, reasoning, prUrl}`. That ledger is the whole corpus —
no embeddings, no extra store, no model call.

Matching is on **rule** first, then narrowed by location. The rule is the only
stable identity a finding has across PRs: its title is model-written and varies
run to run, and its line moves with every edit. A finding with no rule id returns
no history rather than falling back to fuzzy text matching, because a wrong match
here recommends suppressing a real defect.

Only *fresh* (< 120 days), *same-file* verdicts drive a recommendation. A
rejection in a different file is context, not precedent — the rule may be wrong
there and right here.

| Recommendation | When |
|---|---|
| `suppress` | ≥ 2 rejections on this file, no acceptances |
| `deprioritize` | more rejections than acceptances |
| `keep` | accepted before, or no decisive history |
| `none` | no history at all |

**It annotates; it never filters.** Removing a finding on the strength of past
rejections belongs to the posting policy, where every other suppression decision
already lives and is already reported. A service that silently dropped findings
from this data would make "the review stopped mentioning X" untraceable.
