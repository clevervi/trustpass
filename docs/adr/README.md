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
| [0004](0004-trustpass-id-format.md)         | TrustPass ID format: 128-bit Crockford base32    | Accepted |
| [0005](0005-internal-keys-are-never-public.md) | Internal keys are never public                  | Accepted |
| [0006](0006-issuers-are-identified-by-registration-number.md) | Issuers are keyed by registration number, not name | Accepted |
| [0007](0007-identity-may-begin-after-manufacture.md) | Identity may begin after manufacture, and the record says where | Accepted |
| [0008](0008-events-record-what-happened-claims-assert-what-is-true.md) | Events record what happened; claims assert what is true | Accepted |
| [0009](0009-a-capacity-is-granted-not-claimed.md) | A capacity is granted, evidenced and revocable; it is not a role | Accepted |
| [0010](0010-two-records-one-object.md) | Two records for one object are joined by evidence, and neither is destroyed | Accepted |
| [0011](0011-authority-is-pinned-to-the-moment-it-was-used.md) | Authority is pinned to the moment it was used | Accepted |
| [0012](0012-one-party-one-record.md) | One party, one record, and verification is a claim about it | Accepted |
| [0013](0013-the-application-cannot-remove-its-own-guarantees.md) | The application cannot remove its own guarantees | Accepted |

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
