# TrustPass

Verifiable digital identity, warranty and lifecycle history for physical products.

A product gets a TrustPass ID at issue time. From then on, every meaningful event
in its life — sold, activated, inspected, repaired, transferred — is recorded
against that identity. When the product is resold, its history travels with it.

The first target market is high-value consumer electronics (GPUs, laptops,
phones, consoles) in Colombia, where the resale market runs on trust that nobody
can verify.

> **Status: v0.1.0 — foundation.** The platform runs locally end to end. Product
> identity, passports, warranty and lifecycle events are not implemented yet.
> See [`docs/ROADMAP.md`](docs/ROADMAP.md).

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

## Repository layout

```
apps/
  api/        Hono HTTP service, OpenAPI generated from Zod schemas
  web/        Next.js App Router frontend
packages/
  db/         Drizzle schema, migrations and Postgres client
docs/
  adr/        Architecture decision records
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

Integration tests that need Postgres skip themselves when `DATABASE_URL` is
unset, so a clean checkout can run `pnpm test` without Docker. CI always
provides a database, so the skip never hides a regression.

## Stack

TypeScript end to end: Next.js 16, Hono, Drizzle ORM, Postgres 18, Biome,
Vitest. Smart contracts (Foundry) and a Python fraud service arrive later, each
gated on the previous layer proving its value. See
[`docs/adr/`](docs/adr/) for the reasoning.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Branching, commit format,
definition of ready and definition of done are all enforced there.
