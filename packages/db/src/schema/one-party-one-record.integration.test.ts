import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";
import { lifecycleEvent } from "./lifecycle-event.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * What the identity migration promised, asserted against whatever is in the
 * database — not against a fixture it built itself.
 *
 * Raised in review, and the distinction matters: a migration tested only
 * against `db:reset` is tested against zero rows, where every "move every
 * reference" loop is trivially correct. These run against the same database the
 * rest of the suite has been filling all week, which at the time of writing
 * meant 376 issuers, 1,563 products and 1,836 events.
 *
 * They are invariants rather than fixtures, so they keep meaning something as
 * the data changes, and they fail if a later migration or write path breaks the
 * correspondence the migration established.
 */
describe.skipIf(!databaseUrl)("one party, one record", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("gives every issuer an organization with the same registry identity", async () => {
    // Matched, not copied. ADR 0012: the migration moves references rather than
    // duplicating parties, so an issuer that already had an organization reuses
    // it. A count of organizations would not catch a second row for one party;
    // asking for issuers with no match does.
    const [row] = await db.execute<{ unmatched: string }>(
      sql`SELECT count(*)::text AS unmatched
          FROM issuer i
          WHERE NOT EXISTS (
            SELECT 1 FROM organization o
            WHERE o.country = i.country
              AND o.registration_number = i.registration_number
          )`,
    );

    expect(row?.unmatched).toBe("0");
  });

  it("moved every product reference without losing one", async () => {
    const [row] = await db.execute<{ unmoved: string; mismatched: string }>(
      sql`SELECT
            count(*) FILTER (WHERE p.organization_id IS NULL)::text AS unmoved,
            count(*) FILTER (
              WHERE p.organization_id IS NOT NULL AND o.id IS DISTINCT FROM p.organization_id
            )::text AS mismatched
          FROM product p
          JOIN issuer i ON i.id = p.issuer_id
          LEFT JOIN organization o
            ON o.country = i.country AND o.registration_number = i.registration_number
          WHERE p.issuer_id IS NOT NULL`,
    );

    // Two questions, because "every product has an organization" and "it has
    // the *right* one" are different, and a backfill joining on the wrong
    // column would satisfy the first.
    expect(row?.unmoved).toBe("0");
    expect(row?.mismatched).toBe("0");
  });

  it("moved every event reference to the same party that recorded it", async () => {
    const [row] = await db.execute<{ unmoved: string; mismatched: string }>(
      sql`SELECT
            count(*) FILTER (WHERE e.organization_id IS NULL)::text AS unmoved,
            count(*) FILTER (
              WHERE e.organization_id IS NOT NULL AND o.id IS DISTINCT FROM e.organization_id
            )::text AS mismatched
          FROM lifecycle_event e
          JOIN issuer i ON i.id = e.issuer_id
          LEFT JOIN organization o
            ON o.country = i.country AND o.registration_number = i.registration_number
          WHERE e.issuer_id IS NOT NULL`,
    );

    expect(row?.unmoved).toBe("0");
    expect(row?.mismatched).toBe("0");
  });

  it("carried the verification status across and invented none", async () => {
    // The migration copies the current value and nothing else. A history could
    // not be carried because none was ever stored — `verification_status` is a
    // mutable column, so anything reconstructed for 2024 would be a plausible
    // fiction, which is the one thing this project refuses to publish.
    const [row] = await db.execute<{ disagreeing: string }>(
      sql`SELECT count(*)::text AS disagreeing
          FROM issuer i
          JOIN organization o
            ON o.country = i.country AND o.registration_number = i.registration_number
          WHERE o.verification_status IS DISTINCT FROM i.verification_status`,
    );

    expect(row?.disagreeing).toBe("0");
  });

  it("left the append-only guard on", async () => {
    // The migration disables `lifecycle_event_no_update` to backfill, inside
    // its transaction. This is the assertion that it came back — and it is
    // worth more than the migration's own postcondition, because that
    // postcondition ran in the same transaction that could have rolled back.
    const [row] = await db.execute<{ enabled: boolean }>(
      sql`SELECT tgenabled <> 'D' AS enabled
          FROM pg_trigger
          WHERE tgrelid = 'lifecycle_event'::regclass
            AND tgname = 'lifecycle_event_no_update'`,
    );

    expect(row?.enabled).toBe(true);
  });

  it("still refuses to edit history afterwards", async () => {
    // The guard being present is not the same as the guard working: a disabled
    // trigger still has a `pg_trigger` row.
    //
    // Writes its own event rather than updating whatever is there. The first
    // version issued an unqualified UPDATE, which on a freshly reset database
    // touches zero rows — so the row trigger never fired, nothing raised, and
    // the test failed for the one reason that has nothing to do with the guard.
    const created = await insertProductWithProvenance(db, {
      trustpassId: generateTrustPassId(),
      organizationId: null,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `GUARD-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      category: "gpu",
      status: "registered",
      origin: "holder",
    });

    await expectSqlState(
      db
        .update(lifecycleEvent)
        .set({ reason: "fraud_flag" })
        .where(eq(lifecycleEvent.productId, created.id)),
      SqlState.HISTORY_IS_APPEND_ONLY,
    );
  });
});
