/**
 * Restores a real backup into an empty database and asks whether TrustPass
 * came back — all of it, including the part that decides who may change it.
 *
 * The distinction this exists to enforce:
 *
 *   pnpm db:reset      migrations rebuild the schema.   Proves nothing about a backup.
 *   pnpm db:restore-drill   a dump rebuilds the database.   Proves recovery.
 *
 * So the temporary database is created empty, asserted empty, and **never
 * migrated**. If `db:migrate` appeared anywhere in here, a green result would
 * mean the migrations work, which is already known and is not the question.
 *
 * And after #119, #127, #129 and #131 the question is bigger than the data.
 * A restore that returns every product into a database where `trustpass_runtime`
 * can drop a trigger has recovered the rows and lost the guarantees they are
 * worth something because of. The drill asserts the security posture as part of
 * the recovery, not after it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { takeBackup } from "./backup.js";
import {
  backupDestination,
  cluster,
  clusterIsReachable,
  copyIn,
  query,
  run,
  tryQuery,
} from "./pg-tools.js";

interface Check {
  criterion: string;
  passed: boolean;
  source?: string;
  restored?: string;
  detail?: string;
}

const checks: Check[] = [];

function compare(criterion: string, source: string, restored: string, detail?: string): void {
  checks.push({ criterion, passed: source === restored, source, restored, detail });
}

function assert(criterion: string, passed: boolean, detail: string): void {
  checks.push({ criterion, passed, detail });
}

/** What the catalogue should look like, asked identically of both databases. */
const CATALOGUE: { name: string; sql: string }[] = [
  {
    name: "tables",
    sql: "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'",
  },
  {
    name: "functions",
    sql: "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'",
  },
  {
    // Enabled, not merely present. A trigger restored in a disabled state is
    // listed in pg_trigger and enforces nothing — the quiet failure #125 named.
    name: "enabled triggers",
    sql: "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'D'",
  },
  {
    name: "constraints",
    sql: "SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace",
  },
  { name: "indexes", sql: "SELECT count(*) FROM pg_indexes WHERE schemaname='public'" },
  {
    // Values, not just the type. Renaming one restates every event recorded
    // under it without touching a row, which is what #131 measured.
    name: "enum values",
    sql: `SELECT string_agg(t.typname || '=' || e.enumlabel, ',' ORDER BY t.typname, e.enumsortorder)
          FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname='public'`,
  },
];

const TABLES = [
  "product",
  "lifecycle_event",
  "organization",
  "actor",
  "membership",
  "capacity_grant",
  "capacity_grant_revocation",
  "credential",
];

async function main(): Promise<void> {
  const c = cluster();
  const source = process.env.TP_PG_DATABASE || "trustpass";
  const restored = process.env.TP_RESTORE_DATABASE || "trustpass_restore_drill";
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const directory = backupDestination(process.argv[2] ?? "packages/db/.backups/drill", repoRoot);
  const startedAt = new Date().toISOString();

  if (!clusterIsReachable(c)) {
    throw new Error(
      `Cannot reach "${c.container}". Start it with pnpm db:up, or set TP_PG_CONTAINER.`,
    );
  }

  console.log(`Backing up ${source} …`);
  const manifest = takeBackup(directory, source);

  // The backup, checked before anything is trusted to it. A truncated dump is
  // a file of the right name that restores into half a database.
  for (const file of manifest.files) {
    const bytes = readFileSync(join(directory, file.name));
    assert(
      `backup file ${file.name} matches its recorded hash`,
      createHash("sha256").update(bytes).digest("hex") === file.sha256 &&
        bytes.length === file.bytes,
      `${file.bytes} bytes, ${file.sha256.slice(0, 16)}…`,
    );
  }

  // Copied in rather than piped. See copyIn: a custom-format dump is read by
  // seeking, and a pipe cannot seek.
  // Not a fixed path under /tmp. That directory is world-writable, so a fixed
  // name can be replaced between the copy and the restore by anything else in
  // the container — the same shape of race CodeQL found in the preflight. A
  // private directory, made fresh, removes the window rather than narrowing it.
  const scratch = run(c, ["mktemp", "-d", "-t", "tp-drill-XXXXXXXX"])
    .stdout.toString("utf8")
    .trim();
  const inContainer = `${scratch}/restore.dump`;
  const copied = copyIn(c, join(directory, `${source}.dump`), inContainer);
  assert(
    "the dump reached the server",
    copied.ok,
    copied.ok ? inContainer : copied.stderr.trim().slice(0, 160),
  );

  const listing = run(c, ["pg_restore", "--list", inContainer]);
  assert(
    "the dump describes itself, so it is a dump and not a broken file",
    listing.ok && listing.stdout.toString("utf8").includes("TABLE DATA"),
    listing.ok
      ? `${listing.stdout.toString("utf8").split("\n").length} entries`
      : listing.stderr.trim().slice(0, 120),
  );

  // Roles are cluster-level and absent from pg_dump. Asserted by content,
  // because in this cluster they already exist and applying the file changes
  // nothing — the check that matters is that a *new* cluster could rebuild
  // them from what was saved.
  const rolesSql = readFileSync(join(directory, "roles.sql"), "utf8");
  for (const role of ["trustpass_owner", "trustpass_migration", "trustpass_runtime"]) {
    assert(
      `roles.sql can recreate ${role}`,
      rolesSql.includes(role),
      "cluster-level, not in pg_dump",
    );
  }

  console.log(`Creating an empty ${restored} …`);
  run(c, ["dropdb", "-U", c.user, "--if-exists", "--force", restored]);
  const created = run(c, ["createdb", "-U", c.user, restored]);

  if (!created.ok) {
    throw new Error(`Could not create ${restored}: ${created.stderr.trim()}`);
  }

  // The load-bearing assertion of the whole drill. Everything that exists in
  // this database after this line came out of the backup, because there was
  // nothing here and nothing else ran.
  const before = query(
    c,
    restored,
    "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace",
  );
  assert(
    "the target database was empty before the restore",
    before === "0",
    `${before} objects in public`,
  );

  console.log("Restoring …");
  // No --no-owner. Ownership is exactly what this drill is checking survived,
  // and that flag would have thrown it away to make the restore quieter.
  const restore = run(c, [
    "pg_restore",
    "-U",
    c.user,
    "-d",
    restored,
    "--exit-on-error",
    inContainer,
  ]);

  assert(
    "pg_restore completed without an error",
    restore.ok,
    restore.ok ? "" : restore.stderr.trim().slice(0, 300),
  );

  if (!restore.ok) {
    report(startedAt, manifest, restored, directory);
    process.exit(1);
  }

  console.log("Comparing …\n");

  for (const item of CATALOGUE) {
    compare(item.name, query(c, source, item.sql), query(c, restored, item.sql));
  }

  for (const table of TABLES) {
    compare(
      `rows in ${table}`,
      query(c, source, `SELECT count(*) FROM ${table}`),
      query(c, restored, `SELECT count(*) FROM ${table}`),
    );
  }

  // A row count is a number. This asks whether a real passport still resolves
  // with the history that makes it mean anything.
  const sampleId = query(
    c,
    source,
    "SELECT trustpass_id FROM product WHERE organization_id IS NOT NULL ORDER BY id LIMIT 1",
  );
  const passportSql = `SELECT p.trustpass_id || '|' || p.status || '|' || coalesce(o.company_name,'-') || '|' || o.verification_status
       || '|events=' || (SELECT count(*) FROM lifecycle_event e WHERE e.product_id = p.id)
     FROM product p JOIN organization o ON o.id = p.organization_id WHERE p.trustpass_id = '${sampleId}'`;
  compare(
    "a real passport resolves, with its party and its history",
    query(c, source, passportSql),
    query(c, restored, passportSql),
    sampleId,
  );

  // Ownership and grants: the half a data-only comparison would miss entirely.
  const ownership = `SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relkind IN ('r','S') AND relowner <> 'trustpass_owner'::regrole`;
  compare(
    "every object is owned by trustpass_owner",
    query(c, source, ownership),
    query(c, restored, ownership),
  );

  const matrix = `SELECT string_agg(c.relname || ':' ||
        (CASE WHEN has_table_privilege('trustpass_runtime', c.oid, 'SELECT') THEN 'S' ELSE '' END) ||
        (CASE WHEN has_table_privilege('trustpass_runtime', c.oid, 'INSERT') THEN 'I' ELSE '' END) ||
        (CASE WHEN has_table_privilege('trustpass_runtime', c.oid, 'UPDATE') THEN 'U' ELSE '' END) ||
        (CASE WHEN has_table_privilege('trustpass_runtime', c.oid, 'DELETE') THEN 'D' ELSE '' END) ||
        (CASE WHEN has_table_privilege('trustpass_runtime', c.oid, 'TRUNCATE') THEN 'T' ELSE '' END), ' ' ORDER BY c.relname)
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`;
  compare(
    "the runtime grant matrix survived",
    query(c, source, matrix),
    query(c, restored, matrix),
  );

  const attributes = `SELECT string_agg(rolname || ':' || rolsuper::text || rolcreatedb::text || rolcreaterole::text
        || rolreplication::text || rolbypassrls::text, ' ' ORDER BY rolname)
      FROM pg_roles WHERE rolname LIKE 'trustpass%'`;
  compare(
    "the roles carry the same attributes",
    query(c, source, attributes),
    query(c, restored, attributes),
  );

  // The database's own ACL, which pg_dump does not carry. Replayed from the
  // third backup file, then compared exactly.
  //
  // The first version of this drill asked `has_database_privilege(runtime,
  // CONNECT)` and passed — for the wrong reason. A freshly created database
  // gives PUBLIC both CONNECT and TEMPORARY by default, so the runtime could
  // connect because *everyone* could. It took the least-privilege suite,
  // pointed at the restored database, to say so: `cannot create anything in
  // the schema` failed on TEMP. A boolean that the default answers yes to is
  // not a check.
  const aclStatements = readFileSync(join(directory, "database-acl.sql"), "utf8")
    .replaceAll("@DATABASE@", restored)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  assert(
    "the backup carries the database's own privileges",
    aclStatements.some((line) => line.startsWith("REVOKE ALL")),
    `${aclStatements.length} statements`,
  );

  for (const statement of aclStatements) {
    const applied = run(c, [
      "psql",
      "-U",
      c.user,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-qc",
      statement,
    ]);
    if (!applied.ok) {
      assert(
        "replaying the database ACL",
        false,
        `${statement} -> ${applied.stderr.trim().slice(0, 120)}`,
      );
    }
  }

  // Compared by shape, with the database name normalised away, because the
  // restored database is deliberately called something else.
  const aclOf = (database: string) =>
    (
      tryQuery(
        c,
        "postgres",
        // Sorted by the entry itself, in a subquery. The first version used
        // `ORDER BY 1` inside string_agg, which orders by an argument
        // expression rather than the result, and the two databases came back
        // with identical privileges in a different order. Order-dependent, not
        // wrong — the third time this repository has met that distinction, and
        // the second time the fix was to name the ordering rather than the
        // reading.
        `SELECT coalesce(string_agg(entry, ' ' ORDER BY entry), 'default') FROM (
           SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                   || '=' || a.privilege_type) AS entry
           FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = '${database}'
         ) entries`,
      ) ?? ""
    ).trim();

  compare("PUBLIC holds nothing on the database, as 0024 left it", aclOf(source), aclOf(restored));

  const publicTemp = `SELECT has_database_privilege('public','${restored}','TEMP')::text`;
  assert(
    "PUBLIC cannot create temporary tables in the restored database",
    tryQuery(c, "postgres", publicTemp) === "false",
    "the failure the first drill missed",
  );

  run(c, ["rm", "-rf", scratch]);
  report(startedAt, manifest, restored, directory);
}

function report(startedAt: string, manifest: unknown, restored: string, directory: string): void {
  const failed = checks.filter((check) => !check.passed);

  for (const check of checks) {
    const mark = check.passed ? "  ok   " : "  FAIL ";
    const values =
      check.source !== undefined ? `${check.source} -> ${check.restored}` : (check.detail ?? "");
    console.log(`${mark}${check.criterion.padEnd(58)} ${values.slice(0, 70)}`);
  }

  const reportPath = join(directory, "restore-report.json");

  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        restored_database: restored,
        // Recorded because it is the difference between recovery and rebuild,
        // and because a report that does not say so invites the assumption.
        migration_executed: false,
        backup: manifest,
        checks,
        passed: failed.length === 0,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`Evidence: ${reportPath}`);

  if (failed.length > 0) {
    console.log("\nA restore that does not reproduce the source is not a restore.");
    process.exitCode = 1;
    return;
  }

  console.log("\nThe data came back. Whether the boundary came back is the next question:");
  console.log(
    `  RUNTIME_DATABASE_URL=postgresql://trustpass_runtime:<password>@localhost:5433/${restored} \\`,
  );
  console.log("    pnpm --filter @trustpass/db test -- src/schema/least-privilege");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
