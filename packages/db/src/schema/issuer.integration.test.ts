import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { issuer, type NewIssuer } from "./issuer.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * SQLSTATE codes, asserted by value so that a test cannot pass because the
 * insert failed for an unrelated reason such as a dropped connection.
 */
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";
const INVALID_ENUM_INPUT = "22P02";

/**
 * Drizzle wraps driver failures, so the SQLSTATE lives somewhere down the
 * `cause` chain rather than on the error that surfaces.
 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

async function expectSqlState(operation: Promise<unknown>, code: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(sqlStateOf(error)).toBe(code);
    return;
  }

  // Reached only when the operation succeeded, which is itself the failure.
  expect.fail(`Expected SQLSTATE ${code}, but the operation succeeded.`);
}

/**
 * Exercises the issuer table against a real Postgres instance.
 *
 * Constraints are the point of this suite, and a constraint only exists in the
 * database. Asserting them against a mock would test the mock.
 *
 * Rows are namespaced with a per-run prefix and removed afterwards rather than
 * wrapped in a rolled-back transaction: half of these tests provoke constraint
 * violations, and a violation aborts the surrounding transaction in Postgres.
 */
describe.skipIf(!databaseUrl)("issuer table", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let sequence = 0;

  /** A registration number unique to this run, so repeat runs cannot collide. */
  function registrationNumber(): string {
    sequence += 1;
    return `${run}-${String(sequence).padStart(4, "0")}`;
  }

  function build(overrides: Partial<NewIssuer> = {}): NewIssuer {
    return {
      companyName: "Andes Tech Imports",
      legalName: "ANDES TECH IMPORTS SAS",
      registrationNumber: registrationNumber(),
      country: "CO",
      ...overrides,
    };
  }

  beforeAll(() => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });
  });

  afterAll(async () => {
    await db.delete(issuer).where(like(issuer.registrationNumber, `${run}%`));
    await db.$client.end();
  });

  describe("persistence", () => {
    it("round-trips an issuer", async () => {
      const [created] = await db.insert(issuer).values(build()).returning();

      expect(created).toBeDefined();
      expect(created?.companyName).toBe("Andes Tech Imports");
      expect(created?.country).toBe("CO");

      const [found] = await db
        .select()
        .from(issuer)
        .where(eq(issuer.id, created?.id as number));

      expect(found).toEqual(created);
    });

    it("defaults an issuer to unverified", async () => {
      // The honest default. An issuer we have checked nothing about must not
      // start life claiming otherwise.
      const [created] = await db.insert(issuer).values(build()).returning();

      expect(created?.verificationStatus).toBe("unverified");
    });

    it("stores timestamps with a timezone", async () => {
      const [created] = await db.insert(issuer).values(build()).returning();

      expect(created?.createdAt).toBeInstanceOf(Date);
      expect(created?.updatedAt).toBeInstanceOf(Date);
    });

    it("advances updated_at when a row changes", async () => {
      const [created] = await db.insert(issuer).values(build()).returning();

      // Millisecond resolution needs room to move before the comparison.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const [updated] = await db
        .update(issuer)
        .set({ verificationStatus: "verified" })
        .where(eq(issuer.id, created?.id as number))
        .returning();

      expect(updated?.verificationStatus).toBe("verified");
      // Strictly greater, not "greater or equal": the weaker assertion passes
      // even when $onUpdate never fires, which is the thing under test.
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(created?.updatedAt.getTime() as number);
      expect(updated?.createdAt.getTime()).toBe(created?.createdAt.getTime());
    });
  });

  describe("identity — see ADR 0006", () => {
    it("rejects a duplicate registration number within one country", async () => {
      const duplicated = registrationNumber();
      await db
        .insert(issuer)
        .values(build({ registrationNumber: duplicated }))
        .returning();

      await expectSqlState(
        db
          .insert(issuer)
          .values(build({ registrationNumber: duplicated }))
          .returning(),
        UNIQUE_VIOLATION,
      );
    });

    it("allows the same registration number in a different country", async () => {
      // Registries are national. A Colombian NIT and a Mexican RFC that happen
      // to collide identify two different companies.
      const shared = registrationNumber();
      await db
        .insert(issuer)
        .values(build({ registrationNumber: shared, country: "CO" }))
        .returning();

      const [mexican] = await db
        .insert(issuer)
        .values(build({ registrationNumber: shared, country: "MX" }))
        .returning();

      expect(mexican?.country).toBe("MX");
    });

    it("allows two issuers to share a legal name in one country", async () => {
      // United States business names are registered per state, so two
      // legitimate companies may both be "Acme LLC". Keying identity on the
      // name would have refused the second one.
      await db
        .insert(issuer)
        .values(build({ legalName: "ACME LLC", country: "US" }))
        .returning();

      const [second] = await db
        .insert(issuer)
        .values(build({ legalName: "ACME LLC", country: "US" }))
        .returning();

      expect(second?.legalName).toBe("ACME LLC");
    });

    it("requires a registration number", async () => {
      // Nullable would be worse than absent: Postgres allows unlimited nulls in
      // a unique index, so duplicate protection would switch itself off for
      // exactly the unverified issuers where duplicates are most likely.
      await expectSqlState(
        db
          .insert(issuer)
          .values({ ...build(), registrationNumber: null as never })
          .returning(),
        NOT_NULL_VIOLATION,
      );
    });

    it.each([
      ["lower case", "abc123"],
      ["spaces", "ABC 123"],
      ["fewer than four characters", "AB1"],
      ["punctuation", "ABC/123"],
    ])("rejects a registration number with %s", async (_label, registration) => {
      await expectSqlState(
        db
          .insert(issuer)
          .values(build({ registrationNumber: registration }))
          .returning(),
        CHECK_VIOLATION,
      );
    });

    it.each([
      ["Colombian NIT", "900123456-7"],
      ["Mexican RFC", "ABC123456T1A"],
      ["United States EIN", "12-3456789"],
    ])("accepts a real %s", async (_label, registration) => {
      const [created] = await db
        .insert(issuer)
        .values(build({ registrationNumber: `${run}${registration}` }))
        .returning();

      expect(created?.registrationNumber).toBe(`${run}${registration}`);
    });
  });

  describe("field constraints", () => {
    it("rejects a verification status outside the enum", async () => {
      await expectSqlState(
        db
          .insert(issuer)
          .values({
            ...build(),
            // Casting past the type is the point: the guarantee has to hold at
            // the database, not only at the TypeScript boundary.
            verificationStatus: "totally_legit" as never,
          })
          .returning(),
        INVALID_ENUM_INPUT,
      );
    });

    it.each([
      ["lower case", "co"],
      ["digits", "C1"],
      ["blank", "  "],
    ])("rejects a country that is not ISO 3166-1 alpha-2: %s", async (_label, country) => {
      await expectSqlState(
        db.insert(issuer).values(build({ country })).returning(),
        CHECK_VIOLATION,
      );
    });
  });
});
