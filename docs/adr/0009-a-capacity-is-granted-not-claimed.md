# 0009. A capacity is granted, evidenced and revocable; it is not a role on a user

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

`packages/db/src/domain/recording-authority.ts` answers one half of a question
and the database enforces it through a trigger: **what a capacity may assert**.
A holder cannot reinstate a product. An issuer cannot clear a suspension. Only
the system may record `product_activated`. Only an authority may retire a
product that is suspended, because the alternative was a laundering route — a
holder suspends, retires, and the serial is released for a clean re-enrolment.

The other half is unanswered, and nothing in the system hides it:
`lifecycle_event.actor_kind` is **self-declared**. Whoever reaches a write path
names the capacity they are acting in, and the database believes them. That is
why `docs/ROADMAP.md` says the API must not be exposed publicly before `TP-141`.

So the rules about capacity are real and the capacity itself is a claim. The
system knows what an authority may do and cannot tell whether anyone is one.

### An event outlives the identity that wrote it

ADR 0008 decided that events are past-tense and fixed: a mistake is corrected by
recording a correction, never by editing the original. That decision has a
consequence for this one.

Every event written from `TP-141` onwards will point at whatever identity model
exists on the day it is written, and it will keep pointing at it forever. A
model that cannot express *"this police force's warrant ended in March"* will
have recorded events that can never be re-read honestly, because the information
needed to qualify them was never captured. Not captured and lost — **never
captured**. There is no migration back to a fact nobody wrote down.

This is therefore a decision made before the first row exists, for the same
reason ADR 0008 was.

### The shape this wants to be, and why it is wrong

The obvious next step is a `user` table, a password column, and a `role` enum.
It would ship this week. It fails on four questions the system already needs to
answer:

| Question | A role column's answer |
| --- | --- |
| Who granted this capacity? | Nothing. It was set by an UPDATE. |
| On what evidence? | Nothing. |
| Until when? | Never. A role has no end. |
| What happens to what they recorded, after it is taken away? | The column changes and the history silently re-reads. |

The fourth is the one that matters, and it is the one a role column answers
*worst*. Flipping `role` from `authority` to `null` does not just remove a
permission — it retroactively changes what every past event means, in a table
whose entire purpose is that the past does not change.

### Two things authentication does not answer

A login proves that whoever is connecting holds a credential. It says nothing
about what they may assert, on whose authority, or for how long. Building login
first produces a system that knows *who is calling* and still has to guess
*what they are*, which is exactly the position the system is in now, with an
extra table.

**Login is the mechanism for presenting an identity. It is not the identity.**

## Decision

### 1. An actor is the thing that acts, and it is not a person

An **actor** is an entity that can perform a recorded action. A human being may
hold several. A background job is one. An integration belonging to a partner is
one.

*Rejected: making `user` the root of the model.* A machine integration would
then need a fabricated person to hang off, and every query about who did
something would have to know which users are not people. The system records
actions; the thing that acts is the primitive.

### 2. An organisation is a party; `issuer` is a role an organisation plays

`issuer` today means "a business that registers products", and it is the only
organisation the schema can name. That is already a visible gap, and the schema
does not merely permit it — it **requires** it:

```sql
check("lifecycle_event_issuer_matches_actor",
      (actor_kind = 'issuer') = (issuer_id IS NOT NULL))
```

An event whose actor is an authority must have `issuer_id IS NULL`. There is no
column in which to name the authority, so a passport can say a theft was
reported and structurally cannot say who reported it. That is weaker than it
reads, and ADR 0003 exists to stop exactly that kind of quiet overstatement.

The constraint is right for what it guards — a half-recorded actor is worse than
none. What is missing is the party it could point at.

Repair shops, insurers, regulators and police forces are the same kind of thing
as an issuer — a party with a legal identity and a registration number — playing
a different role.

**An organisation is the party. Issuer, authority, repairer are roles it plays.**

*Rejected: a table per kind (`authority`, `repairer`, …).* The same real-world
entity — a manufacturer that also runs its own service centre — would exist
twice, with two verification states that can disagree. ADR 0006 refused to key
issuers by name for the same class of reason: one entity, one record.

This changes `issuer`. The migration is `TP-141`'s work, not this ADR's; the
direction is decided here because changing it later means rewriting every
foreign key that points at an issuer, and there will be more of them each week.

### 3. A capacity is held under a grant, not stored as an attribute

Not `actor.capacity`. A **grant** links an actor to a capacity and carries what
an attribute cannot:

| | |
| --- | --- |
| **actor** | who holds it |
| **capacity** | which entry of `RECORDING_AUTHORITY` — the existing table stays the source of truth |
| **scope** | over which products it applies |
| **granted by** | which actor granted it |
| **granted at** | when |
| **evidence** | what was checked, as a reference, never as a conclusion |
| **valid from / valid until** | when it starts and when it lapses |
| **revoked at / revocation reason** | how it ended early, when it did |

`RECORDING_AUTHORITY` is **not replaced**. It answers what a capacity may
assert; a grant answers who holds that capacity. The two compose, and keeping
them separate is what stops this ADR from quietly redefining rules that already
have tests and a trigger behind them.

### 4. A capacity is scoped, and a global one is a defect

An issuer's `product_registered` capacity is scoped to its own organisation's
products. An authority's is scoped to a jurisdiction.

*Rejected: unscoped capacities.* "An authority" able to suspend any product
anywhere is precisely the fraud vector this whole system exists to resist: one
compromised grant would poison every passport. A capacity with no scope is not
a permission, it is a master key.

### 5. Evidence is a reference, never a conclusion

A grant records *what was checked* — a registry extract, a warrant number, a
signed delegation — as an opaque handle into somebody else's system, in the
shape ADR 0008 already chose for `source_reference`.

It is never rendered as a claim. **A reference is not evidence that was
checked**; it is a pointer to something a reader could check. Displaying "verified"
because a reference exists is ADR 0003's failure reached through a new table.

### 6. An event records the grant it acted under, not only the capacity

This follows from §3 and ADR 0008, and it is the decision most likely to be
skipped as an extra column.

If an event records only `actor_kind = 'authority'`, then when that authority's
warrant is revoked, **no query can find what it wrote**. The events are
indistinguishable from events written by an authority still in good standing.
Recording the grant makes them findable, and therefore qualifiable.

### 7. Revocation is an event, and it does not invalidate the past

A grant ends by being recorded as ended. Never by a delete, never by a silent
flag flip.

And the events written under it **remain true**. This is not leniency; it is
what the event says. An event records that at time T, an actor holding a
then-valid capacity recorded something. Revoking the grant in September does not
make the March recording untrue — it makes it *worth less*, and those are
different statements.

So the passport gains a qualifier, not an erasure:

> Recorded by an authority whose warrant was later withdrawn.

*Rejected: hiding or deleting events written under a revoked grant.* A history
that edits itself when someone's standing changes is not a history. It is a
claim about the past that whoever has the most to gain can rewrite — the thing
`0005_lifecycle_event_append_only` was written to make impossible, arriving
instead through the identity model.

*Also rejected: treating them as still fully authoritative.* A reader weighing a
theft report deserves to know the reporter's warrant was withdrawn. Silence
there is the mirror-image dishonesty.

### 8. A holder holds a capacity nobody granted, and the passport must say so

Every capacity above is granted by someone. `holder` is not, and cannot be:
there is no registry of people who own things, and inventing a grant for it
would fabricate an authority that does not exist.

**This is not a hole in the model. It is the truth about what a holder
enrolment is**, and ADR 0007 already says so — a holder-origin record
establishes that a serial was entered, and nothing about where the product came
from.

So the model states it plainly rather than papering over it: a holder capacity
is self-asserted, it is recorded as self-asserted, and the passport renders it
as such. What authentication adds for a holder is continuity — the same actor
across sessions — not authority.

### 9. A credential is how an actor presents itself, and it is `TP-141`'s

Password, API key, mutual TLS, an OIDC token from a national identity provider:
not decided here.

What *is* decided here is the shape of the question `TP-141` must answer.
Authentication resolves a credential to an **actor**. Authorisation is then a
lookup of that actor's grants that are valid **at the time of the request**,
intersected with `RECORDING_AUTHORITY`. Nothing in the write path reads a role.

## What this ADR does not decide

Written down so `TP-141` has a scope rather than an invitation:

- The credential mechanism, session handling, token lifetime, or rotation.
- How an organisation is verified in the first place — the process behind
  `issuer.verification_status` is still manual and undocumented.
- Whether grants are delegable, and to what depth.
- The public wording for a revoked grant. `apps/web/app/trustpass/claim-wording.ts`
  is the only place codes become language and that is where it will be decided.
- Rate limiting and audit logging. `TP-100` … `TP-105`.

### What it gives #49, and what it does not

[#49](https://github.com/clevervi/trustpass/issues/49) — reconciling a holder
enrolment with a later manufacturer registration — has been waiting on an
authenticated claim of who is who.

This ADR supplies the asymmetry that makes the case decidable: the
manufacturer's claim comes from a **granted, scoped, evidenced** capacity, and
the holder's is **self-asserted** by construction (§8). Those are not two equal
claims about one object, and the reconciliation does not have to treat them as
though they were.

It does **not** decide what happens to the two records. Neither history may be
destroyed, both describe the same physical object, and choosing between merge,
link and supersede is still #49's work.

## Consequences

**Easier.** A passport can name who reported a theft, and say whether their
warrant still stands. An issuer dashboard can show who granted what and when it
lapses. The `TP-100` audit log has something real to record, because a grant and
its revocation are already events.

**Harder.** Every write path gains a grant lookup. Registering a product stops
being one insert. `insertProductWithProvenance` and every fixture that names an
`actorKind` will need a grant behind it, and the test suite is 468 tests deep.

**Costs to undo.** High, and that is the point of writing it now. Events will
reference grants. A grant referenced by an append-only history cannot be
deleted, only ended — so a mistake in this shape is permanent in the same way
the events are.

**Explicit new risk.** A grant is now the thing worth stealing. `TP-101` (access
control) and `TP-104` (rate limiting) stop being generic hardening and become
the defence of this specific object.

## Alternatives rejected

**A `user` table with a `role` enum.** Ships fastest. Cannot answer who granted,
on what evidence, or until when, and answers "what happens to what they
recorded" by silently rewriting it. Rejected on the fourth question, not the
first three.

**Capabilities as signed tokens, with no server-side grant record.** Elegant,
and self-contained: the token carries its own scope and expiry. Revocation
before expiry then requires a revocation list, which is the grant table
arriving anyway, with the audit trail replaced by whatever was in the tokens
somebody still has.

**Deferring the whole model until authentication is built.** The path this ADR
exists to refuse. Login first produces a system that knows who is calling and
still guesses what they are, and by then events are being written against the
guess.

**Extending `actor_kind` with more values.** `repairer`, `insurer`,
`marketplace`. Cheap, and it addresses none of it: a longer list of things
people may declare themselves to be is still a list of things people declare
themselves to be.
