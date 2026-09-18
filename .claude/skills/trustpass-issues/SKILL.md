---
name: trustpass-issues
description: "Trigger: file an issue, open an issue, close an issue, new finding, scope creep, is this done. Decide whether a finding belongs to an existing issue or a new one, and when work is actually complete."
license: Apache-2.0
metadata:
  author: "clevervi"
  version: "1.1"
---

# TrustPass issue discipline

Complements `trustpass-workflow`, which covers branching, commits, the merge bar
and releases.

## Activation Contract

Load when a finding appears mid-implementation, before creating or closing an
issue, or when a change is growing past what its issue described.

## Hard Rules

- **Search before creating**, by error text, domain concept and `TP-` identifier.
  A duplicate splits one problem's evidence across two places.
- **Read the issue and its dependencies before writing code; fix the issue first
  if it is stale.** A "depends on" line may point at something already closed, or
  at two different pieces of work — which reads as unblocked and is not. Keep
  scope, criteria and observed behaviour in step while implementing.
- **Never build a provisional version of a blocked dependency.** Wait, or do the
  part that is genuinely unblocked. A stand-in becomes a second system somebody
  later trusts.
- **Merged is not done, and your own report is not evidence.** Map every
  acceptance criterion to its evidence, then close. Check the target branch
  itself — `gh api repos/.../contents/<path>?ref=develop` — not the local tree
  and not what the last message said. "Builds" is not "works"; an inference is
  not an executed fact.
- **Router output is not repository evidence.** A summary is navigation. Read the
  named source and cite the file, the test and the CI run.
- **Security raises the evidence bar, not the issue count.** Record precondition,
  attacker capability, boundary, reproduction, and the test that fails without
  the fix. Whether it becomes its own issue is decided by the gates below.
- **A suspected live secret is a containment event.** Stop the transmission,
  contain, rotate, *then* write it up.
- **No artefact credits a tool for the work.** Checked, not remembered:
  `node .claude/scripts/tp-attribution.mjs --commit`, and on generated bodies.

## Decision Gates

| A finding appears mid-work | Action |
|---|---|
| Same root cause, same outcome **and** same acceptance criteria | Update the current issue; extend criteria only if needed |
| Independent outcome, or would materially enlarge the pull request | New issue, linked; current pull request keeps its scope |
| Typo, local cleanup, or a detail of the current issue | Just fix it. No issue |

One gate, applied to everything, security included. Absorbing unrelated work
because "we are already here" is how one pull request closes three issues badly.

## Execution Steps

1. Write Objective, Why now, Scope, **Explicitly not in scope**, Acceptance
   criteria (observable, not "improve X"), Risk, Dependencies.
2. When deferring a finding, record it in the pull request as:
   `Found during TP-XXX: <finding> / Not fixed because: <reason> / Follow-up: #YYY`

## Output Contract

Issue, pull request, tests added, verification actually executed, each
acceptance criterion against its evidence, known limitations, follow-ups
opened.

## References

- `CONTRIBUTING.md` — Definition of Ready, Definition of Done, the merge bar.
- `docs/adr/README.md` — when a decision needs an ADR instead.
- `.claude/context/ai-policy.md` — why Gemini output is never authority.
