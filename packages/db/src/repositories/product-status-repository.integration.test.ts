import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { issuer } from "../schema/issuer.js";
import { lifecycleEvent } from "../schema/lifecycle-event.js";
import { product } from "../schema/product.js";
import { findProductHistory } from "./lifecycle-event-repository.js";
import { changeProductStatus } from "./product-status-repository.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises status changes against real Postgres.
 *
 * The transition rules live in a trigger and the append-only rule lives in
 * another. Neither exists in TypeScript, so a mock would assert nothing that
 * holds in production.
 */
describe.skipIf(!databaseUrl)("changing a product's status records why", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let issuerId: number;
  let sequence = 0;

  async function aProduct(status: "draft" | "registered" = "registered"): Promise<number> {
    sequence += 1;
    const [created] = await db
      .insert(product)
      .values({
        trustpassId: generateTrustPassId(),
        issuerId,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `${run}-ST-${sequence}`,
        category: "gpu",
        status,
      })
      .returning({ id: product.id });

    return created?.id as number;
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);

    const [created] = await db
      .insert(issuer)
      .values({
        companyName: `Status ${run}`,
        legalName: `Status ${run} SAS`,
        registrationNumber: `${run}-ST`,
        country: "CO",
      })
      .returning({ id: issuer.id });
    issuerId = created?.id as number;
  });

  afterAll(async () => {
    // Nothing is deleted: products that changed status now carry events, and
    // events cannot be removed. See TP-051.
    await db.$client.end();
  });

  describe("the move and the reason are one act", () => {
    it("records both ends of the transition", async () => {
      const id = await aProduct();

      const result = await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
        sourceReference: "CASE-4471",
      });

      expect(result).toMatchObject({ ok: true });
      const [event] = await findProductHistory(db, id);

      expect(event).toMatchObject({
        type: "product_suspended",
        actorKind: "authority",
        reason: "theft_report",
        previousState: "registered",
        resultingState: "suspended",
      });
    });

    it("moves the product itself, not only the history", async () => {
      const id = await aProduct();

      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "fraud_flag",
      });

      const [row] = await db.select().from(product).where(eq(product.id, id));

      expect(row?.status).toBe("suspended");
    });

    it("keeps the source reference, which is a handle and not a claim", async () => {
      const id = await aProduct();

      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
        sourceReference: "POL-2026-8891",
      });

      const [event] = await db
        .select()
        .from(lifecycleEvent)
        .where(eq(lifecycleEvent.productId, id));

      expect(event?.sourceReference).toBe("POL-2026-8891");
    });

    it("dates the event to when it happened in the world, when that differs", async () => {
      const id = await aProduct();
      const lastMonth = new Date("2026-08-14T09:30:00Z");

      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
        occurredAt: lastMonth,
      });

      const [event] = await findProductHistory(db, id);

      // A theft reported today may have happened last month, and the passport
      // should say when the theft was, not when the paperwork reached us.
      expect(event?.occurredAt.toISOString()).toBe(lastMonth.toISOString());
      expect(event?.recordedAt.getTime()).toBeGreaterThan(lastMonth.getTime());
    });
  });

  describe("the event type reads both ends, not just the destination", () => {
    it("calls a first commitment a registration", async () => {
      const id = await aProduct("draft");

      await changeProductStatus(db, {
        productId: id,
        to: "registered",
        actorKind: "issuer",
        issuerId,
        reason: "issuer_request",
      });

      expect((await findProductHistory(db, id))[0]?.type).toBe("product_registered");
    });

    it("calls a lifted suspension a reinstatement", async () => {
      const id = await aProduct();

      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });
      await changeProductStatus(db, {
        productId: id,
        to: "registered",
        actorKind: "authority",
        reason: "investigation_closed",
      });

      const history = await findProductHistory(db, id);

      // Recording this as another "registered" would lose the fact that
      // something was once wrong — which is the fact a buyer most needs.
      expect(history.map((entry) => entry.type)).toEqual([
        "product_reinstated",
        "product_suspended",
      ]);
    });
  });

  describe("a refused move records nothing", () => {
    it("reports an illegal transition as an outcome, not an exception", async () => {
      const id = await aProduct();
      await changeProductStatus(db, {
        productId: id,
        to: "retired",
        actorKind: "issuer",
        issuerId,
        reason: "end_of_life",
      });

      // retired is terminal.
      const result = await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });

      expect(result).toEqual({
        ok: false,
        reason: "illegal_transition",
        from: "retired",
        to: "suspended",
      });
    });

    it("leaves no event behind when the move was refused", async () => {
      const id = await aProduct();
      await changeProductStatus(db, {
        productId: id,
        to: "retired",
        actorKind: "issuer",
        issuerId,
        reason: "end_of_life",
      });

      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });

      const history = await findProductHistory(db, id);

      // One event, from the retirement. A rejected move that still wrote its
      // event would put a lie in a record that cannot be corrected by deletion.
      expect(history).toHaveLength(1);
      expect(history[0]?.type).toBe("product_retired");
    });

    it("reports a product that does not exist", async () => {
      const result = await changeProductStatus(db, {
        productId: -1,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });

      expect(result).toEqual({ ok: false, reason: "not_found" });
    });

    it("records nothing when the status is already what was asked for", async () => {
      const id = await aProduct();
      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });

      const result = await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "fraud_flag",
      });

      expect(result).toMatchObject({ ok: true });
      // Nothing moved, so nothing happened. An event here would claim a product
      // was suspended twice.
      expect(await findProductHistory(db, id)).toHaveLength(1);
    });
  });

  describe("the history forms an unbroken chain", () => {
    it("keeps each event starting where the previous one ended", async () => {
      const id = await aProduct();

      // Two changes issued together.
      //
      // **This does not reliably reproduce a race, and it is not claimed to.**
      // Both calls are fast enough that they usually serialise on their own —
      // measured at ~13ms apart — so removing the `FOR UPDATE` in the
      // repository leaves this test green. It was written as a concurrency test
      // and does not earn that name.
      //
      // What it does assert is the invariant that makes a history readable at
      // all, under whatever interleaving actually occurs. Reproducing the
      // interleaving deterministically would need transaction control that
      // `changeProductStatus` deliberately does not expose, so the lock is a
      // defensive measure with no test that can fail when it is removed. Said
      // plainly rather than papered over.
      await Promise.allSettled([
        changeProductStatus(db, {
          productId: id,
          to: "suspended",
          actorKind: "authority",
          reason: "theft_report",
        }),
        changeProductStatus(db, {
          productId: id,
          to: "retired",
          actorKind: "issuer",
          issuerId,
          reason: "end_of_life",
        }),
      ]);

      const history = await findProductHistory(db, id);
      const oldestFirst = [...history].reverse();

      // The invariant that makes a history readable at all: each event starts
      // where the previous one ended. A break in the chain means the record
      // describes a product that took a step it never took.
      let expected: string | null = "registered";
      for (const entry of oldestFirst) {
        expect(entry.previousState).toBe(expected);
        expected = entry.resultingState;
      }

      const [row] = await db.select().from(product).where(eq(product.id, id));
      expect(row?.status).toBe(expected);
    });
  });

  describe("history accumulates in the order things happened", () => {
    it("keeps every step of a product's life", async () => {
      const id = await aProduct("draft");

      await changeProductStatus(db, {
        productId: id,
        to: "registered",
        actorKind: "issuer",
        issuerId,
        reason: "issuer_request",
        occurredAt: new Date("2026-01-10T10:00:00Z"),
      });
      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
        occurredAt: new Date("2026-04-02T10:00:00Z"),
      });
      await changeProductStatus(db, {
        productId: id,
        to: "registered",
        actorKind: "authority",
        reason: "dispute_resolved",
        occurredAt: new Date("2026-06-18T10:00:00Z"),
      });
      await changeProductStatus(db, {
        productId: id,
        to: "retired",
        actorKind: "issuer",
        issuerId,
        reason: "end_of_life",
        occurredAt: new Date("2026-09-01T10:00:00Z"),
      });

      const history = await findProductHistory(db, id);

      expect(history.map((entry) => entry.type)).toEqual([
        "product_retired",
        "product_reinstated",
        "product_suspended",
        "product_registered",
      ]);
      expect(history.map((entry) => entry.reason)).toEqual([
        "end_of_life",
        "dispute_resolved",
        "theft_report",
        "issuer_request",
      ]);
    });
  });

  describe("a capacity cannot record what its standing does not support", () => {
    it("refuses a holder clearing a suspension, as an outcome", async () => {
      const id = await aProduct();
      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });

      const result = await changeProductStatus(db, {
        productId: id,
        to: "registered",
        actorKind: "holder",
        reason: "dispute_resolved",
      });

      // The one that matters: a product suspended over a theft report, cleared by
      // whoever holds it, is the system helping launder a stolen device.
      expect(result).toEqual({ ok: false, reason: "unauthorised_actor", actorKind: "holder" });
    });

    it("leaves the product suspended when the actor was refused", async () => {
      const id = await aProduct();
      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });
      await changeProductStatus(db, {
        productId: id,
        to: "registered",
        actorKind: "holder",
        reason: "dispute_resolved",
      });

      const [row] = await db.select().from(product).where(eq(product.id, id));

      expect(row?.status).toBe("suspended");
    });

    it("refuses an issuer suspending a product to bury a complaint", async () => {
      const id = await aProduct();

      const result = await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "issuer",
        issuerId,
        reason: "fraud_flag",
      });

      expect(result).toMatchObject({ ok: false, reason: "unauthorised_actor" });
    });
  });

  describe("the laundering sequence, end to end", () => {
    it("cannot turn a stolen product into a clean passport", async () => {
      const id = await aProduct();

      // 1. an authority suspends it over a theft report
      const suspension = await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
        sourceReference: "POL-2026-8891",
      });
      expect(suspension).toMatchObject({ ok: true });

      // 2. the holder tries to retire it, which would free the serial
      const retirement = await changeProductStatus(db, {
        productId: id,
        to: "retired",
        actorKind: "holder",
        reason: "end_of_life",
      });

      // This is where the sequence has to stop. Everything after it — the serial
      // being released, a fresh enrolment, a passport with no history — follows
      // from this one step succeeding.
      expect(retirement).toEqual({ ok: false, reason: "unauthorised_actor", actorKind: "holder" });

      const [row] = await db.select().from(product).where(eq(product.id, id));
      expect(row?.status).toBe("suspended");
    });

    it("lets an authority end it, and records who did", async () => {
      const id = await aProduct();
      await changeProductStatus(db, {
        productId: id,
        to: "suspended",
        actorKind: "authority",
        reason: "theft_report",
      });

      const result = await changeProductStatus(db, {
        productId: id,
        to: "retired",
        actorKind: "authority",
        reason: "end_of_life",
      });

      expect(result).toMatchObject({ ok: true });
      const history = await findProductHistory(db, id);
      expect(history[0]).toMatchObject({ type: "product_retired", actorKind: "authority" });
    });
  });
});
