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

| Risk              | Merges when                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `low`, `medium`   | Every independent gate is green                                          |
| `high`, `critical` | Every independent gate is green, **and** the self-review bar below is met |

The maintainer has delegated merging at every risk level to whoever authors the
change. There is no second reader, and this document does not pretend there is.
What replaces one is a bar the author has to clear in public, on the pull
request, where anyone can check it was cleared.

**The self-review bar for `high` and `critical`:**

1. **Every guard that protects something is mutation-checked.** Break it on
   purpose — remove the check, loosen the constraint, add the forbidden field —
   run the tests, see them fail, restore it. A test that has never failed has not
   been shown to test anything.
2. **The mutations and their results are listed in the pull request body.** Not
   summarised as "tested thoroughly": which guard, what was broken, how many
   tests went red.
3. **An inline self-review is posted** on the lines worth disagreeing with,
   labelled as a self-review and never recorded as an approval.
4. **Review threads are resolved** before merging. Branch protection enforces it.

This is weaker than an independent reader, and saying so is the point. A mutation
check proves a test can fail; it cannot prove the author tested the right thing.
The bar makes the author's reasoning inspectable, which is the most a single
author can honestly offer.

### A pull request whose commits are not yours is rebase-merged

The default is a squash merge. **Squashing erases authorship**: GitHub
attributes the squashed commit to whoever pressed merge, not to whoever wrote
the code. Measured rather than assumed — three commits authored by the second
account went in under #70 and the contributor count did not move.

So when a pull request carries commits authored by a different account, merge it
with **rebase**, which keeps each commit and its author while still producing a
linear history. Squash the rest.

This repository has one maintainer working from two accounts, and the history
should say which one wrote what. Losing that to a merge strategy is a small lie
told by a default.

### Every guard ships with a test that dies without it

**Adding a check, a constraint, a type guard or a trigger means adding a test
whose failure depends on that specific condition.** Not a test that happens to
exercise the code around it — one that goes red when the guard is removed and
green when it is restored.

This is written down because it is the mistake that keeps recurring here, three
times in one week:

| Guard | How it was caught |
| --- | --- |
| The QR quiet zone | The test derived its bound from the value under test, so it passed with no margin at all (#40) |
| `FOR UPDATE` on a status change | Removing the lock left every test green; the calls serialise on their own (#57) |
| `isHistory` in the passport fetch | Guard added, no test written; removing it changed nothing (#61) |

Each was found by breaking the guard on purpose, never by the suite. **The
protection kept arriving before the proof of the protection**, and a guard with
no test that can fail is indistinguishable from no guard at all — except that it
reads like safety, which is worse.

The order that avoids it: write the failing case first, add the guard, watch it
pass, then remove the guard and watch it fail again.

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
2. Bump `version` in the root manifest and in every workspace package, on
   `develop`, before the release pull request. The API serves its own version
   from its manifest, so skipping this ships a service that reports the previous
   release while running the new one. Bump the README's version badge in the
   same commit — every version printed anywhere becomes a false claim the moment
   it is left behind, and the badge is the one a reader sees first.
3. Open a pull request from `develop` into `main`, titled `release: vX.Y.Z`.
4. Merge it with a **merge commit**, not a squash. The individual changes already
   have their own history and flattening it here destroys the trail from a
   released version back to the pull request that introduced a line.
5. Tag `main`:

   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z — <what this release makes possible>"
   git push origin vX.Y.Z
   ```

6. Publish release notes from the tag, grouped by the conventional-commit type.

Versioning follows semver against the **public contract** — the HTTP API, the
TrustPass ID format, and the database schema. Internal refactors are patch
releases no matter how large the diff.

A tag is a claim that a version works. Cut it only after the artefact has been
run, not merely built: `v0.1.0` was tagged once, found broken on first
execution, and re-cut. That was free because it had not been pushed. After a
push it is not free, because other people's checkouts already believe it.

### A `TP-` identifier has to resolve to something

Two were found pointing at nothing, both by hand: `TP-130`, cited for secure
tags and present nowhere else, and `TP-111`, referenced by
`packages/db/src/schema/product.ts` and owned by no issue at all — so the code
was deferring a decision to an identifier that tracked nothing. It now has one
(#89).

> **A `TP-` identifier in code, an ADR, a release note or this file must resolve
> to an issue or to a roadmap entry. `docs/ROADMAP.md` itself may name unstarted
> work, because that is what a roadmap is for.**

To check:

```bash
rg -o 'TP-[0-9]{3}' --glob '!node_modules' . | sed 's/.*://' | sort -u > /tmp/used
gh issue list --state all --limit 300 --json title -q '.[].title'   | rg -o 'TP-[0-9]{3}' | sort -u > /tmp/issued
comm -23 /tmp/used /tmp/issued   # each result must appear in docs/ROADMAP.md
```

**Deliberately not a CI gate, and the reason is measured rather than assumed.**
42 identifiers are referenced; 25 have an issue. Nearly all of the remainder are
future roadmap entries, which are legitimate — requiring an issue for each would
contradict the Definition of Ready, whose whole point is that an issue carries
acceptance criteria rather than a placeholder. The roadmap also writes ranges,
so `TP-050` … `TP-053` assigns two identifiers it never spells out, and a check
comparing literal strings fails on correct references.

A gate that cries wolf gets ignored, and an ignored gate is worse than a command
somebody runs when they touch an identifier. That is the trade made here; the
migration drift check is a gate because it has no equivalent false positive.

### The README's status block is a claim like any other

`README.md` says what works and what does not. It is the first thing a reader
sees and the last thing anyone remembers to update, and it has already been
wrong: it listed lifecycle events under "not built yet" while they were
recorded, enforced by nine triggers and rendered on the public passport (#87).

So before cutting a release, and whenever a milestone's worth of work has
merged:

- Read the status block against the code rather than against memory. Every entry
  on the "not built yet" list asserts that something is absent, and absence is
  checkable — grep for it, look for the table, open the page.
- Check the whole block, not the line somebody complained about. A fix that
  corrects one sentence and leaves four unverified has not been done.
- Move what shipped into `CHANGELOG.md`'s `Unreleased` in the same pass. The
  rule that later work belongs there already exists; it is the following of it
  that lapses.
- Never write a number that rots. "`develop` is 36 commits ahead" is false by
  the next merge. "`develop` is ahead of it" stays true.

This project spends its credibility on saying what is known and what nobody has
checked. Being wrong about what it has built is the cheapest available way to
lose that, and it costs one reader.

## Migrations

```bash
pnpm db:generate     # after changing a schema file
pnpm db:migrate      # apply pending migrations
pnpm db:reset        # destroy the local volume and rebuild from zero
```

Name every migration: `drizzle-kit generate --name=create_product`. The
generator's default is a random two-word phrase, which tells a future reader
nothing.

**Migrations are forward-only.** Drizzle emits no down script and none is
written by hand. Rolling a schema change backwards in production loses whatever
the new shape recorded, so the recovery path is a restore plus a new forward
migration — a down script would imply an undo that does not exist. Consequently:

- Prefer additive changes. Add a column, backfill it, then stop using the old
  one, in separate migrations.
- A destructive change gets its own migration and its own pull request, so the
  diff that drops data is the whole diff.
- Never edit a migration that has been merged. It has already run somewhere.

### The snapshot has to keep up, and CI checks that it does

`drizzle-kit` keeps its own picture of the schema in
`packages/db/drizzle/meta/NNNN_snapshot.json`, and refreshes it **only when
drizzle-kit itself generates a migration**. A hand-written one — which is most
of them here, because triggers, deferred constraint triggers and partial indexes
are not things the generator can express — leaves that picture describing a
database that no longer exists.

It drifted unnoticed from `0011` to `0016` and surfaced as a generated migration
that fails against *every* database, a freshly reset one included, because it
offered to re-add what earlier migrations already create.

So after hand-writing a migration:

```bash
pnpm db:generate     # expect: No schema changes, nothing to migrate
```

If it produces a file, the schema and the migrations disagree: either a change
never got a migration, or the hand-written one left the snapshot behind. The fix
for the second is to let `generate` write the migration, then replace its body
with an explanation of why it is empty — `0017` is the worked example.
`--custom` looks like the right tool and is not; it copies the previous snapshot
forward and the drift survives.

CI runs the same check, so this is caught in the pull request that causes it.

**What a green check means, and what it does not.** The generator only sees what
it can express. Nine triggers, five trigger functions and two deferrable
constraints carry every guarantee this database makes, and **no snapshot has
ever contained one of them** — measured, not assumed. A green drift check means
*the part of the schema drizzle-kit can represent is not stale*. It says nothing
about the triggers in `0005`, `0008`, `0010`, `0014`, `0015` and `0016`. Those
are covered by the integration suite against a real Postgres, which is a
separate job for exactly this reason.

**`DROP SCHEMA public CASCADE` is not a reset.** Drizzle records applied
migrations in a separate `drizzle` schema, which survives, so the next
`db:migrate` skips everything and leaves an empty database that believes it is
up to date. `pnpm db:reset` removes the volume, which is the only complete
answer.

## Architecture decisions

Any decision that is expensive to reverse gets an ADR in
[`docs/adr/`](docs/adr/). Write it when the decision is made, not afterwards
from memory.
