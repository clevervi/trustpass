import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../client.js";
import { twoConnections, whileHoldingATransaction } from "../testing/overlapping-transactions.js";
import { holderProducts, transitionEventValues } from "../testing/provenance-fixtures.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";
import { lifecycleEvent } from "./lifecycle-event.js";
import { product } from "./product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Provenance holds when two transactions overlap.
 *
 * `provenance.integration.test.ts` asserts the same guarantees on a single
 * connection, and every one of them passed while this did not hold. That is the
 * point of the file: two transactions that never overlap cannot borrow from
 * each other, so a suite built only from them is green whatever the answer to
 * "does this event belong to my transaction" turns out to be.
 *
 * Until 0016 the answer was `recorded_at >= transaction_timestamp()`, which is
 * a time range. Under READ COMMITTED anything another transaction committed
 * while this one was open fell inside it.
 */
describe.skipIf(!databaseUrl)("provenance holds across concurrent transactions", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  const values = holderProducts(`${run}-CONC`);
  let pool: ReturnType<typeof twoConnections>;
  let holder: Database;
  let other: Database;

  beforeAll(() => {
    pool = twoConnections(databaseUrl as string);
    holder = pool.holder;
    other = pool.other;
  });

  afterAll(async () => {
    await pool.close();
  });

  it("refuses A's move when only B recorded an event for it", async () => {
    const created = await insertProductWithProvenance(holder, values());

    // The defect, exactly as reproduced on #82. B's event matches the move A is
    // about to make and is committed and visible; it explains nothing, because
    // B is not A and did not decide to move anything.
    await expectSqlState(
      whileHoldingATransaction({
        holder,
        other,
        otherCommits: (b) =>
          b
            .insert(lifecycleEvent)
            .values(transitionEventValues(created.id, "registered", "suspended")),
        holderThen: (a) =>
          a.update(product).set({ status: "suspended" }).where(eq(product.id, created.id)),
      }),
      SqlState.PROVENANCE_REQUIRED,
    );

    const [row] = await holder.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("registered");
  });

  it("accepts A's move when A recorded its own event, even while B commits one too", async () => {
    const created = await insertProductWithProvenance(holder, values());

    // The other half, and the half a too-broad guard would fail. Refusing
    // everything that overlaps would also pass the test above, and would be
    // useless: concurrency is normal, borrowing is not.
    await whileHoldingATransaction({
      holder,
      other,
      otherCommits: (b) =>
        b
          .insert(lifecycleEvent)
          .values(transitionEventValues(created.id, "registered", "suspended")),
      holderThen: async (a) => {
        await a.update(product).set({ status: "suspended" }).where(eq(product.id, created.id));
        await a
          .insert(lifecycleEvent)
          .values(transitionEventValues(created.id, "registered", "suspended"));
      },
    });

    const [row] = await holder.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("suspended");
  });

  it("does not let B's event break a chain A recorded correctly", async () => {
    const created = await insertProductWithProvenance(holder, values());

    // Two moves and two events, all A's, with a committed event from B sitting
    // in the table ahead of them. A time window pulls B's row into the chain
    // and reports a path that does not connect, refusing a transaction that did
    // everything right.
    //
    // B's event duplicates A's first move on purpose. An earlier version had B
    // write `suspended -> registered`, which happens to chain cleanly in front
    // of A's two events, so the test passed under the time window as well —
    // green for a reason it did not name, and found only by mutating. The
    // values here are chosen so the broken chain is the one B causes.
    await whileHoldingATransaction({
      holder,
      other,
      otherCommits: (b) =>
        b
          .insert(lifecycleEvent)
          .values(transitionEventValues(created.id, "registered", "suspended")),
      holderThen: async (a) => {
        await a.update(product).set({ status: "suspended" }).where(eq(product.id, created.id));
        await a.update(product).set({ status: "registered" }).where(eq(product.id, created.id));
        await a
          .insert(lifecycleEvent)
          .values(transitionEventValues(created.id, "registered", "suspended"));
        await a
          .insert(lifecycleEvent)
          .values(transitionEventValues(created.id, "suspended", "registered"));
      },
    });

    const [row] = await holder.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("registered");
  });

  it("counts an event written inside a savepoint as the transaction's own", async () => {
    const created = await insertProductWithProvenance(holder, values());

    // pg_current_xact_id() returns the top-level transaction id, so a retry or
    // a partial rollback still records against the transaction that will
    // actually commit. If it returned the subtransaction's id instead, every
    // write path using a savepoint would suddenly be unable to explain itself —
    // and Drizzle implements a nested transaction as exactly that.
    await holder.transaction(async (a) => {
      await a.update(product).set({ status: "suspended" }).where(eq(product.id, created.id));

      await a.transaction(async (savepoint) => {
        await savepoint
          .insert(lifecycleEvent)
          .values(transitionEventValues(created.id, "registered", "suspended"));
      });
    });

    const [row] = await holder.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("suspended");
  });

  it("still refuses a move whose event was rolled back to a savepoint", async () => {
    const created = await insertProductWithProvenance(holder, values());

    // The other side of the same decision. The unit of provenance is the
    // commit, so an event undone before COMMIT never existed and cannot explain
    // anything — which is the behaviour wanted, and it is worth pinning rather
    // than inferring from the previous test.
    await expectSqlState(
      holder.transaction(async (a) => {
        await a.update(product).set({ status: "suspended" }).where(eq(product.id, created.id));

        await a
          .transaction(async (savepoint) => {
            await savepoint
              .insert(lifecycleEvent)
              .values(transitionEventValues(created.id, "registered", "suspended"));
            throw new Error("roll this savepoint back");
          })
          .catch(() => undefined);
      }),
      SqlState.PROVENANCE_REQUIRED,
    );

    const [row] = await holder.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("registered");
  });
});
