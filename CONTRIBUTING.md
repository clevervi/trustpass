# Contributing to TrustPass

This project is run as if a team depended on it, because the habits are the
point. Nothing here is decoration.

## Branching — Gitflow

```
main                      always deployable, tagged releases only
  └── develop             integration branch, always green
        └── feature/TP-023-product-registration
        └── fix/TP-024-duplicate-serial
        └── security/TP-101-access-control
```

Rules:

- `main` and `develop` are never committed to directly. Every change arrives via
  pull request.
- Branch names carry the backlog ID: `<type>/TP-0XX-short-slug`.
- Branch types: `feature/`, `fix/`, `security/`, `chore/`, `docs/`.
- Branch from `develop`. Merge back into `develop`.
- `develop` merges into `main` only as a release.

## Commits — Conventional Commits

```
<type>(<scope>): <imperative summary>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `security`.

Scopes follow the epic: `identity`, `passport`, `warranty`, `lifecycle`,
`ownership`, `verification`, `contracts`, `api`, `web`, `db`, `ci`, `security`.

```
feat(identity): add product registration endpoint
fix(warranty): reject claims filed after the coverage window
test(contracts): add ownership transfer invariants
security(auth): restrict lifecycle events to the issuing role
```

One commit should be one reviewable unit of work. If the summary needs an "and",
it is two commits.

## Definition of Ready

An issue may only move to `READY` when it has:

- A clear objective and a bounded scope
- Written acceptance criteria
- Identified dependencies
- Identified component and epic
- An assessed risk level
- A size estimate

## Definition of Done

"It works on my machine" is not done. Done means:

- Code implemented
- Tests covering the behaviour, including the failure path
- Errors handled, not swallowed
- Logs adequate for diagnosing a production incident
- Documentation updated when behaviour changed
- Security impact assessed and written in the PR
- CI green
- PR reviewed and approved

For smart contracts, add:

- Unit tests
- Fuzz tests where inputs are unbounded
- Invariant tests where state must hold across operations
- Slither with no blocking findings
- Administrative functions documented
- Events defined for every state change

## Before you open a PR

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All four must pass locally. CI runs the same commands plus a secret scan over
the full history, so pushing a key is caught before review, not after.

## Priority and risk labels

| Priority | Meaning                                  |
| -------- | ---------------------------------------- |
| `p0`     | Blocks the MVP                           |
| `p1`     | Needed for a functional release          |
| `p2`     | Important, can wait                      |
| `p3`     | Future                                   |

| Risk       | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| `low`      | Local blast radius, easily reverted                  |
| `medium`   | Crosses a module boundary                            |
| `high`     | Touches auth, money, personal data or product truth  |
| `critical` | A mistake here corrupts the trust model itself       |

## Architecture decisions

Any decision that is expensive to reverse gets an ADR in
[`docs/adr/`](docs/adr/). Write it when the decision is made, not afterwards
from memory.
