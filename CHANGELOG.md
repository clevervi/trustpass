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

### Added

- **TrustPass ID** — 128-bit Crockford base32 identifier with a check symbol
  that detects every single-character typo
  ([`8b190e7`](https://github.com/clevervi/trustpass/commit/8b190e7))
- **Issuer model** — issuer registration with four verification states:
  `unverified`, `pending`, `verified`, `suspended`
  ([`f665312`](https://github.com/clevervi/trustpass/commit/f665312))
- **CodeQL** — security and quality analysis on every pull request and weekly
  ([`b936bdc`](https://github.com/clevervi/trustpass/commit/b936bdc))
- **Dependency review** — blocks pull requests introducing dependencies with
  known vulnerabilities or copyleft licences
  ([`b936bdc`](https://github.com/clevervi/trustpass/commit/b936bdc))
- **Risk-based merge policy** — `low` and `medium` merge on green gates, `high`
  and `critical` wait for a human
  ([`b936bdc`](https://github.com/clevervi/trustpass/commit/b936bdc))
- Break-glass procedure for protected branches
  ([`75ba503`](https://github.com/clevervi/trustpass/commit/75ba503))
- Release process definition
  ([`ac26b13`](https://github.com/clevervi/trustpass/commit/ac26b13))
- ADR 0004 — TrustPass ID format
- ADR 0005 — Internal keys are never public
- ADR 0006 — Issuers are identified by registration number, not by name

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
  Postgres service, and a secret scan over the full history
  ([`0fe943a`](https://github.com/clevervi/trustpass/commit/0fe943a))

### Documentation

- README, contributing guide, roadmap, and ADRs 0001 through 0003
  ([`af4c8a9`](https://github.com/clevervi/trustpass/commit/af4c8a9))

### Fixed

- Environment loading via `node --env-file` rather than a manually resolved
  path, which failed on Windows
  ([`1f4bb5f`](https://github.com/clevervi/trustpass/commit/1f4bb5f))

[Unreleased]: https://github.com/clevervi/trustpass/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/clevervi/trustpass/releases/tag/v0.1.0
