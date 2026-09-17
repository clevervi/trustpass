# Architecture Decision Records

An ADR records a decision that is expensive to reverse, along with the context
that made it the right call at the time. The value is not the decision; it is
the reasoning, so that a future reader can tell whether the premises still hold.

Write one when the answer to "why is it like this?" would otherwise be lost.

## Index

| ID                                          | Decision                                        | Status   |
| ------------------------------------------- | ----------------------------------------------- | -------- |
| [0001](0001-typescript-end-to-end.md)       | TypeScript end to end, Python deferred          | Accepted |
| [0002](0002-layered-delivery-order.md)      | Layered delivery: product before infrastructure | Accepted |
| [0003](0003-identity-is-not-authenticity.md) | Identity and authenticity are separate claims   | Accepted |

## Template

```markdown
# NNNN. Title

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Date:** YYYY-MM-DD

## Context

What forces are in play. What we knew, and what we did not.

## Decision

What we are doing, stated plainly.

## Consequences

What this makes easy, what it makes hard, and what it costs to undo.
```
