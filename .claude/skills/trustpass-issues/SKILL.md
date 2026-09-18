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

- **Search before creating.** By error text, domain concept, security boundary
  and `TP-` identifier. A duplicate issue splits the evidence for one problem
  across two places.
- **Merged is not done.** Map every acceptance criterion to the evidence that
  satisfies it, and close only then.
- **Never report a stronger result than the evidence supports.** "Builds" is not
  "works", "tests pass" is not "the criterion is met", and an inference is never
  an executed fact.
- **Router output is not repository evidence.** A summary is navigation. Neither
  opening nor closing an issue rests on it — read the named source, and cite the
  file, the test and the CI run instead.
- **Security findings raise the evidence bar, not the issue count.** Record the
  precondition, the attacker capability, the boundary crossed, a reproduction,
  and the test that fails without the fix. Never downgrade one for needing an
  unusual configuration. Whether it becomes its own issue is decided by the
  gates below, like anything else.
- **A suspected live secret is a containment event, not a backlog event.** Stop
  the third-party transmission, contain and rotate, *then* verify and write it
  up. Searching for a duplicate issue while a credential is still being sent is
  the wrong order.

## Decision Gates

| A finding appears mid-work | Action |
|---|---|
| Same root cause, same outcome **and** same acceptance criteria | Update the current issue; extend criteria only if needed |
| Independent outcome, or would materially enlarge the pull request | New issue, linked; current pull request keeps its scope |
| Typo, local cleanup, or a detail of the current issue | Just fix it. No issue |

One gate, applied to everything, security included. Absorbing unrelated work
because "we are already here" is how one pull request closes three issues badly.

## Execution Steps

1. Search existing issues. Decide update or create, using the gates above.
2. Write Objective, Why now, Scope, **Explicitly not in scope**, Acceptance
   criteria (observable, not "improve X"), Risk, Dependencies.
3. When deferring a finding, record it in the pull request in this shape:
   `Found during TP-XXX: <finding> / Not fixed because: <scope reason> /
   Follow-up: #YYY`

## Output Contract

On completion report: issue, pull request, tests added, verification actually
executed, each acceptance criterion and its evidence, known limitations, and
follow-up issues opened.

## References

- `CONTRIBUTING.md` — Definition of Ready, Definition of Done, the merge bar.
- `docs/adr/README.md` — when a decision needs an ADR instead.
- `.claude/context/ai-policy.md` — why Gemini output is never authority.
