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
 * Rows are namespaced with a per-run suffix and removed afterwards rather than
 * wrapped in a rolled-back transaction: half of these tests provoke constraint
 * violations, and a violation aborts the surrounding transaction in Postgres.
 */
describe.skipIf(!databaseUrl)("issuer table", () => {
  const suffix = `-test-${Math.random().toString(36).slice(2, 10)}`;
  let db: Database;

  function build(overrides: Partial<NewIssuer> = {}): NewIssuer {
    return {
      companyName: "Andes Tech Imports",
      legalName: `ANDES TECH IMPORTS SAS${suffix}`,
      country: "CO",
      ...overrides,
    };
  }

  beforeAll(() => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });
  });

  afterAll(async () => {
    await db.delete(issuer).where(like(issuer.legalName, `%${suffix}`));
    await db.$client.end();
  });

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
    const [created] = await db
      .insert(issuer)
      .values(build({ legalName: `DEFAULT STATUS SAS${suffix}` }))
      .returning();

    expect(created?.verificationStatus).toBe("unverified");
  });

  it("stores timestamps with a timezone", async () => {
    const [created] = await db
      .insert(issuer)
      .values(build({ legalName: `TIMESTAMPS SAS${suffix}` }))
      .returning();

    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.updatedAt).toBeInstanceOf(Date);
  });

  it("rejects a verification status outside the enum", async () => {
    await expectSqlState(
      db
        .insert(issuer)
        .values({
          ...build({ legalName: `BAD STATUS SAS${suffix}` }),
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
  ])("rejects a country that is not ISO 3166-1 alpha-2: %s", async (label, country) => {
    await expectSqlState(
      db
        .insert(issuer)
        .values(build({ legalName: `BAD COUNTRY ${label} SAS${suffix}`, country }))
        .returning(),
      CHECK_VIOLATION,
    );
  });

  it("rejects a second issuer with the same legal name in the same country", async () => {
    const values = build({ legalName: `DUPLICATE SAS${suffix}` });
    await db.insert(issuer).values(values).returning();

    // Two records for one company fragment a product's trust history across
    // two identities, which is the failure the passport exists to prevent.
    await expectSqlState(db.insert(issuer).values(values).returning(), UNIQUE_VIOLATION);
  });

  it("allows the same legal name in a different country", async () => {
    const legalName = `CROSS BORDER SAS${suffix}`;
    await db
      .insert(issuer)
      .values(build({ legalName, country: "CO" }))
      .returning();

    const [mexican] = await db
      .insert(issuer)
      .values(build({ legalName, country: "MX" }))
      .returning();

    expect(mexican?.country).toBe("MX");
  });

  it("advances updated_at when a row changes", async () => {
    const [created] = await db
      .insert(issuer)
      .values(build({ legalName: `TOUCHED SAS${suffix}` }))
      .returning();

    const [updated] = await db
      .update(issuer)
      .set({ verificationStatus: "verified" })
      .where(eq(issuer.id, created?.id as number))
      .returning();

    expect(updated?.verificationStatus).toBe("verified");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      created?.updatedAt.getTime() as number,
    );
  });
});
