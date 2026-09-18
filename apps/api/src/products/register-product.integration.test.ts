import { createDatabase, type Database, schema } from "@trustpass/db";
import { moveProductStatus } from "@trustpass/db/testing";
import { eq } from "drizzle-orm";
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

    await db.insert(schema.organization).values({
      companyName: "Andes Tech Imports",
      legalName: `ANDES REGISTER ${run} SAS`,
      registrationNumber: issuerReference.registrationNumber,
      country: issuerReference.country,
    });
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
      .from(schema.organization)
      .where(eq(schema.organization.id, stored?.organizationId as number));

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

  describe("one live identity per serial", () => {
    it("refuses a second registration of the same serial", async () => {
      // The rule that makes a passport mean anything. Two live identities for
      // one product would let a seller show whichever history looked better.
      const serial = `${run}-DUPLICATE`;

      const first = await post(body({ serial }));
      expect(first.status).toBe(201);
      const created = (await first.json()) as { trustpassId: string };

      const second = await post(body({ serial }));
      expect(second.status).toBe(409);

      const conflict = (await second.json()) as { error: string; message: string };
      expect(conflict.error).toBe("duplicate_serial");

      // This assertion used to be its opposite: the conflict named the existing
      // identifier, as the recovery path for a client that timed out mid-
      // registration and retried. A good reason, and it made a serial printed
      // on the object into a lookup key for the identity ADR 0004 spends its
      // whole Context keeping unguessable.
      expect(conflict.message).not.toContain(created.trustpassId);
      // Nor the serial. Echoing it back confirms which one was asked about,
      // which is most of what a sweep gets to look at.
      expect(conflict.message).not.toContain(serial);
      expect(conflict.message).not.toMatch(/constraint|violates|relation|SQLSTATE|index/i);
    });

    it("refuses a serial that differs only in case", async () => {
      // A plain unique index is case sensitive, and serials get typed by hand
      // off a sticker. The issuer table had exactly this defect before it was
      // caught; this asserts the product table does not.
      const serial = `${run}-CASETEST`;

      expect((await post(body({ serial }))).status).toBe(201);
      expect((await post(body({ serial: serial.toLowerCase() }))).status).toBe(409);
    });

    it("allows the serial again once the prior identity is retired", async () => {
      // A retired product must not poison its serial forever: a warranty
      // replacement unit legitimately carries the serial of the unit it
      // replaced.
      const serial = `${run}-REPLACED`;

      const original = (await (await post(body({ serial }))).json()) as { trustpassId: string };
      expect((await post(body({ serial }))).status).toBe(409);

      const [row] = await db
        .select({ id: schema.product.id })
        .from(schema.product)
        .where(eq(schema.product.trustpassId, original.trustpassId as never));
      // Through the helper since #54: a status change carries the event that
      // explains it, and this test's subject is the serial rule.
      await moveProductStatus(db, row?.id as number, "retired");

      const replacement = await post(body({ serial }));
      expect(replacement.status).toBe(201);

      const rows = await db.select().from(schema.product).where(eq(schema.product.serial, serial));
      expect(rows).toHaveLength(2);
    });

    it("lets exactly one of several concurrent registrations win", async () => {
      // The reason the constraint is in the database. An application-level
      // check reads, decides, then writes, and every one of these would pass
      // the read before any of them wrote.
      const serial = `${run}-RACE`;

      const responses = await Promise.all([
        post(body({ serial })),
        post(body({ serial })),
        post(body({ serial })),
        post(body({ serial })),
        post(body({ serial })),
      ]);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(4);

      const rows = await db.select().from(schema.product).where(eq(schema.product.serial, serial));
      expect(rows).toHaveLength(1);
    });

    it("does not stop a different issuer using the same serial", async () => {
      // Serials are unique only within a manufacturer's own numbering, so two
      // importers holding colliding serials is legitimate. The same serial
      // across issuers is a fraud signal to weigh (TP-111), not a constraint.
      const serial = `${run}-CROSSISSUER`;
      expect((await post(body({ serial }))).status).toBe(201);

      const other = { country: "CO", registrationNumber: `${run}-9002` };
      await db.insert(schema.organization).values({
        companyName: "Sierra Distribution",
        legalName: `SIERRA REGISTER ${run} SAS`,
        registrationNumber: other.registrationNumber,
        country: other.country,
      });

      expect((await post(body({ serial, issuer: other }))).status).toBe(201);
    });
  });
});
