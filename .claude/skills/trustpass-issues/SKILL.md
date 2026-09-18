---
name: trustpass-issues
description: "Trigger: file an issue, open an issue, close an issue, new finding, scope creep, is this done. Decide whether a finding belongs to an existing issue or a new one, and when work is actually complete."
license: Apache-2.0
metadata:
  author: "clevervi"
  version: "1.0"
---

# TrustPass issue discipline

Complements `trustpass-workflow`, which covers branching, commits, the merge bar
and releases. This covers only the backlog: what becomes an issue, what does
not, and what closing one requires.

## Activation Contract

Load when a finding appears mid-implementation, before creating an issue, before
closing one, or when a change is growing past what its issue described.

## Hard Rules

- **Search before creating.** By error text, domain concept, security boundary
  and `TP-` identifier. A duplicate issue splits the evidence for one problem
  across two places.
- **Never close an issue because its pull request merged.** Merged means the
  code is on `develop`. Map each acceptance criterion to the evidence that
  satisfies it, and close only when every one is met.
- **Never report a stronger result than the evidence supports.** "Builds" is not
  "works", "tests pass" is not "the criterion is met", and an inference is never
  an executed fact.
- **A Gemini finding is not an issue.** It becomes one after Claude reads the
  named source and confirms the behaviour independently.
- **Security findings are not downgraded for needing an unusual configuration.**
  Record the precondition, the attacker capability, the boundary crossed, a
  reproduction, and the regression test that now fails without the fix.

## Decision Gates

| A finding appears mid-work | Action |
|---|---|
| Same root cause **and** same acceptance criteria | Update the current issue; extend criteria only if needed |
| Independently actionable, or would materially enlarge the pull request | New issue, linked; current pull request keeps its scope |
| Typo, local cleanup, or a detail of the current issue | Just fix it. No issue |
| Changes a security boundary or domain semantics | New issue, always, however small the fix |

Absorbing unrelated work because "we are already here" is how one pull request
ends up closing three issues badly.

## Execution Steps

1. Search existing issues. Decide update or create, using the gates above.
2. Write Objective, Why now, Scope, **Explicitly not in scope**, Acceptance
   criteria (observable, not "improve X"), Risk, Dependencies.
3. When deferring a finding, record it in the pull request in this shape:
   `Found during TP-XXX: <finding> / Not fixed because: <scope reason> /
   Follow-up: #YYY`
4. Before closing: run the tests, map criterion to evidence, state any
   limitation, then close.

## Output Contract

On completion report: issue, pull request, tests added, verification actually
executed, each acceptance criterion and its evidence, known limitations, and
follow-up issues opened.

## References

- `CONTRIBUTING.md` — Definition of Ready, Definition of Done, the merge bar.
- `docs/adr/README.md` — when a decision needs an ADR instead.
- `.claude/context/ai-policy.md` — why Gemini output is never authority.
