import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";
import { lifecycleEvent } from "./lifecycle-event.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * One party has one record, and nothing remembers the other one.
 *
 * These asserted the move while both tables existed — every issuer matched to
 * an organization, every reference carried across, verification preserved. They
 * did their work: three failed on their first run and found 21 issuers and 82
 * products that had drifted in the minutes since the migration.
 *
 * `0023` dropped the table, so those four cannot run at all. What replaces them
 * is the question that matters from here: **is there any path left back to the
 * old identity?**
 *
 * Asked of the catalogue rather than of the rows, because a repository scan
 * cannot see it. The three functions `0023` had to drop were not in the
 * repository; they were in migrations that had already run.
 */
describe.skipIf(!databaseUrl)("one party, one record", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  describe("nothing leads back to the old identity", () => {
    it("has no issuer table", async () => {
      const [row] = await db.execute<{ present: boolean }>(
        sql`SELECT to_regclass('public.issuer') IS NOT NULL AS present`,
      );

      expect(row?.present).toBe(false);
    });

    it("has no issuer_id column anywhere", async () => {
      const [row] = await db.execute<{ columns: string }>(
        sql`SELECT count(*)::text AS columns FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'issuer_id'`,
      );

      expect(row?.columns).toBe("0");
    });

    it("has no index built on a column that no longer exists", async () => {
      const [row] = await db.execute<{ indexes: string }>(
        sql`SELECT count(*)::text AS indexes FROM pg_indexes
            WHERE schemaname = 'public' AND indexdef ILIKE '%issuer_id%'`,
      );

      expect(row?.indexes).toBe("0");
    });

    it("has no function left behind by the table that is gone", async () => {
      // The one a repository scan could never have found. A trigger vanishes
      // with its table; its function does not, and a dead trigger function
      // outliving its table is something somebody later wires to something
      // else.
      const [row] = await db.execute<{ functions: string }>(
        sql`SELECT count(*)::text AS functions
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND (p.prosrc ILIKE '%from issuer%'
                OR p.prosrc ILIKE '%issuer_id%'
                OR p.proname ILIKE '%issuer%')`,
      );

      expect(row?.functions).toBe("0");
    });

    it("keeps the capacity called issuer, which was never the table", async () => {
      // The distinction the whole migration rested on, asserted so a future
      // cleanup does not helpfully remove it. `actor_kind = 'issuer'` is a role
      // an organization plays; the table was an identity. Dropping the enum
      // value would silently reinterpret every event ever recorded by one.
      const [row] = await db.execute<{ present: boolean }>(
        sql`SELECT 'issuer' = ANY (enum_range(NULL::lifecycle_actor_kind)::text[]) AS present`,
      );

      expect(row?.present).toBe(true);
    });
  });

  describe("the guarantees survived the drop", () => {
    it("left the append-only guard on", async () => {
      const [row] = await db.execute<{ enabled: boolean }>(
        sql`SELECT tgenabled <> 'D' AS enabled
            FROM pg_trigger
            WHERE tgrelid = 'lifecycle_event'::regclass
              AND tgname = 'lifecycle_event_no_update'`,
      );

      expect(row?.enabled).toBe(true);
    });

    it("still refuses to edit history", async () => {
      // A trigger being present is not the same as it working, and `0023`
      // dropped four triggers by name — one keystroke from dropping a fifth.
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
});
