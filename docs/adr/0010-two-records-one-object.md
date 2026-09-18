# 0010. Two records for one object are joined by evidence, and neither is destroyed

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amended:** 2026-09-18 — a third exit from `proposed`, and the evidence
  provider separated from the proposer and the verifier. This **extends** the
  decision rather than clarifying it: §6 and §7 now permit and forbid things the
  original did not.
- **Amended:** 2026-09-18 — the state matrix in §6, the invariant that
  `unresolved` is reachable only from `proposed`, and one correction: §6 said a
  rejection "is withdrawn and re-proposed", which contradicts `withdrawn` being
  defined as the exit from `verified`. Found by building the matrix.

## Context

[Issue #49](https://github.com/clevervi/trustpass/issues/49) is reachable today.
A person enrols a graphics card they hold. Later its manufacturer registers the
same serial. `product_live_issuer_serial_idx` is scoped to one issuer and
`product_live_holder_serial_idx` to records with none, so **both rows are legal
and neither index fires**. The system holds two TrustPass IDs for one object.

The issue already rules out all three obvious answers, and the reasoning is
worth restating because this ADR is built on it. Merging kills one TrustPass ID,
and a code printed on a physical object that stops resolving is the exact
failure the identity design exists to prevent. Leaving them separate gives a
buyer one partial passport that looks complete. Letting the manufacturer claim
it is closest to right and needs an answer to *"how does a manufacturer prove
this is the unit they made?"* — which is the same serial-matching problem from
the other side.

### What ADR 0009 supplies, and what it does not

ADR 0009 decided that a capacity is granted, scoped, evidenced and revocable.
It is tempting to read that as settling #49: the manufacturer holds a granted,
evidenced capacity and the holder's is self-asserted, so the manufacturer wins.

**That reading is wrong, and it is the error this ADR exists to prevent.**
Raised in review, and correct. Authority over a *class* of claims is not
evidence about a *particular object*:

```
"this organisation really is the manufacturer"        <- ADR 0009 answers this
"this serial really belongs to this physical unit"    <- nothing answers this
```

A verified manufacturer typing a serial into a form has proved who they are and
has proved nothing about the object in front of anyone. The asymmetry between
the two assertions is real and useful, but it is a difference in **standing**,
not a substitute for evidence.

### The dimension neither ADR has yet

Both assertions can be true at once, because they are about different times:

```
holder:        "I have had this object since March 2026"
manufacturer:  "we made the unit carrying serial X in 2024"
```

Neither contradicts the other. The gap between them is the unknown period ADR
0007 named, and it does not close because a manufacturer appeared later — it
becomes *bounded at one end*, which is a different and smaller claim.

So a model that records only who said what, and with what authority, cannot
express the one thing that makes these two records compatible. **When a claim
applies is part of the claim.**

## Decision

### 1. A correspondence is a record, not an edit

Two records are joined by a third thing: a **correspondence**, asserting that
two TrustPass IDs describe one physical object.

It never modifies either product. It does not move events between them, does
not copy an issuer onto a holder record, and does not retire one in favour of
the other.

*Rejected: merging, in any form.* Every variant destroys something — an
identifier already printed, or an assertion somebody made. A system whose
answer to "two records" is "now one record" has decided which of two truthful
statements to delete.

*Rejected: a `superseded_by` column on `product`.* It looks cheaper and hides
the same destruction: a record pointing at its replacement is a record that has
stopped speaking for itself, and there is nowhere to put the evidence, the
period, or who said so.

### 2. Both TrustPass IDs resolve, forever, and each says the other exists

Scanning either code returns a passport. A passport whose record is party to a
verified correspondence states so, names the other identifier, and says what
each record covers.

Neither becomes a redirect. A buyer holding the object scanned the code that is
on it, and answering with somebody else's identifier is how a scan stops meaning
anything.

*Rejected: redirecting the holder record to the manufacturer's.* It reintroduces
"the holder's ID died", slowly.

**Amendment — only a `verified` correspondence is public, and the reason is an
attack.** The original said a passport states a verified correspondence and left
the rest to be inferred from the absence of a sentence. It should not be
inferred.

Anyone may propose, nobody is obliged to answer. If a `proposed` or `unresolved`
correspondence appeared on a passport, **proposing one would become a way to put
a permanent question mark on a record you do not own** — no evidence required,
no response possible, and the doubt does the work. So `proposed`, `unresolved`
and `rejected` are recorded, queryable by the parties involved, and invisible to
a reader scanning a code.

### 3. Three things are established independently, and conflating any two is the failure

| | Answers | Decided by |
| --- | --- | --- |
| **Identity** | who is making this claim | `TP-141`, not here |
| **Capacity** | what claims they may make at all | ADR 0009 |
| **Correspondence evidence** | that *this claim* is about *this object* | **this ADR** |

All three are required. A correspondence proposed by a verified manufacturer
acting within its capacity, with no evidence tying it to the unit, is a
correspondence with one of three legs.

### 4. Evidence is enumerated, weighed, and never inferred from standing

A correspondence carries evidence of what tied the two records together. The
kinds this system can express today, weakest first:

| Evidence | What it is worth |
| --- | --- |
| **Serial match** | Very little on its own. It is the reason the question arose, not an answer to it. Serials are printed on the outside of objects and are unique only within a maker's numbering. |
| **Holder confirmation** | The holder, in possession, confirms the manufacturer's description of the unit. Weak alone, meaningful combined with the above. |
| **Manufacturer production record** | A reference into the maker's own system: batch, production date, distribution. Opaque to TrustPass, per ADR 0008 — a reference is not evidence that was checked. |
| **A secure tag** | The only strong one, and it does not exist yet — `TP-EPIC-13`, unscheduled. A challenge-response from hardware bound to the object is the difference between believing a serial and reading one. |

**Standing is never evidence.** That a verified manufacturer proposed the
correspondence is recorded, and it is not one of the rows above.

*Rejected: free-text evidence.* ADR 0008's argument, unchanged: the first time
somebody writes "matched against our records" the system has a sentence where it
needed a value it can weigh, query and render.

### 5. Every assertion carries the period it covers

Each record states the span it speaks for. The manufacturer's begins at
production. The holder's begins at enrolment. They overlap or they do not, and
the interval before the holder's start remains the unknown period.

A verified correspondence does not erase that interval. It **bounds** it: the
object existed from the manufacturer's date, and TrustPass knew nothing about it
until the holder's. That is a smaller unknown, honestly described, and it is
more than either record could say alone. It is the actual benefit of
reconciling, and the reason this is worth building rather than routing around.

*Rejected: treating the manufacturer's record as retroactively covering the
holder's period.* The maker knows when it built the unit. It does not know where
the object was last year, and a passport implying otherwise manufactures
provenance out of a date.

### 6. A correspondence has a state, and the state is a history

```
proposed ──▶ verified ──▶ withdrawn
    │
    ├──────▶ rejected
    │
    └──────▶ unresolved ──▶ proposed
```

**Amendment — the same rules as a table, because they are currently spread over
three sections and nobody reconstructs those correctly from memory.** Nothing
here is new; every cell is read back from §2, §6 and §8 rather than written from
recollection.

| State | Public | Can become | Produces a claim |
| --- | --- | --- | --- |
| `proposed` | No | `verified`, `rejected`, `unresolved` | No |
| `verified` | **Yes** | `withdrawn` | **Yes** — each record names the other and says what it covers |
| `rejected` | No | nothing; a **new** correspondence may be proposed | No |
| `unresolved` | No | `proposed`, when evidence arrives | No |
| `withdrawn` | **Yes** | nothing | States that a join existed and ended. It does **not** assert the records describe one object |

`withdrawn` is public and `rejected` is not, which looks inconsistent and is not.
A `verified` correspondence was already on both passports; removing it silently
would be the dishonesty §6 exists to prevent, so the reversal is as visible as
the join was. A `rejected` one was never public, so publishing the rejection
would broadcast a proposal nobody was obliged to answer — the doubt-casting
attack §2 refuses, arriving through the back door.

**`unresolved` is reachable only from `proposed`.** Not a detail of the diagram:
it is what separates *"a concrete question was raised and the evidence did not
arrive"* from *"we do not know"*. A correspondence nobody proposed cannot be
unresolved, because there was nothing to resolve, and a state that could mean
either would mean neither.

Each transition is a lifecycle event (ADR 0008), append-only, with an actor
capacity, a reason and a recorded_at. So a correspondence can be disputed,
reversed or re-proposed without anything being deleted, and a passport can say
"this was joined and later withdrawn" rather than quietly unjoining.

*Rejected: a boolean, or a delete.* Both make the reversal invisible, and the
reversal is the part somebody will later need to understand.

#### `unresolved` asserts nothing, and that is the whole point

**Amendment.** The original had two exits and a defect its own review named: §7
requires the counterparty to confirm, and the counterparty is frequently not
there. A manufacturer proposes against a card somebody enrolled two years ago
and has since sold; nobody answers; the correspondence sits in `proposed`
forever and the buyer scanning the code still sees two unconnected passports.

A rule that is correct and unusable is still a design failure, and every escape
considered was worse. A timeout that auto-verifies is self-verification with a
delay. An administrator confirming on the holder's behalf is a person who can
join any two records.

So the third exit does not decide anything:

> `unresolved` — the evidence this correspondence needed did not arrive within
> the period allowed for it.

It is **not** `rejected`. Rejected means somebody looked and said no; that is a
judgement and it belongs to a party entitled to make it. Unresolved means nobody
answered, and the honest record of nobody answering is *"nobody answered"* — not
a decision inferred from silence.

It is not a dead end either. New evidence returns a correspondence to `proposed`,
because the reason it lapsed was an absence, and an absence can end.

A rejection does not reopen that way, and the original wording here was wrong:
it said a rejection "is withdrawn and re-proposed", while `withdrawn` is defined
as the exit from `verified`. A rejection is **terminal for that correspondence**.
Somebody may propose a **new** one, which leaves a different trail on purpose —
the rejection stays where it is, because §8 keeps it as information.

*Rejected: leaving `proposed` open indefinitely.* An unbounded pending state is
indistinguishable from a system that is still working on it, and after a year it
is a lie told by a status field.

*Rejected: treating silence as rejection.* Cheaper, and it converts "we could
not reach anyone" into "someone said no" — a verdict manufactured out of
nothing, which is the failure ADR 0003 exists to prevent, reached through a
state machine.

### 7. Three roles, not two

**Amendment.** The original named a proposer and a verifier. Raised in review:
supplying evidence is a **separate position**, and folding it into either of the
other two reintroduces circularity by a route the two-role version could not
see.

```
Manufacturer  → proposes:  serial X is unit Y
Manufacturer  → supplies:  the evidence for its own proposal
Manufacturer  → verifies:  its own proposal
```

Each step reads as reasonable. Together they are self-assertion with paperwork.

| Role | Does | May be |
| --- | --- | --- |
| **Proposer** | asserts two records may describe one object | an issuer over its own products, a holder over their enrolment, or the system on a detected collision |
| **Evidence provider** | supplies one of §4's enumerated kinds | any party able to produce that kind — a service centre inspecting the unit, a marketplace attesting the holder relationship, the holder confirming possession |
| **Verifier** | decides the correspondence is verified | the counterparty record's side, or a party with a granted verification capacity |

**The rule: the three roles are filled by at least two distinct actors, and the
proposer is never the verifier.**

Stated as a floor rather than as "all three must differ", because the floor is
what today's system can actually meet. In the only case that exists now — a
manufacturer proposes, the holder confirms possession and accepts — the holder
is both evidence provider and verifier. Two actors, three roles, no loop. The
parties that would split the third role further (an authorised service centre,
an independent verifier) do not exist yet, and the model permits them rather
than requiring them into existence.

*Rejected: a verified manufacturer verifying its own proposal.* The
"manufacturer wins" rule wearing a process, letting anyone who obtains an issuer
capacity absorb records they have never seen.

*Rejected: requiring three distinct actors.* Correct in principle and
unimplementable today — it would make every correspondence impossible until a
verifier ecosystem exists, which is a rule that forbids the feature rather than
governing it.

**Reject:** either side, at any time before verification, with a recorded reason.

### 8. Rejected is an answer, and it is kept

A rejected correspondence stays. Both records go on resolving independently,
unchanged, and neither passport claims the other exists.

It is retained because a rejection is information: repeated rejected proposals
against one holder's records is a pattern, and deleting them deletes the
pattern. [#89](https://github.com/clevervi/trustpass/issues/89) is where that becomes a signal.

### 9. Two issuers claiming the same serial is not a correspondence

Two *manufacturers* registering the same serial are not two records of one
object; they are a conflict. The per-issuer index permits it deliberately —
serials are unique only within a maker's numbering, so two makers colliding is
legitimate and common.

A correspondence asserts one physical object. Proposing one between two issuer
records asserts that two manufacturers made the same unit, which is either an
error or a counterfeit claim, and it is routed to
[#89](https://github.com/clevervi/trustpass/issues/89) as a fraud signal rather than
accepted as a join.

## The questions this ADR must answer unambiguously

Raised in review as the bar for it being finished, and answered above:

| Question | Answer |
| --- | --- |
| What does it mean that two IDs are candidates for one object? | A correspondence exists between them, in state `proposed` |
| What evidence can join them? | §4's enumerated kinds. Serial match alone is not enough |
| Who may propose? | An issuer over its own products, a holder over their enrolment, or the system on a collision |
| Who may approve? | Never the proposer. The three roles need at least two distinct actors |
| Who supplies the evidence? | A third role, which may coincide with the verifier but never with the proposer alone |
| What does a reader see before it is verified? | Nothing. Otherwise proposing is a way to cast doubt on a record you do not own |
| What if it is rejected? | Both records continue independently, unchanged, and the rejection is kept |
| Do both IDs still resolve? | Yes, forever, and each names the other once verified |
| Is the unknown period preserved? | Yes. Bounded at one end, never erased |
| Can it be reversed? | Yes, to `withdrawn`, as an event. Nothing is deleted |
| What if the evidence never arrives? | `unresolved`. Neither true nor false, and reopenable if evidence appears later |
| Two manufacturers, one serial? | Not a correspondence. A conflict, routed to [#89](https://github.com/clevervi/trustpass/issues/89) |

## What this ADR does not decide

- The schema. Table, columns and constraints belong to the implementation issue,
  not here.
- How a secure tag performs challenge-response (`TP-EPIC-13`, unscheduled).
- The evidence threshold per correspondence kind — how much is enough for a
  manufacturer-to-holder join is a policy question needing real cases.
- The passport wording. `apps/web/app/trustpass/claim-wording.ts` is the only
  place codes become language and that is where it will be written.
- Anything about authentication. `TP-141` still owns proving who is asking, and
  **none of this can be built before it**, because "the holder confirms" and
  "the issuer confirms" are both meaningless while `actor_kind` is self-declared.

## Consequences

**Easier.** A buyer scanning either code learns the other record exists and what
it covers. The unknown period gets smaller for a reason that can be inspected.
Two truthful assertions stop being a bug.

**Harder.** Reading a passport now means reading a graph rather than a row.
Every passport query gains a correspondence lookup, and the page has to render
"joined", "proposed", "rejected" and "withdrawn" without any of them sounding
like a verdict — which is ADR 0003's problem arriving in a new place.

**Costs to undo.** High. Correspondences are events and events are permanent, so
a wrong shape here is migrated rather than edited, exactly as ADR 0008 warned.

**A new thing worth attacking.** A verified correspondence moves trust between
records. Proposing them in volume, or obtaining an issuer capacity to propose
one, becomes worthwhile — which is why §7 refuses self-verification and why
the access-control and rate-limiting work in `TP-100`…`TP-105` now has another
object to protect.

## Alternatives rejected

**Merge, with the holder's ID kept as an alias.** The tempting compromise: one
record, two identifiers. It loses who asserted what — a merged history cannot
say which party recorded which event without keeping both records anyway, at
which point the merge has bought nothing and destroyed the boundary.

**Manufacturer authority settles it.** Rejected in §3 and worth naming
separately because it is what a reasonable reader will assume this ADR decided.
It answers "who is speaking" with "therefore what they said is true about this
object", and those are different sentences.

**Defer until `TP-141` ships.** The order #49 itself warns against: this must be
decided before first-party registration, because after it ships every day
produces record pairs there is no rule for, and the rule would then be written
to fit whatever accumulated.
