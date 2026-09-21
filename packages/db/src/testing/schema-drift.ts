/**
 * Whether the database holds the columns the application believes it holds.
 *
 * #157 found a `tp_probe text` column on `product` in a development database: in
 * no migration, in no schema file, and invisible to all 35 tests in
 * `least-privilege.integration.test.ts`. It added `covers every column of
 * product`, which closed the hole on one table. #162 is the other seven.
 *
 * **The expected set is derived from `schema/*.ts`, and that is the argued half
 * of #162.** The alternative was a literal map of table to column list, in the
 * shape `covers every table` already uses for grants. Both were considered
 * against what each can actually catch:
 *
 * | | derived | literal |
 * |---|---|---|
 * | A column added out of band — the `tp_probe` case | caught | caught |
 * | A hand-written migration adds a column the schema never declared | caught | caught |
 * | `schema/*.ts` edited and no migration generated | **caught** | missed |
 * | A column added deliberately, schema and migration together | not caught | caught |
 *
 * The last row is the only one the literal list wins, and it wins it by failing
 * on a legitimate change — which is the thing #162 itself warns about: *"a test
 * that fails for a legitimate change is a test people learn to update without
 * reading."* Every migration touching a column would edit that list, and a list
 * edited that often is edited without being read.
 *
 * The third row is the one only the derived version catches, and it is an
 * ordinary mistake rather than an exotic one.
 *
 * **Why `least-privilege.integration.test.ts` keeps its literal lists anyway.**
 * That file splits `product`'s columns into `MAY_UPDATE` and `MAY_NOT_UPDATE`
 * and asserts the catalogue equals their union. It is not asking whether the
 * column should exist; it is asking **which side of a privilege decision it
 * falls on**, and that is a decision a person makes and records. Here there is
 * no decision to record — the schema *is* the decision — so deriving is right in
 * one place and wrong in the other, for a reason rather than by taste.
 *
 * **What this cannot do.** It compares two descriptions of the same intent, so
 * it says nothing about whether the intent is good. A column that should never
 * have been added passes as soon as it is declared. That is review's job, and
 * this is drift's.
 */
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

/** Table name to its column names, sorted, as `schema/*.ts` declares them. */
export type ColumnMap = Readonly<Record<string, readonly string[]>>;

/** Deterministic order, and not `localeCompare`, which varies by locale. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
}

/**
 * What the application believes, read out of the schema barrel.
 *
 * Takes the barrel as an argument rather than importing it, so the comparison
 * below can be tested against a fixture without a database and without the real
 * schema — which is what makes the guard mutation-checkable at all. The
 * `Mutations` workflow has no Postgres service.
 */
export function declaredColumns(barrel: Record<string, unknown>): ColumnMap {
  const declared: Record<string, readonly string[]> = {};

  for (const value of Object.values(barrel)) {
    if (!is(value, PgTable)) continue;

    declared[getTableName(value)] = Object.values(getTableColumns(value))
      .map((column) => column.name)
      .sort(byCodeUnit);
  }

  return declared;
}

/**
 * Where the database and the schema disagree, in words a reader can act on.
 *
 * Both directions, and they are different defects: a column the database has and
 * the schema does not is something nobody declared, and a column the schema has
 * and the database does not is a migration that was never generated or never
 * applied. Reporting only one direction would make the second invisible, and the
 * second is the ordinary mistake.
 *
 * Whole tables too. A table missing from one side is not a column problem, and
 * saying "every column of X is missing" for it would bury the actual fact under
 * however many columns X has.
 */
export function columnDifferences(declared: ColumnMap, actual: ColumnMap): readonly string[] {
  const differences: string[] = [];
  const tables = [...new Set([...Object.keys(declared), ...Object.keys(actual)])].sort(byCodeUnit);

  for (const table of tables) {
    const inSchema = declared[table];
    const inDatabase = actual[table];

    if (inSchema === undefined) {
      differences.push(`${table}: in the database, not in the schema`);
      continue;
    }

    if (inDatabase === undefined) {
      differences.push(`${table}: in the schema, not in the database`);
      continue;
    }

    const schemaHas = new Set(inSchema);
    const databaseHas = new Set(inDatabase);

    for (const column of inDatabase) {
      if (!schemaHas.has(column)) {
        differences.push(`${table}.${column}: in the database, not in the schema`);
      }
    }

    for (const column of inSchema) {
      if (!databaseHas.has(column)) {
        differences.push(`${table}.${column}: in the schema, not in the database`);
      }
    }
  }

  return differences;
}
