/**
 * A connection that refuses to write, for tests whose writes must be rolled back.
 *
 * #160 fixed one instance of a test committing an attack it expected to be
 * refused. #171 found six more, still present: `expectSqlState(db.execute(…))`
 * awaits the promise and checks the error code, so a statement that **succeeds**
 * fails the test after committing. Measured, on a cluster whose privilege model
 * had been weakened by one `GRANT`: three tests correctly went red and a
 * `product` row was left permanently carrying the attacker's identifier.
 *
 * **The decision is made from the statement, not from the source text.** A guard
 * that read `least-privilege.integration.test.ts` would be a regular expression
 * over 848 lines that contain the words UPDATE and DELETE in comments, in
 * strings and in prose — and no parser is available to do better, because
 * `typescript@7.0.2` is the native port and exports only `version` and
 * `versionMajorMinor`. That is the instrument class that produced eight false
 * results in this repository in one day.
 *
 * At run time there is no prose. `PgDialect.sqlToQuery` renders exactly the
 * statement that would reach the server, parameters already replaced by `$1`,
 * whatever the source looked like.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "../client.js";

const dialect = new PgDialect();

/**
 * The verb a statement would actually execute.
 *
 * Rendering first is the whole point: multi-line text collapses, `${victim}`
 * becomes `$1`, `sql.identifier(column)` becomes a quoted name, and a comment in
 * the file that says `UPDATE` is not part of anything. Pure — no I/O — so the
 * rule below can be broken on purpose without a database, which is the only way
 * it can be mutation-checked at all: the `Mutations` workflow has no Postgres
 * service.
 */
export function statementVerb(statement: SQL | string): string {
  const rendered = typeof statement === "string" ? statement : dialect.sqlToQuery(statement).sql;

  return (rendered.trim().match(/^[a-zA-Z]+/) ?? ["?"])[0].toUpperCase();
}

/**
 * The one verb allowed through a read-only connection.
 *
 * **An allow-list, so it fails closed.** A deny-list of `INSERT|UPDATE|DELETE`
 * has to be complete to be correct, and it is not: `GRANT`, `ALTER`, `TRUNCATE`,
 * `CREATE`, `COPY … FROM`, `CALL` and `DO` all write, and the next Postgres
 * release may add another. Anything unrecognised is refused instead.
 *
 * `WITH` is refused too, and that is deliberate rather than an oversight. A CTE
 * can write — `WITH gone AS (DELETE FROM product RETURNING *) SELECT * FROM gone`
 * renders with `WITH` as its first word and deletes rows — and telling a writing
 * CTE from a reading one needs the parser that does not exist here. A read-only
 * CTE refused is a test that has to be rewritten; a writing one allowed is a
 * committed attack.
 */
const READS = new Set(["SELECT"]);

/** Whether a statement may go to a connection that must not change anything. */
export function isReadOnly(statement: SQL | string): boolean {
  return READS.has(statementVerb(statement));
}

/**
 * Thrown before the statement is sent, never after.
 *
 * Named for what the caller should do rather than for what went wrong: the
 * statement is not forbidden, it is in the wrong place, and there is a helper
 * whose entire purpose is to run exactly this kind of statement safely.
 */
export class WriteOutsideTheHarness extends Error {
  constructor(verb: string, rendered: string) {
    super(
      `${verb} reached a read-only connection. Writes must go through attempt(), ` +
        `which rolls them back — an attack that is not refused otherwise commits. ` +
        `Statement: ${rendered.replace(/\s+/g, " ").trim().slice(0, 120)}`,
    );
    this.name = "WriteOutsideTheHarness";
  }
}

/**
 * The same connection, minus the ability to change anything.
 *
 * A `Proxy` rather than a hand-written wrapper, because the object has a wide
 * surface — `transaction`, `$client`, the query builders — and a wrapper that
 * forwarded the methods somebody remembered would quietly stop forwarding the
 * one added next. Only `execute` is intercepted; everything else is the real
 * thing.
 *
 * **`transaction` is deliberately left alone.** `attempt()` opens one and writes
 * inside it, which is the sanctioned path, and closing it here would leave
 * nowhere for a write to go.
 */
export function readOnly(db: Database): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "execute") return Reflect.get(target, property, receiver);

      return (statement: SQL | string, ...rest: unknown[]) => {
        if (!isReadOnly(statement)) {
          const rendered =
            typeof statement === "string" ? statement : dialect.sqlToQuery(statement).sql;

          throw new WriteOutsideTheHarness(statementVerb(statement), rendered);
        }

        return (target.execute as (...args: unknown[]) => unknown)(statement, ...rest);
      };
    },
  }) as Database;
}
