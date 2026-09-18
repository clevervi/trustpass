# 0011. Authority is pinned to the moment it was used

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amended:** 2026-09-18 — §3 gains who writes `grant_id`, and §5 gains the
  authorisation chain as a sequence. Both **extend** the decision: the original
  said an event pins the grant and never said who chooses it.

## Context

[ADR 0009](0009-a-capacity-is-granted-not-claimed.md) decided that a capacity is
granted, scoped, evidenced and revocable rather than a role on a user.
[ADR 0010](0010-two-records-one-object.md) decided that an authenticated actor
proves **who is speaking** and never **which object they are speaking about**.

Neither is implemented. `lifecycle_event.actor_kind` is still self-declared:
whoever reaches a write path names the capacity they are acting in, and the
database believes them. `docs/ROADMAP.md` says the API must not be exposed
publicly because of it.

So the question is not how to log people in. It is:

> **Who are you, what may you assert, and why was that authority still valid
> when you asserted it?**

The third clause is where this gets hard, and it is the one a users-and-roles
table answers worst.

### The sentence that has to become a structure

ADR 0009 says revoking a capacity does not invalidate what was recorded under
it. Today that is a promise in a document.

Events are permanent (ADR 0008), and every event written from `TP-141` onwards
points at whatever identity model exists that day, forever. A model that cannot
express *"this police force's warrant ended in March"* will have recorded events
nobody can ever re-read honestly — not lost, **never captured**, and there is no
migration back to a fact nobody wrote down.

So this ADR's real job is to make that promise **demonstrable**. A model where
revocation *could* rewrite history, but where everyone agrees not to, is not a
model. It is an etiquette.

## Decision

### 1. Four things, and conflating any two is the failure

| | Answers | Lifetime |
| --- | --- | --- |
| **Actor** | the thing that acts | permanent |
| **Organization** | which legal party it acts for | permanent |
| **Credential** | how it proves it is that actor | expires, rotates, is revoked |
| **Grant** | what it may assert, over what, from when, until when | revoked, never edited |

An **actor** is anything that performs a recorded action: a person, a background
job, a partner's integration. Per ADR 0009 it is not a synonym for a human.

An **organization** is a party with a legal identity and a registration number.
ADR 0009 decided `issuer` becomes one role an organization plays.

*Rejected: `organization.type = manufacturer`.* It looks like the smallest
possible change and it is the static-role problem returning under a new name. An
organization that manufactures and also runs a service centre has one type and
two jobs, and the day it gains a third the column becomes an array and the
scoping is gone. What an organization may do belongs on the grant, where it can
carry who said so, over what, and until when.

*Rejected: collapsing credential into actor.* Then rotating a key changes who
you are, and every event ever recorded points at an identity that no longer
exists.

### 2. Membership is itself time-bounded

An actor acts **on behalf of** an organization through a membership, and a
membership has a start and an end like everything else here.

The case that forces it: an employee authorised to register products leaves. The
organization persists, the actor persists, and what must stop is the ability to
act for that organization from that date. Nothing else changes, and nothing
already recorded changes at all.

*Rejected: deleting the membership.* It makes the events that actor recorded
unexplainable — they would reference a relationship the database says never
existed.

### 3. An event pins the grant it acted under

Not the capacity. `actor_kind = 'authority'` cannot say which authority, or
under what warrant, and the schema currently **requires** it to stay silent:
`lifecycle_event_issuer_matches_actor` forces `issuer_id IS NULL` whenever the
actor is not an issuer.

An event records the actor and the grant. That makes three questions answerable
years later, none of which are answerable now:

```
who recorded this                        -> actor
why were they allowed to                 -> grant
was that still valid at the time         -> the grant as it stood then
```

#### `grant_id` is not the caller's to choose

**Amendment.** The original decided that an event pins the grant and said
nothing about who writes it. That omission has a record here:

| Column | What happened |
| --- | --- |
| `recorded_at` | Had a default and a doc comment claiming the database set it. A default is what happens when nobody supplies a value, and the provenance triggers read that column to decide which transaction owned an event. An event planted ten years ahead let a status change commit with nothing recorded to explain it. |
| `recorded_in_xact` | Introduced with the lesson already paid for: forced by trigger from the first line. |

`grant_id` is the third column of the same kind and the most valuable yet. A
caller who chooses it attributes their action to any grant they can name, and
every guarantee in this ADR reduces to whatever the writer typed.

> **`grant_id` is resolved by the server from the authenticated actor, written
> by the database, and never changed afterwards.** No write path accepts it as
> input.

Its default follows the `recorded_in_xact` precedent and **fails closed**: a
value no grant can hold, so removing whatever writes it makes every authorised
action refuse loudly rather than pass silently. `recorded_at`'s `defaultNow()`
failed open, which is why it needed a trigger before it could be trusted at all.

*Rejected: accepting `grant_id` and validating it against the actor.* One extra
check, and it is the wrong shape — it trusts an input and then looks for reasons
to reject it, rather than never taking it. Validation is a filter somebody can
forget to apply on the next write path; resolution is the only way the value can
be produced.

### 4. What makes history immutable is that grants are append-only too

This is the decision that turns ADR 0009's promise into a structure, and it is
the one worth arguing about.

**A grant is never updated.** Not to revoke it, not to extend it, not to change
its scope. Every change is a new record, exactly as `lifecycle_event` already
works and for the same reason: a row that can be edited is a claim about the
past that whoever has the most to gain can rewrite.

So "what authority did this actor hold on 2 August" is a **query**, not a
belief. Reconstructing it does not depend on anyone having refrained from an
UPDATE.

*Rejected: a `revoked_at` column on the grant.* It is one column and it is the
whole problem. Setting it is an edit, and an editable grant means the answer to
"was this valid then" is whatever the row says now. The event would still point
at the grant and the grant would have quietly changed underneath it — history
rewritten without a single event being touched.

*Rejected: copying the grant's terms onto the event.* It survives the edit, and
it makes every event carry a snapshot that cannot be checked against anything.
Two copies that can disagree is the problem `product-status` already solves by
testing both against each other, and here there would be nothing to test
against.

### 5. A credential proves the actor and grants nothing

Authentication resolves a credential to an actor. **Authorisation is a separate
lookup**: the grants that actor holds which are valid at the time of the
request, intersected with `RECORDING_AUTHORITY`.

Nothing in a write path reads a role, and nothing reads the credential twice. A
valid credential for an actor with no grant may do nothing at all, which is the
correct and frequently surprising answer.

**Amendment — the chain, because a paragraph is easier to shortcut than a
sequence.**

```
Credential  ──proves──▶  Actor
                           └──member of──▶  Organization
                                              └──holds──▶  Grant
                                                             └──permits──▶  Capacity
                                                                              └──authorizes──▶  Action
```

Never `Credential ──▶ manufacturer`. That collapse is where an implementation
drifts when the rule is prose, and it is the same collapse ADR 0010 refuses
between an actor's standing and evidence about an object: each arrow answers a
different question, and skipping one means answering it by assumption.

*Rejected: capabilities encoded in the credential itself.* Self-contained and
elegant — and revoking before expiry then needs a revocation list, which is the
grant table arriving anyway with the audit trail replaced by whatever is in the
tokens people still hold.

### 6. Expiry and revocation are one rule with two halves

> **A lapsed grant produces no new claims, and invalidates none of the old ones.**

Both halves are load-bearing. The first is the point of having an expiry. The
second is ADR 0009's decision, and skipping it produces a system where losing an
accreditation silently deletes years of legitimate records.

What a reader sees is a qualifier, never an erasure:

> Recorded by an authority whose warrant was later withdrawn.

*Rejected: hiding or invalidating events recorded under a revoked grant.* That
is `0005_lifecycle_event_append_only`'s failure arriving through the identity
model instead of through SQL.

*Rejected: treating them as unchanged.* A reader weighing a theft report
deserves to know the reporter's warrant was withdrawn. Silence there is the
mirror-image dishonesty, and the two failures are equally easy to ship.

### 7. A compromised credential is revoked; the actor survives

Revoking a credential says nothing about the actor's grants and nothing about
what was recorded. The actor gets a new credential and continues.

That separation is the reason §1 keeps them apart, and it has an uncomfortable
half that has to be decided rather than left:

**Actions taken with a credential before anyone knew it was compromised stand as
recorded.** They were accepted; that is a fact about what the system believed.
The compromise is itself recorded, with the window it covers, and a reader
weighs events inside that window accordingly.

*Rejected: retroactively voiding actions in the compromise window.* It is the
intuitive answer and it deletes legitimate records — most actions in that window
were the real actor's. It also hands anyone who can claim a compromise a way to
erase their own history.

### 8. A grant with no scope is a master key

Restated from ADR 0009 §4 because it is the rule most likely to be skipped when
the first grant is written by hand, and because the first grant written by hand
is usually the one that lives longest.

An issuer's capacity is scoped to its own organization's products. An
authority's is scoped to a jurisdiction. There is no global form.

## The limit this repository has to state about itself

ADR 0010 §7 requires at least two distinct actors across proposer, evidence
provider and verifier. That rule assumes two actors are two people.

**This repository is run by one person with two GitHub accounts.**
`CONTRIBUTING.md` says so, and the history shows both. No model in this document
can detect that arrangement: two actors, two credentials, two memberships, and
one human deciding both.

Separation of duties is therefore a **procedural** control here, not a
technical one — exactly like the self-review bar, which `CONTRIBUTING.md`
already describes as weaker than an independent reader and says so rather than
dressing it up. Anything built on `TP-141` inherits that limit, and a document
that let the rule read as enforced would be making the first false claim in the
model.

## What this ADR does not decide

- **The credential mechanism.** Password, API key, mutual TLS, OIDC, passkeys —
  §5 constrains what a credential *is for*, not what it is made of.
- Session handling, token lifetime, rotation cadence.
- **The schema.** Tables, columns and constraints belong to the implementation,
  and deciding them here is how a model gets settled by whatever the first
  migration happened to do.
- How an organization is verified in the first place. `issuer.verification_status`
  is still set by a process nobody has written down.
- Whether grants are delegable, and to what depth.
- The public wording for any of it. `apps/web/app/trustpass/claim-wording.ts` is
  the only place codes become language.

## Consequences

**Easier.** A passport can name who reported a theft and say whether their
warrant still stands. "What could this actor do on 2 August" stops being a
guess. `TP-100` … `TP-105`'s audit log has something real to record, because a
grant and its revocation are already events.

**Harder.** Every write path gains an actor lookup and a grant lookup.
`insertProductWithProvenance` and every fixture naming an `actorKind` will need
a grant behind it, and the suite is 474 tests deep. Append-only grants mean
"the current grants" is a query over history rather than a `WHERE revoked_at IS
NULL`, and that query will be in the hot path of every write.

**Costs to undo.** High, deliberately. Events will reference grants; a grant
referenced by an append-only history cannot be deleted, only ended.

**A new thing worth stealing.** A grant is now the object an attacker wants. Not
a credential — credentials rotate — but the grant behind it. `TP-100` … `TP-105`
stop being generic hardening and become the defence of this specific record.

## Alternatives rejected

**A `user` table with a `role` enum.** Ships this week. Cannot answer who
granted, on what evidence, or until when, and answers "what happens to what they
recorded" by silently rewriting it. Rejected on the fourth question, as ADR 0009
already recorded — repeated here because it is what a reasonable person will
propose the moment implementation starts.

**Mutable grants with a revocation timestamp.** §4. One column, and it makes the
central guarantee unprovable.

**Building authentication first and modelling afterwards.** The path both
previous ADRs exist to refuse. It produces a system that knows who is calling
and still guesses what they are, and by then events are being written against
the guess.
