import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";
import { lifecycleEvent } from "./lifecycle-event.js";
import { product } from "./product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Nothing exists, and nothing moves, without a recorded reason.
 *
 * TP-051 and TP-052 made the known write paths do this. These tests are about
 * the paths nobody has written yet: a bulk import, a migration, a console
 * session. Per ADR 0008 that failure is invisible, because nothing later can
 * distinguish a history that is missing from one that is empty.
 */
describe.skipIf(!databaseUrl)("provenance is guaranteed, not conventional", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let n = 0;

  function values() {
    n += 1;
    return {
      trustpassId: generateTrustPassId(),
      issuerId: null,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-PROV-${n}`,
      category: "gpu" as const,
      status: "registered" as const,
      origin: "holder" as const,
    };
  }

  beforeAll(() => {
    db = createDatabase(databaseUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("refuses a product written with no event to explain it", async () => {
    await expectSqlState(db.insert(product).values(values()), SqlState.PROVENANCE_REQUIRED);
  });

  it("accepts the product when the event is written in the same transaction", async () => {
    const created = await insertProductWithProvenance(db, values());

    expect(created.id).toBeGreaterThan(0);
  });

  it("refuses a status change written with no event to explain it", async () => {
    const created = await insertProductWithProvenance(db, values());

    // The guard that matters most for the paths nobody has written yet. A
    // product that became suspended for no recorded reason can never be
    // explained afterwards, because the history is append-only.
    await expectSqlState(
      db.update(product).set({ status: "suspended" }).where(eq(product.id, created.id)),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it("accepts the status change when the event is written in the same transaction", async () => {
    const created = await insertProductWithProvenance(db, values());

    await db.transaction(async (tx) => {
      await tx.update(product).set({ status: "suspended" }).where(eq(product.id, created.id));
      await tx.insert(lifecycleEvent).values({
        productId: created.id,
        type: "product_suspended",
        actorKind: "authority",
        issuerId: null,
        // now(), not a Date: recorded_at defaults to the transaction
        // timestamp, and a Date read afterwards is later than it.
        occurredAt: sql`now()` as unknown as Date,
        reason: "theft_report",
        previousState: "registered",
        resultingState: "suspended",
      });
    });

    const [row] = await db.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("suspended");
  });

  it("does not accept an event from an earlier transaction as an explanation", async () => {
    const created = await insertProductWithProvenance(db, values());

    await db.transaction(async (tx) => {
      await tx.update(product).set({ status: "suspended" }).where(eq(product.id, created.id));
      await tx.insert(lifecycleEvent).values({
        productId: created.id,
        type: "product_suspended",
        actorKind: "authority",
        issuerId: null,
        // now(), not a Date: recorded_at defaults to the transaction
        // timestamp, and a Date read afterwards is later than it.
        occurredAt: sql`now()` as unknown as Date,
        reason: "theft_report",
        previousState: "registered",
        resultingState: "suspended",
      });
    });

    await db.transaction(async (tx) => {
      await tx.update(product).set({ status: "registered" }).where(eq(product.id, created.id));
      await tx.insert(lifecycleEvent).values({
        productId: created.id,
        type: "product_reinstated",
        actorKind: "authority",
        issuerId: null,
        // now(), not a Date: recorded_at defaults to the transaction
        // timestamp, and a Date read afterwards is later than it.
        occurredAt: sql`now()` as unknown as Date,
        reason: "dispute_resolved",
        previousState: "suspended",
        resultingState: "registered",
      });
    });

    // The same move again, with no new event. The first suspension's event is
    // still in the table and matches registered -> suspended, so a check
    // scoped to history rather than to this transaction would accept it and
    // leave the third move unexplained while looking accounted for.
    await expectSqlState(
      db.update(product).set({ status: "suspended" }).where(eq(product.id, created.id)),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it("still reports an illegal move as illegal, not as unexplained", async () => {
    const created = await insertProductWithProvenance(db, values());

    // The status guard raises immediately; the provenance triggers fire at
    // COMMIT. A caller is told the move was not allowed rather than that it
    // forgot to explain a move it was never going to be permitted to make.
    await expectSqlState(
      db.update(product).set({ status: "draft" }).where(eq(product.id, created.id)),
      SqlState.ILLEGAL_STATUS_TRANSITION,
    );
  });
});
