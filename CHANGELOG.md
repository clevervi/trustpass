# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning follows semver against the **public contract** — the HTTP API, the
TrustPass ID format, and the database schema. Internal refactors are patch
releases no matter how large the diff.

A version's section lists only what that tag actually contains. Work merged to
`develop` afterwards belongs under Unreleased until the next release is cut.

## [Unreleased]

### Changed

- **The roadmap says what shipped.** v0.5.0 was planned as Ownership and became
  **Identity and authority**, because `TP-141` turned out to be unbuildable
  until the model behind it was decided and that took four ADRs. Ownership moves
  to v0.6.0 for the reason that moved lifecycle events ahead of warranty: a
  transfer has to say *who* transferred it, and until this milestone the system
  could not name a party or prove one held any capacity. Recorded rather than
  quietly renumbered — a roadmap that drops a milestone is the stale claim this
  project keeps removing from everywhere else.

### Decided

- **[ADR 0012](docs/adr/0012-one-party-one-record.md) — one party, one record,
  and verification is a claim about it.** #107 added `organization` without
  reconciling it with `issuer`, leaving two unconnected tables for one kind of
  thing — the duplication ADR 0006 and ADR 0009 both refuse, introduced by the
  pull request citing ADR 0009 as its reason. The question raised in review
  reframed it: not *how do we connect them* but **which is canonical and where
  does verification live**. `organization` is canonical and `issuer` becomes a
  role it plays. Verification belongs to the party rather than to a capacity,
  because a police force is checked whether or not it holds a grant. And
  `verification_status` is a **claim** while changes to it are **events**, per
  ADR 0008 — today it is a mutable column and nothing else, which is ADR 0011
  §4's rejected shape in a different table: *"was this issuer verified in
  March"* has no answer, and the passport renders the present value beside
  events recorded over years.
- **[ADR 0011](docs/adr/0011-authority-is-pinned-to-the-moment-it-was-used.md)
  amended: `grant_id` is not the caller's to choose.** §3 decided an event pins
  the grant it acted under and never said who writes it — the third column of
  that kind here, after `recorded_at` (which had a default and a comment
  claiming the database set it, and let a planted event explain a status change)
  and `recorded_in_xact` (forced by trigger from its first line). `grant_id` is
  the most valuable of the three: a caller who chooses it attributes their
  action to any grant they can name. Now server-resolved, server-written and
  immutable, with a default that fails closed. Validating a supplied value is
  rejected as the wrong shape — validation is a filter somebody forgets on the
  next write path. §5 also gains the authorisation chain as a sequence, because
  a paragraph is easier to shortcut than a diagram.
- **[ADR 0011](docs/adr/0011-authority-is-pinned-to-the-moment-it-was-used.md) —
  authority is pinned to the moment it was used.** The logical model for
  `TP-141`, with no tables: the question is not how to log people in but who you
  are, what you may assert, and why that authority was still valid when you
  asserted it. ADR 0009 promised that revoking a capacity does not invalidate
  what was recorded under it; this makes the promise structural. **Grants are
  append-only**, never updated to revoke, extend or rescope, so "what could this
  actor do on 2 August" is a query rather than a belief. A `revoked_at` column
  is rejected explicitly: the event still points at the grant and the grant
  changes underneath it, rewriting history without an event being touched.
  Actor, Organization, Credential and Grant stay four separate things, and an
  event pins the grant it acted under rather than only the capacity. Also states
  a limit the model has about itself — ADR 0010 asks for two distinct actors,
  and no access model that identifies actors by credential can tell two actors
  apart from one party holding both sets, so separation of duties is procedural
  here rather than technical.
- **[ADR 0010](docs/adr/0010-two-records-one-object.md) amended: the state rules
  as a table, and one contradiction they surfaced.** The semantics were spread
  across three sections, and the likely misreading was the expensive one —
  `unresolved` taken for `rejected`, which turns an absence of evidence into
  somebody's verdict. Building the table found that §6 said a rejection "is
  withdrawn and re-proposed" while `withdrawn` is the exit from `verified`; a
  rejection is terminal for that correspondence and a new one may be proposed
  instead. Also states the invariant that `unresolved` is reachable only from
  `proposed`, and records as open the question the binary visibility rule
  leaves: a buyer cannot see a conflict that is real but unanswered.

## [0.4.0] — 2026-09-18

**Lifecycle events and enrolment.** A product's history is recorded, append-only,
and rendered on its passport, and the record can now begin with whoever holds
the object rather than only with a business holding a national registration
number.

The milestone's own argument, from `docs/ROADMAP.md`: a status change that
leaves no record of why it happened is not a smaller problem than a missing
feature. Products could already be suspended, and a passport could already say
`Suspended` while being unable to say whether that was a theft report, a fraud
flag or a disputed claim — which mean very different things to somebody deciding
whether to buy.

`TP-034`, `TP-046` … `TP-048`, `TP-050` … `TP-053`.

### Decided

- **[ADR 0010](docs/adr/0010-two-records-one-object.md) amended: `unresolved` is
  an answer, and the evidence provider is a third role.** §7 required the
  counterparty to confirm, and the counterparty is frequently not there — so a
  correspondence nobody answers waited in `proposed` forever, a defect the
  original pull request's own self-review named without solving. A third exit
  now records that the evidence did not arrive, asserting neither truth nor
  falsehood, and reopens if evidence appears later; treating silence as
  rejection was refused because it manufactures a verdict out of an absence.
  Supplying evidence is also separated from proposing and verifying, since one
  actor filling all three is self-assertion with paperwork. And only a
  **verified** correspondence is public: were `proposed` visible, proposing one
  would be a way to put a permanent question mark on a record you do not own.
- **[ADR 0010](docs/adr/0010-two-records-one-object.md) — two records for one
  object are joined by evidence, and neither is destroyed.** Settles
  [#49](https://github.com/clevervi/trustpass/issues/49): a holder enrolment and
  a later manufacturer registration of the same serial are two truthful
  assertions about one object, made by parties with different standing over
  different periods. They are joined by a **correspondence** — a record in its
  own right, never an edit to either product — so both TrustPass IDs keep
  resolving and each names the other once verified. Standing is explicitly not
  evidence: a verified manufacturer has proved who it is and nothing about the
  object, so "the manufacturer wins" is refused and self-verification with it.
  The unknown period is bounded rather than erased, which is the actual benefit
  of reconciling. Proposed, verified, rejected and withdrawn are all events, so
  a join can be reversed or disputed without anything being deleted.
- **[ADR 0009](docs/adr/0009-a-capacity-is-granted-not-claimed.md) — a capacity
  is granted, evidenced and revocable; it is not a role on a user.**
  `recording-authority.ts` already decides what a capacity may assert and a
  trigger enforces it; nothing decided who holds one, and `actor_kind` is
  self-declared. Decided before `TP-141` builds anything to present an identity,
  because events are permanent and each will point at whatever model existed the
  day it was written. A capacity is held under a grant carrying scope, granting
  actor, evidence reference, validity window and revocation, and an event
  records the grant it acted under — without which a revoked warrant leaves what
  it wrote unfindable. Revocation never invalidates past events: the passport
  gains a qualifier, never an erasure. A holder's capacity is granted by nobody
  and is recorded as self-asserted, because no registry of people who own things
  exists and inventing a grant would fabricate an authority.
- **[ADR 0008](docs/adr/0008-events-record-what-happened-claims-assert-what-is-true.md)
  — events record what happened; claims assert what is true.** Fixed before the
  first event row exists, because every milestone after v0.4.0 writes to the
  same spine and a wrong shape is migrated rather than edited. An event is
  past-tense and append-only, carrying `occurred_at` **and** `recorded_at`
  separately, with `reason` from a closed set. Reasons never become states:
  `suspended` stays one state and `theft_report`, `fraud_flag` and `dispute` are
  reasons on the event that caused it. Enrolment is the first event and must not
  produce `active`, which means "in an owner's hands" and cannot be true before
  ownership exists.
- **[ADR 0007](docs/adr/0007-identity-may-begin-after-manufacture.md) amended:
  what begins at enrolment is the record, not the product.** A device has had an
  identity since it was made; what starts is TrustPass's knowledge of it. Read
  loosely the original wording implied a product did not exist before enrolment,
  which would make the unknown period look like a defect in the object rather
  than a limit on what this system saw. The decision is unchanged.
- **Lifecycle events now come before warranty.** The order was v0.4.0 Warranty →
  v0.5.0 Lifecycle and ownership. It is now v0.4.0 Lifecycle events and
  enrolment → v0.5.0 Ownership → v0.6.0 Warranty, with verification and
  blockchain shifting to v0.7.0 and v0.8.0.

  The reason is already visible in this repository rather than hypothetical:
  [`docs/product-lifecycle.md`](docs/product-lifecycle.md) states that a status
  change leaves no record of *why* it happened. Products can be suspended today,
  and the passport can say `Suspended` while being unable to say whether that
  was a theft report, a fraud flag or a disputed claim — which mean very
  different things to a buyer. Every feature after this one writes history, so
  warranty should be the event spine's first consumer rather than its accidental
  author.

  Note that `docs/releases/v0.3.0.md` still points forward to the old ordering.
  It is a dated snapshot of what that tag contained and is deliberately not
  rewritten; `docs/ROADMAP.md` is the current plan.
- **[ADR 0007](docs/adr/0007-identity-may-begin-after-manufacture.md) — identity
  may begin after manufacture.** A product can currently only be registered by a
  business holding a national registration number, which makes every product
  that already exists unreachable. Enrolment becomes a first-class path
  recording the record's **origin** (`manufacturer`, `supply_chain`, `holder`),
  because a device enrolled by whoever held it asserts far less than one
  registered at the factory and must not be mistakable for it. Scheduled as
  `TP-046`…`TP-049` in v0.4.0.

### Added

- **Lifecycle events, and provenance as a database guarantee.** A product's
  history is recorded in `lifecycle_event`, append-only, and rendered on its
  passport. Nine triggers carry the rules rather than application code, because
  a rule that lives only in TypeScript is bypassed by the first path that writes
  without going through it: history cannot be edited, deleted or truncated
  (`TP002`); each actor capacity may record only what it is entitled to
  (`TP003`); and a product can neither exist nor change status without an event
  explaining why, written in the same transaction (`TP004`).
- **Holder enrolment.** A person can enrol hardware they hold, without a
  national registration number. The record carries `origin` so a device enrolled
  by whoever held it is never mistakable for one registered at the factory.

### Fixed

- **`drizzle-kit` offered migrations that fail on every database**
  ([#85](https://github.com/clevervi/trustpass/issues/85)). Its snapshot
  refreshes only when `drizzle-kit` itself generates a migration, and every
  migration since `0011` is hand-written — triggers and deferred constraints are
  not things the generator can express — so the snapshot described a database
  that stopped existing five migrations earlier. CI now fails when
  `db:generate` produces anything, with the limit written down: a green result
  means the part of the schema `drizzle-kit` can represent is not stale, and
  nothing about the nine triggers, which no snapshot has ever contained.
- **A concurrent transaction's event could explain your status change**
  ([#82](https://github.com/clevervi/trustpass/issues/82)). The provenance
  triggers scoped "this transaction" with `recorded_at >= transaction_timestamp()`,
  which is a time **range**, not an identity — under READ COMMITTED anything
  another transaction committed meanwhile fell inside it. Reproduced with two
  connections: a product moved with no event written in its transaction at all.
  Now `recorded_in_xact = pg_current_xact_id()`, the top-level transaction id,
  so an event either was written by this transaction or was not.
- **A planted `recorded_at` defeated the provenance guarantee**
  ([#79](https://github.com/clevervi/trustpass/issues/79)). The column had a
  default and a comment claiming the database set it; a default is what happens
  when nobody supplies a value, and the triggers read exactly that column to
  decide which transaction owned an event. An event planted ten years ahead, in
  its own transaction, let a later status change commit having recorded nothing.
  Both columns are now written by a trigger, for every writer including the
  owner.
- **A passport QR could encode a host this deployment does not own**
  ([#43](https://github.com/clevervi/trustpass/issues/43)). `passportUrl`
  defaulted to `http://localhost:3000` when `NEXT_PUBLIC_SITE_URL` was unset,
  and both call sites relied on that default. The resulting code scanned
  cleanly and resolved elsewhere — and on a developer's machine that address is
  not dead, it is whatever else holds the port.

### Changed

- **`NEXT_PUBLIC_SITE_URL` is now required in production.** Unset, no QR is
  rendered: the passport page omits it and `/trustpass/{id}/qr.svg` answers
  `503`. A missing QR is honest; one pointing at the wrong host is not, and it
  is printed onto an object that cannot be recalled.
- **The QR's `Cache-Control` now depends on where its origin came from.** A
  configured origin is cached for a year as before. An origin derived from the
  request — development only — is `no-store`, because `Host` is
  caller-controlled and caching it would serve a forged host to every later
  visitor.

## [0.3.0] — 2026-09-17

Passport. A TrustPass ID now resolves to a page anyone can read, and that page
states what has been checked and — more importantly — what has not.

### Added

- **`GET /passports/{trustpassId}`** — the first public read surface. A separate
  prefix from `/products` on purpose: `POST /products` returns the whole serial,
  and the same prefix returning a masked one on read is an asymmetry waiting to
  cause a mistake. When authentication arrives (TP-141) `/products/*` locks and
  `/passports/*` stays public, which is a prefix rule rather than a per-method
  exception.
- **Serial disclosure** — the last four characters, and only when at least five
  remain hidden. Below that nothing is shown, because masking that discloses
  half the value is not masking. Counts code points, so a serial containing an
  astral character is never split mid-pair.
- **Verification claims** — issuer, serial, secure tag, warranty and physical
  authenticity, each stated separately with its own state. The serial is
  `recorded`, never `verified`: the issuer supplied it and nothing has compared
  it to any object. Physical authenticity is permanently `not_verifiable`. There
  is no aggregate verdict and no score.
- **The passport page** at `/trustpass/{trustpassId}`, rendering four outcomes
  distinctly — the passport, a mistyped code, an unissued code, and TrustPass
  being unreachable.
- **QR codes**, rendered inline on the passport as server-side SVG and served as
  a downloadable file at `/trustpass/{trustpassId}/qr.svg`. Both come from one
  function. The page says beside the code that scanning it proves only that
  someone had the code.
- **The first tests in `apps/web`**, with a Vitest config. The script was
  `vitest run --passWithNoTests`, which reported success on an app with no tests.

### Changed

- **Serials are no longer exposed whole by the read path.** `PublicPassport` has
  no field for one, so the type makes it unrenderable rather than merely absent.
- **Merge policy.** `high` and `critical` pull requests no longer wait for a
  second reader; merging is delegated to the author. What replaces the reader is
  a public bar: every protective guard mutation-checked, the results listed in
  the pull request, and an inline self-review. The document states plainly that
  this is weaker than independent review.
- **`TP-034` (lifecycle history) moved to v0.5.0.** There is no event table, so
  the section would render nothing or repeat two facts shown above it.

### Fixed

- The home page announced `v0.1.0` while the repository was at `v0.2.0`, and
  nothing updated it on release. A label nobody maintains becomes a false claim
  on its own.

### Trust model notes

- **A mistyped identifier and an unissued one are different answers.** A typo
  returns `422 mistyped_trustpass_id` and the page says so; an unissued but
  well-formed identifier returns `404`. Returning 404 for a typo would be the
  system agreeing a product is unregistered because one character was misread,
  which is the false accusation ADR 0004's check symbol exists to prevent.
- **A failure to check is never a verdict.** When the API cannot be reached the
  page says no check was made, rather than rendering a passport-shaped layout
  with blank fields.
- **Draft products have no passport.** A draft is a row that claims nothing, and
  publishing its passport would publish a claim nobody made. It returns 404.
- **Passports are never indexed.** Every branch of the page carries `noindex`,
  deliberately without a robots.txt disallow — a crawler blocked by robots.txt
  never fetches the page and so never sees the directive.
- **A QR is discovery, not security.** It can be photographed from a listing and
  reprinted onto any object, so a successful scan is evidence that someone had
  the code and nothing more.

### Known limitations

- **No authentication.** Anyone who can reach `POST /products` can register
  against any issuer. The API must not be exposed publicly before TP-141.
- **The 404 passport page renders no HTML** ([#38](https://github.com/clevervi/trustpass/issues/38)).
  The status is correct, but Next 16.3.5 leaves the not-found boundary for the
  client, so a reader without JavaScript sees a blank page. Measured across four
  configurations against a production build.
- No warranty, lifecycle events or ownership transfer.
- **The QR has not been scanned by a physical phone.** Its matrix is decoded by
  an independent decoder in CI, which proves the encoding is correct but not
  that it scans across camera apps and print sizes.

## [0.2.0] — 2026-09-17

Identity. A business registers a product and receives a TrustPass ID, and one
physical product cannot hold two live identities.

### Added

- **TrustPass ID** — 128-bit Crockford base32 identifier with a check symbol
  that detects every single-character typo
  ([`8b190e7`](https://github.com/clevervi/trustpass/commit/8b190e7))
- **Issuer model** — four verification states (`unverified`, `pending`,
  `verified`, `suspended`), keyed by the registration number its national
  authority guarantees unique
  ([`f665312`](https://github.com/clevervi/trustpass/commit/f665312))
- **Product model** — brand, model, serial, category, status and issuer, with
  the issuer foreign key set to RESTRICT so provenance cannot be deleted
  ([`5666512`](https://github.com/clevervi/trustpass/commit/5666512))
- **Status lifecycle** — the allowed moves between `draft`, `registered`,
  `active`, `suspended` and `retired`, enforced by a database trigger rather
  than by application code. `retired` is terminal, and `suspended` cannot
  return to `active` in one step
  ([`046b170`](https://github.com/clevervi/trustpass/commit/046b170))
- **`POST /products`** — registers a product against an existing issuer and
  returns its TrustPass ID, with validation at the boundary and one documented
  error shape
  ([`3acb78e`](https://github.com/clevervi/trustpass/commit/3acb78e))
- **One live identity per serial** — a partial unique index over issuer and
  lower-cased serial, excluding retired products, so a warranty replacement can
  reuse the serial it replaces. A duplicate returns 409 naming the existing
  TrustPass ID
  ([`f040311`](https://github.com/clevervi/trustpass/commit/f040311))
- **CodeQL** — security and quality analysis on every pull request and weekly
  ([`b936bdc`](https://github.com/clevervi/trustpass/commit/b936bdc))
- **Dependency review** — blocks pull requests introducing dependencies with
  known vulnerabilities or copyleft licences
  ([`b936bdc`](https://github.com/clevervi/trustpass/commit/b936bdc))
- **Full-history secret scan** — a weekly sweep of every commit, because the
  per-change scan only covers the commits in each push
  ([`281d5da`](https://github.com/clevervi/trustpass/commit/281d5da))
- **Risk-based merge policy** — `low` and `medium` merge on green gates, `high`
  and `critical` wait for a human
  ([`b936bdc`](https://github.com/clevervi/trustpass/commit/b936bdc))
- Break-glass procedure for protected branches
  ([`75ba503`](https://github.com/clevervi/trustpass/commit/75ba503))
- Release process definition
  ([`ac26b13`](https://github.com/clevervi/trustpass/commit/ac26b13))
- Migration policy and `pnpm db:reset`, which removes the volume. `DROP SCHEMA
  public CASCADE` leaves Drizzle's ledger behind and is not a reset
  ([`5666512`](https://github.com/clevervi/trustpass/commit/5666512))
- ADR 0004 — TrustPass ID format
- ADR 0005 — Internal keys are never public
- ADR 0006 — Issuers are identified by registration number, not by name
- [`docs/product-lifecycle.md`](docs/product-lifecycle.md) — the status diagram
  and the reasoning behind the two one-way transitions

### Changed

- CI actions updated to current majors: `actions/checkout` 7,
  `actions/setup-node` 7, `github/codeql-action` 4, `gitleaks-action` 3,
  `pnpm/action-setup` 6
  ([#15](https://github.com/clevervi/trustpass/pull/15)–[#19](https://github.com/clevervi/trustpass/pull/19))

### Fixed

- Documentation claims audited against what the code and tags actually contain.
  The v0.1.0 notes credited that tag with work merged afterwards, the security
  policy promised response times a single maintainer cannot keep, and the served
  OpenAPI document advertised endpoints that do not exist
  ([`755cd94`](https://github.com/clevervi/trustpass/commit/755cd94))
- Next 16 regenerating agent instruction files into `apps/web` on every
  `next dev`, which put deleted files back
  ([`c0c5d68`](https://github.com/clevervi/trustpass/commit/c0c5d68))

### Security

- esbuild pinned past two dev-server advisories reaching the tree through
  `drizzle-kit`. Neither was exploitable here — both require running esbuild's
  development server — but an open alert on a public repository is a claim
  nobody should have to disprove
  ([`bd66d8b`](https://github.com/clevervi/trustpass/commit/bd66d8b))

### Known limitations

- **No authentication.** Anyone who can reach `POST /products` can register
  against any issuer. The API must not be exposed publicly before TP-141.
- No public passport page, warranty, lifecycle events or ownership transfer.
- Serials are stored whole and are not safe to display; masking is TP-031.

## [0.1.0] — 2026-09-17

Foundation. The platform runs locally end to end with generated OpenAPI, live
health checks, and a CI pipeline that enforces quality before any code reaches
`develop`.

### Added

- **Monorepo** — pnpm workspace with `apps/api`, `apps/web`, `packages/db`
  ([`c7f5487`](https://github.com/clevervi/trustpass/commit/c7f5487))
- **Database** — Drizzle ORM over Postgres 18 with a health probe and a
  migration pipeline
  ([`18f1554`](https://github.com/clevervi/trustpass/commit/18f1554))
- **API** — Hono HTTP service with `/health`, `/version` and a generated
  OpenAPI 3.1 document
  ([`c956f03`](https://github.com/clevervi/trustpass/commit/c956f03))
- **Web** — Next.js 16 App Router frontend reporting live API and database
  status
  ([`3d347be`](https://github.com/clevervi/trustpass/commit/3d347be))
- **CI** — GitHub Actions pipeline: lint, typecheck, build, tests against a real
  Postgres service, and a secret scan over the commits in each change
  ([`0fe943a`](https://github.com/clevervi/trustpass/commit/0fe943a))

### Documentation

- README, contributing guide, roadmap, and ADRs 0001 through 0003
  ([`af4c8a9`](https://github.com/clevervi/trustpass/commit/af4c8a9))

### Fixed

- Environment loading via `node --env-file` rather than a manually resolved
  path, which failed on Windows
  ([`1f4bb5f`](https://github.com/clevervi/trustpass/commit/1f4bb5f))

[Unreleased]: https://github.com/clevervi/trustpass/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/clevervi/trustpass/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/clevervi/trustpass/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/clevervi/trustpass/releases/tag/v0.1.0
