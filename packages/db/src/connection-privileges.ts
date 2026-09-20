import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/**
 * What the connection this process holds is able to do to the database.
 *
 * ADR 0013 built a runtime role that cannot remove the guarantees it operates
 * under, and said plainly what it could not do:
 *
 *   "Nothing takes effect until DATABASE_URL names trustpass_runtime. A
 *    migration cannot edit an environment file."
 *
 * Which leaves the whole thing resting on somebody remembering one line in a
 * deploy. Forget it and the API starts as `trustpass` — superuser, owner of
 * every table — and nothing anywhere says so. The service starts, health
 * passes, passports resolve, and the append-only history is one statement away
 * from editable. The first evidence would be a record that changed.
 *
 * So the process asks, and refuses to run if the answer is wrong.
 *
 * **What this is, precisely: a startup barrier, not a continuous guarantee.**
 * It asks once, on one pooled connection, before anything is served. A
 * membership granted at 10:20 against a process that started at 10:05 is not
 * detected, and neither is a pooler that hands out sessions belonging to
 * different roles. The property provided is *"the connection was in the right
 * posture when the application started"*, which defends against a misconfigured
 * deployment and not against a compromised administrator.
 *
 * Re-asking per request was considered and rejected: it costs a round trip on
 * every request to detect something the role model in ADR 0013 already
 * prevents, and the role model is the defence. This is the check that the role
 * model is the one being used.
 */

export interface ConnectionPrivileges {
  /** `current_user`, which is the effective role, not the one in the URL. */
  role: string;
  superuser: boolean;
  createDatabase: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRowLevelSecurity: boolean;
  /**
   * Objects this role holds the owner's rights over — by owning them, or by
   * being a member of a role that does.
   *
   * **This is the field that matters, and it is not the obvious one.** A check
   * built from the five attributes above plus "owns nothing" passes
   * `trustpass_migration`, measured:
   *
   *   role                 five flags clean   owns directly   reachable
   *   trustpass            no                 0               35
   *   trustpass_migration  YES                0               25
   *   trustpass_owner      yes                25              25
   *   trustpass_runtime    yes                0               0
   *
   * `trustpass_migration` carries no attribute and owns nothing of its own,
   * and holds the owner's rights over everything through one GRANT.
   *
   * **Why `MEMBER` and not `SET`.** Review proposed `SET`, on the reading that
   * `SET` is the privilege meaning "can issue `SET ROLE`" — which the Postgres
   * documentation supports, and which would open a hole here. Measured on
   * Postgres 18 with `GRANT trustpass_owner TO probe WITH INHERIT TRUE, SET
   * FALSE`:
   *
   *   role               MEMBER   SET   USAGE (inherits privileges)
   *   tp_probe_inherit   t        f     t
   *
   * Connected as that role, never issuing `SET ROLE`:
   *
   *   ALTER TABLE lifecycle_event DISABLE TRIGGER lifecycle_event_no_update;
   *   -> ALTER TABLE.  guard_on: 0.  still listed in pg_trigger: 1.
   *
   * A `SET`-based count reads `0` for it and starts the application. So the
   * question is deliberately not "can this connection become that role" —
   * inheritance reaches the same privileges without `SET ROLE` ever being
   * called.
   *
   * **`MEMBER` is not `USAGE OR SET`, and an earlier version of this comment
   * said it was.** It is strictly broader: it reports membership whatever that
   * membership confers. Measured:
   *
   *   GRANT owner TO member WITH INHERIT FALSE, SET FALSE
   *
   *   MEMBER   USAGE   SET
   *   t        f       f
   *
   * So this count can refuse a connection whose membership grants it nothing.
   * That false positive is accepted on purpose: in a fail-closed barrier it is
   * the direction to be wrong in, and it means no shape of `GRANT ... TO ...
   * WITH` can arrive later and slip past the inventory. The guard is
   * deliberately conservative rather than exact, and a role being a member of
   * itself folds plain ownership in as well.
   */
  reachableOwnership: number;
  /**
   * Entries of `FORBIDDEN_PRIVILEGES` this role actually holds, described the
   * way somebody has to act on them.
   *
   * Empty on a correctly migrated database. A missing table lands here too,
   * rather than throwing: an API pointed at a database with no schema should
   * refuse for a reason that names the table, not with a query error.
   */
  forbiddenHeld: readonly string[];
}

/**
 * Privileges the migrations deliberately do not grant, named one by one.
 *
 * The five attributes and `reachableOwnership` answer *"can this connection
 * dismantle the guarantees?"*. They never ask what it may **do**, and a role
 * that owns nothing while holding `UPDATE ON TABLE product` passes every one of
 * them — which is the posture this application was in before `0027`, and the
 * posture any environment is in where `0027` has not been applied.
 *
 * So this is the other question, and it is asked of the catalogue rather than
 * inferred from a migration having supposedly run. Six entries rather than the
 * whole grant matrix: each one is a capability that, on its own, undoes
 * something a reader of this repository is told is guaranteed.
 *
 * The full matrix lives in `least-privilege.integration.test.ts` and is checked
 * there against a real database. This is the subset worth refusing to start
 * over, and duplicating six lines is the cost of the application being able to
 * check them without a test runner.
 */
export const FORBIDDEN_PRIVILEGES: readonly {
  readonly relation: string;
  readonly privilege: string;
  /** Set when the grant is column-level, per `0027`. */
  readonly column?: string;
  readonly because: string;
}[] = [
  {
    relation: "product",
    privilege: "UPDATE",
    because: "the runtime updates two columns, not the table (0027)",
  },
  {
    relation: "product",
    privilege: "UPDATE",
    column: "serial",
    because: "a serial is what a passport is matched against",
  },
  {
    relation: "product",
    privilege: "UPDATE",
    column: "trustpass_id",
    because: "a printed label depends on it (ADR 0004)",
  },
  {
    relation: "lifecycle_event",
    privilege: "UPDATE",
    because: "history is append-only",
  },
  {
    relation: "lifecycle_event",
    privilege: "DELETE",
    because: "history is append-only",
  },
  {
    relation: "capacity_grant",
    privilege: "INSERT",
    because: "a role that can grant itself authority has none worth checking",
  },
];

/**
 * The reasons this connection should not run the application, in the order a
 * reader would want them.
 *
 * Pure, and separate from the query on purpose: every condition below is a
 * guard, and a guard needs a test that dies without it. Keeping this free of
 * I/O means those tests need no Postgres and the mutation check is cheap.
 */
export function privilegeFailures(privileges: ConnectionPrivileges): string[] {
  const failures: string[] = [];

  if (privileges.superuser) {
    failures.push("it is a superuser, so no privilege check applies to it at all");
  }

  if (privileges.replication) {
    failures.push("it can replicate, which streams the whole cluster without reading a table");
  }

  if (privileges.bypassRowLevelSecurity) {
    failures.push("it bypasses row-level security, silently, the day any is defined");
  }

  if (privileges.createRole) {
    failures.push("it can create roles, and so can grant itself anything through a new one");
  }

  if (privileges.createDatabase) {
    failures.push("it can create databases");
  }

  if (privileges.reachableOwnership > 0) {
    failures.push(
      `it holds the owner's rights over ${privileges.reachableOwnership} database object(s), ` +
        "which is enough to disable or rewrite every guarantee that protects the record",
    );
  }

  // Each one separately rather than "it holds 3 privileges it should not",
  // because the remedy differs: a missing table means the migrations have not
  // run, and a held privilege means somebody granted it.
  for (const held of privileges.forbiddenHeld) {
    failures.push(held);
  }

  return failures;
}

/**
 * Which of `FORBIDDEN_PRIVILEGES` this connection actually holds.
 *
 * One statement per entry rather than one clever query, because the entries
 * differ — some are table-level and some are column-level — and a query that
 * handled both would be harder to read than six that do not.
 *
 * **`to_regclass` first, and the reason is the case this check exists for.**
 * `has_table_privilege` on a table that does not exist raises, so an API
 * pointed at an empty database would have failed with a query error instead of
 * a sentence naming the table. A missing table is the most likely way for this
 * to trip — it means the migrations have not run — and it deserves the clearer
 * message, not the worse one.
 */
async function heldForbiddenPrivileges(db: Database): Promise<string[]> {
  // Issued together rather than one after another. Six sequential round trips
  // before anything is served is invisible against a local database and is six
  // times a latency somebody already chose pooling to avoid — and "startup is
  // not a hot path" is the reasoning that produces slow startups, one
  // defensible decision at a time. They are independent reads; nothing here
  // needs ordering.
  const answers = await Promise.all(
    FORBIDDEN_PRIVILEGES.map(async (entry) => {
      const [row] = await db.execute<{ missing: boolean; granted: boolean | null }>(sql`
        SELECT to_regclass(${entry.relation}) IS NULL AS missing,
               CASE
                 WHEN to_regclass(${entry.relation}) IS NULL THEN NULL
                 WHEN ${entry.column ?? null}::text IS NULL
                   THEN has_table_privilege(current_user, ${entry.relation}, ${entry.privilege})
                 ELSE has_column_privilege(
                   current_user, ${entry.relation}, ${entry.column ?? ""}::text, ${entry.privilege}
                 )
               END AS granted
      `);

      return { entry, missing: row?.missing === true, granted: row?.granted === true };
    }),
  );

  const held: string[] = [];
  // Once per table, not once per entry. An empty database has three entries
  // naming `product` and reported the same sentence three times — six lines
  // saying three things, in the message somebody reads while a deploy is
  // failing. Found by pointing it at one.
  //
  // Built from `answers` in order, so the reporting stays deterministic even
  // though the queries no longer complete in one.
  const reportedMissing = new Set<string>();

  for (const { entry, missing, granted } of answers) {
    const target = entry.column ? `${entry.relation}.${entry.column}` : entry.relation;

    if (missing) {
      if (!reportedMissing.has(entry.relation)) {
        reportedMissing.add(entry.relation);
        held.push(
          `the table ${entry.relation} does not exist, so the migrations have not run here`,
        );
      }

      continue;
    }

    if (granted) {
      held.push(`it may ${entry.privilege} ${target} — ${entry.because}`);
    }
  }

  return held;
}

/**
 * Asks Postgres, rather than reading the role out of the connection string.
 *
 * A role name in a URL is a claim about what was intended. `current_user` is
 * what happened — and they differ whenever a connection pooler, a `SET ROLE` in
 * a session default, or a plain typo sits between the two.
 */
export async function readConnectionPrivileges(db: Database): Promise<ConnectionPrivileges> {
  const [row] = await db.execute<{
    role: string;
    superuser: boolean;
    create_database: boolean;
    create_role: boolean;
    replication: boolean;
    bypass_rls: boolean;
    reachable_ownership: string;
  }>(sql`
    WITH ns AS (
      -- Every schema this database's own objects can live in. The first
      -- version asked about 'public' alone and missed
      -- drizzle.__drizzle_migrations, whose owner decides which migrations
      -- this database believes it has already run.
      SELECT oid FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema')
        AND nspname NOT LIKE 'pg\\_toast%'
        AND nspname NOT LIKE 'pg\\_temp%'
    ),
    owned AS (
      -- Tables, partitioned tables, sequences, views, materialised views.
      SELECT c.relowner AS owner FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'S', 'v', 'm')

      UNION ALL

      -- Functions, which pg_class does not contain and the first version of
      -- this query therefore never saw. Migration 0024 moves the seven trigger
      -- functions to the owner on purpose, because a function owner can
      -- CREATE OR REPLACE the body of an append-only guard and leave the
      -- trigger attached, enabled, and enforcing nothing. Measured: a role able
      -- to become the owner of a function and nothing else scored 0 here while
      -- being able to redefine it.
      SELECT p.proowner FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace

      UNION ALL

      -- Enums, domains and ranges, because a type owner can rewrite what the
      -- stored data means without touching any of it.
      --
      -- An earlier version of this comment said the owner could drop an enum
      -- value. It cannot — Postgres 18.6 answers ALTER TYPE ... DROP VALUE with
      -- "dropping an enum value is not implemented". RENAME VALUE is what
      -- exists, and it is worse. Run against the real type inside a rolled-back
      -- transaction:
      --
      --   ALTER TYPE lifecycle_actor_kind RENAME VALUE 'issuer' TO 'holder_verified';
      --
      --   before                    after
      --   issuer      1744          holder_verified  1744
      --   authority   1167          authority        1167
      --   holder       722          holder            722
      --
      -- 1,744 lifecycle events restated, and \`lifecycle_event_no_update\` never
      -- fired, because no row was touched. The append-only guarantee is
      -- bypassed by editing the dictionary instead of the text. DROP TYPE, and
      -- the column with it, is the blunter version of the same ownership.
      --
      -- Restricted to those three kinds because pg_type also holds a composite
      -- type and an array type for every table, and counting those would count
      -- each table three times.
      SELECT t.typowner FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
      WHERE t.typtype IN ('e', 'd', 'r')
    )
    SELECT current_user AS role,
           r.rolsuper       AS superuser,
           r.rolcreatedb    AS create_database,
           r.rolcreaterole  AS create_role,
           r.rolreplication AS replication,
           r.rolbypassrls   AS bypass_rls,
           (SELECT count(*) FROM owned WHERE pg_has_role(r.oid, owned.owner, 'MEMBER'))::text
             AS reachable_ownership
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);

  if (!row) {
    // Fail-closed, and this is the branch that makes the rest worth having: a
    // check that cannot answer must not be read as an answer of "fine".
    throw new Error("Postgres did not describe the connected role. Refusing to continue.");
  }

  return {
    role: row.role,
    superuser: row.superuser,
    createDatabase: row.create_database,
    createRole: row.create_role,
    replication: row.replication,
    bypassRowLevelSecurity: row.bypass_rls,
    forbiddenHeld: await heldForbiddenPrivileges(db),
    // `count(*)` is bigint, and the driver hands bigint back as text rather
    // than lose precision. Parsing it here keeps that away from every caller.
    reachableOwnership: Number.parseInt(row.reachable_ownership, 10),
  };
}

export interface UnprivilegedConnectionOptions {
  /**
   * Starts anyway, having said so.
   *
   * The deliberate shape of this: an explicit opt-in, never an environment
   * default. Keying the check on `NODE_ENV === "production"` was the obvious
   * design and it has the defect it exists to fix — `apps/api/src/env.ts`
   * declares `NODE_ENV` with `.default("development")`, so a deploy that
   * forgets that variable, which is the same forgetfulness this guard is for,
   * one variable over, would skip the check entirely.
   *
   * Inverted, forgetting anything makes the process stricter. Nobody sets this
   * in production by accident.
   */
  allowPrivileged?: boolean;
  /** Where the warning goes when the escape hatch is used. */
  warn?: (message: string) => void;
}

/**
 * Refuses to continue on a connection that can dismantle the guarantees the
 * application runs on. Throws; it does not warn and carry on.
 */
export async function assertConnectionIsUnprivileged(
  db: Database,
  options: UnprivilegedConnectionOptions = {},
): Promise<ConnectionPrivileges> {
  const privileges = await readConnectionPrivileges(db);
  const failures = privilegeFailures(privileges);

  if (failures.length === 0) {
    return privileges;
  }

  if (options.allowPrivileged) {
    // Every start, not only the first. A warning that appears once is a
    // warning nobody sees in a log they opened this morning.
    (options.warn ?? console.warn)(
      `Running against a privileged database connection as "${privileges.role}", ` +
        "because TRUSTPASS_ALLOW_PRIVILEGED_DATABASE is set. " +
        `${failures.length} guarantee(s) in ADR 0013 are not in force.`,
    );
    return privileges;
  }

  throw new Error(
    [
      `Refusing to start against the database as "${privileges.role}":`,
      ...failures.map((failure) => `  - ${failure}`),
      "",
      "The application must connect as a role that owns nothing and inherits nothing. See ADR 0013.",
      "  1. pnpm db:migrate          creates trustpass_runtime and its grants",
      "  2. pnpm db:provision        gives it a password from the environment",
      "  3. point DATABASE_URL at trustpass_runtime",
      "",
      "To run against this connection anyway, set TRUSTPASS_ALLOW_PRIVILEGED_DATABASE=true.",
    ].join("\n"),
  );
}
