# 0005. Internal keys are never public

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

[ADR 0004](0004-trustpass-id-format.md) chose a 128-bit random identifier for
products, and accepted a cost: random primary keys insert at random positions in
a B-tree, which causes page splits, poor cache locality and index bloat. At a few
thousand rows this is invisible. At the millions of products the system is meant
to hold, it is a real write-path problem.

That cost only exists if the public identifier is also the primary key. It does
not have to be.

There is a second, quieter problem pulling the same way. A sequential key that
reaches an API response publishes the row count. `issuer/7` says TrustPass has
about seven customers. For a platform whose pitch is that it is a network, that
is a number worth not giving away.

Both problems dissolve under one rule, and the alternative — picking a key
strategy per table according to expected volume — costs more than it saves. Every
reader then has to remember which table does what, and every new table reopens
the argument.

## Decision

**Every table has a `bigint generated always as identity` primary key. That key
never crosses the API boundary.**

Public identifiers are separate columns: random, uniquely indexed, and added to
a table only when an external consumer actually needs to name that row.

For `product`, that column is the TrustPass ID, which TrustPass generates. For
`issuer` it is the registration number, which a national authority already
issued and already publishes — see [ADR 0006](0006-issuers-are-identified-by-registration-number.md).
A public identifier does not have to be one we invented; it has to be unique,
stable, and safe to expose.

Consequently:

- Foreign keys, joins and internal references use the identity key. They are
  small, sequential, and cheap to index.
- Anything serialised into an API response, a URL, a QR code or a log that leaves
  the system uses the public identifier.
- A table with no public identifier is a table nothing outside the system can
  address. That is a feature, not an omission.

## Consequences

- Inserts land at the end of the primary key index regardless of how random the
  public identifier is. The cost accepted in ADR 0004 is paid by a secondary
  unique index on a column that is looked up, not ordered — which is what a hash
  or B-tree index is good at.
- One rule, no exceptions, nothing to memorise per table.
- Row counts and creation order stay internal.
- The discipline is not enforced by the type system. An identity key serialised
  into a response is a plain number and nothing will complain. This is a review
  concern, and it is why `risk:high` changes to the API surface need a human to
  read them.
- Tables carry two identifiers once they are externally addressable. That is the
  price, and it buys a key that is fast internally and meaningless externally.
