# 0012. One party, one record, and verification is a claim about it

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

[#107](https://github.com/clevervi/trustpass/pull/107) introduced `organization`
and did not reconcile it with `issuer`. The database now holds two tables for
"a business with a legal identity and a registration number", unconnected:

```
product.issuer_id               -> issuer.id
capacity_grant.organization_id  -> organization.id

issuer <-> organization:  nothing
```

Which is the duplication ADR 0006 refused for naming and ADR 0009 refused
explicitly — *"the same real-world entity would exist twice, with two
verification states that can disagree"* — introduced by the pull request citing
that ADR as its reason for adding the table.

The immediate consequence is that `capacity_grant.scope_kind = 'own_organization'`
cannot be evaluated against a product: the grant names an organization, the
product names an issuer, and no join exists. Scope is real in the schema and not
in behaviour.

### The question that has to be answered first

Raised in review, and it reframes the issue correctly:

> The question is not *"how do we connect the two tables"*. It is **which one is
> the canonical identity, and where does the verification of that identity
> live?**

Connecting them is a migration. Deciding what a party *is* is not, and doing the
migration first would settle it by accident.

## Decision

### 1. `organization` is the canonical identity of a party

`issuer` becomes a role an organization plays, as ADR 0009 decided. There is one
record per legal party, keyed by country and registration number per ADR 0006,
and `product` references the organization.

*Rejected: `issuer` gains an `organization_id`.* The cheapest change, and it
keeps two rows for one business with a pointer between them. The defect is not
that they are unlinked; the defect is that there are two, each free to accumulate
properties the other does not have.

*Rejected: grants scope to an issuer instead.* Smallest change that makes scope
work, and it makes the authority model depend on the table that happens to exist
rather than the concept ADR 0009 decided. It also leaves `authority`, `repairer`
and `insurer` with nowhere to live, which was the gap `organization` was added
to close.

### 2. Verification is a property of the party, not of a capacity

An organization is verified, or is not, independently of anything it may do. A
police force checked against a national registry is checked whether or not it
holds a grant, and a manufacturer whose registration lapses is unverified even
while its grants remain valid — those are two different facts and they can move
in opposite directions.

*Rejected: folding verification into the grant's `evidence_reference`.* It reads
tempting because a grant already carries what was checked. But a grant's evidence
answers *"why may this party do this"*, and verification answers *"is this party
who it claims"*. Collapsing them means an unverified organization becomes
unverifiable in principle — there would be nowhere to record the check that has
not happened yet.

### 3. Verification status is a claim; changes to it are events

This is the decision that is not a migration detail, and ADR 0008 already
supplies the shape.

> **Events record what happened; claims assert what is true.**

`verification_status` is a **claim**: it answers what a buyer deciding today
needs to know, and it is revisable. A verification being granted, withdrawn or
suspended is an **event**: past-tense, append-only, with a reason and a recorded
time.

The column stays, because the question *"is this company checked, now"* is the
one the passport asks and it should not require reducing a history to answer.
What changes is that it stops being the only record of the fact.

*Rejected: a mutable column and nothing else — what exists today.* The same
defect ADR 0011 §4 rejected for grants, in a different table. A status that can
be edited means *"was this issuer verified in March"* has no answer, and the
passport renders that status beside events recorded over years:
`computeVerificationClaims` reads the **current** value, so a record created
while a company was in good standing is displayed today under whatever standing
that company has now.

That is not automatically wrong — a buyer deciding today is entitled to today's
answer — but it is currently a choice nobody made. With the events recorded, it
becomes one: the passport may show the present claim, the past one, or both, and
`apps/web/app/trustpass/claim-wording.ts` decides which without the data having
been destroyed.

*Rejected: deriving the status from events on every read.* Correct and it puts a
reduction over history in the path of every passport render, to answer a question
the column already answers. The column is a projection; the events are the
record. Keeping both is the ordinary trade, and it is only honest because the
events exist to check the projection against.

### 4. The migration moves references; it does not copy rows

Every `issuer` becomes an `organization` **by identity** — matched on country and
registration number — rather than by creating a new row and copying fields.

`product.issuer_id` and `lifecycle_event.issuer_id` are `ON DELETE RESTRICT`,
which exists precisely so an issuer cannot vanish from under the events that
reference it. The migration has to move those references with the identity
intact, not around it.

*Rejected: leaving `issuer` in place as a view or an alias.* It would keep every
existing query working and would leave two names for one thing, which is the
state this ADR exists to end. `issuer` goes when nothing references it.

## What this ADR does not decide

- The order of the migration's statements, and how it preserves `RESTRICT`
  references while moving them. That is the implementation, and it is the part
  most likely to go wrong.
- Whether `issuer.company_name` and `legal_name` remain two fields on an
  organization, or one.
- What the passport shows once verification has a history — present claim, past
  claim, or both. That belongs with the wording, per §3.
- How an organization gets verified in the first place. The process behind
  `verification_status` has never been written down, and this ADR does not
  write it.

## Consequences

**Easier.** `own_organization` scope becomes evaluable, which unblocks the write
paths. An authority can be named on an event for the first time — a passport can
say who reported a theft. One party has one verification state.

**Harder.** The migration touches `product` and `lifecycle_event`, the two tables
whose references are protected precisely because losing them would be
unrecoverable. And `verification_status` gaining a history means every write path
that changes it gains an event, exactly as product status did.

**Costs to undo.** High. Once `product` references `organization`, moving back
means the same migration in reverse against more rows.

## Alternatives rejected

Collected from §1–§4 because each is what somebody will propose to avoid the
migration:

**`issuer` gains `organization_id`.** Two rows for one business, with a pointer.

**Grants scope to `issuer`.** Contradicts ADR 0009 and leaves non-issuer parties
homeless.

**`issuer` becomes a view over `organization`.** Every query keeps working and
two names for one thing survive indefinitely.

**Do the migration first and decide afterwards.** The path this ADR exists to
refuse: the shape would be settled by whatever the migration found convenient,
and §3's decision — that verification has a history — would never have been
asked, because moving a column does not raise the question of whether the column
should be the only record.
