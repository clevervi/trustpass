# 0004. TrustPass ID format

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

Every registered product carries one identifier for its entire life. That
identifier appears in a public URL and is printed on a physical label. Both
facts constrain the design, and neither is reversible once products are in the
field.

**Public URL.** The passport a TrustPass ID addresses is readable by anyone with
the link — that is the point of the product. So the identifier must not be
enumerable. If it is, an attacker walks the ID space and scrapes every passport:
the catalogue, the volumes, the repair rates, the ownership churn, the warranty
claim patterns. That is competitive intelligence and a privacy leak, given away
for free. This rules out sequences, counters, and identifiers derived from the
serial.

It also rules out time-ordered identifiers such as UUIDv7 and ULID, despite
their real advantage in index locality. Both embed a timestamp prefix, which
publishes when a product was issued and narrows any search to the products
issued nearby. Issue time belongs in the database, behind access control, not in
a string printed on a box.

**Printed label.** Labels get scratched, soaked and torn. When the code will not
scan, a human reads the identifier aloud or types it in. Two consequences
follow.

First, the alphabet has to tolerate that. `1`/`I`/`l` and `0`/`O` are the classic
substitutions.

Second — and this is the one that is easy to miss — a mistyped identifier must
be distinguishable from an identifier that does not exist. Without a checksum,
both produce "not found". Telling someone standing at a counter that the product
they are about to buy is *not registered*, when in fact they fat-fingered one
character, is a false fraud accusation. It costs a legitimate sale and it
damages trust in the system that exists to create trust.

Third, a printed format can never be retrofitted. Whatever ships is in
circulation forever.

## Decision

```
TP1-XXXXXXXXXXXXXXXXXXXXXXXXXXC
│ │ └─ 26 symbols, 128 bits from the CSPRNG   └─ check symbol
│ └─── format version
└───── prefix
```

- **128 bits of entropy**, from `crypto.getRandomValues`. This is the accepted
  baseline for unguessable public identifiers and is above UUIDv4's 122 bits.
  Enumeration resistance is not the place to economise, and the saving would
  have been about ten characters on a label that is scanned almost every time.
- **Crockford base32** for the encoding. Its alphabet omits `I`, `L`, `O` and
  `U`: the first three to prevent transcription errors, the last so that random
  output cannot spell an obscenity on a customer's invoice.
- **A version marker** immediately after the prefix. It is the only mechanism by
  which the format can ever change without invalidating labels already printed.
- **A Crockford check symbol**, computed modulo 37.

Parsing is deliberately forgiving of humans and strict about correctness. It
accepts lower case, missing or additional separators, and folds `I`, `L` and `O`
onto the symbols they were meant to be. It then verifies the check symbol and
reports a failure as a checksum mismatch rather than as a lookup miss.

### Why the modulus is 37

37 is prime and larger than the 32-symbol alphabet. A single-symbol substitution
shifts the encoded value by `delta * 32^position`, where `0 < |delta| < 32`.
Neither factor is divisible by 37, so the product cannot be either, so the
remainder must change.

That makes **every** single-symbol substitution detectable, not merely most of
them. The test suite asserts this exhaustively over all positions and all
substitutions rather than trusting the argument, and the assertion has been
confirmed to fail when the modulus is replaced with a composite one.

## Consequences

- Identifiers are 31 characters. Longer than a UUID, and the trade is
  deliberate: a QR code absorbs the difference, and a human gets an alphabet
  built for reading aloud plus a checksum.
- Sequential inserts no longer land adjacently in the primary key index, so
  write locality is worse than a time-ordered identifier would give. Accepted:
  the leak is permanent and public, the index cost is a tuning problem with
  known remedies.
- "You mistyped this" is now a distinct outcome from "this product is not
  registered". The API can say so, and the interface must.
- The format cannot be changed, only versioned. `TP2-` is how a future format
  arrives; `TP1-` identifiers keep resolving.
- The implementation lives in `packages/db` alongside the schema, because the
  identifier is the product's primary key. When pure domain logic that touches
  no persistence outgrows that package — status transitions and the verification
  model are the next candidates — it should be extracted into its own package
  rather than left to accumulate.
