import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./client.js";
import {
  assertConnectionIsUnprivileged,
  readConnectionPrivileges,
} from "./connection-privileges.js";

const databaseUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.RUNTIME_DATABASE_URL;

/**
 * The guard from both sides of the boundary, against a real Postgres.
 *
 * The unit tests decide what to do with an answer. These prove the answer is
 * the one Postgres actually gives — which is the half that would be wrong if
 * `pg_has_role`, `current_user` under a pool, or bigint coming back as text
 * behaved differently from how they were assumed to.
 */
describe.skipIf(!databaseUrl)("the connection describes itself honestly", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("refuses to run the application as the superuser", async () => {
    // The connection every test in this repository uses, and the one a deploy
    // that forgot to change DATABASE_URL would use in production.
    await expect(assertConnectionIsUnprivileged(db)).rejects.toThrow(/Refusing to start/);
  });

  it("says what is wrong and what to do about it", async () => {
    // A refusal nobody can act on is an outage with extra steps. Asserted by
    // content rather than by "it threw", so that a future edit that reduces the
    // message to "permission denied" fails here.
    const failure = await assertConnectionIsUnprivileged(db).catch((error: Error) => error.message);

    expect(failure).toMatch(/superuser/i);
    expect(failure).toMatch(/pnpm db:provision/);
    expect(failure).toMatch(/TRUSTPASS_ALLOW_PRIVILEGED_DATABASE/);
  });

  it("starts anyway when told to, and says so every time", async () => {
    const warnings: string[] = [];

    const privileges = await assertConnectionIsUnprivileged(db, {
      allowPrivileged: true,
      warn: (message) => warnings.push(message),
    });

    expect(privileges.superuser).toBe(true);
    // Every start, not the first: called twice, warned twice.
    await assertConnectionIsUnprivileged(db, {
      allowPrivileged: true,
      warn: (message) => warnings.push(message),
    });

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/TRUSTPASS_ALLOW_PRIVILEGED_DATABASE/);
  });

  it("refuses a role that owns nothing but is one SET ROLE from owning everything", async () => {
    // The condition this whole module turns on, and the only one with no test
    // that could kill it until this existed.
    //
    // `trustpass_migration` carries no attribute and owns nothing directly, so
    // a check built from the five flags plus `relowner = current_user` — the
    // obvious implementation, and the one the review proposed — starts the
    // application on a connection that can `SET ROLE trustpass_owner` and drop
    // every trigger. Measured, as that role:
    //
    //   current_user=trustpass_migration  owns_directly=0
    //   can_become_owner=16               superuser=f
    //
    // Reached from this superuser connection rather than from a third
    // credential, because SET ROLE gets to exactly the same `current_user` and
    // CI does not need another password to prove it.
    //
    // One connection, pinned: postgres.js pools, and a SET ROLE on one member
    // of a pool says nothing about the connection the next query lands on.
    const pinned = createDatabase(databaseUrl as string, { maxConnections: 1 });

    try {
      await pinned.execute(sql`SET ROLE trustpass_migration`);

      const privileges = await readConnectionPrivileges(pinned);

      expect(privileges.role).toBe("trustpass_migration");
      expect(privileges.superuser).toBe(false);
      expect(privileges.createDatabase).toBe(false);
      expect(privileges.createRole).toBe(false);
      expect(privileges.replication).toBe(false);
      expect(privileges.bypassRowLevelSecurity).toBe(false);
      expect(privileges.reachableOwnership).toBeGreaterThan(0);

      await expect(assertConnectionIsUnprivileged(pinned)).rejects.toThrow(/owner's rights over/);
    } finally {
      await pinned.$client.end();
    }
  });

  /**
   * Builds an owner nobody else uses, gives it exactly one object, and asks the
   * guard what a member of that owner looks like.
   *
   * Written this way rather than asserting a count, because a count is a
   * property of today's schema: `reachableOwnership` was 16 when #127 shipped
   * and is 25 now, and a test pinned to either number fails on the next
   * migration for no reason anyone cares about. This asks the question the
   * guard exists to answer, and stays true whatever the schema becomes.
   */
  // Every probe object below is a function or lives in its own schema, and
  // every probe function has EXECUTE revoked from PUBLIC the moment it exists.
  // Neither is fussiness.
  //
  // The first version created a probe TABLE in `public` and a probe function
  // with the default ACL, which is EXECUTE to PUBLIC. Vitest runs test files in
  // parallel, and `least-privilege.integration.test.ts` asserts two things over
  // `public` at the same time: the exact list of tables, and that the runtime
  // can execute no function. Both were true until this file created an object
  // between them.
  //
  // It failed once in four full-suite runs and passed with the two files alone,
  // every time — order-dependent, not flaky, which is the same distinction #78
  // cost a morning to learn. A test that is wrong about *when* it is wrong is
  // worse than one that is simply wrong.
  async function guardSeesOwnershipOf(
    create: string,
    drop: string,
    grantOptions = "",
  ): Promise<number> {
    // One connection: SET ROLE applies to a session, and a ten-member pool
    // would answer from whichever member the next query lands on.
    const pinned = createDatabase(databaseUrl as string, { maxConnections: 1 });

    try {
      await pinned.execute(sql.raw("DROP ROLE IF EXISTS tp_probe_member"));
      await pinned.execute(sql.raw("DROP ROLE IF EXISTS tp_probe_owner"));
      await pinned.execute(sql.raw("CREATE ROLE tp_probe_owner NOLOGIN"));
      await pinned.execute(sql.raw("CREATE ROLE tp_probe_member NOLOGIN"));
      await pinned.execute(sql.raw(`GRANT tp_probe_owner TO tp_probe_member ${grantOptions}`));
      await pinned.execute(sql.raw(create));

      await pinned.execute(sql.raw("SET ROLE tp_probe_member"));
      const privileges = await readConnectionPrivileges(pinned);
      await pinned.execute(sql.raw("RESET ROLE"));

      expect(privileges.role).toBe("tp_probe_member");
      return privileges.reachableOwnership;
    } finally {
      const cleanup = createDatabase(databaseUrl as string, { maxConnections: 1 });
      try {
        await cleanup.execute(sql.raw(drop));
        await cleanup.execute(sql.raw("DROP ROLE IF EXISTS tp_probe_member"));
        await cleanup.execute(sql.raw("DROP ROLE IF EXISTS tp_probe_owner"));
      } finally {
        await cleanup.$client.end();
      }
      await pinned.$client.end();
    }
  }

  it("sees a function it could redefine, which pg_class does not contain", async () => {
    // The defect this file was extended for. Migration 0024 moves the seven
    // trigger functions to the owner because a function owner can
    // CREATE OR REPLACE the body of an append-only guard and leave the trigger
    // attached, enabled, and enforcing nothing — `least-privilege` tests that
    // exact attack under the name "redefine a trigger function".
    //
    // The first version of the startup guard queried pg_class only. Functions
    // are in pg_proc, so a role able to become the owner of every one of them
    // scored 0 and the API started.
    const reachable = await guardSeesOwnershipOf(
      "CREATE FUNCTION tp_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;" +
        " REVOKE EXECUTE ON FUNCTION tp_probe_fn() FROM PUBLIC;" +
        " ALTER FUNCTION tp_probe_fn() OWNER TO tp_probe_owner",
      "DROP FUNCTION IF EXISTS tp_probe_fn()",
    );

    expect(reachable).toBeGreaterThan(0);
  });

  it("sees a member that inherits the owner's rights but cannot SET ROLE", async () => {
    // The case that decides MEMBER against SET, and which nothing defended
    // until this test existed — the reasoning was in a comment and a comment
    // cannot go red.
    //
    // Review proposed `pg_has_role(..., 'SET')` on the reading that SET is the
    // privilege meaning "can issue SET ROLE". The reading is right and the
    // change opens a hole. Measured on Postgres 18:
    //
    //   role               MEMBER   SET   USAGE (inherits privileges)
    //   probe              t        f     t
    //
    // Connected as such a role, never issuing SET ROLE:
    //
    //   ALTER TABLE lifecycle_event DISABLE TRIGGER lifecycle_event_no_update;
    //   -> ALTER TABLE.  guard_on: 0.  still listed in pg_trigger: 1.
    //
    // Inheritance reaches the owner's privileges without SET ROLE ever being
    // called, so a SET-based count reads 0 and the application starts on it.
    const reachable = await guardSeesOwnershipOf(
      "CREATE FUNCTION tp_probe_inherited() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;" +
        " REVOKE EXECUTE ON FUNCTION tp_probe_inherited() FROM PUBLIC;" +
        " ALTER FUNCTION tp_probe_inherited() OWNER TO tp_probe_owner",
      "DROP FUNCTION IF EXISTS tp_probe_inherited()",
      "WITH INHERIT TRUE, SET FALSE",
    );

    expect(reachable).toBeGreaterThan(0);
  });

  it("sees an enum it could reinterpret every past event with", async () => {
    // `lifecycle_actor_kind` is an enum, and its owner can rewrite what the
    // stored data means without touching any of it.
    //
    // Not by dropping a value — Postgres 18.6 answers ALTER TYPE ... DROP VALUE
    // with "dropping an enum value is not implemented", which an earlier
    // version of this comment got wrong. By renaming one, which is worse:
    // renaming `'issuer'` restated 1,744 lifecycle events in a rolled-back
    // transaction, and `lifecycle_event_no_update` never fired because no row
    // was touched.
    const reachable = await guardSeesOwnershipOf(
      "CREATE TYPE tp_probe_enum AS ENUM ('a', 'b'); ALTER TYPE tp_probe_enum OWNER TO tp_probe_owner",
      "DROP TYPE IF EXISTS tp_probe_enum",
    );

    expect(reachable).toBeGreaterThan(0);
  });

  it("sees an object outside public, where the migration ledger lives", async () => {
    // `drizzle.__drizzle_migrations` decides which migrations this database
    // believes it has already run. Its owner can make it believe anything.
    const reachable = await guardSeesOwnershipOf(
      "CREATE SCHEMA tp_probe_schema; CREATE TABLE tp_probe_schema.ledger (id integer);" +
        " ALTER TABLE tp_probe_schema.ledger OWNER TO tp_probe_owner;" +
        " ALTER SCHEMA tp_probe_schema OWNER TO tp_probe_owner",
      "DROP SCHEMA IF EXISTS tp_probe_schema CASCADE",
    );

    expect(reachable).toBeGreaterThan(0);
  });

  it("counts reachable ownership rather than direct ownership", async () => {
    // The measurement the whole design rests on, asked of the catalogue for all
    // three roles at once. `trustpass_migration` is the one that matters: no
    // attribute, owns nothing, and one SET ROLE from owning everything.
    const rows = await db.execute<{
      rolname: string;
      attributes_clear: boolean;
      owns_directly: string;
      can_become_owner: string;
    }>(sql`
      SELECT r.rolname,
             NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
                  OR r.rolreplication OR r.rolbypassrls) AS attributes_clear,
             (SELECT count(*) FROM pg_class
               WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'S')
                 AND relowner = r.oid)::text AS owns_directly,
             (SELECT count(*) FROM pg_class
               WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'S')
                 AND pg_has_role(r.oid, relowner, 'MEMBER'))::text AS can_become_owner
      FROM pg_roles r
      WHERE r.rolname IN ('trustpass_migration', 'trustpass_runtime')
      ORDER BY r.rolname
    `);

    const migration = rows.find((row) => row.rolname === "trustpass_migration");
    const runtime = rows.find((row) => row.rolname === "trustpass_runtime");

    expect(migration?.attributes_clear).toBe(true);
    expect(migration?.owns_directly).toBe("0");
    expect(Number(migration?.can_become_owner)).toBeGreaterThan(0);

    expect(runtime?.attributes_clear).toBe(true);
    expect(runtime?.can_become_owner).toBe("0");
  });
});

describe.skipIf(!runtimeUrl)("the runtime connection is allowed to run the application", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(runtimeUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("starts, and reports which role got through", async () => {
    // The other half. A guard that refuses everything is not a guard, and this
    // is the assertion that would catch a condition tightened past the point
    // where the application can run at all.
    const privileges = await assertConnectionIsUnprivileged(db);

    expect(privileges.role).toBe("trustpass_runtime");
    expect(privileges.reachableOwnership).toBe(0);
  });

  it("reads every attribute as false", async () => {
    const privileges = await readConnectionPrivileges(db);

    expect(privileges).toEqual({
      role: "trustpass_runtime",
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRowLevelSecurity: false,
      reachableOwnership: 0,
    });
  });
});
