# 0002. Layered delivery: product before infrastructure

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

TrustPass has an appealing technical surface: blockchain anchoring, secure NFC
tags with cryptographic authentication, an anomaly detection engine, a public
SDK. Every one of them is defensible in isolation.

Every one of them is also worthless if the product underneath has no users and
no data. A fraud model needs history. An NFC binding needs a product identity to
bind to. Blockchain anchoring needs events worth anchoring.

There is a second constraint specific to this project: there is no pilot
customer. The goal is a working, well-engineered system, not near-term revenue.
That changes what "first" means. Without a customer, the earliest valuable
milestone is the one that is *demonstrable* — scan a code, see a real passport —
not the one that is commercially urgent.

## Decision

Deliver in layers, each gated on the previous one working:

1. **Product** — identity, passport, lifecycle, ownership, warranty
2. **Infrastructure** — public API, blockchain anchoring, verification service
3. **Physical security** — QR hardening, secure NFC, tamper detection
4. **Intelligence** — fraud signals, risk scoring, analytics

Within layer 1, the public passport comes before warranty workflows, reversing
the order that a paying customer would have justified. A passport is visible; a
warranty state machine is not.

No token. No NFT marketplace. No native mobile app. No multi-chain support.
These are not rejected forever; they are rejected as starting points.

## Consequences

- Each layer produces something demonstrable before the next begins.
- The blockchain work happens against a real data model instead of a speculative
  one, so the on-chain/off-chain split is decided with evidence.
- If the project stops at layer 1, it is still a complete, coherent system rather
  than scaffolding for features that never arrived.
- Commercially motivated ordering is explicitly not being followed. If a real
  pilot customer appears, this ADR should be revisited, because warranty
  workflows would then likely outrank the public passport.
