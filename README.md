# TrustPass

[![CI](https://github.com/clevervi/trustpass/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/clevervi/trustpass/actions/workflows/ci.yml)
[![CodeQL](https://github.com/clevervi/trustpass/actions/workflows/codeql.yml/badge.svg)](https://github.com/clevervi/trustpass/actions/workflows/codeql.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-0.4.0-green)

A verification layer for second-hand physical products.

A buyer can see what is known about a product, who said it, what evidence is
behind it — and what nobody has checked. Every participating product gets a
persistent identity, and that identity carries its record across owners,
marketplaces and repairs instead of dying with a listing.

The first target is high-value consumer electronics in Colombia, where the resale
market runs on trust nobody can verify.

### The problem

Buying second-hand means answering questions you have no way to answer:

- Is this the product being advertised?
- Is the warranty real, and does it still apply?
- Has it been repaired, or had parts replaced?
- Which part of its history is verified, and which is somebody's word?

TrustPass exists to narrow that uncertainty without pretending to remove it.

> **Status: v0.4.0, nothing deployed.** Identity, the public passport and a
> product's history work end to end. A TrustPass ID resolves to a page stating
> what has been checked and what has not, with claims listed separately, the
> serial masked, a QR that points at it, and the record of what happened to the
> product and why.
>
> A product cannot change status without an event explaining why, written in the
> same transaction and enforced by the database rather than by whichever code
> happens to be writing. A record can also begin with whoever holds the object,
> not only with a business holding a national registration number — which is
> most of the resale market.
>
> **Not built yet:** warranty, ownership transfer, condition, evidence from
> outside sources, blockchain anchoring, NFC. The verified resale flow is the
> destination, not the current state. There is also no authentication, so the
> API must not be exposed publicly yet. See
> [`docs/ROADMAP.md`](docs/ROADMAP.md) and [`CHANGELOG.md`](CHANGELOG.md).

## What this is not

TrustPass is not a marketplace, not a payment system, not an NFT platform, and
not an authenticity oracle. It is infrastructure that marketplaces, retailers,
repairers and buyers can verify a product against.

## What this is honest about

TrustPass proves **identity**, not physical **authenticity**. If a fraudulent
issuer registers a counterfeit as genuine, the ledger faithfully records that the
issuer said so. The product surfaces what is actually verified — issuer, serial,
tag, warranty — and never renders a blanket "100% authentic" badge.

The principles this follows, including the ones that forbid features, are in
[`docs/PRODUCT_PRINCIPLES.md`](docs/PRODUCT_PRINCIPLES.md).

## Quick start

Requires Node 24+, pnpm 10+ and Docker.

```bash
pnpm install
pnpm db:setup       # container, migrations, roles — and prints the URLs
cp .env.example .env
pnpm dev            # API on :3001, web on :3000
```

`pnpm db:setup` ends by printing the `DATABASE_URL` and `RUNTIME_DATABASE_URL`
to paste into `.env`. The passwords it uses are published in
[`packages/db/src/scripts/local-dev.ts`](packages/db/src/scripts/local-dev.ts)
and are deliberately not secret — they are for a throwaway container on your own
machine. The command refuses any host that is not the loopback, and refuses to
use them at all unless it is asked explicitly.

Without it, a working database is four commands and two passwords nobody wrote
down: the roles `0024` creates have no login until `pnpm db:provision` gives
them one, and until then every integration test **skips** rather than fails.

Then open <http://localhost:3000>. The landing page reports live API and
database health, so a red dot means the stack is genuinely broken, not that the
page is a mock.

### Configuration

| Variable | Where | Required |
| --- | --- | --- |
| `DATABASE_URL` | API | Always |
| `NEXT_PUBLIC_API_URL` | Web | Always |
| `NEXT_PUBLIC_SITE_URL` | Web | **In production** |

`NEXT_PUBLIC_SITE_URL` is the public origin this deployment is served from, and
it is what passport QR codes encode.

In development it may be omitted: the origin is taken from the request, so the
codes work on whatever port you are using. **In production an unset value means
no QR is rendered at all** — the passport page omits it and
`/trustpass/{id}/qr.svg` answers `503`.

That is deliberate. A QR built from a guess still scans; it simply resolves
somewhere else, and nobody finds out until a camera follows it onto a printed
label that cannot be recalled. Publishing nothing is the safe answer to a
deployment that cannot say where it lives.

The origin is never taken from the request in production, because the `Host`
header is caller-controlled and the QR response is cached for a year — a forged
host would be served to everyone who came after.

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
| `pnpm db:setup`   | Container, migrations and role passwords in one  |
| `pnpm db:up`      | Starts Postgres via Docker Compose               |
| `pnpm db:down`    | Stops Postgres                                   |
| `pnpm db:logs`    | Follows the Postgres container logs              |
| `pnpm db:migrate` | Applies pending migrations                       |
| `pnpm db:generate`| Generates a migration from schema changes        |
| `pnpm db:reset`   | Destroys the local volume, then `db:setup` — which **rotates the role passwords to the published ones**, so an `.env` holding your own will stop matching |
| `pnpm db:studio`  | Opens Drizzle Studio against the local database  |

Integration tests that need Postgres skip themselves when `DATABASE_URL` is
unset, so a clean checkout can run `pnpm test` without Docker. CI always
provides a database, so the skip never hides a regression.

## Stack

TypeScript end to end: Next.js 16, Hono, Drizzle ORM, Postgres 18, Biome,
Vitest. Smart contracts (Foundry) and a Python fraud service arrive later, each
gated on the previous layer proving its value. See
[`docs/adr/`](docs/adr/) for the reasoning.

## Contributors

[@clevervi](https://github.com/clevervi) and
[@raishark](https://github.com/raishark). Both write code across the whole
codebase — the foundation commits are Raishark's — and GitHub attributes each
commit to the account that authored it. There is no split by area, and the
commit history is the record of who wrote what.

**An approval from either does not open the merge gate**, and that is enforced
rather than promised: [`no-self-approval.yml`](.github/workflows/no-self-approval.yml)
is a required check on `develop` and fails on an approving review from either
account. `develop` requires **zero** approving reviews.

What carries the weight instead is the argued review. Every pull request sets
out the case for its design — including the option rejected and what it would
have cost — and the strongest objection to it, with the evidence that would
settle the disagreement. The objection has to be answered before a thread
closes: the design changes, the answer is written down, or the limitation is
accepted with an issue behind it.

It is a weaker bar than an independent reviewer and
[`CONTRIBUTING.md`](CONTRIBUTING.md) says so rather than dressing it up. What it
does produce is a public record of *why* each decision went the way it did,
which is most of what a review is for.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. Branching, commit format,
definition of ready and definition of done are all enforced there.

- [`CHANGELOG.md`](CHANGELOG.md) — what shipped and when.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — how we treat each other.
- [`.github/SECURITY.md`](.github/SECURITY.md) — how to report a vulnerability.
