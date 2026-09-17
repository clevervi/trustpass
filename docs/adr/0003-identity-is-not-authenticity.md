# 0003. Identity and authenticity are separate claims

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

The tempting pitch for a product passport is "scan it and know it is genuine".
That pitch is false, and building toward it would make the system actively
harmful.

Two distinct claims get conflated:

- **Identity** — this record corresponds to this product.
- **Authenticity** — the physical product is genuinely what the record says.

A digital ledger can establish the first. It cannot establish the second. If a
fraudulent importer registers a counterfeit as genuine, the system faithfully
records that the importer made that claim. It has inspected nothing.

A printed QR code compounds this: it can be photographed and reprinted onto any
object. A QR proves that someone had a copy of the code, not that this object is
the one it was issued for.

## Decision

Model trust as a chain of separately verifiable claims, and surface each one
independently:

```
issuer verified → serial verified → tag verified → warranty verified
```

The passport shows what is actually verified and what is not. A product with a
verified issuer but no cryptographic tag reads:

```
Issuer:                 VERIFIED
Serial:                 VERIFIED
Secure tag:             NOT PRESENT
Physical authenticity:  NOT INDEPENDENTLY VERIFIED
```

The interface will never render an unqualified "100% authentic" badge.

Two assurance tiers exist. `Standard` is QR plus serial plus issuer signature,
verified server side. `Secure` adds a cryptographically authenticating NFC tag
where the tag proves possession of a key, not merely possession of an image.

## Consequences

- The product is harder to sell than a green checkmark, and that is the correct
  trade. A false authenticity guarantee transfers risk to the buyer while
  charging the issuer for it.
- The verification model must be explicit in the data layer from the start:
  claims are stored and displayed individually, never collapsed into one boolean.
- Secure NFC is positioned as an upgrade tier with a real difference in what it
  proves, rather than as a marketing feature.
- Buyers get calibrated information. "Reported stolen: no flag" means no flag was
  recorded — not that the product was never stolen. The wording carries that
  distinction.
