/**
 * The fingerprint against a real catalogue.
 *
 * The unit tests beside this one prove the refusal fires and the comparison can
 * tell a difference. They cannot prove the eleven queries still match anything —
 * a catalogue view renamed, a filter tightened, a schema moved, and each one
 * returns an empty set that compares equal to itself forever. That is what this
 * file is for, and it is the reason the refusal exists rather than a duplicate
 * of it.
 *
 * **Every mutation here runs inside a transaction that rolls back.** Vitest runs
 * test files in parallel against one database, and the residue being created is
 * a privilege escalation — a committed `GRANT UPDATE (serial)` would be visible
 * to every other suite for as long as this one held it, and a test that has to
 * be trusted to clean up after itself is a test that eventually does not.
 *
 * **Note on locks, and an unresolved observation.** The two mutating tests hold a
 * lock on the object they change — `ALTER TABLE ... DISABLE TRIGGER` takes ACCESS
 * EXCLUSIVE — for as long as the transaction lives, which is one fingerprint,
 * roughly thirty milliseconds. Fifteen runs of the full package suite were made
 * against one cluster: fourteen were clean at 505 of 505, and one reported 502
 * without its output being captured. The lock window is the obvious suspect and
 * it is a suspect, not a finding. Recorded rather than rounded down to "flaky",
 * because the next person to see it should know it has been seen once.
 *
 * Skips without DATABASE_URL, because a password cannot live in the repository.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import {
  fingerprintDifferences,
  missingSections,
  schemaFingerprint,
} from "./schema-fingerprint.js";

const databaseUrl = process.env.DATABASE_URL;

/** Rolls back whatever the callback did, and returns what it computed. */
async function withRollback<T>(db: Database, run: (tx: never) => Promise<T>): Promise<T> {
  let captured: T | undefined;
  let ran = false;

  try {
    await db.transaction(async (tx) => {
      captured = await run(tx as never);
      ran = true;
      tx.rollback();
    });
  } catch (error) {
    // `tx.rollback()` signals by throwing, which is Drizzle's contract. Anything
    // thrown before the callback finished is a real failure and must surface —
    // swallowing it would turn a broken test into a passing one.
    if (!ran) throw error;
  }

  return captured as T;
}

describe.skipIf(!databaseUrl)("run the schema fingerprint against Postgres", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(databaseUrl ?? "");
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("answers with every section, none of them having measured nothing", async () => {
    const fingerprint = await schemaFingerprint(db);

    expect(missingSections(fingerprint)).toEqual([]);
  });

  it("finds the objects the migrations created, not an empty set that compares equal", async () => {
    const fingerprint = await schemaFingerprint(db);

    // Named literally rather than counted. A count would pass against a
    // catalogue query that matched the wrong things in the right number.
    expect(fingerprint.tables).toContain("product");
    expect(fingerprint.tables).toContain("lifecycle_event");
    expect(fingerprint.enumLabels).toContain("product_status.registered");
    expect(fingerprint.triggers.some((t) => t.startsWith("product."))).toBe(true);

    // The column's full descriptor, written out. An earlier version asked
    // whether the list contained a value it had just found in that same list,
    // which is true of any list and says nothing — the tautology
    // `CONTRIBUTING.md` names. A type or a nullability changing out of band is
    // exactly what this section is for, so the assertion has to carry both.
    expect(fingerprint.columns).toContain("product.serial character varying(120) NOT NULL");
  });

  // There was a test here asserting that two fingerprints of an untouched
  // database are identical. It failed, and it was the test that was wrong:
  //
  //   + functions: tp_probe_fn 50255ff8740daa71862fb2aabdbccbcb
  //   - roleMemberships: tp_probe_member -> tp_probe_owner
  //
  // Neither is this file's. Vitest runs test files in parallel against one
  // database, and the attack suites create and drop catalogue objects while this
  // one is reading. The database was not unchanged, so "unchanged" was never a
  // premise this environment can supply — the same shape as asserting a global
  // `count(*)`, which `CONTRIBUTING.md` already warns about.
  //
  // Reflexivity is proved in the unit tests, where the input is a value rather
  // than a shared cluster. What survives here is that every assertion below is
  // `toContain` or `some`, deliberately: this file asks whether a specific
  // difference appeared, never whether it was the only one.

  it("sees a column privilege granted to the runtime, which a table grant hides", async () => {
    // The measured reason `columnPrivileges` is a section at all:
    // `role_table_grants` reports only SELECT and INSERT for the runtime on
    // `product`, so an `UPDATE` on one column leaves that view untouched.
    const differences = await withRollback(db, async (tx) => {
      const before = await schemaFingerprint(tx);

      await (tx as unknown as Database).execute(
        sql`GRANT UPDATE (serial) ON product TO trustpass_runtime`,
      );

      const after = await schemaFingerprint(tx);

      expect(after.tablePrivileges).toEqual(before.tablePrivileges);

      return fingerprintDifferences(before, after);
    });

    expect(differences).toContain("+ columnPrivileges: trustpass_runtime product.serial UPDATE");
  });

  it("sees a trigger disabled while it stays listed in the catalogue", async () => {
    const differences = await withRollback(db, async (tx) => {
      const before = await schemaFingerprint(tx);
      const target = before.triggers[0];

      // Not a type ceremony. An empty `triggers` section would make the rest of
      // this test disable nothing and then assert nothing changed, which passes.
      if (target === undefined) throw new Error("the fingerprint found no triggers to disable");

      const table = target.slice(0, target.indexOf("."));
      const rest = target.slice(target.indexOf(".") + 1);
      const name = rest.slice(0, rest.lastIndexOf(" "));

      await (tx as unknown as Database).execute(
        sql`ALTER TABLE ${sql.identifier(table)} DISABLE TRIGGER ${sql.identifier(name)}`,
      );

      const after = await schemaFingerprint(tx);

      // Still there, still named, still attached. Only `tgenabled` moved, which
      // is why a section listing trigger names alone would report IDENTICAL.
      expect(after.triggers).toHaveLength(before.triggers.length);

      return fingerprintDifferences(before, after);
    });

    expect(differences.some((d) => d.startsWith("+ triggers:") && d.endsWith(" D"))).toBe(true);
  });

  it("leaves nothing behind, which is the property the rollback is for", async () => {
    const after = await schemaFingerprint(db);

    // Scoped to the one grant this file creates. An earlier version also
    // asserted that no trigger anywhere was disabled, which is a claim about the
    // whole cluster and so a claim about what every other suite is doing — the
    // same mistake as the stability test removed above, one file further along.
    expect(after.columnPrivileges).not.toContain("trustpass_runtime product.serial UPDATE");
  });
});
