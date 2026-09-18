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
   * Objects in `public` whose owner this role can become — by owning them, or
   * by being a member of a role that does.
   *
   * This is the field that matters, and it is not the obvious one. A check
   * built from the five attributes above plus "owns nothing" passes
   * `trustpass_migration`, measured:
   *
   *   role                 five flags clean   owns directly   can become owner
   *   trustpass            no                 0               16
   *   trustpass_migration  YES                0               16
   *   trustpass_owner      yes                16              16
   *   trustpass_runtime    yes                0               0
   *
   * `trustpass_migration` carries no attribute and owns nothing, and one
   * `SET ROLE trustpass_owner` makes it the owner of everything. Asking
   * `pg_has_role(..., 'MEMBER')` collapses both questions into one, because a
   * role is a member of itself.
   */
  reachableOwnership: number;
}

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
      `it can become the owner of ${privileges.reachableOwnership} object(s) in public, ` +
        "which is enough to disable every trigger that protects the record",
    );
  }

  return failures;
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
    SELECT current_user AS role,
           r.rolsuper       AS superuser,
           r.rolcreatedb    AS create_database,
           r.rolcreaterole  AS create_role,
           r.rolreplication AS replication,
           r.rolbypassrls   AS bypass_rls,
           (SELECT count(*) FROM pg_class
             WHERE relnamespace = 'public'::regnamespace
               AND relkind IN ('r', 'S', 'v', 'm')
               AND pg_has_role(r.oid, relowner, 'MEMBER'))::text AS reachable_ownership
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
      "The application must connect as a role that owns nothing. See ADR 0013.",
      "  1. pnpm db:migrate          creates trustpass_runtime and its grants",
      "  2. pnpm db:provision        gives it a password from the environment",
      "  3. point DATABASE_URL at trustpass_runtime",
      "",
      "To run against this connection anyway, set TRUSTPASS_ALLOW_PRIVILEGED_DATABASE=true.",
    ].join("\n"),
  );
}
