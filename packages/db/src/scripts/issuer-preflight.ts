import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../client.js";

/**
 * Whether `issuer` can be dropped yet.
 *
 * ADR 0012 splits the identity migration in two: #113 moved the data, and the
 * destructive half drops `issuer_id` and then `issuer`. This decides whether
 * the second may run, and it exists because *"the application no longer needs
 * `issuer`"* is otherwise an opinion — held most confidently by whoever is
 * about to run the `DROP`.
 *
 * It reads and never writes. A preflight that changes anything is not one.
 *
 * It counts **code** as well as rows, which is the half a SQL-only check
 * misses: a database with no `issuer_id` values and a repository that still
 * selects the column is not ready, it is one deploy away from an error nobody
 * saw coming.
 */

/** A condition that must hold before anything is dropped. */
interface Condition {
  readonly label: string;
  readonly count: number;
  /** What the count has to be. Everything here must reach zero. */
  readonly mustBe: 0;
  /** What it means when it is not zero, in one line. */
  readonly ifNotZero: string;
}

/**
 * Files that still depend on the `issuer` **table**.
 *
 * The word is not the dependency, and the first version of this check confused
 * the two. It reported twenty files, of which `recording-authority.ts` names
 * `issuer` as an **actor capacity** — a value in `lifecycleActorKind` that
 * outlives the table entirely — while `qr.ts` had it in a comment and
 * `claim-wording.ts` in the words a passport shows a reader.
 *
 * None of those break when the table goes. Counting them would make the check
 * unpassable by anything short of renaming a capacity, and a check that cannot
 * pass is a check people learn to skip.
 *
 * So this looks for the column and the table: `issuerId`, `issuer_id`, a query
 * against `issuer`, or its row types. The schema declares the table by
 * necessity until it is dropped, and migrations are history that is never
 * edited; both are excluded.
 */
const DEPENDS_ON_THE_TABLE =
  /\bissuerId\b|\bissuer_id\b|\b(?:from|insert|into|join)\s*\(\s*issuer\s*[),]|\bNewIssuer\b|\bIssuerVerificationStatus\b/;
/**
 * The repository root, found rather than assumed.
 *
 * The first version computed it from `import.meta.dirname` and four `..`
 * segments. The arithmetic was right and the value was not what the script saw
 * under `tsx`, so the walk scanned nothing, found nothing, and printed **READY
 * FOR THE DESTRUCTIVE MIGRATION** — with nineteen files still depending on the
 * table it was about to approve dropping.
 *
 * That is the exact failure the check exists to prevent, produced by the check.
 * So it climbs until it finds the workspace file, and `scanned` below proves it
 * actually looked.
 */
function repositoryRoot(): string {
  let current = resolve(process.cwd());

  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        "Could not find the repository root. Refusing to report on a tree I cannot see.",
      );
    }
    current = parent;
  }

  return current;
}

function filesDependingOnTheIssuerTable(root: string): {
  readonly offenders: readonly string[];
  readonly scanned: number;
} {
  const offenders: string[] = [];
  let scanned = 0;

  const skip = new Set(["node_modules", "dist", ".next", "drizzle", "scripts"]);
  const allowed = /[\\/]schema[\\/]/;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;

      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }

      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      // Tests follow the code they test; they are not an independent
      // dependency, and counting them would report the same work twice.
      if (entry.includes(".test.")) continue;
      if (allowed.test(full)) continue;

      scanned += 1;
      if (DEPENDS_ON_THE_TABLE.test(readFileSync(full, "utf8"))) {
        offenders.push(relative(root, full));
      }
    }
  }

  walk(root);
  return { offenders: offenders.sort(), scanned };
}

/**
 * The check checks itself first.
 *
 * This script has now reported **READY FOR THE DESTRUCTIVE MIGRATION** twice
 * while nineteen files still depended on the table. Once because it computed
 * the wrong root and scanned nothing; once because the word boundaries in its
 * pattern were written as literal backspace characters, so it matched nothing.
 *
 * Both failures printed the same reassuring sentence. A check that can be
 * silently wrong in the permissive direction is worse than no check, because
 * it converts a judgement into a false guarantee — so it now proves it can
 * still recognise a dependency before it is allowed to say anything about one.
 */
const MUST_MATCH = [
  "const x = product.issuerId;",
  "await db.select().from(issuer);",
  "type T = NewIssuer;",
] as const;

const MUST_NOT_MATCH = [
  "issuer: ['record_enrolled', 'product_registered'],",
  "// for an issuer who needs a file to print",
  'issuer: "Issuer",',
] as const;

function theCheckStillWorks(): string | null {
  for (const sample of MUST_MATCH) {
    if (!DEPENDS_ON_THE_TABLE.test(sample)) {
      return `pattern no longer recognises a dependency: ${sample}`;
    }
  }

  for (const sample of MUST_NOT_MATCH) {
    if (DEPENDS_ON_THE_TABLE.test(sample)) {
      return `pattern now flags the actor capacity or prose: ${sample}`;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const broken = theCheckStillWorks();

  if (broken) {
    console.error(`Preflight is not trustworthy: ${broken}`);
    process.exit(2);
  }

  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error("DATABASE_URL is not set. This check reads the database.");
    process.exit(2);
  }

  const db = createDatabase(url);
  const repoRoot = repositoryRoot();

  try {
    const [counts] = await db.execute<Record<string, string>>(
      sql`SELECT
            (SELECT count(*) FROM issuer)::text AS issuers,
            (SELECT count(*) FROM organization)::text AS organizations,
            (SELECT count(*) FROM product WHERE issuer_id IS NOT NULL)::text
              AS products_on_issuer,
            (SELECT count(*) FROM lifecycle_event WHERE issuer_id IS NOT NULL)::text
              AS events_on_issuer,
            (SELECT count(*) FROM product
               WHERE issuer_id IS NOT NULL AND organization_id IS NULL)::text
              AS products_unmoved,
            (SELECT count(*) FROM lifecycle_event
               WHERE issuer_id IS NOT NULL AND organization_id IS NULL)::text
              AS events_unmoved,
            (SELECT count(*) FROM issuer i WHERE NOT EXISTS (
               SELECT 1 FROM organization o
               WHERE o.country = i.country
                 AND o.registration_number = i.registration_number))::text
              AS issuers_unmatched,
            (SELECT count(*) FROM issuer i
               JOIN organization o
                 ON o.country = i.country
                AND o.registration_number = i.registration_number
               WHERE o.verification_status IS DISTINCT FROM i.verification_status)::text
              AS verification_disagreeing`,
    );

    const { offenders, scanned } = filesDependingOnTheIssuerTable(repoRoot);

    // A walk that found almost nothing has looked in the wrong place, and a
    // preflight reporting READY because it saw no code is worse than one that
    // refuses to answer. Measured: this repository has well over a hundred
    // source files, so anything under fifty means the root is wrong.
    if (scanned < 50) {
      console.error(
        `Only ${scanned} source files were scanned under ${repoRoot}. Refusing to report.`,
      );
      await db.$client.end();
      process.exit(2);
    }
    const n = (key: string): number => Number(counts?.[key] ?? "0");

    console.log(`Scanning ${repoRoot}`);
    console.log("");
    console.log("State");
    console.log(`  issuers                              ${n("issuers")}`);
    console.log(`  organizations                        ${n("organizations")}`);
    console.log(`  products referencing an issuer       ${n("products_on_issuer")}`);
    console.log(`  events referencing an issuer         ${n("events_on_issuer")}`);
    console.log(`  source files scanned                 ${scanned}`);
    console.log("");

    const conditions: readonly Condition[] = [
      {
        label: "issuers with no organization",
        count: n("issuers_unmatched"),
        mustBe: 0,
        ifNotZero: "a party would lose its identity when issuer goes",
      },
      {
        label: "products with an issuer and no organization",
        count: n("products_unmoved"),
        mustBe: 0,
        ifNotZero: "dropping issuer_id would orphan them",
      },
      {
        label: "events with an issuer and no organization",
        count: n("events_unmoved"),
        mustBe: 0,
        ifNotZero: "history would stop naming who acted",
      },
      {
        label: "parties whose two records disagree about verification",
        count: n("verification_disagreeing"),
        mustBe: 0,
        ifNotZero: "dropping one would pick a winner silently",
      },
      {
        label: "source files still depending on the issuer table",
        count: offenders.length,
        mustBe: 0,
        ifNotZero: "the application still needs the table it is about to lose",
      },
    ];

    console.log("Conditions for the destructive migration");
    for (const condition of conditions) {
      const ok = condition.count === condition.mustBe;
      console.log(
        `  ${ok ? "ok  " : "NOT "} ${String(condition.count).padStart(4)}  ${condition.label}`,
      );
      if (!ok) console.log(`         -> ${condition.ifNotZero}`);
    }

    if (offenders.length > 0) {
      console.log("");
      console.log("Files still depending on the issuer table:");
      for (const file of offenders) console.log(`  ${file}`);
    }

    const blocking = conditions.filter((c) => c.count !== c.mustBe);

    console.log("");
    if (blocking.length === 0) {
      console.log("READY FOR THE DESTRUCTIVE MIGRATION");
    } else {
      console.log(`NOT READY: ${blocking.length} condition(s) unmet.`);
    }

    await db.$client.end();
    process.exit(blocking.length === 0 ? 0 : 1);
  } catch (error) {
    await db.$client.end().catch(() => undefined);
    console.error("Preflight could not complete:", error);
    process.exit(2);
  }
}

await main();
