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
the commits you are adding, so pushing a key is caught before review rather than
after. A separate weekly job sweeps the entire history, because a per-change scan
says nothing about a key that is already in it.

## Who reviews, and what that review is worth

Every change goes through a pull request, and branch protection enforces it. But
a pull request is only a gate if something actually looks at it, so it is worth
being precise about what does.

**Genuinely independent.** These have no stake in the change and no memory of
writing it:

| Gate                      | Looks for                                             |
| ------------------------- | ----------------------------------------------------- |
| Lint, typecheck and build | Contract and style violations                         |
| Test against Postgres     | Behaviour, including the integration path             |
| Secret scan               | Credentials introduced by this change                 |
| Full secret scan          | Credentials anywhere in history — weekly, not per change |
| CodeQL                    | Security and quality defects, refreshed weekly        |
| Dependency review         | New dependencies with known vulnerabilities or copyleft licences |

**Not independent.** A second pass over a diff by whoever wrote it is the same
judgement running twice. It catches real things and is worth doing — two defects
in the issuer model were found that way — but it is not a second opinion, and it
must never be recorded as an approval. It goes in as review comments, labelled
as a self-review.

A second account belonging to the same person does not change this. The
mechanism would pass; the review would not have happened.

**Merge policy by risk label:**

| Risk                       | Merges when                                          |
| -------------------------- | ---------------------------------------------------- |
| `low`, `medium`            | Every independent gate is green                       |
| `high`, `critical`         | A human has read the diff and said so                 |

The split is deliberate. Waiting on a human for a dependency bump wastes the
gate on something the automation already covers. Waiting on one before changing
how trust is established is the entire point of having a gate.

## Break-glass

`main` and `develop` are protected, and the protection applies to
administrators too. That is deliberate: on a repository with a single
maintainer, a rule that the owner can silently step around is not a rule.

There is still an escape hatch, and it is meant to be an inconvenient one:

1. Disable the protection rule for the branch, in the repository settings.
2. Make the change.
3. Re-enable the protection.
4. Open an issue recording what was bypassed, why, and what would have to be
   true for it not to happen again.

Step 4 is the part that matters. A bypass that nobody wrote down is how a
process quietly stops existing.

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

## Releases

`develop` is always green. `main` is always deployable. A release is the act of
moving one into the other, and it is the only time `main` changes.

1. Confirm the milestone is closed: every issue in it is done, and CI on
   `develop` is green.
2. Open a pull request from `develop` into `main`, titled `release: vX.Y.Z`.
3. Merge it with a **merge commit**, not a squash. The individual changes already
   have their own history and flattening it here destroys the trail from a
   released version back to the pull request that introduced a line.
4. Tag `main`:

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z — <what this release makes possible>"
   git push origin vX.Y.Z
   ```

5. Publish release notes from the tag, grouped by the conventional-commit type.

Versioning follows semver against the **public contract** — the HTTP API, the
TrustPass ID format, and the database schema. Internal refactors are patch
releases no matter how large the diff.

A tag is a claim that a version works. Cut it only after the artefact has been
run, not merely built: `v0.1.0` was tagged once, found broken on first
execution, and re-cut. That was free because it had not been pushed. After a
push it is not free, because other people's checkouts already believe it.

## Architecture decisions

Any decision that is expensive to reverse gets an ADR in
[`docs/adr/`](docs/adr/). Write it when the decision is made, not afterwards
from memory.
