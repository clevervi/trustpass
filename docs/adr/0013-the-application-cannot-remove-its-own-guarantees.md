# 0013. The application cannot remove its own guarantees

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

Every guarantee this project makes lives in Postgres. ADR 0005 put it there on
purpose, and its migration argued the case in one sentence:

> the application connects as the owner, and the owner can grant itself any
> privilege back.

That sentence was written as a reason to distrust application-level checks. Read
again it is also a description of what the database-level ones are worth,
because the same credential that cannot be stopped from re-granting itself a
privilege cannot be stopped from removing a trigger either.

Measured before deciding anything, against the running database:

```
trustpass: superuser=t createdb=t createrole=t replication=t bypassrls=t
trustpass owns 8 of 8 tables, 8 of 8 sequences, 7 of 7 functions
PUBLIC holds CONNECT and TEMP on the database (default, never revoked)
```

Five cluster-level attributes, not the two the issue recorded. `replication`
alone lets that credential stream the entire cluster out without reading a
single table through SQL.

The `0023` rehearsal ran seven attacks against a purpose-made role and all seven
were refused, which was reported at the time as evidence the model held. It was
not: the role in that rehearsal was invented for the rehearsal. Two of the seven
— dropping a trigger, dropping a table — succeed with the credential the API
actually uses.

And the cheapest attack was not in those seven at all:

```sql
ALTER TABLE lifecycle_event DISABLE TRIGGER lifecycle_event_no_update;
```

One statement. No `DROP`. Afterwards the trigger is still listed in `pg_trigger`
and every check in this repository that asks "is the guard present" answers yes.
Only `tgenabled` moved.

So TP001 through TP005, the deferred provenance check, the append-only history
and the append-only authority were all resting on the same assumption: that
nobody with the application's credential would try. That is not defence in
depth. That is one layer, described twice.

## Decision

**Three roles, and the application is never the owner of anything.**

```
trustpass_owner      owns every object            NOLOGIN
trustpass_migration  DDL, by membership in owner  LOGIN, deploy only
trustpass_runtime    the application              LOGIN, no DDL, enumerated
```

`trustpass` stays superuser and stays the operator's way in. The boundary this
draws is between the *application* and the record, which is the boundary an
attacker crosses over HTTP.

**Every grant is named.** The rehearsal used `GRANT SELECT, INSERT, UPDATE ON
ALL TABLES`, which has the defect `0023` refused in `DROP TABLE ... CASCADE`: it
acts on things without naming them, so a reviewer cannot say what it did. It is
also wrong. Measured across every repository and service in the codebase:

```
.insert()  ->  product, lifecycle_event.  Nothing else.
.update()  ->  product.                   Nothing else.
.delete()  ->  nothing at all, anywhere.
```

| Table | Runtime |
| --- | --- |
| `product` | SELECT, INSERT, UPDATE |
| `lifecycle_event` | SELECT, INSERT |
| everything else | SELECT |
| any table | never DELETE, TRUNCATE, REFERENCES or TRIGGER |

`lifecycle_event` is the row to look at. The append-only trigger already refuses
an UPDATE with TP002, so withholding the privilege looks redundant — and that is
the whole idea. The trigger is what an attacker who reaches the owner turns off.
The missing privilege is what still says no afterwards, and it says it before
any trigger is consulted, because Postgres checks the privilege at execution
start. The same attack that ADR 0005 answered with TP002 is now answered with
`42501`, from a layer that cannot be disabled by the layer below it.

**No default privileges granting anything to the runtime.** A new table gets no
access until a migration names it, and
`least-privilege.integration.test.ts` fails on a table it has never heard of.
The failure is the point: it is a decision waiting to be made about what the
application may do with that table, and the alternative is a privilege arriving
because somebody inherited a default.

**The privilege model is asserted from the runtime's own connection, in CI.** A
matrix over the catalogue, thirty-one assertions, all thirteen of its
guarantees mutation-checked. The question it exists to answer is not "was this
correct the day it was written" but **"can a future migration turn the runtime
back into an owner without a test going red"**.

## What this ADR does not decide

**It does not demote `trustpass`.** An operator holding a superuser password is
a different threat with a different answer, and the answer is the one #122 is
about: a backup somebody has actually restored.

**It does not separate `migration` from `owner` in privilege, only in
credential.** In Postgres only an object's owner may alter or drop it, so a
migration role must be able to become the owner — and a member can `SET ROLE` at
will. Compromising `trustpass_migration` is compromising `trustpass_owner`, and
this ADR says so rather than claiming a blast radius it does not have. What the
split does buy: the owner has no password to leak and no way to log in, and DDL
has a credential that a deploy holds and the application never does.

**It does not address row-level security.** Nothing uses RLS today, which is why
`rolbypassrls` is currently moot — and why it is asserted false anyway, so that
the day RLS arrives it is not silently doing nothing.

**It does not stop an operator's mistake.** Found while mutation-checking this:
an `ALTER TABLE ... OWNER TO` destroys the grants held by the role becoming the
owner, with no error and no warning. The audit test catches it after the fact.
Nothing prevents it.

## Consequences

- A new table needs a `GRANT` written into its migration and a line in the
  `EXPECTED` matrix. Forgetting either is a red test, not a silent grant and not
  a production outage.
- `pnpm db:provision` becomes part of standing up an environment, and two
  secrets join the deployment: `TRUSTPASS_RUNTIME_PASSWORD` and
  `TRUSTPASS_MIGRATION_PASSWORD`. Neither is ever committed — the migration
  creates all three roles NOLOGIN and without a password for that reason.
- **Nothing takes effect until `DATABASE_URL` names `trustpass_runtime`.** A
  migration cannot edit an environment file. Until an operator makes that
  change, this is a model with nobody standing in it, and the provisioning
  script says so in its own output rather than letting anyone believe otherwise.

  *Amended by TP-166 (#126).* That sentence described a guarantee whose
  enforcement was a person remembering one line, which is not a guarantee. The
  API now asks Postgres what it is connected as and refuses to start on a
  connection that can dismantle its own protections — see
  `packages/db/src/connection-privileges.ts`. Forgetting the line is now a
  failed deploy rather than a silent loss of every guarantee above.

  Writing that check produced one correction to this ADR's own reasoning. The
  five role attributes plus "owns nothing" — the obvious test, and the one
  proposed in review — passes `trustpass_migration`, measured:

  ```
  role                 attributes clear   owns directly   reachable
  trustpass_migration  yes                0               25
  trustpass_runtime    yes                0               0
  ```

  A role with nothing of its own and the owner's rights over everything. The
  question that separates them is not what the connection owns but **what it
  holds the owner's rights over**, which `pg_has_role(..., 'MEMBER')` answers in
  one clause and which subsumes ownership, because a role is a member of itself.

  *Corrected by TP-167 (#128).* Two things in the paragraph above were wrong
  when first written, and both were found by testing a review's objection
  rather than accepting or dismissing it.

  The inventory was incomplete. It counted `pg_class` in `public` — tables,
  sequences, views — which is 16 objects and leaves out the seven trigger
  functions, the `lifecycle_actor_kind` enum, and `drizzle.__drizzle_migrations`.
  A role able to become the owner of a trigger function and nothing else scored
  zero and the API started on it, while `CREATE OR REPLACE FUNCTION` on an
  append-only guard is the attack this migration's own header names as the
  quiet one. The count is 25 now, over `pg_class`, `pg_proc` and `pg_type` in
  every non-system schema.

  And the phrase "what it can become" was the wrong description. Review
  proposed `pg_has_role(..., 'SET')` on the reading that `SET` is the privilege
  meaning "can issue `SET ROLE`", which the documentation supports and which
  would open a hole. Measured on Postgres 18:

  ```
  GRANT trustpass_owner TO probe WITH INHERIT TRUE, SET FALSE

  role     MEMBER   SET   USAGE (inherits privileges)
  probe    t        f     t
  ```

  Connected as that role, without ever issuing `SET ROLE`:

  ```
  ALTER TABLE lifecycle_event DISABLE TRIGGER lifecycle_event_no_update;
  -> ALTER TABLE.  guard_on: 0.  still listed in pg_trigger: 1.
  ```

  A `SET`-based count reads zero for it. So the question is deliberately *not*
  what the connection can become: **inheritance reaches the same privileges
  without `SET ROLE` ever being called.** `MEMBER` is `USAGE OR SET` and covers
  both paths.
- The integration suite keeps running as the superuser, because it creates and
  cleans fixtures. Only the least-privilege suite connects as the runtime, which
  is correct: it is the only one asking what the application can do.

## Alternatives rejected

**Leave it, and rely on the triggers.** The position ADR 0005 took by omission.
Rejected on the measurement above: two of the rehearsal's seven attacks succeed
with the real credential, and the cheapest attack of all was not in the seven.

**`ALTER DEFAULT PRIVILEGES ... GRANT ... TO trustpass_runtime`.** One line,
saves a line per future table, and undoes the enumeration this whole decision is
made of — a table added tomorrow would become readable by the application
without anyone deciding that it should.

**`REASSIGN OWNED BY trustpass TO trustpass_owner`.** One line instead of
twenty-five, and the wrong line for the reason `0023` gave about CASCADE: it
moves whatever the role happens to own, including the database itself and
anything an operator created by hand, and the diff does not say what moved.

**Grant the runtime `USAGE` on sequences.** The rehearsal did. It is unnecessary
here: every `id` is `GENERATED ALWAYS AS IDENTITY`, not `serial`, and an
identity column's sequence advances without consulting the caller's privileges.
Asserted rather than assumed — the runtime was granted none, and the suite
inserts a product as the runtime to prove it.

**`NOINHERIT` on `trustpass_migration`.** Considered, so that owner privileges
needed an explicit `SET ROLE`. Dropped because `ALTER ROLE ... IN DATABASE ...
SET role = trustpass_owner` already makes every migration session become the
owner on connect — which is what stops a future table being created with the
wrong owner — and nobody could state what `NOINHERIT` would add on top of it.
