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
 * **Nothing here writes**, and the note at the bottom of this file is why. Two
 * tests used to create their own evidence inside rolled-back transactions; #207
 * has the deadlock that cost, and the measurement showing neither needed to.
 * Read that before adding a test that changes anything — this database is shared
 * with twenty-seven other files running at the same time.
 *
 * Skips without DATABASE_URL, because a password cannot live in the repository.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { missingSections, schemaFingerprint } from "./schema-fingerprint.js";

const databaseUrl = process.env.DATABASE_URL;

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
  // than a shared cluster. What survives here is the rule that produced it:
  // **no assertion may depend on what another suite is doing.** So the cases
  // below name specific rows, and the one that does look at every row —
  // `carries every trigger's enabled state` — asks about the *shape* of each
  // value rather than its content. A trigger another file disables still matches
  // it, which is the point.

  it("sees a column privilege that a table grant hides, without creating one", async () => {
    // The measured reason `columnPrivileges` is a section at all — and it does
    // not need to be manufactured, because #157 already put it there.
    //
    // An earlier version granted `UPDATE (serial)` inside a rolled-back
    // transaction to make the asymmetry appear. Measured first, before changing
    // anything: the runtime already holds column-level `UPDATE` on `status` and
    // `updated_at` and no table-level `UPDATE` at all. The grant was a third
    // instance of something already true twice — and it was the weaker instance,
    // because `serial` is a column this project deliberately keeps unupdatable,
    // so the test asserted against a privilege that must never exist instead of
    // against the two that do.
    const fingerprint = await schemaFingerprint(db);

    expect(fingerprint.columnPrivileges).toContain("trustpass_runtime product.status UPDATE");
    expect(fingerprint.columnPrivileges).toContain("trustpass_runtime product.updated_at UPDATE");

    // The hiding half. Without this line the case above is just "a grant
    // exists", which `least-privilege.integration.test.ts` already says better.
    expect(fingerprint.tablePrivileges).not.toContain("trustpass_runtime product UPDATE");
  });

  it("carries every trigger's enabled state, which is what a name-only list loses", async () => {
    // A disabled trigger is still listed in `pg_trigger`, still named, still
    // attached — so a section holding names alone reports no difference for one
    // that has been switched off. `tgenabled` is what makes that visible, and
    // whether it reaches the value is answerable by reading.
    //
    // An earlier version proved it by running `ALTER TABLE … DISABLE TRIGGER`.
    // That is a stronger-looking test and a weaker one: it took ACCESS EXCLUSIVE
    // on a table twenty-seven other files write to. What it added over this was
    // that a change in the state produces a difference — and
    // `fingerprintDifferences` already proves that against `O` and `D` fixtures,
    // in a unit test, where it can also be mutation-checked.
    const fingerprint = await schemaFingerprint(db);

    expect(fingerprint.triggers.length).toBeGreaterThan(0);

    // Every row, not some. One row carrying a state while the rest silently lost
    // theirs is the shape a `some()` would pass.
    const withoutState = fingerprint.triggers.filter((row) => !/ [ODRA]$/.test(row));

    expect(withoutState).toEqual([]);
  });
});

/**
 * **Nothing in this file writes, and #207 is why.**
 *
 * Two tests here created their own evidence — `GRANT UPDATE (serial)` and
 * `ALTER TABLE … DISABLE TRIGGER`, inside transactions that rolled back. They
 * passed. They also held ACCESS EXCLUSIVE on tables that twenty-seven other
 * files write to, and the same pattern in #162 produced a deadlock with both
 * lock modes and both process ids printed:
 *
 * ```
 * 40P01  Process 263 waits for RowExclusiveLock on relation 16554;
 *                    blocked by process 281.
 *        Process 281 waits for AccessExclusiveLock on relation 16711;
 *                    blocked by process 263.
 * ```
 *
 * **The fix was not synchronisation.** Before changing anything, each test was
 * asked whether its DDL was necessary for the property it claimed. Measured on a
 * migrated cluster:
 *
 * - the runtime already holds column-level `UPDATE` on `status` and
 *   `updated_at`, and no table-level `UPDATE` at all — so the asymmetry the
 *   grant manufactured was already present, twice;
 * - all seventeen trigger rows already carry an enabled state, so nothing had to
 *   be disabled to see that the field reaches the value.
 *
 * Neither was necessary. What the DDL genuinely added — that a *change* produces
 * a difference — is proved in `schema-fingerprint.test.ts` against fixtures,
 * which is also the only place the mutation runner can reach, since the
 * `Mutations` workflow has no Postgres service.
 *
 * A retry, a timeout or a lock ordering would have kept two tests that were
 * asking a shared cluster to demonstrate something a fixture demonstrates
 * better.
 */
