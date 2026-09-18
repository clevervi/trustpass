import { createDatabase, type Database, generateTrustPassId, schema } from "@trustpass/db";
import { insertProductWithProvenance, moveProductStatus } from "@trustpass/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { registerProduct } from "../products/register-product.js";
import { buildDependencies } from "../testing/dependencies.js";
import { readPassport } from "./read-passport.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Registers a product over HTTP and reads its passport back over HTTP, against a
 * real database.
 *
 * The route tests stub the service, which proves the HTTP contract and nothing
 * about what actually leaves Postgres. Masking and key exclusion are only real if
 * they hold here.
 */
describe.skipIf(!databaseUrl)("GET /passports/{trustpassId} against a real database", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let sequence = 0;

  const verifiedIssuer = { country: "CO", registrationNumber: `${run}-VERIFIED` };
  const unverifiedIssuer = { country: "CO", registrationNumber: `${run}-UNVERIFIED` };

  async function register(
    serial: string,
    issuer: { country: string; registrationNumber: string } = verifiedIssuer,
  ): Promise<string> {
    const response = await app.request("/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issuer,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial,
        category: "gpu",
      }),
    });
    expect(response.status).toBe(201);

    return ((await response.json()) as { trustpassId: string }).trustpassId;
  }

  function uniqueSerial(): string {
    sequence += 1;
    return `${run}-SN-${String(sequence).padStart(6, "0")}`;
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });
    app = createApp(
      buildDependencies({
        registerProduct: (input) => registerProduct(db, input),
        readPassport: (trustpassId) => readPassport(db, trustpassId),
      }),
    );

    await db.insert(schema.organization).values([
      {
        companyName: "Andes Tech Imports",
        legalName: `ANDES VERIFIED ${run} SAS`,
        registrationNumber: verifiedIssuer.registrationNumber,
        country: verifiedIssuer.country,
        verificationStatus: "verified",
      },
      {
        companyName: "Unchecked Imports",
        legalName: `UNCHECKED ${run} SAS`,
        registrationNumber: unverifiedIssuer.registrationNumber,
        country: unverifiedIssuer.country,
      },
    ]);
  });

  afterAll(async () => {
    // Deliberately no cleanup. Since TP-051 a registered product carries a
    // lifecycle event, events cannot be deleted, and the product foreign key is
    // RESTRICT — so these rows cannot be removed and neither can the issuer
    // that owns them.
    //
    // That is the guarantee working rather than a leak: a teardown that
    // succeeded here would prove a product's history can be erased. Each run
    // uses its own prefix, so the rows accumulate without colliding.
    await db.$client.end();
  });

  it("reads back the passport of a product registered a moment ago", async () => {
    const trustpassId = await register(uniqueSerial());

    const response = await app.request(`/passports/${trustpassId}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      trustpassId,
      brand: "ASUS",
      status: "registered",
      issuer: {
        companyName: "Andes Tech Imports",
        registrationNumber: verifiedIssuer.registrationNumber,
        verificationStatus: "verified",
      },
    });
  });

  it("never lets the whole serial leave the API", async () => {
    // Asserted on the raw text, not the parsed object: a serial leaking into an
    // unexpected field or a message would slip past a check on one property.
    const serial = uniqueSerial();
    const trustpassId = await register(serial);

    const response = await app.request(`/passports/${trustpassId}`);
    const text = await response.text();

    expect(text).not.toContain(serial);
    expect(JSON.parse(text)).toMatchObject({
      serial: { suffix: serial.slice(-4), hiddenCharacters: serial.length - 4 },
    });
  });

  it("reveals nothing of a serial too short to mask", async () => {
    const trustpassId = await register(`${run}`.slice(0, 6));

    const body = (await (await app.request(`/passports/${trustpassId}`)).json()) as {
      serial: unknown;
    };

    expect(body.serial).toBeNull();
  });

  it("never exposes an internal key from a real row", async () => {
    const trustpassId = await register(uniqueSerial());

    const body = (await (await app.request(`/passports/${trustpassId}`)).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("organizationId");
    expect(body.issuer).not.toHaveProperty("id");
  });

  it("reports an unverified issuer as unverified, end to end", async () => {
    // A product registered by an unchecked company carries exactly the weight of
    // that company's word. The passport has to say so.
    const trustpassId = await register(uniqueSerial(), unverifiedIssuer);

    const body = (await (await app.request(`/passports/${trustpassId}`)).json()) as {
      claims: { claim: string; state: string }[];
    };

    expect(body.claims).toContainEqual({ claim: "issuer", state: "unverified" });
    expect(body.claims).toContainEqual({ claim: "serial", state: "recorded" });
    expect(body.claims).toContainEqual({ claim: "physical_authenticity", state: "not_verifiable" });
  });

  it("still publishes a suspended product, and says it is suspended", async () => {
    const trustpassId = await register(uniqueSerial());
    // Through the helper: since #54 a status change carries the event that
    // explains it, and this test's subject is what the passport publishes.
    const [row] = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.trustpassId, trustpassId as never));
    await moveProductStatus(db, row?.id as number, "suspended");

    const response = await app.request(`/passports/${trustpassId}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "suspended" });
  });

  it("does not publish a draft", async () => {
    // A draft claims nothing. Publishing it publishes a claim nobody made.
    const trustpassId = generateTrustPassId();
    const [issuer] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.registrationNumber, verifiedIssuer.registrationNumber));

    await insertProductWithProvenance(db, {
      trustpassId,
      organizationId: issuer?.id as number,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: uniqueSerial(),
      category: "gpu",
      status: "draft",
    });

    const response = await app.request(`/passports/${trustpassId}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "passport_not_found" });
  });

  it("answers 404 for an identifier nobody registered", async () => {
    const response = await app.request(`/passports/${generateTrustPassId()}`);

    expect(response.status).toBe(404);
  });
});
