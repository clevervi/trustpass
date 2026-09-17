# TrustPass

[![CI](https://github.com/clevervi/trustpass/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/clevervi/trustpass/actions/workflows/ci.yml)
[![CodeQL](https://github.com/clevervi/trustpass/actions/workflows/codeql.yml/badge.svg)](https://github.com/clevervi/trustpass/actions/workflows/codeql.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.2.0--dev-green)

Verifiable digital identity, warranty and lifecycle history for physical products.

The goal: a product receives a TrustPass ID at issue time, and every meaningful
event in its life — sold, activated, inspected, repaired, transferred — is
recorded against that identity, so that when the product is resold its history
travels with it.

The first target market is high-value consumer electronics (GPUs, laptops,
phones, consoles) in Colombia, where the resale market runs on trust that nobody
can verify.

> **Status: pre-release, nothing deployed.** Latest tag is `v0.1.0`
> (foundation). Merged to `develop` since: the TrustPass ID, the issuer and
> product models, the status lifecycle, and `POST /products`.
>
> **Not built yet:** the public passport page, warranty, lifecycle events,
> ownership transfer, blockchain anchoring, NFC. The verified resale flow
> described above does not exist. There is also no authentication, so the API
> must not be exposed publicly yet. See [`docs/ROADMAP.md`](docs/ROADMAP.md)
> and [`CHANGELOG.md`](CHANGELOG.md).

## What this is honest about

TrustPass proves **identity**, not physical **authenticity**. If a fraudulent
issuer registers a counterfeit as genuine, the ledger faithfully records that the
issuer said so. The product surfaces what is actually verified — issuer, serial,
tag, warranty — and never renders a blanket "100% authentic" badge.

## Quick start

Requires Node 24+, pnpm 10+ and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up          # Postgres on localhost:5433
pnpm db:migrate     # apply schema migrations
pnpm dev            # API on :3001, web on :3000
```

Then open <http://localhost:3000>. The landing page reports live API and
database health, so a red dot means the stack is genuinely broken, not that the
page is a mock.

| Endpoint                            | Purpose                       |
| ----------------------------------- | ----------------------------- |
| `http://localhost:3001/health`      | Liveness plus dependency check |
| `http://localhost:3001/version`     | Deployed service version      |
| `http://localhost:3001/openapi.json` | Generated OpenAPI 3.1 document |
| `POST http://localhost:3001/products` | Register a product, receive its TrustPass ID |

## Repository layout

```
apps/
  api/        Hono HTTP service, OpenAPI generated from Zod schemas
  web/        Next.js App Router frontend
packages/
  db/         Drizzle schema, migrations and Postgres client
docs/
  adr/        Architecture decision records
  product-lifecycle.md
              Product statuses and the moves allowed between them
```

## Scripts

Every script runs from the repository root across all workspace packages.

| Script            | Does                                             |
| ----------------- | ------------------------------------------------ |
| `pnpm dev`        | Runs API and web in parallel                     |
| `pnpm build`      | Builds every package                             |
| `pnpm test`       | Runs every test suite                            |
| `pnpm typecheck`  | Typechecks every package                         |
| `pnpm lint`       | Biome lint and format check                      |
| `pnpm format`     | Biome lint and format, writing fixes             |
| `pnpm db:up`      | Starts Postgres via Docker Compose               |
| `pnpm db:down`    | Stops Postgres                                   |
| `pnpm db:logs`    | Follows the Postgres container logs              |
| `pnpm db:migrate` | Applies pending migrations                       |
| `pnpm db:generate`| Generates a migration from schema changes        |
| `pnpm db:reset`   | Destroys the local volume and rebuilds from zero |
| `pnpm db:studio`  | Opens Drizzle Studio against the local database  |

Integration tests that need Postgres skip themselves when `DATABASE_URL` is
unset, so a clean checkout can run `pnpm test` without Docker. CI always
provides a database, so the skip never hides a regression.

## Stack

TypeScript end to end: Next.js 16, Hono, Drizzle ORM, Postgres 18, Biome,
Vitest. Smart contracts (Foundry) and a Python fraud service arrive later, each
gated on the previous layer proving its value. See
[`docs/adr/`](docs/adr/) for the reasoning.

## Maintainer

[@clevervi](https://github.com/clevervi), who also commits as
[@raishark](https://github.com/raishark).

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Branching, commit format,
definition of ready and definition of done are all enforced there.

- [`CHANGELOG.md`](CHANGELOG.md) — what shipped and when.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — how we treat each other.
- [`.github/SECURITY.md`](.github/SECURITY.md) — how to report a vulnerability.
