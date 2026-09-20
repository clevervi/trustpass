import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { changeProductStatus } from "../repositories/product-status-repository.js";
import { expectSqlState, SqlState, sqlStateOf } from "../testing/sql-state.js";
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
  // No table-level UPDATE. The runtime updates two columns and the grant says
  // so — see the column matrix below. `has_table_privilege` reports false for
  // a column grant, measured, so this row is the truth rather than a downgrade.
  product: ["SELECT", "INSERT"],
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

  /**
   * Every attack in this file expects exactly this, and never a trigger.
   *
   * **Inside a transaction that can only end in a rollback**, and the reason is
   * in the repository's own schema. The first version ran each statement
   * directly:
   *
   *   const refused = (statement: string) =>
   *     expectSqlState(db.execute(sql.raw(statement)), INSUFFICIENT_PRIVILEGE);
   *
   * When the privilege is missing — the expected case — nothing happens and
   * nothing is left behind. When it is present the statement succeeds, the test
   * fails, **and the change is committed**. That is not hypothetical: it left a
   * `tp_probe text` column on `product` in a development database, from the
   * `alter a table` row below, found only when #157 added a guard that looked at
   * columns. A leftover table fails `covers every table` and a leftover function
   * fails `can execute no function`; a leftover column failed nothing.
   *
   * The file already knew this for exactly one row. The enum rename carries a
   * comment saying an attack test that does damage when it succeeds is a test
   * nobody should run near anything that matters — and the fix applied there was
   * to name a value that does not exist, which defuses that statement and no
   * other. Two entries above it, `ALTER TABLE product ADD COLUMN` was doing
   * damage the whole time.
   *
   * So the rollback is unconditional and does not depend on the assertion
   * failing. A refusal aborts the transaction on its own; a success throws a
   * sentinel that rolls it back and then fails the test by name. Neither path
   * can commit.
   */
  class AttackSucceeded extends Error {
    constructor(readonly statement: string) {
      super(statement);
      this.name = "AttackSucceeded";
    }
  }

  type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

  /**
   * **The only place in this file where an attack reaches the database.**
   *
   * It reports what happened rather than asserting it, so that a test needing a
   * different assertion can have one without needing its own transaction —
   * which is the mechanism that produced this defect twice. The first version
   * put the rollback inside `refused()`, and `gains nothing by granting itself a
   * privilege` needed to assert against the catalogue instead of against an
   * error, did not fit, and was written as a bare `db.execute`. It escalated a
   * privilege for real.
   *
   * `observe` runs inside the transaction, because a catalogue read after the
   * rollback asks about a state that has already been undone.
   *
   * ponytail: this makes the invariant *easy* to hold, not enforced. A
   * fifteenth attack can still be written with a bare `db.execute` and nothing
   * will say so — see #171 for making it checkable.
   *
   * Note on locks: a statement that is refused never gets past the privilege
   * check and takes nothing. One that *succeeds* holds whatever it locked —
   * ACCESS EXCLUSIVE, for the DROP and ALTER rows — until the sentinel unwinds
   * the transaction. That window only opens under a deliberately broken
   * privilege model, which is to say during mutation testing, which is exactly
   * when somebody is watching these tests closely enough to misread a lock wait
   * as a finding.
   */
  async function attempt<T>(
    statement: string,
    observe?: (tx: Tx) => Promise<T>,
  ): Promise<{ readonly sqlState?: string; readonly observed?: T }> {
    let observed: T | undefined;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(statement));

        // Reached only when the statement was not refused.
        observed = await observe?.(tx);

        // Rolls the transaction back, which is the whole point, and carries the
        // statement out so a failure names what succeeded rather than what was
        // expected. Unconditional: it does not depend on any assertion failing,
        // which is the mistake a DDL test in this repository made once before —
        // under mutation the assertion passed, nothing rolled back, and
        // `actor.id` was left GENERATED BY DEFAULT in a live database.
        throw new AttackSucceeded(statement);
      });
    } catch (error) {
      if (error instanceof AttackSucceeded) {
        return { observed };
      }

      return { sqlState: sqlStateOf(error) };
    }

    // Unreachable: the callback either throws the sentinel or lets the
    // database's own error out. Asserted rather than assumed, because "the
    // transaction returned normally" would mean the sentinel stopped being
    // thrown and every attack in this file had quietly stopped being checked.
    return expect.fail(`The transaction returned without refusing or rolling back: ${statement}`);
  }

  /** Every attack in this file expects exactly this, and never a trigger. */
  const refused = async (statement: string): Promise<void> => {
    const { sqlState } = await attempt(statement);

    if (sqlState === undefined) {
      expect.fail(`The attack was not refused and has been rolled back: ${statement}`);
    }

    expect(sqlState).toBe(SqlState.INSUFFICIENT_PRIVILEGE);
  };

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
      // Rolled back like every other attack, and this one needed it most.
      //
      // It is the only attack asserted against the catalogue instead of against
      // an error, so it sits outside `refused()` and did not get the transaction
      // when the others did. Measured: with the runtime made a member of
      // `trustpass_owner`, this GRANT stops being a no-op, succeeds, and
      // **persists** — `trustpass_runtime` came out of that run holding DELETE
      // on `lifecycle_event`, which then made `cannot delete history` answer
      // TP002 instead of 42501 and `holds exactly lifecycle_event` go red.
      //
      // A test for privilege escalation that escalates a privilege when it
      // fails is the same defect as #160 wearing different clothes, and it was
      // found by the mutation for #160 rather than by reading.
      //
      // The catalogue is read inside the transaction, because outside it the
      // rollback has already undone what is being asked about.
      const { sqlState, observed } = await attempt(
        "GRANT DELETE ON lifecycle_event TO trustpass_runtime",
        async (tx) => {
          const [row] = await tx.execute<{ granted: boolean }>(
            sql`SELECT has_table_privilege(current_user, 'lifecycle_event', 'DELETE') AS granted`,
          );

          return row?.granted;
        },
      );

      // Both, because they fail differently and the difference is the finding.
      // The statement is expected to *succeed* and accomplish nothing; an error
      // here would mean Postgres had started refusing it outright, which is a
      // change in behaviour worth failing on rather than passing quietly.
      expect(sqlState).toBeUndefined();
      expect(observed).toBe(false);
    });
  });

  describe("what the runtime may change on a product, column by column", () => {
    // The table matrix above answers "may the runtime update `product`". Once
    // that is a column-level decision the question stops having a single
    // answer, and this block is where the real one lives.
    //
    // **The invariant cannot be a CHECK constraint**, and that was settled by
    // measurement before the design was chosen rather than argued afterwards.
    // A constraint asks whether the values in a row agree with each other. The
    // question here is which columns may change at all, and no arrangement of
    // values answers it — see "the coherent lie" below.

    /** A row of this block's own, so no test depends on what a previous run left. */
    let victim: number;

    beforeAll(async () => {
      const created = await insertProductWithProvenance(db, {
        trustpassId: generateTrustPassId(),
        organizationId: null,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `COL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        category: "gpu",
        status: "registered",
        origin: "holder",
      });

      victim = created.id;
    });

    /** The literal requirement from #157, derived from nothing. */
    const MAY_UPDATE = ["status", "updated_at"] as const;

    /**
     * Every other column, listed rather than computed — for the same reason
     * `covers every table` lists tables. A set derived from the catalogue at
     * run time would assert whatever the catalogue happened to say and could
     * not fail; this one fails when a column appears that nobody decided
     * about, which is the drift the table matrix above already guards against.
     *
     * **That guard was missing at column granularity and it had already let
     * something through.** Writing this found a `tp_probe text` column on
     * `product` in the development database: in no migration, in no schema
     * file, holding no data, and matching one statement exactly — the
     * `alter a table` row of ATTACKS above. `refused()` runs each attack
     * directly against the live database, so an attack that is ever *not*
     * refused commits, and that one did. It has been dropped.
     *
     * Two of its neighbours leave residue the same way and were caught by
     * design: a leftover `tp_probe` table fails `covers every table`, and a
     * leftover `tp_probe()` function fails `can execute no function`. A
     * leftover column failed nothing, because nothing here looked at columns.
     *
     * Under column-level grants that stops being untidiness. An out-of-band
     * column is a column no GRANT ever named, and what a role may do with a
     * column nobody decided about is now a question with an answer.
     */
    const MAY_NOT_UPDATE = [
      "id",
      "trustpass_id",
      "brand",
      "model",
      "serial",
      "category",
      "created_at",
      "origin",
      "organization_id",
    ] as const;

    it("covers every column of product", async () => {
      const rows = await db.execute<{ attname: string }>(
        sql`SELECT attname FROM pg_attribute
            WHERE attrelid = 'product'::regclass AND attnum > 0 AND NOT attisdropped
            ORDER BY attname`,
      );

      expect(rows.map((row) => row.attname)).toEqual([...MAY_UPDATE, ...MAY_NOT_UPDATE].sort());
    });

    it.each(MAY_UPDATE)("may update %s", async (column) => {
      const [row] = await db.execute<{ allowed: boolean }>(
        sql`SELECT has_column_privilege(current_user, 'product', ${column}::text, 'UPDATE') AS allowed`,
      );

      expect({ [column]: row?.allowed }).toEqual({ [column]: true });
    });

    it.each(MAY_NOT_UPDATE)("may not update %s", async (column) => {
      const [row] = await db.execute<{ allowed: boolean }>(
        sql`SELECT has_column_privilege(current_user, 'product', ${column}::text, 'UPDATE') AS allowed`,
      );

      expect({ [column]: row?.allowed }).toEqual({ [column]: false });
    });

    /**
     * `id` is excluded, and the exclusion is the finding.
     *
     * `UPDATE product SET id = id` answers `428C9`, not `42501`, and it does so
     * whether the column grant is in place or not — measured both ways.
     * `GENERATED ALWAYS AS IDENTITY` is enforced during parse analysis, which
     * runs before the executor checks any privilege, so on this one column the
     * privilege is never consulted at all.
     *
     * Left in the loop it would have passed for the wrong reason before the
     * migration existed and failed for the wrong reason after it. It gets its
     * own case below, asserting the guard that actually answers.
     */
    const ATTEMPTABLE = MAY_NOT_UPDATE.filter((column) => column !== "id");

    it.each(ATTEMPTABLE)("refuses an UPDATE of %s when it is attempted", async (column) => {
      // The catalogue above and the attempt here answer different questions,
      // and a disagreement between them is the thing worth finding. A privilege
      // that reads correctly and does not hold is a shape this repository keeps
      // discovering in its own measurements, so both are asked.
      //
      // Each column is set to itself. The refusal is a permission check on the
      // target list, made before any row is examined and before any constraint
      // or foreign key is consulted — so the statement needs no value that
      // would be valid, and inventing one would only add a second reason it
      // could fail.
      await expectSqlState(
        db.execute(
          sql`UPDATE product SET ${sql.identifier(column)} = ${sql.identifier(column)} WHERE id = ${victim}`,
        ),
        SqlState.INSUFFICIENT_PRIVILEGE,
      );
    });

    it("refuses an UPDATE of id, by identity rather than by privilege", async () => {
      // Two independent guards cover this column and only one of them is this
      // issue's. Asserting 42501 here would claim the grant protects `id` when
      // the grant is never reached — and that claim would survive the grant
      // being removed, which is the definition of a test that proves nothing.
      await expectSqlState(
        db.execute(sql`UPDATE product SET id = id WHERE id = ${victim}`),
        SqlState.GENERATED_ALWAYS,
      );
    });

    it("refuses a forbidden column smuggled in beside an allowed one", async () => {
      // The shape a real attempt takes, and the case that separates a
      // column-level grant from a guard that inspects the first assignment.
      //
      // `status = status`, not `status = 'suspended'`. Written the obvious way
      // this test was red before the migration existed and red for the wrong
      // reason: a real status change trips `product_requires_provenance` and
      // answers TP004, so it would have gone green the day the grant arrived
      // while proving only that the provenance trigger still works.
      await expectSqlState(
        db.execute(
          sql`UPDATE product SET status = status, trustpass_id = 'TP1-NOPE' WHERE id = ${victim}`,
        ),
        SqlState.INSUFFICIENT_PRIVILEGE,
      );
    });

    it("refuses the coherent lie no check constraint can catch", async () => {
      // Measured before choosing this design, against a table-level grant:
      //
      //   UPDATE product SET origin='holder', organization_id=NULL   ACCEPTED
      //
      // An issuer-registered product becomes a holder enrolment and loses the
      // company that registered it. `product_holder_has_no_organization` has no
      // opinion because the resulting pair is internally consistent — it asks
      // whether values agree, and they do.
      //
      // The privilege refuses the statement without reading the row, which is
      // why this is written as a grant and not as a constraint.
      await expectSqlState(
        db.execute(
          sql`UPDATE product SET origin = 'holder', organization_id = NULL WHERE id = ${victim}`,
        ),
        SqlState.INSUFFICIENT_PRIVILEGE,
      );
    });

    it("still suspends a product through the path the application uses", async () => {
      // The other half of the criterion, and the half a privilege change is
      // most likely to break. The statement Drizzle emits here, read from its
      // own logger rather than assumed:
      //
      //   update "product" set "status" = $1, "updated_at" = $2
      //   where "product"."id" = $3
      //
      // `updated_at` is in it because `$onUpdate` injects it into every UPDATE
      // this schema emits, and nothing in the application asks for it. A grant
      // of `status` alone reads like the tighter, more careful decision and
      // stops the application dead — measured, and it would have shipped,
      // because no test in this file ran an UPDATE at all before this one.
      //
      // `changeProductStatus` rather than a hand-written UPDATE, because the
      // status and its lifecycle event are one transaction: a bare UPDATE
      // answers TP004 and would have reported a privilege failure as a
      // provenance failure, or the reverse.
      const result = await changeProductStatus(db, {
        productId: victim,
        to: "suspended",
        // Only `authority` may record `product_suspended` — a holder cannot
        // suspend, per `RECORDING_AUTHORITY`. Naming the wrong capacity here
        // returns `unauthorised_actor` without ever issuing the UPDATE, which
        // would have made this test green while measuring nothing.
        actorKind: "authority",
        reason: "theft_report",
      });

      expect(result).toMatchObject({ ok: true, product: { id: victim, status: "suspended" } });
    });
  });

  describe("the boundary that keeps issuance off the API", () => {
    it("cannot insert a credential, attempted rather than looked up", async () => {
      // **This property is part of the security of credential issuance, and it
      // lives here rather than in that code.**
      //
      // `issueCredentialFor` has no terminal check: it issues, and the caller
      // decides whether the secret may be delivered. What stops an endpoint
      // from calling it is not a guard in that file — it is this grant. So the
      // grant is now load-bearing for issuance, and removing it would open a
      // path no code review of `auth/` would catch.
      //
      // The matrix test above already records `credential: ["SELECT"]`, read
      // from `has_table_privilege`. That asks the catalogue. This asks
      // Postgres, by trying, because a catalogue that says one thing while an
      // INSERT succeeds is the disagreement worth finding.
      const [victim] = (await db.execute(
        sql`SELECT id FROM actor ORDER BY id LIMIT 1`,
      )) as unknown as [{ id: string } | undefined];

      await expectSqlState(
        db.execute(sql`
          INSERT INTO credential (actor_id, kind, label, issued_at, handle, secret_digest)
          VALUES (${victim?.id ?? 1}, 'api_key', 'runtime tried to issue', now(),
                  'AAAAAAAAAAA', sha256('x'::bytea))
        `),
        SqlState.INSUFFICIENT_PRIVILEGE,
      );
    });

    it("can still read one, because verifying is its whole job", async () => {
      // The other half. A grant matrix that also stopped the runtime reading
      // `credential` would make authentication impossible, and a test that only
      // asserted the refusal would not notice.
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS reachable FROM credential
      `)) as unknown as [{ reachable: number }];

      expect(rows[0]?.reachable).toBeGreaterThanOrEqual(0);
    });
  });

  describe("what the grant matrix does not decide", () => {
    it("records an event that names nobody, because no constraint asks it to", async () => {
      // **A characterization test, and #153 is the issue that closes it.**
      //
      // Green here means the current boundary is documented and watched. It
      // does not mean a null actor is fine:
      //
      //   this test passes  =  the behaviour is known and pinned
      //   this test passes  !=  actor_id NULL is safe
      //
      // When #153 lands this test fails, and the failure is the notification.
      // Anyone who finds it green and reads no further should land on #153.
      //
      // It is also the honest half of a claim I nearly overstated.
      //
      // `lifecycle_event.actor_id` arrived in 0026 and the API cannot omit it:
      // the repository parameter is required and the compiler enforces it at
      // twenty-five call sites. That is a code guarantee. It is not a database
      // one, and the difference is easy to lose.
      //
      // Two earlier probes as this role were refused — by
      // `lifecycle_event_correction_targets` and by TP003 — and neither refusal
      // was about `actor_id`, so neither proved anything. This combination is
      // the one the authority trigger permits, and it is accepted with no
      // actor at all.
      //
      // So the boundary reads:
      //
      //   the API              an actor is mandatory
      //   a direct SQL write   it is not
      //
      // The day a NOT NULL or a trigger closes that, this test fails, and the
      // failure is the notification. Closing it needs every write path —
      // `insertProductWithProvenance` and the status transitions included — to
      // satisfy it at once, which is why it is a phase rather than an oversight.
      const created = await insertProductWithProvenance(db, {
        trustpassId: generateTrustPassId(),
        organizationId: null,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `NA-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
        category: "gpu",
        status: "registered",
        origin: "holder",
      });

      // `RETURNING` rather than a count afterwards. The row this insert wrote
      // is named, so the assertion is about that row and not about a
      // population that happens to contain it.
      //
      // The count it replaces was already scoped to the suspension, because
      // `insertProductWithProvenance` also writes an event with no actor and
      // counting every unattributed row for this product would have passed
      // whether or not this insert did anything. Scoping fixed that; naming
      // the row removes the inference entirely.
      const inserted = (await db.execute(sql`
        INSERT INTO lifecycle_event (product_id, type, actor_kind, actor_id, organization_id, reason, occurred_at)
        VALUES (${created.id}, 'product_suspended', 'authority', NULL, NULL, 'theft_report', now())
        RETURNING id
      `)) as unknown as { id: string }[];

      const eventId = inserted[0]?.id;

      expect(eventId).toBeDefined();

      const stored = (await db.execute(sql`
        SELECT actor_id, actor_kind, type
        FROM lifecycle_event
        WHERE id = ${eventId}
      `)) as unknown as { actor_id: string | null; actor_kind: string; type: string }[];

      expect(stored).toHaveLength(1);
      expect(stored[0]?.actor_id).toBeNull();
      expect(stored[0]?.actor_kind).toBe("authority");
      expect(stored[0]?.type).toBe("product_suspended");
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
