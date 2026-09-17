# 0007. Identity may begin after manufacture

- **Status:** Accepted
- **Date:** 2026-09-17
- **Amended:** 2026-09-17 — terminology, see below. The decision is unchanged.

## Amendment: what "begins" is the record, not the product

The title and the original wording said identity *begins* at enrolment. That
conflates two different things, and the conflation matters.

A graphics card has had an identity since it was manufactured. It has a serial,
a maker and a history whether or not any ledger knows about it. What begins at
enrolment is **TrustPass's record of that identity**, not the identity itself.

Read the loose way, the model implies a product did not exist before it was
enrolled — which would make the unknown period look like a defect in the product
rather than a limit on what this system can see. The gap is ours, not the
object's, and a passport that blames the object for our ignorance is the kind of
false signal this project exists to avoid.

So throughout: enrolment establishes **where the TrustPass record starts**.
Everywhere the word `origin` appears, it means the origin of the record.

The filename and title are kept so existing links and history stay intact.

## Context

Every product in the system today is registered by an `issuer`, and an issuer is
a registered business: `unique (country, registration_number)` per
[ADR 0006](0006-issuers-are-identified-by-registration-number.md), which is the
NIT in Colombia, the RFC in Mexico, the EIN in the United States.

That models one story well — a manufacturer or distributor registers a product
as it enters the supply chain, and identity begins at manufacture.

It models the market this project exists for **not at all**.

A graphics card bought three years ago has no TrustPass record, and its
manufacturer has never heard of TrustPass. Neither has the person selling it.
Under the current model the answer to "can I verify this?" is "no, and there is
nothing you can do about it" — for essentially every product that exists.

That is the wrong answer in two directions at once:

**Commercially.** Second-hand is where verification is worth the most and where
first-party registration is least available. A system that only works once
manufacturers participate cannot bootstrap: it needs the network before it can
offer anyone a reason to join it.

**Practically, and immediately.** The maintainer owns hardware and no company.
There is no path to registering a real product with a real serial and looking at
its passport, which means the system cannot be exercised end to end against
anything physical. A ledger nobody can put an object into is not testable in the
way that matters.

The obvious workaround is to let a person register as an issuer with an invented
registration number. That corrupts the one field ADR 0006 chose precisely because
a national authority guarantees it, and it makes `issuer_verification_status`
meaningless — an issuer that cannot be looked up in any registry is not
`unverified`, it is not an issuer.

### The reason this is not a small change

The temptation is to treat enrolment as registration with a laxer actor. It is
not. The two carry completely different evidence.

A manufacturer registering at the factory asserts: *this unit was made by us,
this is its serial, here is its warranty.* Whatever else is unproven, provenance
begins at a known origin.

A person enrolling a device they hold asserts: *I have an object in front of me
and this is the serial printed on it.* Nothing about where it came from, whether
it is genuine, whether they own it, or whether it was stolen last week.

Storing both as "a product was registered" and rendering both as a passport
would make the second look like the first. That is
[ADR 0003](0003-identity-is-not-authenticity.md)'s failure mode reached by a new
route: not a false badge, but a true record whose *shape* implies a provenance
it does not have.

## Decision

**Identity may begin at any point in a product's life, and the record states
where it began.**

Four parts.

### 1. Enrolment is a first-class path, not a degraded registration

A product record carries an **origin**: how its identity was established.

| Origin | Established by | What it asserts |
| --- | --- | --- |
| `manufacturer` | the maker | this unit was made by us |
| `supply_chain` | a distributor or retailer | we handled this unit, and when |
| `holder` | whoever had the object | this serial was on an object someone held |

`holder` is not a lesser form of the others. It is a different claim, recorded
accurately, and it is the one that will be most common for years.

### 2. An individual is not an issuer

ADR 0006's key stands unbent. A person enrolling their own device does not get a
row in `issuer` with a fabricated registration number, and does not get an
`issuer_verification_status` that cannot mean anything.

Enrolment is recorded against a different kind of actor. What that actor is
called and how it is authenticated is implementation (`TP-141` and the ownership
epic); what this ADR fixes is that it is **not** squeezed into `issuer`.

### 3. A retroactively enrolled passport declares its unknown period

The passport already distinguishes "recorded" from "verified". It must also
distinguish **"before TrustPass"** from **"nothing happened"**.

A passport whose identity began at enrolment shows an explicit gap:

```
Unknown          before 17 September 2026 — outside TrustPass
Enrolled         17 September 2026, by the holder
```

Never an empty history that reads as a clean one. The gap is the honest part, and
a system that shows its gaps is more credible than one that implies completeness
it cannot have.

### 4. Enrolment claims neither ownership nor authenticity

Enrolling a device establishes that someone entered a serial. It is not a claim
of ownership, not proof of possession, and not evidence about the object.

Possession and ownership are separate concepts arriving with the ownership epic.
Nothing in the enrolment path may be worded, rendered or modelled as though
enrolling conferred either.

## Consequences

**What this makes possible.** The system can be exercised against real hardware
immediately, and the resale market — the one this project is for — stops being
unreachable until manufacturers arrive. Evidence can accumulate on a product
before any first party participates, and a manufacturer joining later strengthens
a record that already exists rather than starting one.

**What this makes harder, and it is not small.**

*Anyone can enrol any serial.* Someone can enrol a serial they have never seen,
or enrol a stolen device to give it a passport that looks orderly. The mitigation
is not to prevent enrolment but to ensure a `holder`-origin passport visibly
claims almost nothing — it must never be mistakable for provenance. Rate limiting
(within `TP-100`…`TP-105`) and authentication (`TP-141`) reduce volume; they do
not change what the claim means, and the display is what has to carry that
weight.

*Two records can claim one serial.* A holder enrols a card; its manufacturer
later registers the same serial. The existing partial unique index is per issuer,
so both survive, and the system must eventually decide whether they are one
product with two records or a duplicate to reconcile. This ADR does not decide
that. It is tracked as
[#49](https://github.com/clevervi/trustpass/issues/49) and must be decided
before first-party registration ships, not after — an acknowledged problem with
no owner is a problem that disappears.

*Every surface must carry origin.* A passport that does not say how its identity
began is worse after this change than before it, because the reader now has two
possibilities and no way to tell them apart. Origin is not an optional field to
add later.

**What it costs to undo.** Little, if reversed soon: no enrolled products exist
yet. Reversing after enrolment is in use means telling people the records they
created have no place in the system, which is not a thing that can be done
quietly.

## Alternatives rejected

**Wait for manufacturers.** The plan that requires the hardest participant first
and offers nothing before they arrive. It also leaves the project untestable
against real objects, which is how a design stays plausible for a year and then
turns out to be wrong.

**Let individuals register as issuers.** Cheapest to build and it destroys the
issuer key, the verification states, and the meaning of every claim attributed to
an issuer. ADR 0006 chose that key because an authority guarantees it; a
self-asserted value in the same column guarantees nothing while looking identical.

**One flat product model with no origin.** Simplest schema, and it makes a
holder-enrolled record indistinguishable from a manufacturer-registered one at
exactly the moment a buyer is deciding whether to trust it. That is the outcome
this project exists to prevent.
