# Backup and restore

A backup is a file. Whether it restores is a different question, and the only
way to answer it is to restore one.

```bash
pnpm db:backup            # take a backup
pnpm db:restore-drill     # take one, restore it into an empty database, and check
```

## Three files, not one

`pg_dump` writes a database. Two things that TrustPass depends on are not in it,
and both were found by running the drill rather than by reading about it.

| File | What it carries | Why `pg_dump` does not |
| --- | --- | --- |
| `trustpass.dump` | schema, data, ownership, table grants | — |
| `roles.sql` | `trustpass_owner`, `trustpass_migration`, `trustpass_runtime`, their attributes and memberships | Roles are cluster-level, not database objects |
| `database-acl.sql` | the database's own privileges | Database-level ACLs need `--create`, which also fixes the database name |

**Restoring without `roles.sql`** lands in a cluster where the GRANT statements
name roles that do not exist. Either the restore fails, or it succeeds into a
database where nothing enforces the boundary ADR 0013 built.

**Restoring without `database-acl.sql`** is quieter and was the one that nearly
got through. `createdb` produces the Postgres default, which gives **PUBLIC
`CONNECT` and `TEMPORARY`** — and migration `0024` had revoked exactly that. The
first drill restored all 4,280 products, compared every catalogue count, and
passed. The least-privilege suite, pointed at the restored database, then failed
on `cannot create anything in the schema`.

That is the whole argument of this procedure in one sentence: **the data came
back and the posture did not, and only running the real suite against the real
restore said so.**

## Taking a backup

```bash
pnpm db:backup .backups/2026-09-18
```

Writes the three files and a `manifest.json` with the size and SHA-256 of each.
The hashes are not decoration — the drill recomputes them before trusting the
files, because a truncated dump is a file of the right name that restores into
half a database.

## Restoring

```bash
# 1. Roles first. They are cluster-level; skip this on a cluster that has them.
docker exec -i trustpass-postgres psql -U postgres < roles.sql

# 2. An empty database. Never migrated — see below.
docker exec trustpass-postgres createdb -U trustpass trustpass_restored

# 3. The data.
docker cp trustpass.dump trustpass-postgres:/tmp/restore.dump
docker exec trustpass-postgres pg_restore -U trustpass -d trustpass_restored \
  --exit-on-error /tmp/restore.dump

# 4. The database's own privileges. Substitute the name.
sed 's/@DATABASE@/trustpass_restored/g' database-acl.sql \
  | docker exec -i trustpass-postgres psql -U trustpass -d postgres

# 5. Passwords, which are not in any backup by design.
TRUSTPASS_RUNTIME_PASSWORD=... TRUSTPASS_MIGRATION_PASSWORD=... pnpm db:provision
```

**Every command above uses the operator's superuser credential, and none of them
is the application's.** Restoring needs to create a database, own objects and
grant privileges; running TrustPass needs none of that. When the restored
database goes into service, `DATABASE_URL` names `trustpass_runtime` — and if it
does not, the API refuses to start and says why (ADR 0013, TP-166). The
superuser is how an operator reaches this database, never how the product does.

**Never run `pnpm db:migrate` against the restored database.** Migrations
rebuild a schema; they do not recover anything. A drill that migrates proves the
migrations work — which is already known, and is not the question. The drill
asserts the target is empty immediately before the restore for exactly this
reason: everything present afterwards came out of the backup.

**`--no-owner` is not used.** It makes a restore quieter by discarding ownership,
and ownership is precisely what ADR 0013 rests on.

## What the drill checks

31 checks, all against a real restore of the live database.

- The backup files match their recorded hashes, and `pg_restore --list` can
  describe the dump.
- `roles.sql` can recreate all three roles.
- The target database was empty before the restore.
- Tables, functions, **enabled** triggers, constraints, indexes and every enum
  value match the source. Enabled, because a trigger restored in a disabled
  state sits in `pg_trigger` looking present and enforces nothing.
- Row counts match on all eight tables.
- A real TrustPass ID resolves with its party, its verification state and its
  event count.
- Every object is owned by `trustpass_owner`; the runtime grant matrix is
  identical; the roles carry the same attributes; the database ACL matches.

Then, separately, because a script asserting about itself is weaker than the
suite that guards the boundary every day:

```bash
RUNTIME_DATABASE_URL=postgresql://trustpass_runtime:<password>@localhost:5433/trustpass_restored \
DATABASE_URL=postgresql://trustpass:<password>@localhost:5433/trustpass_restored \
  pnpm --filter @trustpass/db test -- src/schema/least-privilege src/connection-privileges
```

53 tests, connecting as `trustpass_runtime` to the restored database.

## The evidence

Each drill writes `restore-report.json` beside the backup: when it ran, the
backup's hashes, every check with its source and restored values, and
`migration_executed: false`. It is recorded rather than asserted because a
report that does not say so invites the assumption.

## What this does not cover

- **A different cluster.** Everything here restores into the same Postgres, so
  `roles.sql` is verified by content rather than by being applied to a cluster
  that lacks the roles. Restoring onto fresh hardware is the case this procedure
  describes and has not rehearsed.
- **Scheduling *backups*, retention, offsite storage and point-in-time
  recovery.** Nothing is deployed, so a backup schedule would be a schedule for
  nothing. What was missing was the procedure and the proof it works.

  **The *drill* is scheduled, and that is a different thing.**
  [`.github/workflows/restore-drill.yml`](../../.github/workflows/restore-drill.yml)
  runs it weekly, on a push to `main` and on demand, publishing
  `restore-report.json` as a build artefact so a claim about a drill can be
  checked without rerunning it. #140, and the reason it is separate: a rehearsal
  that runs when somebody remembers is the same kind of claim as a backup nobody
  restored.

  It starts its own container rather than using a service one, because
  `pg_dump` refuses to dump a server newer than itself and the tools have to
  come from inside the server's own image. The version is written in that
  workflow rather than inherited from the runner.
- **Timing.** The drill records when it started and finished; no RTO or RPO is
  claimed, because a number measured once on a developer's laptop is not one.
