import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import {
  holderProducts,
  type MovableStatus,
  transitionEventValues,
} from "../testing/provenance-fixtures.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";
import { lifecycleEvent, type NewLifecycleEvent } from "./lifecycle-event.js";
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
  const values = holderProducts(`${run}-PROV`);
  let db: Database;

  /** A status change and the event explaining it, together — the legal shape. */
  async function moveWithReason(
    productId: number,
    from: "registered" | "suspended",
    to: "registered" | "suspended",
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.update(product).set({ status: to }).where(eq(product.id, productId));
      await tx.insert(lifecycleEvent).values({
        productId,
        type: to === "suspended" ? "product_suspended" : "product_reinstated",
        actorKind: "authority",
        organizationId: null,
        // now(), not a Date: recorded_at defaults to the transaction timestamp,
        // and a Date read afterwards is later than it.
        occurredAt: sql`now()` as unknown as Date,
        reason: to === "suspended" ? "theft_report" : "dispute_resolved",
        previousState: from,
        resultingState: to,
      });
    });
  }

  /** A batch of status moves and hand-written events, as one transaction. */
  function inOneTransaction(
    moves: readonly { id: number; to: "registered" | "suspended" | "retired" }[],
    events: readonly { id: number; from: MovableStatus; to: MovableStatus }[],
  ) {
    return db.transaction(async (tx) => {
      for (const move of moves) {
        await tx.update(product).set({ status: move.to }).where(eq(product.id, move.id));
      }
      for (const event of events) {
        await tx
          .insert(lifecycleEvent)
          .values(transitionEventValues(event.id, event.from, event.to));
      }
    });
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

    await moveWithReason(created.id, "registered", "suspended");

    const [row] = await db.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe("suspended");
  });

  it("does not accept an event from an earlier transaction as an explanation", async () => {
    const created = await insertProductWithProvenance(db, values());

    await moveWithReason(created.id, "registered", "suspended");

    await moveWithReason(created.id, "suspended", "registered");

    // The same move again, with no new event. The first suspension's event is
    // still in the table and matches registered -> suspended, so a check
    // scoped to history rather than to this transaction would accept it and
    // leave the third move unexplained while looking accounted for.
    await expectSqlState(
      db.update(product).set({ status: "suspended" }).where(eq(product.id, created.id)),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it("does not accept an event planted with a future recorded_at", async () => {
    const created = await insertProductWithProvenance(db, values());

    // The attack the trigger was open to until 0015. Every rule in this file
    // scopes "this transaction" by recorded_at, and recorded_at was a column
    // the writer chose — so an event planted ten years ahead, alone in an
    // earlier transaction, satisfied a later move that recorded nothing at all.
    //
    // Measured before the fix: the plant was accepted, and the move committed.
    // A status change with no reason in its transaction, on an append-only
    // history that could never be corrected afterwards.
    await db.insert(lifecycleEvent).values({
      ...transitionEventValues(created.id, "registered", "suspended"),
      recordedAt: sql`now() + interval '10 years'`,
    } as unknown as NewLifecycleEvent);

    await expectSqlState(
      db.update(product).set({ status: "suspended" }).where(eq(product.id, created.id)),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it.each([
    {
      name: "one event explaining two identical moves",
      moves: ["suspended", "registered", "suspended"],
      events: [
        ["registered", "suspended"],
        ["suspended", "registered"],
      ],
    },
    {
      name: "an event that describes a different move",
      moves: ["retired"],
      events: [["suspended", "registered"]],
    },
  ] as const)("refuses $name", async ({ moves, events }) => {
    // The first case is the hole #54 left open: moves one and three share a
    // (previous, resulting) pair, so a check asking whether *some* matching
    // event exists accepts the third on the strength of the first's event.
    //
    // The second shows the rule is one move per transaction rather than
    // balanced bookkeeping — counting a trigger's own firings from inside a row
    // trigger is not possible, so the correspondence is made 1:1 by
    // construction instead.
    //
    // The third shows counting alone is not enough: one event, one move, and
    // they describe different transitions.
    const created = await insertProductWithProvenance(db, values());
    if (moves[0] === "retired") await moveWithReason(created.id, "registered", "suspended");

    await expectSqlState(
      inOneTransaction(
        moves.map((to) => ({ id: created.id, to })),
        events.map(([from, to]) => ({ id: created.id, from, to })),
      ),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it.each([
    { name: "two moves, each with its own event", moves: 2 },
    { name: "three moves, each with its own event", moves: 3 },
  ])("accepts $name", async ({ moves }) => {
    // The events have to account for every move, not be limited to one. A
    // transaction deliberately moving a product twice with a recorded reason
    // for each has nothing to hide, and an earlier rule refused it — raised in
    // review, and the objection was right.
    const created = await insertProductWithProvenance(db, values());
    const path = Array.from({ length: moves }, (_, i) =>
      i % 2 === 0 ? ("suspended" as const) : ("registered" as const),
    );

    await inOneTransaction(
      path.map((to) => ({ id: created.id, to })),
      path.map((to, i) => ({
        id: created.id,
        from:
          i === 0
            ? ("registered" as const)
            : path[i - 1] === "suspended"
              ? ("suspended" as const)
              : ("registered" as const),
        to,
      })),
    );

    const [row] = await db.select().from(product).where(eq(product.id, created.id));
    expect(row?.status).toBe(path[path.length - 1]);
  });

  it("refuses events that do not form an unbroken path", async () => {
    const created = await insertProductWithProvenance(db, values());

    // Two events that each describe a legal move but do not connect: the
    // second starts where the first did, not where it ended. A count would
    // accept this; the chain does not.
    await expectSqlState(
      inOneTransaction(
        [
          { id: created.id, to: "suspended" },
          { id: created.id, to: "registered" },
        ],
        [
          { id: created.id, from: "registered", to: "suspended" },
          { id: created.id, from: "registered", to: "suspended" },
        ],
      ),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it("refuses a second product moved without its own event", async () => {
    const a = await insertProductWithProvenance(db, values());
    const b = await insertProductWithProvenance(db, values());

    // Row-level, so each product's firing looks for its own event. Verified
    // rather than assumed when review raised it.
    await expectSqlState(
      inOneTransaction(
        [
          { id: a.id, to: "suspended" },
          { id: b.id, to: "suspended" },
        ],
        [{ id: a.id, from: "registered", to: "suspended" }],
      ),
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
