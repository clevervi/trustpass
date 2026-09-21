/**
 * The guard that says whether the database holds the columns the schema declares.
 *
 * #157 found a `tp_probe text` column on `product` that was in no migration, no
 * schema file, and invisible to 35 tests. It closed that hole on one table.
 * #162 is the other seven, and its third criterion asks for the guard to be
 * mutation-checked on more than one — so every named test below names two.
 *
 * Only the pure half is here. The `Mutations` workflow has no Postgres service,
 * so a mutation whose named test needs a database matches a skipped test and the
 * runner reports `no-such-test` rather than a verdict.
 */
export default {
  name: "schema-drift",
  issue: 162,

  protects: ["packages/db/src/testing/schema-drift.ts"],

  runner: {
    cwd: "packages/db",
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "src/testing/schema-drift.test.ts",
      "--reporter=dot",
    ],
    nameFlag: "-t",
  },

  mutations: [
    {
      file: "packages/db/src/testing/schema-drift.ts",
      mutations: [
        {
          label: "the TypeScript property name is read as the column name",
          test: "reports the database column name, not the TypeScript property name",
          from: "    declared[getTableName(value)] = Object.values(getTableColumns(value))\n      .map((column) => column.name)\n      .sort(byCodeUnit);",
          to: "    declared[getTableName(value)] = Object.keys(getTableColumns(value)).sort(byCodeUnit);",
        },
        {
          // Not `if (false) continue;`. That makes `getTableName` throw on a
          // string, the test errors instead of failing its assertion, and the
          // runner reports `failed-other` and refuses to call it caught — which
          // is the rule #194 added after a mutant that would not compile was
          // counted as a guard working. A mutation has to fail the assertion.
          label: "anything in the barrel is treated as a table",
          test: "finds every table in the barrel and ignores what is not one",
          from: "    if (!is(value, PgTable)) continue;",
          to: "    if (!is(value, PgTable)) {\n      declared[String(value)] = [];\n      continue;\n    }",
        },
        {
          label: "a column only the database has is not reported",
          test: "reports a column the database has and the schema does not, on either table",
          from: "    for (const column of inDatabase) {\n      if (!schemaHas.has(column)) {\n        differences.push(`${table}.${column}: in the database, not in the schema`);\n      }\n    }\n\n",
          to: "",
        },
        {
          label: "a column only the schema has is not reported",
          test: "reports a column the schema has and the database does not, on either table",
          from: "    for (const column of inSchema) {\n      if (!databaseHas.has(column)) {\n        differences.push(`${table}.${column}: in the schema, not in the database`);\n      }\n    }",
          to: "",
        },
        {
          label: "the comparison stops after the first table",
          test: "reports drift on two tables at once, rather than stopping at the first",
          from: "  for (const table of tables) {",
          to: "  for (const table of tables.slice(0, 1)) {",
        },
        {
          label: "a table missing from the schema is reported as a column",
          test: "names a whole table rather than every column of it",
          from: "      differences.push(`${table}: in the database, not in the schema`);",
          to: "      differences.push(`${table}.*: in the database, not in the schema`);",
        },
      ],
    },
  ],
};
