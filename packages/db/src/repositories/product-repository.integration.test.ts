import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId, type TrustPassId } from "../identity/trustpass-id.js";
import { issuer } from "../schema/issuer.js";
import { type ProductStatus, product } from "../schema/product.js";
import { findProductByTrustPassId } from "./product-repository.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises the passport lookup against a real Postgres instance.
 *
 * The join and the column projection are the point. A mock would return
 * whatever shape the test gave it, and so could never show that an internal key
 * fails to leave the database.
 */
describe.skipIf(!databaseUrl)("findProductByTrustPassId", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let issuerId: number;
  let sequence = 0;

  async function createProduct(status: ProductStatus = "registered"): Promise<TrustPassId> {
    sequence += 1;
    const trustpassId = generateTrustPassId();

    // The status trigger only allows a product to be born draft or registered,
    // so later statuses are reached by legal moves.
    const insertAs = status === "draft" ? "draft" : "registered";
    await db.insert(product).values({
      trustpassId,
      issuerId,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-SERIAL-${sequence}`,
      category: "gpu",
      status: insertAs,
    });

    if (status !== insertAs) {
      await db.update(product).set({ status }).where(eq(product.trustpassId, trustpassId));
    }

    return trustpassId;
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });

    const [created] = await db
      .insert(issuer)
      .values({
        companyName: "Andes Tech Imports",
        legalName: `ANDES PASSPORT ${run} SAS`,
        registrationNumber: `${run}-PASS`,
        country: "CO",
        verificationStatus: "verified",
      })
      .returning();

    issuerId = created?.id as number;
  });

  afterAll(async () => {
    // Products first: the issuer foreign key is RESTRICT.
    await db.delete(product).where(like(product.serial, `${run}%`));
    await db.delete(issuer).where(like(issuer.registrationNumber, `${run}%`));
    await db.$client.end();
  });

  it("returns the product with its issuer joined in", async () => {
    const trustpassId = await createProduct();

    const found = await findProductByTrustPassId(db, trustpassId);

    expect(found).toMatchObject({
      trustpassId,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      category: "gpu",
      status: "registered",
      issuer: {
        companyName: "Andes Tech Imports",
        country: "CO",
        registrationNumber: `${run}-PASS`,
        verificationStatus: "verified",
      },
    });
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it("returns undefined for an identifier nobody registered", async () => {
    await expect(findProductByTrustPassId(db, generateTrustPassId())).resolves.toBeUndefined();
  });

  it("never selects an internal key", async () => {
    // ADR 0005, made testable. The projection names its columns, so the keys
    // are not in the row at all — there is nothing for a later layer to leak.
    const found = await findProductByTrustPassId(db, await createProduct());

    expect(found).toBeDefined();
    expect(Object.keys(found ?? {})).not.toContain("id");
    expect(Object.keys(found ?? {})).not.toContain("issuerId");
    expect(Object.keys(found?.issuer ?? {})).not.toContain("id");
  });

  it.each(["draft", "registered", "active", "suspended", "retired"] as const)(
    "returns a product that is %s, leaving publishability to the caller",
    async (status) => {
      // A repository that hides drafts would make "not found" ambiguous for
      // every future caller that is allowed to see them.
      const found = await findProductByTrustPassId(db, await createProduct(status));

      expect(found?.status).toBe(status);
    },
  );
});
