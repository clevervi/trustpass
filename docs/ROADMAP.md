# Roadmap

Delivery follows [ADR 0002](adr/0002-layered-delivery-order.md): product first,
infrastructure second, physical security third, intelligence last. Each layer is
gated on the previous one working.

## Epics

| ID           | Epic               | Layer          |
| ------------ | ------------------ | -------------- |
| `TP-EPIC-01` | Product Discovery  | —              |
| `TP-EPIC-02` | Core Platform      | 1 Product      |
| `TP-EPIC-03` | Product Identity   | 1 Product      |
| `TP-EPIC-04` | Product Passport   | 1 Product      |
| `TP-EPIC-05` | Warranty           | 1 Product      |
| `TP-EPIC-06` | Lifecycle          | 1 Product      |
| `TP-EPIC-07` | Ownership          | 1 Product      |
| `TP-EPIC-08` | Verification       | 2 Infra        |
| `TP-EPIC-09` | Blockchain         | 2 Infra        |
| `TP-EPIC-10` | Security           | cross-cutting  |
| `TP-EPIC-11` | Fraud Intelligence | 4 Intelligence |
| `TP-EPIC-12` | Repair Network     | 1 Product      |
| `TP-EPIC-13` | NFC                | 3 Physical     |
| `TP-EPIC-14` | API / SDK          | 2 Infra        |
| `TP-EPIC-15` | Commercial         | —              |
| `TP-EPIC-16` | Operations         | cross-cutting  |

## Milestones

### v0.1.0 — Foundation ✅

Monorepo, Postgres, API with generated OpenAPI, Next.js frontend, and CI
covering linting, typechecking, build, tests against a real database, and a
secret scan. CodeQL and dependency review were added after this tag.

`TP-010` `TP-011` `TP-012` `TP-013` `TP-014` `TP-015` `TP-016`

### v0.2.0 — Identity ✅

A business registers a product and receives a TrustPass ID. One physical product
cannot hold two live identities.

`TP-020` `TP-021` `TP-022` `TP-023` `TP-024` `TP-025`

Merged to `develop` and awaiting a release tag. Notable beyond the original
scope: the status lifecycle is enforced by a database trigger, product creation
is restricted to `draft` and `registered`, and issuers are keyed by registration
number rather than by legal name — see
[ADR 0006](adr/0006-issuers-are-identified-by-registration-number.md).

**Not included:** authentication. Anyone reaching `POST /products` can register
against any issuer, so the API must not be exposed publicly before `TP-141`.

`TP-141` is gated on `TP-140`, not the other way round.
[ADR 0009](adr/0009-a-capacity-is-granted-not-claimed.md) decides what an
identity **is** — an actor, and capacities granted to it with a scope, an
evidence reference, an expiry and a revocation — before anything is built to
present one. Login resolves a credential to an actor; it does not decide what
that actor may assert. Events are permanent (ADR 0008), so every event written
after `TP-141` points at whatever identity model existed that day, forever.

### v0.3.0 — Passport ✅

A QR resolves to a public passport page showing what is verified and what is not,
per [ADR 0003](adr/0003-identity-is-not-authenticity.md). This is the first
milestone that demonstrates the product to someone who has never seen it.

| Task | What | Risk |
| --- | --- | --- |
| `TP-030` | Resolve a TrustPass ID to a public passport | high |
| `TP-031` | Product identity, with the serial masked | high |
| `TP-033` | Each verification claim stated separately | critical |
| `TP-032` | The QR that resolves to the passport | low |

**`TP-034` moved to v0.5.0.** It renders lifecycle history, and lifecycle events
are `TP-050`. There is no event table today, so the section would show nothing —
and nothing currently records *why* a status changed, so even a transition log is
unavailable. The milestone is smaller than originally written, deliberately.

**`TP-032` is a web task, not an API one.** Hono's `secureHeaders()` sets
`Cross-Origin-Resource-Policy: same-origin`, so a page on one port cannot embed an
SVG served from another. The QR is an encoding of a URL and the web app owns the
URL, so it is rendered there.

### v0.4.0 — Lifecycle events and retroactive enrolment

Events recorded against the product identity: who did what, to which product,
when, **why**, and what state it moved from and to.

`TP-050` … `TP-053`, and `TP-034` (moved from v0.3.0: the passport's history
section needs events to show).

**Retroactive enrolment joins this milestone**, per
[ADR 0007](adr/0007-identity-may-begin-after-manufacture.md). Today a product
can only be registered by a business holding a national registration number, so
every product that already exists — which is the entire resale market — is
unreachable, and the system cannot be exercised against real hardware at all.

Enrolment records a product's **origin** (`manufacturer`, `supply_chain`,
`holder`) and the passport shows it, because a device enrolled by whoever held it
asserts far less than one registered at the factory and must not be mistakable
for it. A passport whose identity began at enrolment declares its unknown period
explicitly rather than showing an empty history that reads as a clean one.

`TP-046` … `TP-048`

Enrolment and events ship together because they are the same statement. "The
TrustPass **record** starts here, and everything before it is outside TrustPass"
is the first entry in a product's history, not a field beside it. The object's
own identity is older than the record — the unknown period is a limit on what
this system saw, not a gap in the product.

The shape of an event is fixed by
[ADR 0008](adr/0008-events-record-what-happened-claims-assert-what-is-true.md)
before any of it is built, because every milestone after this one writes to the
same spine and a wrong shape is migrated, not edited. Three things it settles
that constrain this milestone directly:

- **`occurred_at` and `recorded_at` are separate.** A repair done in March and
  recorded in September is two dates, and the distance between them is itself
  information.
- **Reasons are a closed set and never become states.** `suspended` stays one
  state; `theft_report`, `fraud_flag` and `dispute` are reasons on the event
  that caused it.
- **Enrolment must not produce `active`.** `active` means "in an owner's hands"
  and ownership does not exist until v0.5.0, so a `holder`-enrolled product
  stops at `registered`. Asserted by test, not left to judgement.

`origin` crosses the API boundary as part of the passport contract, not as
something the page decides. A marketplace reading `GET /passports/{id}` has to be
able to tell a manufacturer-registered product from a holder-enrolled one.

#### Why this is no longer the warranty milestone

The ordering was Warranty → Lifecycle. It is now Lifecycle → Warranty, and the
reason is visible in this repository rather than theoretical.

[`product-lifecycle.md`](product-lifecycle.md) already states that **a status
change leaves no record of why it happened**. That is not a future gap: products
can already be suspended today, and the passport can already say `Suspended`
while being unable to say whether that was a theft report, a fraud flag or a
disputed claim. Those mean very different things to someone deciding whether to
buy.

Every feature after this one writes history. Warranty activation is an event. A
claim is an event. A repair, an inspection, a transfer, a dispute — all events.
Building warranty first means warranty invents its own record of what happened,
and every feature after it either copies that or retrofits.

So the event spine comes first, and warranty becomes its first serious consumer
rather than its accidental author.

### v0.5.0 — Identity and authority

**Who may speak, and why that authority was still valid when they spoke.** Not
planned as a milestone: it grew out of `TP-141` being unbuildable until the
model behind it was decided, and it took four ADRs to decide.

[ADR 0009](adr/0009-a-capacity-is-granted-not-claimed.md) — a capacity is
granted, scoped, evidenced and revocable, never a role on a user.
[ADR 0010](adr/0010-two-records-one-object.md) — two records for one object are
joined by evidence, and neither is destroyed.
[ADR 0011](adr/0011-authority-is-pinned-to-the-moment-it-was-used.md) — grants
are append-only, so *"what could this actor do in August"* is a query rather
than a belief. [ADR 0012](adr/0012-one-party-one-record.md) — one party has one
record, and `issuer` becomes a role an organization plays.

Shipped: `actor`, `organization`, `membership`, `credential`, `capacity_grant`
and its revocations; `grant_id` on every event; and the migration that made
`organization` the canonical identity and removed `issuer` entirely.

**Not shipped: authentication.** `actor_kind` is still self-declared. The model
now says exactly what `TP-141` has to build, which it did not before.

### v0.6.0 — Ownership

**Moved from v0.5.0.** The order changed because identity did, and the reason is
the same one that moved lifecycle events ahead of warranty: an ownership
transfer needs to say *who* transferred it, and until this milestone the system
could not name a party or prove one held any capacity at all. Building ownership
first would have meant modelling a transfer between two things the system could
not identify.

Ownership as its own object with its own events, not a column on the product.
Transfer requires acceptance by the receiver, and the history of who held a
product outlives any single holder.

`TP-060` … `TP-064`

**Ownership is modelled so that possession and custody can be added without
reshaping it.** An owner, whoever is physically holding a product, and whoever
has custody of it — a repair centre, a courier, a marketplace holding stock —
are three different facts. Only ownership ships here, but a design that makes
`owner` mean "whoever last interacted with this" cannot represent a repair
without lying.

This is also where `active` stops being an administrative label.
[`product-lifecycle.md`](product-lifecycle.md) defines it as "in an owner's
hands" while ownership does not exist, so today it is a button. It must become a
consequence: a product is `active` because ownership was established, not
because somebody set it.

### v0.7.0 — Warranty

Warranty creation, activation, coverage calculation and claims with a real state
machine — recorded as evidence and events against the product, not as three
columns on it, so that a repair can affect a warranty without erasing how it got
there.

`TP-040` … `TP-045`

### v0.8.0 — Verification and security hardening

Verification service, public verification endpoint, threat model, RBAC, audit
log, rate limiting, emergency procedures.

`TP-070` … `TP-074`, `TP-100` … `TP-105`

### v0.9.0 — Blockchain anchoring

On-chain/off-chain boundary documented first, then `ProductRegistry`,
`LifecycleRegistry` and `OwnershipRegistry` with unit, fuzz and invariant tests
plus Slither in CI.

`TP-080` … `TP-090`

### Later

Repair network, public API and SDKs, fraud intelligence, secure NFC. Each is
gated on the layer below producing real data.

## Explicitly out of scope

No token. No DEX. No NFT marketplace. No stablecoin payments. No warranty escrow.
No native mobile app. No multi-chain support. No enterprise ERP integration.

These are not permanent rejections. They are rejections as starting points.
