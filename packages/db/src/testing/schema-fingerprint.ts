/**
 * Everything about a database that an attack could leave behind, as a value.
 *
 * #170 claimed that nine attacks can succeed and leave the database
 * byte-identical. The evidence was a shell script in a temporary directory: the
 * pull request described it, nothing in the repository could re-run it, and it
 * is now gone. #172 is that gap, and this is the script, rewritten where it can
 * be tested.
 *
 * **It is a differ, not a validator.** It answers *did anything change between
 * these two moments*, by comparing a database with itself. It does not answer
 * *is this database correct*, which is a comparison against a reference and is
 * #162's question. The two share these catalogue queries and nothing else; the
 * note at the bottom of this file records why they stayed separate.
 *
 * **It is only meaningful against the same cluster, with nothing else writing to
 * it.** `roleMemberships` is cluster-wide rather than schema-scoped, deliberately
 * — an attack that adds the runtime to `pg_read_all_data` leaves no trace in
 * `public` — so two fingerprints of two different clusters differ for reasons
 * that mean nothing.
 *
 * The second half of that was learned by writing a test that assumed otherwise.
 * It asserted two fingerprints of an untouched database are identical, and it
 * failed on `tp_probe_fn` and `tp_probe_member`, objects belonging to other
 * suites running in parallel against the same database. Nothing was wrong with
 * the fingerprint; "untouched" was not something the environment could supply.
 * A caller comparing two moments is asserting that **only** the thing under test
 * happened in between, and that is a claim about the whole cluster.
 *
 * **The measurement was wrong three times before it was right**, and each
 * failure made the result look decided. Recorded here because the next person to
 * rebuild this will meet the same ones:
 *
 * 1. Fed through `psql -c`, only the first three of nine result sets came back.
 *    It reported `IDENTICAL` having never compared triggers, indexes,
 *    constraints or privileges — exactly the objects the successful attacks
 *    touch.
 * 2. It watched schema objects only, and reported `IDENTICAL` while the runtime
 *    was sitting on a leaked `DELETE` grant on `lifecycle_event`.
 * 3. It compared `count(*)` on `lifecycle_event` and reported `CHANGED` on a
 *    clean run, because a test file legitimately appends events. A count rises
 *    honestly; the **oldest** id is what moves when history is deleted.
 */
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import type { Transaction } from "./overlapping-transactions.js";

/**
 * A connection or a transaction on one.
 *
 * Taking a transaction is what makes this safe to exercise. Proving the
 * fingerprint notices a leaked grant means creating one, and vitest runs test
 * files in parallel against a single database — a committed `GRANT` would be a
 * real privilege escalation visible to every other suite for as long as the test
 * held it. Inside a transaction that rolls back, nothing else ever sees it.
 */
export type Queryable = Database | Transaction;

/**
 * The eleventh section is not in #170's list of ten, and it is not scope creep.
 *
 * Measured: `information_schema.role_table_grants` reports only `SELECT` and
 * `INSERT` for `trustpass_runtime` on `product`. The `UPDATE` grant #157 gave it
 * on `status` and `updated_at` appears **only** in `column_privileges`. A
 * fingerprint without that section reports `IDENTICAL` after an attack that
 * grants `UPDATE` on `product.serial` — which is the residue this exists to
 * catch.
 */
const SECTIONS = {
  tables: sql`SELECT c.relname AS value
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r'
              ORDER BY 1`,

  columns: sql`SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                      || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
                      || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') AS value
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
               WHERE n.nspname = 'public' AND c.relkind = 'r'
                 AND a.attnum > 0 AND NOT a.attisdropped
               ORDER BY 1`,

  // Hashed rather than quoted in full. A changed body has to be detected, which
  // the hash does; reading *what* changed is `pg_get_functiondef`'s job once a
  // difference is already known, and a fingerprint nobody can skim is one
  // nobody reads.
  functions: sql`SELECT p.proname || ' ' || md5(pg_get_functiondef(p.oid)) AS value
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                 ORDER BY 1`,

  // `tgenabled` carries the whole point: a disabled trigger is still listed in
  // `pg_trigger` looking entirely present. The cast is not decoration — it is
  // `"char"`, and concatenating it without one fails the query outright. That
  // error was swallowed into a silently missing section once, which is most of
  // why the refusal below exists.
  triggers: sql`SELECT c.relname || '.' || t.tgname || ' ' || t.tgenabled::text AS value
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND NOT t.tgisinternal
                ORDER BY 1`,

  enumLabels: sql`SELECT t.typname || '.' || e.enumlabel AS value
                  FROM pg_enum e
                  JOIN pg_type t ON t.oid = e.enumtypid
                  JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public'
                  ORDER BY t.typname, e.enumsortorder`,

  constraints: sql`SELECT c.conrelid::regclass::text || '.' || c.conname
                          || ' ' || pg_get_constraintdef(c.oid) AS value
                   FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                   WHERE n.nspname = 'public'
                   ORDER BY 1`,

  indexes: sql`SELECT indexname || ' ' || indexdef AS value
               FROM pg_indexes WHERE schemaname = 'public'
               ORDER BY 1`,

  // Every grantee, not only the runtime's. A grant to a role invented by the
  // attack is the case a filtered list cannot see, and that is the same argument
  // `least-privilege.integration.test.ts` makes for being exhaustive over the
  // catalogue rather than over a list somebody remembered to update.
  tablePrivileges: sql`SELECT grantee || ' ' || table_name || ' ' || privilege_type AS value
                       FROM information_schema.role_table_grants
                       WHERE table_schema = 'public'
                       ORDER BY 1`,

  columnPrivileges: sql`SELECT grantee || ' ' || table_name || '.' || column_name
                               || ' ' || privilege_type AS value
                        FROM information_schema.column_privileges
                        WHERE table_schema = 'public'
                        ORDER BY 1`,

  roleMemberships: sql`SELECT member.rolname || ' -> ' || granted.rolname AS value
                       FROM pg_auth_members am
                       JOIN pg_roles member ON member.oid = am.member
                       JOIN pg_roles granted ON granted.oid = am.roleid
                       ORDER BY 1`,

  // Not `count(*)`. An absolute count rises whenever a test registers a product,
  // so it reported CHANGED on a clean run. What moves when history is deleted or
  // truncated is the oldest id, and it stays put when history is appended to.
  oldestLifecycleEvent: sql`SELECT min(id)::text AS value FROM lifecycle_event`,
} as const;

export type SectionName = keyof typeof SECTIONS;

export type Fingerprint = { readonly [K in SectionName]: readonly string[] };

/**
 * The one section that may legitimately hold nothing.
 *
 * A database with no lifecycle events yet is a real state, and `min(id)` over no
 * rows is an answer. Every other section describes structure that exists the
 * moment the migrations have run, so an empty one means the query stopped
 * working rather than that the thing stopped existing.
 */
const MAY_BE_EMPTY: ReadonlySet<SectionName> = new Set(["oldestLifecycleEvent"]);

/**
 * Deterministic order, and deliberately not `localeCompare`.
 *
 * `typescript:S2871` asks for a compare function and suggests that one. It would
 * be the wrong one here: `localeCompare` answers according to the locale the
 * process happens to be running under, so the same set of section names could
 * sort one way on a developer's machine and another in CI — and this value is
 * asserted against literally in a test. The rule is right that a bare `sort()`
 * should not be relied on; the fix it proposes trades an unspecified order for a
 * machine-dependent one.
 *
 * These are ASCII identifiers. Code-unit order is total, stable and the same
 * everywhere.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;

  return 0;
}

/**
 * Which sections came back with nothing when they had to come back with
 * something.
 *
 * **This is the most valuable line in the original script**, and it is a
 * translation rather than a copy. There, a section went missing because `psql`
 * truncated the output and the header never appeared. Here a query either
 * returns rows or throws, so the surviving failure is the *empty* one: a query
 * that still parses, still runs, and matches nothing — after a catalogue name
 * changes, or a filter is tightened, or a schema is renamed. The consequence is
 * identical. A section that matched nothing compares equal to itself forever,
 * and a comparison built from enough of those reports `IDENTICAL` having
 * measured nothing.
 *
 * Pure, and not as a matter of taste: the `Mutations` workflow has no Postgres
 * service, so a guard whose only test needs a database cannot be mutation
 * checked at all — the filter would match a skipped test and the run would
 * report `no-such-test` rather than a verdict.
 */
export function missingSections(sections: Record<string, readonly string[]>): readonly string[] {
  return Object.keys(SECTIONS)
    .filter((name) => !MAY_BE_EMPTY.has(name as SectionName))
    .filter((name) => (sections[name]?.length ?? 0) === 0)
    .sort(byCodeUnit);
}

/**
 * Every section, or an error naming the ones that measured nothing.
 *
 * It throws rather than returning a partial value on purpose. A caller holding
 * an incomplete fingerprint can still compare it, and the comparison will pass —
 * which is the failure mode this whole file is a reaction to. A measurement that
 * reports a verdict when it did not measure is worse than one that fails.
 */
export async function schemaFingerprint(db: Queryable): Promise<Fingerprint> {
  const sections: Record<string, readonly string[]> = {};

  for (const [name, query] of Object.entries(SECTIONS)) {
    const rows = await db.execute(query);

    sections[name] = [...rows]
      .map((row) => (row as { value: unknown }).value)
      .filter((value) => value !== null)
      .map(String);
  }

  const missing = missingSections(sections);

  if (missing.length > 0) {
    throw new Error(
      `FINGERPRINT INCOMPLETE, missing: ${missing.join(", ")} — the comparison proves nothing`,
    );
  }

  return sections as Fingerprint;
}

/**
 * What moved between two fingerprints, section by section.
 *
 * `toEqual` says whether they differ. This says how, which is what a script
 * reporting on nine attacks needs to print — and what turns "something changed"
 * into a line somebody can act on.
 */
export function fingerprintDifferences(before: Fingerprint, after: Fingerprint): readonly string[] {
  const differences: string[] = [];

  for (const name of Object.keys(SECTIONS) as SectionName[]) {
    const was = new Set(before[name]);
    const now = new Set(after[name]);

    for (const value of after[name]) if (!was.has(value)) differences.push(`+ ${name}: ${value}`);
    for (const value of before[name]) if (!now.has(value)) differences.push(`- ${name}: ${value}`);
  }

  return differences;
}

/**
 * **Why this is not #162.**
 *
 * #162 wants the database compared against `packages/db/src/schema/*.ts` — *does
 * the database match the schema the application believes it has*. That is an
 * absolute question with a reference answer, it fails when a migration and the
 * schema file disagree, and it would have caught the stray `tp_probe` column on
 * its first run.
 *
 * This compares the database against itself at another moment. It has no
 * reference and cannot have one: a fingerprint's expected value *is* the
 * previous fingerprint. It would not have caught `tp_probe`, because `tp_probe`
 * was already there before anybody looked.
 *
 * So they are one query set and two questions, and collapsing them would mean
 * one of the two answers getting weaker. What #162 can take from here is the
 * `columns` query; what it cannot take is the comparison, which is the part that
 * matters in both.
 */
