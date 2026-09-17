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
