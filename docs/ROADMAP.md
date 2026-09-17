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

Monorepo, Postgres, API with generated OpenAPI, Next.js frontend, CI with
linting, typechecking, tests against a real database, and secret scanning.

`TP-010` `TP-011` `TP-012` `TP-013` `TP-014` `TP-015` `TP-016`

### v0.2.0 — Identity

A business registers, registers a product, and receives a TrustPass ID. Duplicate
serials from the same issuer are rejected.

`TP-020` `TP-021` `TP-022` `TP-023` `TP-024` `TP-025`

### v0.3.0 — Passport

A QR resolves to a public passport page showing what is verified and what is not,
per [ADR 0003](adr/0003-identity-is-not-authenticity.md). This is the first
milestone that demonstrates the product to someone who has never seen it.

`TP-030` `TP-031` `TP-032` `TP-033` `TP-034`

### v0.4.0 — Warranty

Warranty creation, activation, coverage calculation and claims with a real state
machine.

`TP-040` … `TP-045`

### v0.5.0 — Lifecycle and ownership

Events recorded against the product identity, with role-based authorisation over
who may record what. Ownership transfer requires acceptance by the receiver.

`TP-050` … `TP-053`, `TP-060` … `TP-064`

### v0.6.0 — Verification and security hardening

Verification service, public verification endpoint, threat model, RBAC, audit
log, rate limiting, emergency procedures.

`TP-070` … `TP-074`, `TP-100` … `TP-105`

### v0.7.0 — Blockchain anchoring

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
