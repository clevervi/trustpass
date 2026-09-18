import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import {
  type LifecycleActorKind,
  type LifecycleEventType,
  lifecycleActorKind,
  lifecycleEvent,
  lifecycleEventType,
} from "../schema/lifecycle-event.js";
import { product } from "../schema/product.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { mayRecord, RECORDING_AUTHORITY } from "./recording-authority.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Compares the declared authority table against the trigger that enforces it.
 *
 * The two copies cannot be merged into one artefact, so every pairing is tried
 * against real Postgres. A divergence is a failing test rather than a rule that
 * quietly stopped applying — the same arrangement the status transitions use.
 */
describe.skipIf(!databaseUrl)("what a capacity may record", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let productId: number;

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);
    const [created] = await db
      .insert(product)
      .values({
        trustpassId: generateTrustPassId(),
        issuerId: null,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `${run}-AUTH`,
        category: "gpu",
        status: "registered",
        origin: "holder",
      })
      .returning({ id: product.id });
    productId = created?.id as number;
  });

  afterAll(async () => {
    await db.$client.end();
  });

  function write(actorKind: LifecycleActorKind, type: LifecycleEventType) {
    return db.insert(lifecycleEvent).values({
      productId,
      type,
      actorKind,
      issuerId: null,
      occurredAt: new Date(),
      // A correction needs a target and the check constraint enforces it; for
      // the pairing sweep the authority trigger fires first, so an unauthorised
      // pairing is refused before the target is missed.
      ...(type === "record_corrected" ? { correctsEventId: null } : {}),
    });
  }

  const everyPairing = lifecycleActorKind.enumValues.flatMap((actorKind) =>
    lifecycleEventType.enumValues.map((type) => ({ actorKind, type })),
  );

  it.each(everyPairing.filter(({ actorKind, type }) => !mayRecord(actorKind, type)))(
    "refuses a $actorKind recording $type",
    async ({ actorKind, type }) => {
      await expectSqlState(write(actorKind, type), SqlState.UNAUTHORISED_RECORDING);
    },
  );

  it("declares the same table the trigger enforces", async () => {
    // Every allowed pairing must actually be accepted. A TypeScript table that
    // permits what the database refuses is worse than either alone: a caller
    // is told it may write something that then fails at the boundary.
    const refused: string[] = [];

    for (const { actorKind, type } of everyPairing.filter((p) => mayRecord(p.actorKind, p.type))) {
      try {
        await write(actorKind, type);
      } catch (error) {
        const code = (error as { cause?: { code?: string } })?.cause?.code;
        if (code === SqlState.UNAUTHORISED_RECORDING) refused.push(`${actorKind}/${type}`);
      }
    }

    expect(refused).toEqual([]);
  });

  it("does not let a holder clear an accusation against its own product", () => {
    // The entry that matters most, asserted on the declaration as well as
    // against the database: a suspension lifted by whoever holds the object is
    // the system helping launder a stolen device.
    expect(mayRecord("holder", "product_reinstated")).toBe(false);
    expect(RECORDING_AUTHORITY.holder).not.toContain("product_reinstated");
    expect(RECORDING_AUTHORITY.holder).not.toContain("product_suspended");
  });

  it("does not let an issuer suspend a product to bury a complaint", () => {
    expect(mayRecord("issuer", "product_suspended")).toBe(false);
  });

  it("leaves only TrustPass able to correct its own record", () => {
    for (const actorKind of lifecycleActorKind.enumValues) {
      expect(mayRecord(actorKind, "record_corrected")).toBe(actorKind === "system");
    }
  });
});
