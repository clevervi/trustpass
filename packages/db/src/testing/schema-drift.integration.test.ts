/**
 * The schema the application believes it has, against the one it actually has.
 *
 * The unit tests beside this one prove the comparison can tell a difference.
 * They cannot prove the catalogue query still matches anything — a filter
 * tightened, a schema renamed, and it returns an empty set that agrees with
 * nothing and reports no drift. So the first case here refuses an empty
 * population, for the reason #199 gave and #172 met again.
 *
 * **Nothing here writes, and the note at the bottom of this file is why.** An
 * earlier version created drift with `ALTER TABLE` inside rolled-back
 * transactions and deadlocked two unrelated suites. Read that before adding a
 * test that changes anything: this database is shared with twenty-seven other
 * files running at the same time.
 *
 * Skips without DATABASE_URL, because a password cannot live in the repository.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import * as schema from "../schema/index.js";
import { type ColumnMap, columnDifferences, declaredColumns } from "./schema-drift.js";

const databaseUrl = process.env.DATABASE_URL;

/** Every column Postgres reports, grouped by table. */
async function actualColumns(db: Database): Promise<ColumnMap> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(
    sql`SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2`,
  );

  const actual: Record<string, string[]> = {};

  for (const row of rows) {
    const columns = actual[row.table_name] ?? [];

    columns.push(row.column_name);
    actual[row.table_name] = columns;
  }

  return actual;
}

describe.skipIf(!databaseUrl)("the database matches the schema the application believes", () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(databaseUrl ?? "");
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("reads a population from both sides, so an empty comparison cannot pass", async () => {
    const declared = declaredColumns(schema);
    const actual = await actualColumns(db);

    // #199's lesson. Two empty sets agree perfectly and prove nothing, and the
    // assertion below would be green for a query that had stopped matching.
    expect(Object.keys(declared).length).toBeGreaterThan(0);
    expect(Object.keys(actual).length).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(Object.keys(declared).sort());
  });

  it("agrees on every column of every table", async () => {
    expect(columnDifferences(declaredColumns(schema), await actualColumns(db))).toEqual([]);
  });

  it("sees the real catalogue, not a shape the comparison would agree with anyway", async () => {
    const actual = await actualColumns(db);

    // Written out, because "some columns came back" is true of a query that
    // returned the wrong table's. These two carry the columns #157 and #162 are
    // about.
    expect(actual.product).toContain("serial");
    expect(actual.product).toContain("trustpass_id");
    expect(actual.lifecycle_event).toContain("recorded_in_xact");
    expect(actual.membership).toContain("ended_at");
  });
});

/**
 * **There were two more tests here, and removing them is the finding.**
 *
 * They created real drift — `ALTER TABLE lifecycle_event ADD COLUMN tp_probe`,
 * the same on `organization`, and a `DROP COLUMN` on `membership` — inside
 * transactions that rolled back, and asserted that the comparison reported it on
 * two tables. They worked. They also **deadlocked the suite**:
 *
 * ```
 * 40P01  Process 263 waits for RowExclusiveLock on relation 16554;
 *                    blocked by process 281.
 *        Process 281 waits for AccessExclusiveLock on relation 16711;
 *                    blocked by process 263.
 * ```
 *
 * `ALTER TABLE` takes ACCESS EXCLUSIVE and holds it until the rollback. Vitest
 * runs twenty-eight files in parallel against one database and `lifecycle_event`
 * is written by most of them, so the two sides took their locks in opposite
 * orders and Postgres killed one. Two suites that had nothing to do with this
 * change failed, naming code that was correct.
 *
 * This is the mechanism #207 was opened about as a *suspect*, now reproduced
 * with an error code, and it is worth more than the tests it cost.
 *
 * **What is not lost.** Drift detection is proved in `schema-drift.test.ts`
 * against fixtures, on two tables, where the mutations can reach it — the
 * `Mutations` workflow has no Postgres, so that is the only place it could have
 * been checked anyway. What an integration test can add is that the catalogue
 * query still matches and that the real schema agrees, and both of those are
 * above without a single `ALTER TABLE`.
 *
 * Fabricating drift to watch a pure function notice it was asking a shared
 * cluster to prove something a fixture proves better.
 */
