# 0006. Issuers are identified by registration number, not by name

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

The `issuer` table first enforced uniqueness over `(legal_name, country)`. The
reasoning was that a company registry issues one legal name per jurisdiction, so
a collision must be a duplicate record rather than two real companies.

That reasoning holds in Colombia and fails elsewhere.

Colombia runs national *control de homonimia* through the RUES: chambers of
commerce cannot register a name already registered anywhere in the country, and
the control is strict enough that the corporate form is not a differentiator —
`Carnes y Carnes S en C` counts as identical to `Carnes y Carnes Ltda`.

The United States does not work that way at all. Business names are registered
at **state** level. Two unrelated companies may both be `Acme LLC`, one in
Delaware and one in Texas, and both are legitimate. A unique index over
`(legal_name, 'US')` rejects the second one.

Since the data model is meant to be international from the start, a constraint
that depends on one country's naming law is a constraint that breaks on the
first issuer from a country with different law. And it breaks by refusing a
legitimate business, which is the worst direction for it to fail in.

There is a further problem with names as keys even where they are unique: they
change. Companies rebrand, restructure, and get acquired. A key that changes is
not a key.

## Decision

Identify an issuer by the identifier its own national authority guarantees to be
unique: `unique (country, registration_number)`.

That is the NIT in Colombia, the RFC in Mexico, the EIN in the United States, the
VAT number across the EU. Every jurisdiction that registers businesses issues
one, it does not change when the company rebrands, and it is the field the
verification workflow has to check anyway — verification means confirming this
issuer exists in that registry, which is a lookup by number, not by name.

`registration_number` is `not null`. An organisation that cannot produce a
registration number cannot be verified, and per ADR 0003 an unverifiable issuer
makes every passport it signs meaningless. Nullable would also be actively
harmful: Postgres permits unlimited nulls in a unique index, so the duplicate
protection would switch itself off for exactly the unverified issuers where
duplicates are most likely.

Format is checked but not parsed: uppercase alphanumeric with hyphens, 4 to 50
characters. That accepts `900123456-7`, `ABC123456T1A` and `12-3456789` without
teaching the schema the rules of every tax authority on earth. Confirming that a
number is real is the verification workflow's job, not a check constraint's.

Legal name keeps a non-unique index, because looking an issuer up by name stays
a normal thing to do.

## Consequences

- The uniqueness guarantee now comes from the authority that actually issues it,
  rather than from an assumption about naming law that holds in one country.
- Registering an issuer requires its registration number up front. That is a real
  constraint on the onboarding flow and it is intentional.
- Two issuers may now share a legal name within a country. In Colombia that
  cannot happen legitimately; elsewhere it can, and the schema no longer
  pretends otherwise.
- Rebranding no longer looks like a new issuer, so a product's trust history
  survives its issuer changing names.
- The schema cannot tell whether a registration number is genuine, only that it
  is shaped like one. That gap is what `verification_status` exists to close,
  and why `unverified` is the default.
