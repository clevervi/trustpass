## What changed

<!-- One paragraph. What does this PR do? -->

## Why

<!-- Link the backlog item: Closes TP-0XX -->

Closes TP-

## Acceptance criteria

<!-- Copy the criteria from the issue and tick what this PR satisfies. -->

- [ ]
- [ ]

## Tests

<!-- What did you add or change? How would this break loudly if the logic regressed? -->

## Security impact

<!-- Auth, permissions, data exposure, new dependency, new external call.
     Write "None" only after actually checking. -->

## Breaking changes

<!-- API shape, database schema, environment variables. "None" if none. -->

## Screenshots

<!-- UI changes only. Delete this section otherwise. -->

---

## Argued review

<!-- Both accounts are one maintainer, so this is a counter-argument, not a
     second reader. Post the case under the account that authored the commits
     and the objection under the other one, and say so in the first comment.
     Neither may approve: `no-self-approval.yml` is a required check and fails
     if either does. -->

- [ ] The case is posted: why this design, which option was rejected, what it
      would have cost
- [ ] The objection is posted under the other account — or it is stated plainly
      that the change was simple enough not to need one
- [ ] Every objection is answered: the design changed, the answer is written
      down, or it is an accepted limitation with an issue behind it

- [ ] CI is green
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass locally
- [ ] `pnpm-lock.yaml` is committed if any dependency changed — a local run
      passes against an already-populated `node_modules`, CI does not
- [ ] No secrets, keys or production data in the diff
- [ ] Documentation updated if behaviour changed
