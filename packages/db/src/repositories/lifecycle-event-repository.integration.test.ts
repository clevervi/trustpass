import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { actor } from "../schema/actor.js";
import { lifecycleEvent } from "../schema/lifecycle-event.js";
import { organization } from "../schema/organization.js";
import { type NewProduct, product } from "../schema/product.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { findHistoryByTrustPassId, findProductHistory } from "./lifecycle-event-repository.js";
import { insertProduct } from "./product-repository.js";
import { changeProductStatus } from "./product-status-repository.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises the registration path's provenance against real Postgres.
 *
 * The property under test is that registering a product and recording where it
 * came from are one act. A mock would let them be two.
 */
describe.skipIf(!databaseUrl)("registration records its own provenance", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let organizationId: number;
  let sequence = 0;

  /**
   * Whoever is recording these. A real row, because `lifecycle_event.actor_id`
   * references `actor` and a write with no identified actor no longer compiles.
   */
  let caller: { actorId: number };

  function build(overrides: Partial<NewProduct> = {}): NewProduct {
    sequence += 1;

    return {
      trustpassId: generateTrustPassId(),
      organizationId,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-PROV-${sequence}`,
      category: "gpu",
      status: "registered",
      ...overrides,
    };
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);

    const [created] = await db
      .insert(organization)
      .values({
        companyName: `Prov ${run}`,
        legalName: `Prov ${run} SAS`,
        registrationNumber: `${run}-PV`,
        country: "CO",
      })
      .returning({ id: organization.id });
    organizationId = created?.id as number;

    const [person] = await db
      .insert(actor)
      .values({ kind: "service", displayName: `${run} caller` })
      .returning({ id: actor.id });

    caller = { actorId: person?.id as number };
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("writes exactly one event when a product is registered", async () => {
    const result = await insertProduct(db, build(), caller);
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`);

    const history = await findProductHistory(db, result.product.id);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      type: "product_registered",
      actorKind: "issuer",
      previousState: null,
      resultingState: null,
    });
  });

  it("records the issuer as the actor, not an anonymous write", async () => {
    const result = await insertProduct(db, build(), caller);
    if (!result.ok) throw new Error("expected success");

    // The length assertion is what makes the `[0]` valid. `product_id` is not
    // unique on `lifecycle_event`, so a query that returns one row today does
    // so by construction rather than by constraint, and construction changes.
    const events = await db
      .select()
      .from(lifecycleEvent)
      .where(eq(lifecycleEvent.productId, result.product.id));

    expect(events).toHaveLength(1);
    const [event] = events;

    // The capacity and the issuer travel together, and the check constraint
    // would have refused one without the other. Asserting it here is about the
    // repository supplying both, not about the constraint.
    expect(event?.actorKind).toBe("issuer");
    expect(event?.organizationId).toBe(organizationId);
  });

  it("dates the event to the product's own creation, not to a second clock", async () => {
    const result = await insertProduct(db, build(), caller);
    if (!result.ok) throw new Error("expected success");

    // Asked of Postgres, not compared in JavaScript.
    //
    // An earlier version of this test compared two `Date` objects and passed
    // while the database disagreed: `timestamptz` holds microseconds, a
    // JavaScript `Date` holds milliseconds, so both sides had already been
    // truncated to the same wrong value. The comparison has to happen where the
    // precision still exists.
    const [row] = await db.execute<{ aligned: boolean }>(sql`
      SELECT e.occurred_at = p.created_at AS aligned
      FROM lifecycle_event e
      JOIN product p ON p.id = e.product_id
      WHERE e.product_id = ${result.product.id}
    `);

    expect(row?.aligned).toBe(true);
  });

  it("says the record began rather than that an issuer committed, for a draft", async () => {
    const result = await insertProduct(db, build({ status: "draft" }), caller);
    if (!result.ok) throw new Error("expected success");

    const history = await findProductHistory(db, result.product.id);

    // A draft claims nothing. Recording it as `product_registered` would be a
    // claim nobody made.
    expect(history[0]?.type).toBe("record_enrolled");
  });

  it("leaves no product behind when the serial is already live", async () => {
    const values = build();
    const first = await insertProduct(db, values, caller);
    if (!first.ok) throw new Error("expected the first insert to succeed");

    const second = await insertProduct(
      db,
      { ...values, trustpassId: generateTrustPassId() },
      caller,
    );

    expect(second).toEqual({ ok: false, reason: "duplicate_live_serial" });

    // The rejection still has to travel out of the transaction as its own
    // outcome. Wrapping the writes must not turn a duplicate into a generic
    // failure, which is what would happen if the constraint name were lost.
    const rows = await db
      .select({ id: product.id })
      .from(product)
      .where(eq(product.serial, values.serial));

    expect(rows).toHaveLength(1);
  });

  it("gives each product its own history", async () => {
    const one = await insertProduct(db, build(), caller);
    const two = await insertProduct(db, build(), caller);
    if (!one.ok || !two.ok) throw new Error("expected both to succeed");

    expect(await findProductHistory(db, one.product.id)).toHaveLength(1);
    expect(await findProductHistory(db, two.product.id)).toHaveLength(1);
  });

  it("cannot be handed a product with no history, because one cannot exist", async () => {
    sequence += 1;

    // This used to insert a bare product and assert the reader returned an
    // empty array. #54 closed that path: a product with no recorded origin is
    // refused at COMMIT, so the case the reader was defending against is now
    // unreachable. The test asserts the closure instead of the defence.
    await expectSqlState(
      db.insert(product).values(build({ serial: `${run}-BARE-${sequence}` })),
      SqlState.PROVENANCE_REQUIRED,
    );
  });

  it("returns nothing for an identifier no product holds", async () => {
    // The case that remains: a well-formed identifier nobody issued. An empty
    // array rather than a failure, because the passport read has already
    // decided whether the product exists.
    expect(await findHistoryByTrustPassId(db, generateTrustPassId())).toEqual([]);
  });

  it("orders history by when things happened, not by when they were recorded", async () => {
    const result = await insertProduct(db, build(), caller);
    if (!result.ok) throw new Error("expected success");

    const march = new Date("2026-03-04T10:00:00Z");
    await db.insert(lifecycleEvent).values({
      productId: result.product.id,
      type: "product_suspended",
      actorKind: "authority",
      occurredAt: march,
      reason: "theft_report",
      previousState: "registered",
      resultingState: "suspended",
    });

    const history = await findProductHistory(db, result.product.id);

    // The suspension happened in March and was recorded just now. Ordering by
    // when it was learned would put it first and tell the story of this
    // system's bookkeeping instead of the story of the product.
    expect(history.map((entry) => entry.type)).toEqual(["product_registered", "product_suspended"]);
  });

  it("does not expose internal keys to a reader", async () => {
    const result = await insertProduct(db, build(), caller);
    if (!result.ok) throw new Error("expected success");

    const [entry] = await findProductHistory(db, result.product.id);

    // ADR 0005. The projection lists its columns, so a column added to the
    // table later cannot start appearing here on its own.
    for (const key of ["id", "productId", "organizationId", "correctsEventId"]) {
      expect(entry).not.toHaveProperty(key);
    }
  });
});

describe.skipIf(!databaseUrl)("history found by the public identifier", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let organizationId: number;
  let caller: { actorId: number };

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);
    const [created] = await db
      .insert(organization)
      .values({
        companyName: `ById ${run}`,
        legalName: `ById ${run} SAS`,
        registrationNumber: `${run}-BI`,
        country: "CO",
      })
      .returning({ id: organization.id });
    organizationId = created?.id as number;

    const [person] = await db
      .insert(actor)
      .values({ kind: "service", displayName: `${run} caller` })
      .returning({ id: actor.id });

    caller = { actorId: person?.id as number };
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("finds a product's history without the caller holding its internal key", async () => {
    const result = await insertProduct(
      db,
      {
        trustpassId: generateTrustPassId(),
        organizationId,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `${run}-BYID`,
        category: "gpu",
        status: "registered",
      },
      caller,
    );
    if (!result.ok) throw new Error("expected success");

    const history = await findHistoryByTrustPassId(db, result.product.trustpassId);

    // The join lives inside this package precisely so the product id never has
    // to leave it. ADR 0005.
    expect(history).toHaveLength(1);
    expect(history[0]?.type).toBe("product_registered");
  });

  it("returns nothing for an identifier that resolves to no product", async () => {
    expect(await findHistoryByTrustPassId(db, generateTrustPassId())).toEqual([]);
  });

  it("does not mix one product's history into another's", async () => {
    const [one, two] = await Promise.all([
      insertProduct(
        db,
        {
          trustpassId: generateTrustPassId(),
          organizationId,
          brand: "ASUS",
          model: "A",
          serial: `${run}-MIX-1`,
          category: "gpu",
          status: "registered",
        },
        caller,
      ),
      insertProduct(
        db,
        {
          trustpassId: generateTrustPassId(),
          organizationId,
          brand: "ASUS",
          model: "B",
          serial: `${run}-MIX-2`,
          category: "gpu",
          status: "registered",
        },
        caller,
      ),
    ]);
    if (!one.ok || !two.ok) throw new Error("expected both");

    await changeProductStatus(db, {
      productId: one.product.id,
      to: "suspended",
      actorKind: "authority",
      reason: "theft_report",
    });

    expect(await findHistoryByTrustPassId(db, one.product.trustpassId)).toHaveLength(2);
    expect(await findHistoryByTrustPassId(db, two.product.trustpassId)).toHaveLength(1);
  });
});
