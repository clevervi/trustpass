# 0001. TypeScript end to end, Python deferred

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

The original plan paired a FastAPI backend with a Next.js frontend. That split
is reasonable with a team: Python owns data work, TypeScript owns the browser.

This project does not have a team that size. At its scale the split costs two
language runtimes, two dependency managers, two test runners, two CI matrices,
and — the expensive part — two definitions of every domain model. A `Product`
declared in Pydantic and again in TypeScript drifts the first week nobody is
looking.

The blockchain layer planned for later (Foundry, viem, wagmi) lives in the
TypeScript ecosystem regardless.

The fraud and anomaly engine planned for later is genuinely better served by
Python, but it cannot be built before there is data to analyse, which is several
milestones away.

## Decision

Build the platform in TypeScript end to end:

- `apps/web` — Next.js 16, App Router
- `apps/api` — Hono, with OpenAPI generated from the same Zod schemas used for
  runtime validation
- `packages/db` — Drizzle ORM over Postgres, the single source of truth for
  domain types

Introduce a Python service only when the fraud engine exists, as a separate
process behind the same API boundary. Deferring it costs nothing, because the
seam is an HTTP boundary either way.

## Consequences

- A domain model is declared once and inferred everywhere. Schema changes surface
  as type errors instead of runtime mismatches.
- One toolchain: pnpm, Biome, Vitest, one CI pipeline.
- Request validation and API documentation come from the same Zod schema, so the
  published contract cannot silently drift from the enforced one.
- Python is unavailable for data work until the fraud service is introduced. If
  heavy analysis is needed sooner than expected, the cost is standing up that
  service early — not rewriting the platform.
