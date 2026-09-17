# Agent instructions

TrustPass. TypeScript monorepo: `apps/api` (Hono), `apps/web` (Next.js),
`packages/db` (Drizzle over Postgres).

## Before changing anything

Read `CONTRIBUTING.md`. Branching, commit format, review policy, release process
and the definitions of ready and done are all enforced there, not advisory.

`main` and `develop` are protected for everyone including administrators. Every
change arrives through a pull request.

## Skills

| Skill | Load when |
|---|---|
| `.claude/skills/trustpass-workflow/SKILL.md` | Starting a `TP-0XX` item, committing, opening or reviewing a pull request, cutting a release |

## Commands

```bash
pnpm db:up          # Postgres on localhost:5433
pnpm db:migrate     # apply migrations
pnpm dev            # API on :3001, web on :3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Integration tests skip themselves without `DATABASE_URL`. CI always supplies one,
so the skip never hides a regression.

## Two things this project will not do

**It will not claim a product is authentic.** A ledger proves an issuer made a
claim, never that a physical object matches it. See
`docs/adr/0003-identity-is-not-authenticity.md`.

**It will not fake a reviewer.** Independent review means CodeQL, dependency
review, secret scanning and a human reading the diff. A second pass by the same
author is posted as a self-review and never recorded as an approval.
