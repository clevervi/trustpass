import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";

const runtimeUrl = process.env.RUNTIME_DATABASE_URL;

/**
 * What the application can do, asked of the application's own connection.
 *
 * The `0023` rehearsal ran seven attacks against a purpose-made role and all
 * seven were refused. That proved something about a role invented for the
 * rehearsal and nothing about the credential the API actually holds, which at
 * the time was superuser and owned every table — two of those seven would have
 * succeeded with it.
 *
 * So the question this file exists to answer is not "was the runtime role
 * correct on the day it was written". It is:
 *
 *   **can any future migration turn the runtime back into an owner without a
 *   test going red?**
 *
 * Hence the matrix below is exhaustive over the catalogue, not over a list
 * somebody remembered to update: a table added tomorrow with no entry here
 * fails `covers every table` before it can quietly become readable.
 *
 * Skips without RUNTIME_DATABASE_URL, because a password cannot live in the
 * repository. CI provisions one per run; locally, `pnpm db:provision`.
 */

/** SELECT, INSERT, UPDATE. DELETE and TRUNCATE are never granted, anywhere. */
type Grant = "SELECT" | "INSERT" | "UPDATE";

/**
 * Derived from every write in the codebase, not from what seemed reasonable:
 * `.insert()` reaches `product` and `lifecycle_event`; `.update()` reaches
 * `product`; `.delete()` reaches nothing. Everything else the application only
 * reads, and is written by migrations.
 *
 * When a capability arrives that needs more, the GRANT ships in the same
 * migration as the capability and the line changes here in the same pull
 * request. That is the point: the privilege is a decision somebody makes, not a
 * default somebody inherits.
 */
const EXPECTED: Record<string, readonly Grant[]> = {
  actor: ["SELECT"],
  capacity_grant: ["SELECT"],
  capacity_grant_revocation: ["SELECT"],
  credential: ["SELECT"],
  lifecycle_event: ["SELECT", "INSERT"],
  membership: ["SELECT"],
  organization: ["SELECT"],
  product: ["SELECT", "INSERT", "UPDATE"],
};

const ALL_GRANTS: readonly Grant[] = ["SELECT", "INSERT", "UPDATE"];

/**
 * Every statement here succeeds today with the credential the API holds.
 *
 * A table rather than fourteen near-identical blocks, because adding an attack
 * should be adding a row — and because fourteen blocks differing only in a
 * string is the shape a reader skims instead of reads.
 */
const ATTACKS: readonly { name: string; statement: string }[] = [
  {
    // The one that matters most, and the one missing from the `0023` rehearsal.
    // No DROP, a single statement, and afterwards the trigger is still listed
    // in `pg_trigger` looking entirely present — `tgenabled` is all that moved.
    // Every check in this repository that asks "is the guard there" says yes.
    name: "disable a trigger",
    statement: "ALTER TABLE lifecycle_event DISABLE TRIGGER lifecycle_event_no_update",
  },
  {
    // The quiet version of dropping one. CREATE OR REPLACE leaves the trigger
    // attached, enabled, and firing a body that returns NEW without checking
    // anything at all.
    name: "redefine a trigger function",
    statement:
      "CREATE OR REPLACE FUNCTION lifecycle_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$",
  },
  {
    name: "drop a trigger",
    statement: "DROP TRIGGER lifecycle_event_no_update ON lifecycle_event",
  },
  { name: "drop a trigger function", statement: "DROP FUNCTION product_status_guard()" },
  {
    name: "create a function",
    statement: "CREATE FUNCTION tp_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$",
  },
  { name: "alter a table", statement: "ALTER TABLE product ADD COLUMN tp_probe text" },
  {
    // Cheaper than altering a column, and it removes a guarantee outright.
    name: "drop a constraint",
    statement: "ALTER TABLE product DROP CONSTRAINT product_serial_not_blank",
  },
  { name: "drop a table", statement: "DROP TABLE organization" },
  { name: "create a table", statement: "CREATE TABLE tp_probe (id integer)" },
  {
    // Not a guarantee in itself, but the unique index on the TrustPass
    // identifier is — dropping it lets two live products claim one identity.
    name: "drop an index",
    statement: "DROP INDEX product_trustpass_id_idx",
  },
  {
    // TRUNCATE is not DELETE and fires no row triggers, so the append-only
    // guard would never see it. The missing privilege is all that stands here.
    name: "truncate history",
    statement: "TRUNCATE lifecycle_event",
  },
  {
    name: "delete history",
    statement: "DELETE FROM lifecycle_event WHERE id = (SELECT min(id) FROM lifecycle_event)",
  },
  {
    // The attack that rewrites the past without an UPDATE, and the one this
    // table had no case for until TP-168. A type owner cannot drop an enum
    // value — Postgres answers DROP VALUE with "not implemented" — but it can
    // rename one, and renaming is worse. Measured against the real type inside
    // a rolled-back transaction:
    //
    //   ALTER TYPE lifecycle_actor_kind RENAME VALUE 'issuer' TO 'holder_verified';
    //
    //   issuer 1744  ->  holder_verified 1744
    //
    // 1,744 events restated. `lifecycle_event_no_update` never fires, because
    // no row is touched — the append-only guard watches the text and this edits
    // the dictionary. Nothing in TP001–TP005 sees it either.
    //
    // The value named here does not exist, deliberately, and the statement is
    // still a real test of the boundary: Postgres checks ownership before it
    // looks the value up, answering `42501: must be owner of type
    // lifecycle_actor_kind`. So this asserts the privilege and stays harmless
    // the day the privilege is gone — it would fail on the missing value
    // instead of renaming a live one.
    //
    // Written that way after the mutation check renamed `'issuer'` for real and
    // left 1,744 events reading `tp_probe_renamed` until it was put back. An
    // attack test that does damage when it succeeds is a test nobody should run
    // near anything that matters.
    name: "rename an enum value out from under every event recorded with it",
    statement:
      "ALTER TYPE lifecycle_actor_kind RENAME VALUE 'tp_probe_absent' TO 'tp_probe_renamed'",
  },
  {
    // The same attack #78 answered with TP002, now answered with 42501 —
    // Postgres checks the privilege at execution start and no row is ever
    // reached. Asserted by code, not by "it threw", so the day somebody grants
    // UPDATE on this table the test goes red rather than quietly passing on the
    // trigger's answer instead.
    name: "edit history before the trigger is ever consulted",
    statement: "UPDATE lifecycle_event SET reason = 'fraud_flag'",
  },
];

describe.skipIf(!runtimeUrl)("the runtime role cannot remove what protects the record", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(runtimeUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  /** Every attack in this file expects exactly this, and never a trigger. */
  const refused = (statement: string) =>
    expectSqlState(db.execute(sql.raw(statement)), SqlState.INSUFFICIENT_PRIVILEGE);

  describe("who it is", () => {
    it("connects as trustpass_runtime and not as anybody else", async () => {
      // If this fails, every other assertion in the file is measuring the
      // wrong role and passing for the wrong reason.
      const [row] = await db.execute<{ user: string }>(sql`SELECT current_user AS user`);

      expect(row?.user).toBe("trustpass_runtime");
    });

    it("carries no cluster-level attribute", async () => {
      const [row] = await db.execute<{
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(
        sql`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
            FROM pg_roles WHERE rolname = current_user`,
      );

      // Named one by one rather than asserted as a set, so a failure says which.
      // `rolreplication` is the one people forget: it needs no table privilege
      // at all and streams the entire cluster. `rolbypassrls` matters the day
      // row-level security is switched on and silently does nothing.
      expect(row?.rolsuper).toBe(false);
      expect(row?.rolcreatedb).toBe(false);
      expect(row?.rolcreaterole).toBe(false);
      expect(row?.rolreplication).toBe(false);
      expect(row?.rolbypassrls).toBe(false);
    });

    it("owns nothing", async () => {
      // The load-bearing half. An owner can grant itself back every privilege
      // this file checks for, so "holds no privilege" is only true for as long
      // as "owns no object" is.
      const [row] = await db.execute<{ owned: string }>(
        sql`SELECT count(*)::text AS owned FROM pg_class
            WHERE relowner = current_user::regrole
              AND relnamespace = 'public'::regnamespace`,
      );

      expect(row?.owned).toBe("0");
    });

    it("cannot become the owner", async () => {
      // Membership is the other way in, and it does not go through a GRANT on
      // any table. Postgres answers this one with 42501 too.
      await refused("SET ROLE trustpass_owner");
    });

    it("cannot create anything in the schema", async () => {
      const [row] = await db.execute<{ usage: boolean; create: boolean; temp: boolean }>(
        sql`SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usage,
                   has_schema_privilege(current_user, 'public', 'CREATE') AS create,
                   has_database_privilege(current_user, current_database(), 'TEMP') AS temp`,
      );

      expect(row?.usage).toBe(true);
      expect(row?.create).toBe(false);
      // PUBLIC holds TEMP on every database by default. A role that can create
      // temporary tables can stage data inside the transaction it is attacking.
      expect(row?.temp).toBe(false);
    });
  });

  describe("the grant matrix", () => {
    it("covers every table in the schema", async () => {
      // The drift guard, and the reason this file is worth more than the
      // rehearsal was. A table added by a future migration with no entry in
      // EXPECTED fails here — before anyone can decide by accident what the
      // application may do with it.
      const rows = await db.execute<{ relname: string }>(
        sql`SELECT relname FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
            ORDER BY relname`,
      );

      expect(rows.map((row) => row.relname)).toEqual(Object.keys(EXPECTED).sort());
    });

    it.each(Object.entries(EXPECTED))("holds exactly %s: %j", async (table, granted) => {
      const [row] = await db.execute<Record<string, boolean>>(
        sql`SELECT
              has_table_privilege(current_user, ${table}, 'SELECT')   AS "SELECT",
              has_table_privilege(current_user, ${table}, 'INSERT')   AS "INSERT",
              has_table_privilege(current_user, ${table}, 'UPDATE')   AS "UPDATE",
              has_table_privilege(current_user, ${table}, 'DELETE')   AS "DELETE",
              has_table_privilege(current_user, ${table}, 'TRUNCATE') AS "TRUNCATE",
              has_table_privilege(current_user, ${table}, 'REFERENCES') AS "REFERENCES",
              has_table_privilege(current_user, ${table}, 'TRIGGER')  AS "TRIGGER"`,
      );

      // Asked of `has_table_privilege` rather than of `information_schema`'s
      // grant list, because this answers for privileges arriving by role
      // membership and by PUBLIC as well as by a GRANT naming the role — which
      // is exactly how a privilege appears that no migration ever wrote down.
      for (const grant of ALL_GRANTS) {
        expect({ [grant]: row?.[grant] }).toEqual({ [grant]: granted.includes(grant) });
      }

      // Never, on any table, for any reason. DELETE and TRUNCATE remove the
      // record; REFERENCES and TRIGGER are how a role that cannot alter a table
      // attaches behaviour to it anyway.
      expect(row?.DELETE).toBe(false);
      expect(row?.TRUNCATE).toBe(false);
      expect(row?.REFERENCES).toBe(false);
      expect(row?.TRIGGER).toBe(false);
    });

    it("can execute no function in the schema", async () => {
      // All seven return `trigger` today, and Postgres refuses to call one
      // directly, so this is unreachable rather than dangerous. The default it
      // overrides is not: functions are EXECUTE-to-PUBLIC unless somebody says
      // otherwise, and the first SECURITY DEFINER function to arrive would hand
      // the runtime whatever it was defined with.
      const [row] = await db.execute<{ executable: string; definer: string }>(
        sql`SELECT
              count(*) FILTER (WHERE has_function_privilege(current_user, p.oid, 'EXECUTE'))::text AS executable,
              count(*) FILTER (WHERE p.prosecdef)::text AS definer
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'`,
      );

      expect(row?.executable).toBe("0");
      expect(row?.definer).toBe("0");
    });
  });

  describe("the attacks the rehearsal could not run", () => {
    // Every one of these succeeds today with the credential the API holds.

    it.each(ATTACKS)("cannot $name", async ({ statement }) => {
      await refused(statement);
    });

    it("gains nothing by granting itself a privilege", async () => {
      // The one attack in this file that Postgres does not refuse with an
      // error, which is why it is asserted differently from the rest.
      //
      // A role granting a privilege it holds no grant option for gets a
      // *warning* — `WARNING: no privileges were granted for "lifecycle_event"`
      // — and a statement that returns successfully. Written as `refused(...)`
      // like its neighbours, this test failed with "the operation succeeded",
      // and the first reading of that was that the runtime had escalated. It
      // had not: the catalogue still said `DELETE = false`.
      //
      // Worth knowing in both directions. An attacker checking exit codes
      // records this as a win and moves on. A defender checking exit codes
      // records it as a breach. Only the catalogue answers the question, so
      // that is what this asserts.
      await db.execute(sql.raw("GRANT DELETE ON lifecycle_event TO trustpass_runtime"));

      const [row] = await db.execute<{ granted: boolean }>(
        sql`SELECT has_table_privilege(current_user, 'lifecycle_event', 'DELETE') AS granted`,
      );

      expect(row?.granted).toBe(false);
    });
  });

  describe("and the application still works", () => {
    it("registers a product with its provenance", async () => {
      // A privilege model that also stops the application is not a security
      // control, it is an outage. This exercises the whole write path as the
      // runtime: INSERT into product, INSERT into lifecycle_event, UPDATE of a
      // status, and the deferred provenance check at COMMIT.
      //
      // It proves two things that were argued rather than measured while
      // writing 0024. That revoking EXECUTE from PUBLIC does not stop a trigger
      // firing — Postgres checks that privilege when the trigger is created,
      // not each time it runs. And that an identity column needs no sequence
      // privilege: the runtime was granted none, and `GENERATED ALWAYS AS
      // IDENTITY` advances its sequence without consulting the caller's rights.
      const created = await insertProductWithProvenance(db, {
        trustpassId: generateTrustPassId(),
        organizationId: null,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `LP-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        category: "gpu",
        status: "registered",
        origin: "holder",
      });

      expect(created.id).toBeGreaterThan(0);
    });

    it("still refuses a product with no provenance", async () => {
      // The guarantees are unchanged for the role that is allowed to write.
      // Least privilege that quietly relaxed a constraint would be a worse
      // outcome than the superuser it replaced.
      //
      // `origin` is named rather than left to its default. Without it the row
      // defaults to `supply_chain` with no organization, which
      // `product_holder_has_no_organization` rejects immediately with 23514 —
      // so the insert never reached COMMIT and never reached the provenance
      // check at all. The first version of this test asserted TP004 and got
      // 23514, passing the row-level constraint off as the deferred one.
      await expectSqlState(
        db.execute(sql`
          INSERT INTO product (trustpass_id, brand, model, serial, category, status, origin)
          VALUES (${generateTrustPassId()}, 'ASUS', 'ROG Strix', ${`NP-${Math.random().toString(36).slice(2, 10).toUpperCase()}`}, 'gpu', 'registered', 'holder')
        `),
        SqlState.PROVENANCE_REQUIRED,
      );
    });
  });
});
