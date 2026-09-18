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

      await expect(assertConnectionIsUnprivileged(pinned)).rejects.toThrow(/become the owner/);
    } finally {
      await pinned.$client.end();
    }
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
