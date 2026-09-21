/**
 * The comparison, without a database.
 *
 * #162 asks for the guard to be mutation-checked on at least two tables. That is
 * only possible here: the `Mutations` workflow has no Postgres service, so a
 * mutation whose named test needs one matches a skipped test and the runner
 * reports `no-such-test` rather than a verdict. Every case below names two
 * tables for that reason, and the integration file proves the same property
 * against a real catalogue.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { columnDifferences, declaredColumns } from "./schema-drift.js";

// A fixture barrel rather than the real one. Asserting against `schema/*.ts`
// would make the test agree with whatever the schema currently says, which is
// the circularity the module's header rejects for a different reason.
const widget = pgTable("widget", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
});

const gadget = pgTable("gadget", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

const BARREL = { widget, gadget, notATable: "a type export, an enum, a helper" };

describe("what the schema declares", () => {
  it("finds every table in the barrel and ignores what is not one", () => {
    expect(declaredColumns(BARREL)).toEqual({
      widget: ["id", "label"],
      gadget: ["created_at", "id"],
    });
  });

  it("reports the database column name, not the TypeScript property name", () => {
    // `createdAt` in the schema file is `created_at` in Postgres. Comparing the
    // property name would report every snake_case column as drift on the first
    // run, and the fix somebody would reach for is deleting the test.
    expect(declaredColumns(BARREL).gadget).toContain("created_at");
    expect(declaredColumns(BARREL).gadget).not.toContain("createdAt");
  });
});

describe("where the database and the schema disagree", () => {
  const DECLARED = { widget: ["id", "label"], gadget: ["created_at", "id"] };

  it("finds nothing when both describe the same thing", () => {
    expect(columnDifferences(DECLARED, { ...DECLARED })).toEqual([]);
  });

  it("reports a column the database has and the schema does not, on either table", () => {
    // The `tp_probe` case, which #157 found by hand on `product`.
    expect(
      columnDifferences(DECLARED, {
        widget: ["id", "label", "tp_probe"],
        gadget: ["created_at", "id"],
      }),
    ).toEqual(["widget.tp_probe: in the database, not in the schema"]);

    expect(
      columnDifferences(DECLARED, {
        widget: ["id", "label"],
        gadget: ["created_at", "id", "tp_probe"],
      }),
    ).toEqual(["gadget.tp_probe: in the database, not in the schema"]);
  });

  it("reports a column the schema has and the database does not, on either table", () => {
    // A migration that was never generated, or never applied. The ordinary
    // mistake, and the one a literal list could not catch at all.
    expect(columnDifferences(DECLARED, { widget: ["id"], gadget: ["created_at", "id"] })).toEqual([
      "widget.label: in the schema, not in the database",
    ]);

    expect(columnDifferences(DECLARED, { widget: ["id", "label"], gadget: ["id"] })).toEqual([
      "gadget.created_at: in the schema, not in the database",
    ]);
  });

  it("reports drift on two tables at once, rather than stopping at the first", () => {
    expect(
      columnDifferences(DECLARED, { widget: ["id", "label", "tp_probe"], gadget: ["id"] }),
    ).toEqual([
      "gadget.created_at: in the schema, not in the database",
      "widget.tp_probe: in the database, not in the schema",
    ]);
  });

  it("names a whole table rather than every column of it", () => {
    expect(columnDifferences(DECLARED, { ...DECLARED, orphan: ["id"] })).toEqual([
      "orphan: in the database, not in the schema",
    ]);

    expect(columnDifferences(DECLARED, { widget: ["id", "label"] })).toEqual([
      "gadget: in the schema, not in the database",
    ]);
  });

  it("is ordered, so the report reads the same on every machine", () => {
    const differences = columnDifferences(DECLARED, {
      widget: ["id", "label", "zzz"],
      gadget: ["created_at", "id", "aaa"],
    });

    expect(differences).toEqual([
      "gadget.aaa: in the database, not in the schema",
      "widget.zzz: in the database, not in the schema",
    ]);
  });
});
