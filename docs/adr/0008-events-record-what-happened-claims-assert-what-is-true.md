# 0008. Events record what happened; claims assert what is true

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

v0.4.0 introduces lifecycle events, and every milestone after it writes history:
ownership transfer, warranty activation, a repair, an inspection, a dispute.

If the event model is wrong, each of those either copies the mistake or builds a
parallel history beside it, and a product's story ends up spread across five
tables that disagree. This is the decision that is genuinely expensive to
reverse, so it is made before the first event row exists rather than after.

Two problems are already visible in the shipped system.

### The passport can say `Suspended` and cannot say why

[`product-lifecycle.md`](../product-lifecycle.md) states it plainly: a status
change leaves no record of why it happened. Products can be suspended **today**.
So a reader can be shown:

```
Status    Suspended
```

and nothing else. A theft report, a fraud investigation and a disputed warranty
claim all render identically, and they are not remotely the same news for
someone about to buy. The worst reading is available to the reader and the
system cannot correct it.

### `claim` currently means "a derived view of current state"

`computeVerificationClaims` builds the passport's claim list from the product
and issuer rows as they are now. That is correct for what v0.3.0 promised, and
it has no room for the question that follows every claim a stranger reads:

> Why does this say verified? Who checked, when, and against what?

The temptation is to answer that by giving claims a history. That is the wrong
shape, and choosing it here would be hard to undo.

## Decision

**An event and a claim are different kinds of statement, stored separately,
neither derived from the other by default.**

| | Event | Claim |
| --- | --- | --- |
| Says | something happened | something is true now |
| Tense | past, fixed | present, revisable |
| Mutability | append-only, never edited | recomputed or restated |
| Answers | what occurred, when, who, why | what is the case, on whose authority |
| Example | `PRODUCT_SUSPENDED`, reason `theft_report` | `issuer: verified` |

An event is a fact about the world: *on this date, this actor did this, for this
reason.* It is never revised, because the past does not change. A mistake is
corrected by recording a correcting event, not by editing the original.

A claim is an assertion about the present: *this is currently true, and here is
who says so.* It may be withdrawn, superseded or re-verified.

Events often **cause** claims to change, but a claim is not the sum of its
events and an event is not a claim about now. Collapsing them gives either an
audit log that pretends to be a verdict, or a verdict with no evidence behind it.

### The minimum an event carries

Fixed now so that every later feature writes the same shape:

| Field | Why it is not optional |
| --- | --- |
| `product` | what this happened to |
| `type` | what happened, from a closed set — not free text |
| `actor` | who did it, and in what capacity |
| `occurred_at` | when it happened in the world |
| `recorded_at` | when TrustPass learned of it |
| `reason` | **why**, from a closed set |
| `source` / `evidence` | what backs it, where that exists |
| `previous_state` | what it moved from |
| `resulting_state` | what it moved to |

Two of these are worth defending.

**`occurred_at` and `recorded_at` are both required and are not the same
date.** A repair happened in March and was recorded in September. Storing one
timestamp forces a choice between lying about when the repair happened and
lying about when it became known, and a system built on provenance cannot do
either. The distance between them is itself information: a sale recorded two
years late is a weaker record than one recorded the same day.

**`reason` is a closed set, not a description.** A free-text field is not
queryable, not translatable, and invites a sentence where a fact belongs. The
wording lives in the interface, as ADR 0003 already requires for claim states.

### Reasons are reasons; they do not become states

`suspended` stays one state. `theft_report`, `fraud_flag`, `dispute` and
`counterfeit_report` are **reasons attached to the event that produced it**.

The alternative — a state per cause — multiplies the state machine by every new
kind of bad news, and every transition table, guard and trigger has to grow with
it. Worse, it puts the reason in the product's current status, where it is
overwritten by the next transition. Reasons belong in history, which is the one
place that does not forget.

### Enrolment is the first event, not a field beside the history

Per [ADR 0007](0007-identity-may-begin-after-manufacture.md), a record begins at
enrolment and declares an unknown period before it. That is an event —
`RECORD_ENROLLED`, with the origin as its actor capacity — and it is the first
row in the product's history rather than a column consulted separately.

This also makes the unknown period a property of the history rather than a note
on the page: the history starts where it starts, and nothing before it is
claimed.

### An enrolment does not produce `active`

`active` is defined as "in an owner's hands", and ownership does not exist until
v0.5.0. Enrolling a device therefore **must not** move it to `active`, in either
direction of convenience.

The sequence is: a record exists → ownership is established → `active` becomes
true. Until v0.5.0 ships, a `holder`-enrolled product stops at `registered`, and
this is asserted by test rather than left to the implementer's judgement.

Letting enrolment imply `active` would mean the system says "in an owner's
hands" because somebody typed a serial.

### `origin` is domain, not presentation

The origin of a record belongs in the domain model and crosses the API boundary
as part of the passport contract. It is not a rendering decision made by the
page.

A consumer reading `GET /passports/{id}` — a marketplace, `TP-072`, anything —
must be able to tell a manufacturer-registered product from a
holder-enrolled one. If only the HTML knows the difference, every machine
consumer treats them as equivalent, which is the exact confusion ADR 0007 exists
to prevent.

## Consequences

**What this makes easy.** Ownership, warranty, repair, inspection and disputes
all write to one spine and read from it. A passport's history section is one
query. "Why is this suspended?" has an answer, and so does "when did TrustPass
learn this?".

**What this makes harder.** Every state-changing operation must now supply an
actor and a reason, including the ones where it feels like ceremony. Writing a
status change becomes two writes that must not diverge, so it belongs in one
transaction and probably behind a database-level guarantee rather than
application discipline — the same reasoning that put status transitions in a
trigger rather than in TypeScript.

**What it costs to undo.** After events exist it is very expensive: the history
is the product. Changing the event shape later means migrating rows that are,
by construction, not supposed to be edited.

**What this deliberately does not decide.** How claims acquire their own
evidence and authority. That is real and coming, and the review that prompted
this ADR is right that a claim will eventually need to say who asserted it and
on what basis. Deciding it now, before a single event exists to reason over,
would be designing against an imagined shape. This ADR fixes the boundary — an
event is not a claim — so that decision can be made later without unpicking the
history.

## Alternatives rejected

**One table for both.** A `product_history` holding state changes and
verification results together. Simplest to build, and it forces every consumer
to ask "is this row a thing that happened or a thing someone asserts?" — a
distinction that must then be re-derived at every read.

**Derive claims entirely from events.** Attractive: one source of truth, claims
as a fold over history. It breaks on the first claim with no event behind it —
`physical_authenticity: not_verifiable` is permanently true and nothing ever
happened to make it so. Forcing synthetic events to justify standing facts
corrupts the history with rows recording nothing.

**Free-text reasons.** Cheapest to write and impossible to query, translate or
render consistently. It also invites explanation where a fact is needed, and the
first time someone writes "suspended pending investigation into possible theft"
the system has a paragraph where it needed `theft_report`.

**A state per cause** (`suspended_theft`, `suspended_fraud`). Discussed above:
it grows the state machine with every kind of bad news and puts the reason
somewhere it gets overwritten.
