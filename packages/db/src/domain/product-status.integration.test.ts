import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { issuer } from "../schema/issuer.js";
import { type ProductStatus, product } from "../schema/product.js";
import { expectSqlState, SqlState, sqlMessageOf, sqlStateOf } from "../testing/sql-state.js";
import { canTransition, PRODUCT_STATUS_TRANSITIONS } from "./product-status.js";

const databaseUrl = process.env.DATABASE_URL;

const ALL_STATUSES = Object.keys(PRODUCT_STATUS_TRANSITIONS) as ProductStatus[];

/** How to reach each status from a fresh insert, using only legal moves. */
const ROUTES: Readonly<Record<ProductStatus, { insertAs: ProductStatus; steps: ProductStatus[] }>> =
  {
    draft: { insertAs: "draft", steps: [] },
    registered: { insertAs: "registered", steps: [] },
    active: { insertAs: "registered", steps: ["active"] },
    suspended: { insertAs: "registered", steps: ["suspended"] },
    retired: { insertAs: "registered", steps: ["retired"] },
  };

/**
 * Checks the database enforces the same lifecycle as `product-status.ts`.
 *
 * The rules exist twice — once in TypeScript for the application, once in a
 * trigger so no write path can sidestep them — and two copies drift. This suite
 * compares every source-to-target pair against the real trigger, so a
 * divergence is a red test rather than a silent hole in the guarantee.
 */
describe.skipIf(!databaseUrl)("product status guard", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let issuerId: number;
  let sequence = 0;

  async function createProductIn(status: ProductStatus): Promise<number> {
    sequence += 1;
    const route = ROUTES[status];

    const [created] = await db
      .insert(product)
      .values({
        trustpassId: generateTrustPassId(),
        issuerId,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial: `${run}-${String(sequence).padStart(4, "0")}`,
        category: "gpu",
        status: route.insertAs,
      })
      .returning();

    const id = created?.id as number;

    for (const step of route.steps) {
      await db.update(product).set({ status: step }).where(eq(product.id, id));
    }

    return id;
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });

    const [created] = await db
      .insert(issuer)
      .values({
        companyName: "Andes Tech Imports",
        legalName: `ANDES STATUS ${run} SAS`,
        registrationNumber: `${run}-ISSUER`,
        country: "CO",
      })
      .returning();

    issuerId = created?.id as number;
  });

  afterAll(async () => {
    await db.delete(product).where(like(product.serial, `${run}%`));
    await db.delete(issuer).where(like(issuer.registrationNumber, `${run}%`));
    await db.$client.end();
  });

  describe("the database agrees with the transition table", () => {
    const pairs = ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const));

    it.each(pairs)("%s to %s", async (from, to) => {
      const id = await createProductIn(from);
      const attempt = db.update(product).set({ status: to }).where(eq(product.id, id));

      if (canTransition(from, to)) {
        await attempt;
        const [after] = await db.select().from(product).where(eq(product.id, id));
        expect(after?.status).toBe(to);
        return;
      }

      await expectSqlState(attempt, SqlState.ILLEGAL_STATUS_TRANSITION);
    });
  });

  describe("creation", () => {
    it.each(["draft", "registered"] as const)("allows a product to start as %s", async (status) => {
      const id = await createProductIn(status);
      const [created] = await db.select().from(product).where(eq(product.id, id));

      expect(created?.status).toBe(status);
    });

    it.each(["active", "suspended", "retired"] as const)(
      "refuses to create a product already %s",
      async (status) => {
        // Without this the transition rules are bypassed entirely by inserting
        // the end state: a product born active was never registered by anyone.
        sequence += 1;
        await expectSqlState(
          db
            .insert(product)
            .values({
              trustpassId: generateTrustPassId(),
              issuerId,
              brand: "ASUS",
              model: "ROG Strix RTX 5070 Ti",
              serial: `${run}-BORN-${sequence}`,
              category: "gpu",
              status,
            })
            .returning(),
          SqlState.ILLEGAL_STATUS_TRANSITION,
        );
      },
    );
  });

  describe("ordinary writes", () => {
    it("leaves a non-status update alone", async () => {
      // The trigger is BEFORE UPDATE OF status, so a write that does not touch
      // status must not fire it at all.
      const id = await createProductIn("active");

      const [updated] = await db
        .update(product)
        .set({ brand: "Gigabyte" })
        .where(eq(product.id, id))
        .returning();

      expect(updated?.brand).toBe("Gigabyte");
      expect(updated?.status).toBe("active");
    });

    it("allows setting a status to the value it already has", async () => {
      const id = await createProductIn("retired");

      const [updated] = await db
        .update(product)
        .set({ status: "retired" })
        .where(eq(product.id, id))
        .returning();

      expect(updated?.status).toBe("retired");
    });
  });

  describe("the refusal itself", () => {
    it("names both states in the message", async () => {
      // A caller should be able to tell someone what was attempted, without
      // reading the trigger source.
      const id = await createProductIn("retired");

      try {
        await db.update(product).set({ status: "active" }).where(eq(product.id, id));
        expect.fail("expected the illegal transition to be refused");
      } catch (error) {
        // The message lives on the driver error, not on Drizzle's wrapper,
        // which stringifies as "Failed query: ..." and drops it.
        expect(sqlStateOf(error)).toBe(SqlState.ILLEGAL_STATUS_TRANSITION);
        expect(sqlMessageOf(error)).toContain("retired");
        expect(sqlMessageOf(error)).toContain("active");
      }
    });

    it("is distinguishable from a check violation", async () => {
      // TP001 rather than 23514: "that move is not allowed" is a different
      // answer from "the database said no", and the API will report it as one.
      const id = await createProductIn("suspended");

      await expectSqlState(
        db.update(product).set({ status: "active" }).where(eq(product.id, id)),
        SqlState.ILLEGAL_STATUS_TRANSITION,
      );
    });
  });
});
