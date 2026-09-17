---
name: trustpass-workflow
description: "Trigger: TrustPass backlog item, TP-0XX, branch, commit, pull request, code review, release. Enforces this repo's gitflow, review and evidence discipline."
license: Apache-2.0
metadata:
  author: "clevervi"
  version: "1.0"
---

## Activation Contract

Load before starting a `TP-0XX` item, committing, opening or reviewing a pull request, or tagging a release in this repository.

## Hard Rules

- Never commit to `main` or `develop`. Branch `<type>/TP-0XX-slug` from `develop`.
- Never open a pull request for an item with no written acceptance criteria. Create the issue first.
- Never state a behaviour you have not executed. Run the artefact, query the database, print the output. Building is not running.
- Never merge `risk:high` or `risk:critical`. Those wait for a human.
- Never post a review from an account that did not do the work, and never record a self-review as an approval.
- Never let a test pass for a reason it does not name. Assert the specific error code, not that something threw.
- Write an ADR in `docs/adr/` when a decision is expensive to reverse, at the moment it is made.
- Commit `pnpm-lock.yaml` whenever a dependency changes. A local run passes against a populated `node_modules`; CI does not.

## Decision Gates

| Situation | Action |
|---|---|
| `risk:low` or `risk:medium`, every gate green | Squash merge, delete branch |
| `risk:high` or `risk:critical` | Stop. Hand to the human reviewer |
| Decision is expensive to reverse | ADR before the pull request |
| A test has never failed | Break the code, prove it fails, restore |
| Assumption about law, a registry, or platform behaviour | Verify against a source and cite it |
| Review finding | Inline comment on the line, not an essay |
| Tag already cut, defect found, nothing pushed | Delete the tag and re-cut it |

## Execution Steps

1. Create or confirm the issue: objective, scope, acceptance criteria, dependencies, component, risk, estimate.
2. Branch from `develop`.
3. Implement. Every non-trivial behaviour gets a test that fails when that behaviour breaks.
4. Apply migrations if the schema changed, then run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
5. Commit in conventional format. The body states *why*, including the option rejected and what it would have cost.
6. Open the pull request with the template filled honestly. Reference `Closes TP-0XX`.
7. Wait for every gate. Re-read the diff and post findings as inline comments.
8. Apply the merge gate above.

## Output Contract

Report: the issue closed, gate results, any defect the self-review found and how it was fixed, and the two or three decisions the human should challenge — each with file and line.

## References

- `CONTRIBUTING.md` — branching, commits, review policy, releases, definitions of ready and done.
- `docs/adr/README.md` — ADR index and template.
- `.github/PULL_REQUEST_TEMPLATE.md` — required pull request sections.
