import { createDatabase, type Database, schema } from "@trustpass/db";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { buildDependencies } from "../testing/dependencies.js";
import { registerProduct } from "./register-product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises registration end to end: HTTP in, row in Postgres out.
 *
 * The route tests stub the service, which proves the HTTP contract and nothing
 * about whether a product is actually stored. This closes that gap.
 */
describe.skipIf(!databaseUrl)("POST /products against a real database", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let app: ReturnType<typeof createApp>;

  const issuerReference = { country: "CO", registrationNumber: `${run}-9001` };

  function body(overrides: Record<string, unknown> = {}) {
    return {
      issuer: issuerReference,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-SERIAL`,
      category: "gpu",
      ...overrides,
    };
  }

  function post(payload: unknown) {
    return app.request("/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });
    app = createApp(buildDependencies({ registerProduct: (input) => registerProduct(db, input) }));

    await db.insert(schema.issuer).values({
      companyName: "Andes Tech Imports",
      legalName: `ANDES REGISTER ${run} SAS`,
      registrationNumber: issuerReference.registrationNumber,
      country: issuerReference.country,
    });
  });

  afterAll(async () => {
    await db.delete(schema.product).where(like(schema.product.serial, `${run}%`));
    await db.delete(schema.issuer).where(like(schema.issuer.registrationNumber, `${run}%`));
    await db.$client.end();
  });

  it("stores the product and returns its TrustPass ID", async () => {
    const response = await post(body());

    expect(response.status).toBe(201);
    const created = (await response.json()) as { trustpassId: string; status: string };
    expect(created.trustpassId).toMatch(/^TP1-/);
    expect(created.status).toBe("registered");

    const [stored] = await db
      .select()
      .from(schema.product)
      .where(eq(schema.product.trustpassId, created.trustpassId as never));

    expect(stored).toBeDefined();
    expect(stored?.brand).toBe("ASUS");
    expect(stored?.status).toBe("registered");
  });

  it("issues a different identifier for every registration", async () => {
    const first = (await (await post(body({ serial: `${run}-A` }))).json()) as {
      trustpassId: string;
    };
    const second = (await (await post(body({ serial: `${run}-B` }))).json()) as {
      trustpassId: string;
    };

    expect(first.trustpassId).not.toBe(second.trustpassId);
  });

  it("links the product to the issuer that was named", async () => {
    const created = (await (await post(body({ serial: `${run}-LINK` }))).json()) as {
      trustpassId: string;
    };

    const [stored] = await db
      .select()
      .from(schema.product)
      .where(eq(schema.product.trustpassId, created.trustpassId as never));

    const [issuer] = await db
      .select()
      .from(schema.issuer)
      .where(eq(schema.issuer.id, stored?.issuerId as number));

    expect(issuer?.registrationNumber).toBe(issuerReference.registrationNumber);
  });

  it("returns 422 for an issuer that is not registered", async () => {
    const response = await post(
      body({ issuer: { country: "CO", registrationNumber: `${run}-NOPE` } }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "issuer_not_found" });
  });

  it("stores products for an unverified issuer, and says so in the response", async () => {
    // Per ADR 0003 an unverified issuer's claim is still recorded — the system
    // reports who said it, not whether it is true. The response has to make
    // that visible rather than implying verification happened.
    const created = (await (await post(body({ serial: `${run}-UNVERIFIED` }))).json()) as {
      issuer: { verificationStatus: string };
    };

    expect(created.issuer.verificationStatus).toBe("unverified");
  });

  it("currently allows one issuer to register the same serial twice", async () => {
    // KNOWN GAP, closed by TP-024.
    //
    // This asserts the behaviour as it is, not as it should be. A client
    // retrying after a timeout produces a second identity for one physical
    // product — two passports for one GPU, which is the exact failure the
    // system exists to prevent.
    //
    // When TP-024 adds the partial unique index, this test must fail and be
    // rewritten to expect the rejection. That is the point of writing it.
    const serial = `${run}-DUPLICATE`;

    const first = await post(body({ serial }));
    const second = await post(body({ serial }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const rows = await db.select().from(schema.product).where(eq(schema.product.serial, serial));

    expect(rows).toHaveLength(2);
  });
});
