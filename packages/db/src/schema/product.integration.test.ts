import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { issuer } from "./issuer.js";
import { type NewProduct, product } from "./product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises the product table against a real Postgres instance.
 *
 * Foreign keys, enums and check constraints only exist in the database.
 * Asserting them against a mock would test the mock.
 */
describe.skipIf(!databaseUrl)("product table", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let issuerId: number;
  let otherIssuerId: number;
  let sequence = 0;

  function registrationNumber(): string {
    sequence += 1;
    return `${run}-${String(sequence).padStart(4, "0")}`;
  }

  function build(overrides: Partial<NewProduct> = {}): NewProduct {
    // Each product needs its own serial. Before the partial unique index
    // landed, every product built here shared one and nothing complained —
    // these fixtures were creating duplicates of each other unnoticed.
    sequence += 1;

    return {
      trustpassId: generateTrustPassId(),
      issuerId,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-SERIAL-${sequence}`,
      category: "gpu",
      ...overrides,
    };
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });

    const [primary] = await db
      .insert(issuer)
      .values({
        companyName: "Andes Tech Imports",
        legalName: "ANDES TECH IMPORTS SAS",
        registrationNumber: registrationNumber(),
        country: "CO",
      })
      .returning();

    const [secondary] = await db
      .insert(issuer)
      .values({
        companyName: "Sierra Distribution",
        legalName: "SIERRA DISTRIBUTION SAS",
        registrationNumber: registrationNumber(),
        country: "CO",
      })
      .returning();

    issuerId = primary?.id as number;
    otherIssuerId = secondary?.id as number;
  });

  afterAll(async () => {
    // Products first: the foreign key is RESTRICT, which is the point.
    await db.delete(product).where(like(product.serial, `${run}%`));
    await db.delete(issuer).where(like(issuer.registrationNumber, `${run}%`));
    await db.$client.end();
  });

  describe("persistence", () => {
    it("round-trips a product", async () => {
      const values = build();
      const [created] = await db.insert(product).values(values).returning();

      expect(created).toBeDefined();
      expect(created?.trustpassId).toBe(values.trustpassId);
      expect(created?.brand).toBe("ASUS");
      expect(created?.category).toBe("gpu");

      const [found] = await db
        .select()
        .from(product)
        .where(eq(product.id, created?.id as number));

      expect(found).toEqual(created);
    });

    it("defaults a product to draft", async () => {
      // A row existing is not a claim that the product is registered. Same
      // reasoning as `unverified` on issuer: the honest default.
      const [created] = await db.insert(product).values(build()).returning();

      expect(created?.status).toBe("draft");
    });

    it("stores timestamps with a timezone", async () => {
      const [created] = await db.insert(product).values(build()).returning();

      expect(created?.createdAt).toBeInstanceOf(Date);
      expect(created?.updatedAt).toBeInstanceOf(Date);
    });

    it("advances updated_at when a row changes", async () => {
      const [created] = await db.insert(product).values(build()).returning();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const [updated] = await db
        .update(product)
        .set({ status: "registered" })
        .where(eq(product.id, created?.id as number))
        .returning();

      expect(updated?.status).toBe("registered");
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(created?.updatedAt.getTime() as number);
      expect(updated?.createdAt.getTime()).toBe(created?.createdAt.getTime());
    });

    it("accepts an identifier straight from the generator", async () => {
      // The branded TrustPassId type has to survive the round trip into a
      // varchar column and back, or every caller ends up casting.
      const trustpassId = generateTrustPassId();
      const [created] = await db.insert(product).values(build({ trustpassId })).returning();

      expect(created?.trustpassId).toBe(trustpassId);
      expect(created?.trustpassId).toMatch(/^TP1-/);
    });
  });

  describe("identity", () => {
    it("rejects a second product with the same TrustPass ID", async () => {
      // This is the guarantee the superseded "TrustPass ID is the primary key"
      // criterion existed to protect. A unique index enforces it without making
      // a random value the clustering key — see ADR 0005.
      const trustpassId = generateTrustPassId();
      await db.insert(product).values(build({ trustpassId })).returning();

      await expectSqlState(
        db.insert(product).values(build({ trustpassId })).returning(),
        SqlState.UNIQUE_VIOLATION,
      );
    });

    it.each([
      ["a bare UUID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
      ["an empty string", ""],
      ["a lookalike prefix", "XP1-8ZQ4K7M2NR5VXC3HJ0FYWB6TD9"],
    ])("rejects %s as a TrustPass ID", async (_label, candidate) => {
      await expectSqlState(
        db
          .insert(product)
          .values(build({ trustpassId: candidate as NewProduct["trustpassId"] }))
          .returning(),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("accepts a future format version", async () => {
      // ADR 0004 versions the format. A constraint written today must not lock
      // out a TP2 identifier issued later.
      const [created] = await db
        .insert(product)
        .values(build({ trustpassId: "TP2-SOMETHINGNEWENTIRELY" as NewProduct["trustpassId"] }))
        .returning();

      expect(created?.trustpassId).toBe("TP2-SOMETHINGNEWENTIRELY");
    });
  });

  describe("issuer relationship", () => {
    it("refuses a product whose issuer does not exist", async () => {
      // An orphan product has no provenance, which makes its passport
      // meaningless. The database refuses rather than trusting the caller.
      await expectSqlState(
        db
          .insert(product)
          .values(build({ issuerId: 9_999_999 }))
          .returning(),
        SqlState.FOREIGN_KEY_VIOLATION,
      );
    });

    it("refuses to delete an issuer that still has products", async () => {
      // RESTRICT rather than CASCADE: deleting an issuer would erase the
      // provenance of everything it signed. Issuers get suspended, not deleted.
      //
      // The code is 23001 restrict_violation, not 23503 foreign_key_violation.
      // Postgres raises RESTRICT immediately and NO ACTION at constraint-check
      // time, and the distinction is exactly what proves RESTRICT is in force.
      await db
        .insert(product)
        .values(build({ issuerId: otherIssuerId }))
        .returning();

      await expectSqlState(
        db.delete(issuer).where(eq(issuer.id, otherIssuerId)),
        SqlState.RESTRICT_VIOLATION,
      );
    });

    it("requires an issuer unless the record was enrolled by a holder", async () => {
      // The column stopped being NOT NULL in TP-047 so a holder enrolment can
      // exist. The rule did not weaken, it moved: a check constraint now ties
      // the absence of an issuer to a holder origin, so an issuer-origin record
      // with no issuer is still refused — and a holder record with one is too,
      // which the NOT NULL never caught.
      await expectSqlState(
        db
          .insert(product)
          .values({ ...build(), issuerId: null as never })
          .returning(),
        SqlState.CHECK_VIOLATION,
      );
    });
  });

  describe("field constraints", () => {
    it("rejects a category outside the enum", async () => {
      await expectSqlState(
        db
          .insert(product)
          .values(build({ category: "spaceship" as never }))
          .returning(),
        SqlState.INVALID_TEXT_REPRESENTATION,
      );
    });

    it("rejects a status outside the enum", async () => {
      await expectSqlState(
        db
          .insert(product)
          .values(build({ status: "probably_fine" as never }))
          .returning(),
        SqlState.INVALID_TEXT_REPRESENTATION,
      );
    });

    it.each([
      ["blank", "   "],
      ["a single character", "X"],
    ])("rejects a serial that is %s", async (_label, serial) => {
      await expectSqlState(
        db.insert(product).values(build({ serial })).returning(),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("allows two issuers to register the same serial", async () => {
      // Serials are only unique within a manufacturer's own numbering, and two
      // importers can legitimately hold units with colliding serials. Stopping
      // one issuer from registering the same serial twice is TP-024, and it is
      // a different rule from this one.
      const serial = `${run}-SHARED-SERIAL`;
      await db.insert(product).values(build({ serial, issuerId })).returning();

      const [second] = await db
        .insert(product)
        .values(build({ serial, issuerId: otherIssuerId }))
        .returning();

      expect(second?.serial).toBe(serial);
    });
  });
});

/**
 * Where a record came from, and what follows from having no issuer.
 *
 * One block rather than two: both need the same issuer and the same builder,
 * and the rules they cover are the same rule seen from either side — a record
 * has an issuer or it has a holder origin.
 */
describe.skipIf(!databaseUrl)("where a record began", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let issuerId: number;
  let n = 0;

  /** An issuer-registered row. Pass `issuerId: null, origin: "holder"` for the other kind. */
  function row(overrides: Partial<NewProduct> = {}): NewProduct {
    n += 1;
    return {
      trustpassId: generateTrustPassId(),
      issuerId,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-ORIGIN-${n}`,
      category: "gpu",
      ...overrides,
    };
  }

  function holder(serial: string): NewProduct {
    return row({ serial, issuerId: null, status: "registered", origin: "holder" });
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);
    const [created] = await db
      .insert(issuer)
      .values({
        companyName: `Origin ${run}`,
        legalName: `Origin ${run} SAS`,
        registrationNumber: `${run}-OR`,
        country: "CO",
      })
      .returning({ id: issuer.id });
    issuerId = created?.id as number;
  });

  afterAll(async () => {
    await db.delete(product).where(like(product.serial, `${run}%`));
    await db.delete(issuer).where(like(issuer.registrationNumber, `${run}%`));
    await db.$client.end();
  });

  it("defaults to supply_chain rather than claiming a factory", async () => {
    const [created] = await db.insert(product).values(row()).returning();

    // Every product registered before this column existed came through
    // POST /products from a business whose relationship to the factory nobody
    // recorded. Defaulting them to `manufacturer` would assert something no row
    // supports — the default is a claim like any other.
    expect(created?.origin).toBe("supply_chain");
  });

  it.each(["manufacturer", "supply_chain"] as const)("accepts %s", async (origin) => {
    const [created] = await db.insert(product).values(row({ origin })).returning();

    expect(created?.origin).toBe(origin);
  });

  it("accepts holder, but only without an issuer", async () => {
    // Since TP-047 a holder origin and an issuer are mutually exclusive: a
    // person cannot carry a company's standing.
    const [created] = await db
      .insert(product)
      .values(row({ origin: "holder", issuerId: null }))
      .returning();

    expect(created?.origin).toBe("holder");
    expect(created?.issuerId).toBeNull();
  });

  it("refuses an origin outside the closed set", async () => {
    await expectSqlState(
      db.insert(product).values(row({ origin: "imported_somehow" as never })),
      SqlState.INVALID_TEXT_REPRESENTATION,
    );
  });

  it("exists with no issuer at all", async () => {
    const [created] = await db
      .insert(product)
      .values(holder(`${run}-H1`))
      .returning();

    expect(created?.issuerId).toBeNull();
    expect(created?.origin).toBe("holder");
  });

  it("cannot be born active, because entering a serial is not owning a product", async () => {
    // ADR 0008. Somebody typed a serial; that establishes nothing about who
    // holds the object, and `active` means ownership was established.
    await expectSqlState(
      db.insert(product).values({ ...holder(`${run}-H2`), status: "active" }),
      SqlState.ILLEGAL_STATUS_TRANSITION,
    );
  });

  it("refuses a second live holder record for the same serial", async () => {
    n += 1;
    const serial = `${run}-DUP-${n}`;
    await db.insert(product).values(holder(serial));

    // Without this, anyone could enrol a device, have something unwelcome
    // recorded against it, enrol it again and show the clean passport.
    await expectSqlState(
      db.insert(product).values(holder(serial.toLowerCase())),
      SqlState.UNIQUE_VIOLATION,
    );
  });

  it("lets an issuer register a product whose serial a holder already enrolled", async () => {
    n += 1;
    const serial = `${run}-SHARE-${n}`;
    await db.insert(product).values(holder(serial));

    // Serials are only unique inside a manufacturer's own numbering, so a
    // collision across these two is legitimate rather than a duplicate.
    const [alsoRegistered] = await db
      .insert(product)
      .values({ ...holder(serial), issuerId, origin: "supply_chain" })
      .returning();

    expect(alsoRegistered?.issuerId).toBe(issuerId);
  });

  it("releases the serial when the holder record is retired", async () => {
    n += 1;
    const serial = `${run}-REL-${n}`;
    const [first] = await db.insert(product).values(holder(serial)).returning();
    await db
      .update(product)
      .set({ status: "retired" })
      .where(eq(product.id, first?.id as number));

    const [second] = await db.insert(product).values(holder(serial)).returning();

    expect(second?.id).not.toBe(first?.id);
  });

  it("refuses a holder record that names an issuer", async () => {
    // A person claiming a company's standing.
    await expectSqlState(
      db.insert(product).values({ ...holder(`${run}-H5`), issuerId }),
      SqlState.CHECK_VIOLATION,
    );
  });

  it("refuses an issuer-origin record with no issuer", async () => {
    // An orphan: it claims a supply chain nobody can be asked about.
    await expectSqlState(
      db.insert(product).values({ ...holder(`${run}-H6`), origin: "supply_chain" }),
      SqlState.CHECK_VIOLATION,
    );
  });
});
