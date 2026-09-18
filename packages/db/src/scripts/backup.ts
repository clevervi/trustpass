/**
 * Takes a backup. Two files, because one is not enough.
 *
 * `pg_dump` writes a database. It does not write roles: `trustpass_owner`,
 * `trustpass_migration` and `trustpass_runtime` are cluster-level objects, and
 * their attributes and memberships are not rows in any table this dump touches.
 *
 * A restore from the dump alone lands in a database where the schema is right,
 * the data is right, and the GRANT statements name roles that do not exist —
 * so either the restore fails, or it succeeds into a cluster where nothing
 * enforces the boundary #119 and #127 built.
 *
 * Nor does pg_dump write the database's own ACL. That was not a guess: the
 * first drill restored everything and the least-privilege suite then failed on
 * the restored database, because `createdb` produces the Postgres default —
 * **PUBLIC holding CONNECT and TEMPORARY** — and migration 0024 had revoked
 * exactly that. So there is a third file, and it is the one that would have
 * been missed.
 *
 *   pnpm db:backup [directory]
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupDestination, cluster, clusterIsReachable, run } from "./pg-tools.js";

/** The database's own privileges, as statements that can be replayed elsewhere. */
const ACL_SQL = `SELECT 'REVOKE ALL ON DATABASE @DATABASE@ FROM PUBLIC;'
UNION ALL
SELECT 'GRANT ' || string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type)
       || ' ON DATABASE @DATABASE@ TO '
       || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END || ';'
FROM pg_database d, aclexplode(d.datacl) a
WHERE d.datname = current_database()
GROUP BY a.grantee`;

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface BackupManifest {
  taken_at: string;
  database: string;
  server_version: string;
  files: { name: string; bytes: number; sha256: string }[];
}

export function takeBackup(directory: string, database: string): BackupManifest {
  const c = cluster();

  if (!clusterIsReachable(c)) {
    throw new Error(
      `Cannot reach the container "${c.container}". Start it with pnpm db:up, or set TP_PG_CONTAINER.`,
    );
  }

  mkdirSync(directory, { recursive: true });

  const version = run(c, ["psql", "-U", c.user, "-d", database, "-tAqc", "SHOW server_version"]);

  // Custom format, not plain SQL. It is compressed, it restores selectively,
  // and `pg_restore --list` can describe it without restoring it — which the
  // drill uses to check the backup before trusting it.
  const dump = run(c, ["pg_dump", "-U", c.user, "-d", database, "-Fc", "--no-password"]);

  if (!dump.ok || dump.stdout.length === 0) {
    throw new Error(`pg_dump produced nothing: ${dump.stderr.trim()}`);
  }

  // The half pg_dump does not cover. Cluster-wide, so it is the same file
  // whichever database is being backed up.
  const roles = run(c, ["pg_dumpall", "-U", c.user, "--roles-only", "--no-password"]);

  if (!roles.ok || roles.stdout.length === 0) {
    throw new Error(`pg_dumpall produced nothing: ${roles.stderr.trim()}`);
  }

  // Reconstructed from the catalogue rather than dumped, because no pg_dump
  // flag produces it without also producing a CREATE DATABASE that fixes the
  // name — and a restore into a differently named database is the normal case
  // for a drill. @DATABASE@ is substituted at restore time.
  const acl = run(c, ["psql", "-U", c.user, "-d", database, "-tAqc", ACL_SQL]);

  if (!acl.ok) {
    throw new Error(`Could not read the database ACL: ${acl.stderr.trim()}`);
  }

  const files = [
    { name: `${database}.dump`, data: dump.stdout },
    { name: "roles.sql", data: roles.stdout },
    { name: "database-acl.sql", data: acl.stdout },
  ];

  for (const file of files) {
    writeFileSync(join(directory, file.name), file.data);
  }

  const manifest: BackupManifest = {
    taken_at: new Date().toISOString(),
    database,
    server_version: version.stdout.toString("utf8").trim(),
    files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
  };

  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return manifest;
}

const isEntryPoint =
  process.argv[1]?.endsWith("backup.ts") || process.argv[1]?.endsWith("backup.js");

if (isEntryPoint) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const directory = backupDestination(process.argv[2] ?? "packages/db/.backups/latest", repoRoot);
  const database = process.env.TP_PG_DATABASE || "trustpass";

  try {
    const manifest = takeBackup(directory, database);

    console.log(`Backup of ${manifest.database} on Postgres ${manifest.server_version}`);
    console.log(`  ${directory}`);

    for (const file of manifest.files) {
      console.log(
        `  ${file.name.padEnd(20)} ${String(file.bytes).padStart(10)} bytes  ${file.sha256.slice(0, 16)}…`,
      );
    }

    console.log("\nA backup is a file. Whether it restores is a separate question:");
    console.log("  pnpm db:restore-drill");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
