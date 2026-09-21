/**
 * The rule that decides, without a database.
 *
 * The `Mutations` workflow has no Postgres service, so a guard reachable only
 * through an integration test cannot be broken on purpose — the name filter
 * matches a skipped test and the runner reports `no-such-test`. Everything that
 * decides lives here for that reason.
 *
 * **These check the property, not today's file.** Several statements below do
 * not appear anywhere in `least-privilege.integration.test.ts`; they are here
 * because the rule has to hold for the write somebody adds next, which is the
 * whole of #171.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isReadOnly, readOnly, statementVerb, WriteOutsideTheHarness } from "./read-only.js";

describe("what a statement would actually execute", () => {
  it("reads the verb through interpolated parameters", () => {
    // `${42}` becomes `$1` before the verb is read, so a parameterised write is
    // not disguised by its parameters.
    expect(statementVerb(sql`UPDATE product SET status = status WHERE id = ${42}`)).toBe("UPDATE");
  });

  it("reads the verb through an interpolated identifier", () => {
    expect(statementVerb(sql`UPDATE product SET ${sql.identifier("serial")} = 'x'`)).toBe("UPDATE");
  });

  it("reads the verb through leading whitespace and newlines", () => {
    const statement = sql`
      INSERT INTO credential (actor_id, kind)
      VALUES (${1}, 'api_key') RETURNING id
    `;

    expect(statementVerb(statement)).toBe("INSERT");
  });

  it("reads the verb out of a raw string, which is how the harness runs one", () => {
    expect(statementVerb(sql.raw("GRANT UPDATE ON product TO trustpass_runtime"))).toBe("GRANT");
  });
});

describe("what may reach a connection that must not change anything", () => {
  it("admits a plain read", () => {
    expect(isReadOnly(sql`SELECT count(*) AS n FROM product`)).toBe(true);
  });

  it("admits a read whose parameters mention a table it does not touch", () => {
    // `'product'` here is a value, not a target. A rule reading the text rather
    // than the verb would have to decide that, and would eventually decide it
    // wrongly.
    expect(
      isReadOnly(sql`SELECT has_table_privilege(current_user, ${"product"}, 'SELECT') AS a`),
    ).toBe(true);
  });

  it("refuses every ordinary write", () => {
    expect(isReadOnly(sql`UPDATE product SET status = 'retired'`)).toBe(false);
    expect(isReadOnly(sql`INSERT INTO product (brand) VALUES ('x')`)).toBe(false);
    expect(isReadOnly(sql`DELETE FROM lifecycle_event`)).toBe(false);
  });

  it("refuses a write that is not an INSERT, UPDATE or DELETE", () => {
    // The reason this is an allow-list. A deny-list has to be complete, and
    // these are the ones a short one forgets.
    expect(isReadOnly(sql.raw("GRANT DELETE ON lifecycle_event TO trustpass_runtime"))).toBe(false);
    expect(isReadOnly(sql.raw("ALTER TABLE product ADD COLUMN tp_probe text"))).toBe(false);
    expect(isReadOnly(sql.raw("TRUNCATE lifecycle_event"))).toBe(false);
    expect(isReadOnly(sql.raw("CREATE TABLE tp_probe (id int)"))).toBe(false);
  });

  it("refuses a verb it has never heard of, rather than letting it past", () => {
    // The property, not the inventory. A statement this rule does not recognise
    // is refused — including one Postgres adds after this was written.
    expect(isReadOnly(sql.raw("MERGE INTO product USING source ON true"))).toBe(false);
    expect(isReadOnly(sql.raw("FLUMMOX product SET everything"))).toBe(false);
  });

  it("refuses a CTE, because a writing one is indistinguishable without a parser", () => {
    const writing = sql`WITH gone AS (DELETE FROM product RETURNING *) SELECT * FROM gone`;
    const reading = sql`WITH n AS (SELECT 1 AS x) SELECT * FROM n`;

    expect(isReadOnly(writing)).toBe(false);

    // Refused too, and deliberately. A read-only CTE refused is a test somebody
    // rewrites; a writing one admitted is a committed attack.
    expect(isReadOnly(reading)).toBe(false);
  });
});

describe("the connection itself", () => {
  const spy = () => {
    const calls: unknown[] = [];
    const fake = {
      execute: (statement: unknown) => {
        calls.push(statement);
        return Promise.resolve([]);
      },
      transaction: () => Promise.resolve("untouched"),
      $client: { end: () => Promise.resolve() },
    };

    // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the client, not the client.
    return { calls, guarded: readOnly(fake as any), fake };
  };

  it("lets a read through to the real connection", async () => {
    const { calls, guarded } = spy();

    await guarded.execute(sql`SELECT 1 AS n`);

    expect(calls).toHaveLength(1);
  });

  it("refuses a write before it reaches the connection", () => {
    const { calls, guarded } = spy();

    expect(() => guarded.execute(sql`UPDATE product SET status = 'retired'`)).toThrow(
      WriteOutsideTheHarness,
    );

    // The half that matters. Throwing after the statement was sent would be a
    // message about a write that already happened.
    expect(calls).toHaveLength(0);
  });

  it("names the helper the write should have used", () => {
    const { guarded } = spy();

    expect(() => guarded.execute(sql`DELETE FROM product`)).toThrow(/attempt\(\)/);
  });

  it("leaves everything other than execute alone", async () => {
    const { guarded } = spy();

    // `transaction` is how `attempt()` does its work. Closing it here would
    // leave nowhere legitimate for a write to go.
    await expect(guarded.transaction(async () => undefined)).resolves.toBe("untouched");
    expect(typeof guarded.$client.end).toBe("function");
  });
});
