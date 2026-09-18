/**
 * Gives the migration and runtime roles a way in.
 *
 * `0024_three_roles_one_database.sql` creates all three roles NOLOGIN and
 * without a password, on purpose: a migration file is committed, and a
 * credential in a committed file is a credential that has leaked. So the
 * migration builds the privilege model and this script, run by an operator,
 * attaches credentials to it from the environment.
 *
 * It is idempotent and it is safe to re-run to rotate a password.
 *
 * Run it with a superuser connection:
 *
 *   TRUSTPASS_MIGRATION_PASSWORD=... TRUSTPASS_RUNTIME_PASSWORD=... pnpm db:provision
 *
 * Afterwards `DATABASE_URL` for the API must name `trustpass_runtime`, and the
 * deploy's migration step must name `trustpass_migration`. Until then the
 * privilege model exists and nothing stands in it — which this script says out
 * loud at the end rather than letting anyone believe otherwise.
 */
import postgres from "postgres";

/**
 * Each role and the name of the environment variable that carries its
 * password. One table rather than a list beside a parallel record: two
 * structures that have to agree about the same two roles is one more thing to
 * keep in step than this needs.
 *
 * The field is called `variable` and holds a *name*, never a value, and that
 * distinction is worth leaving alone. The first version called this map
 * `PASSWORD_VARIABLE`, and CodeQL read the error message below — which prints
 * `TRUSTPASS_RUNTIME_PASSWORD` so an operator knows what to set — as
 * `js/clear-text-logging`, high severity. It was wrong about the leak and right
 * that the name did not say what the thing was.
 */
const ROLE_ENVIRONMENT = [
  { role: "trustpass_migration", variable: "TRUSTPASS_MIGRATION_PASSWORD" },
  { role: "trustpass_runtime", variable: "TRUSTPASS_RUNTIME_PASSWORD" },
] as const;

type Role = (typeof ROLE_ENVIRONMENT)[number]["role"];

/**
 * Postgres has no way to bind a parameter into DDL, and `ALTER ROLE ...
 * PASSWORD` is DDL. Rather than build the statement here and hope the escaping
 * is right, the server builds it: `format('%I ... %L', ...)` runs with the role
 * name and the password as ordinary bound parameters, and hands back a string
 * that is correct by construction.
 *
 * ponytail: the returned statement still contains the password in clear text,
 * so a server with `log_statement = 'all'` writes it to the log. `SET LOCAL
 * log_statement = 'none'` below covers that for this session. The full fix is
 * to send a pre-computed `SCRAM-SHA-256$...` verifier, which Postgres accepts
 * in place of a password and which never carries the secret at all — worth
 * doing the day this runs anywhere but an operator's terminal.
 */
async function grantLogin(
  // Both, because this is called inside `sql.begin` where the handle is a
  // TransactionSql and the two do not share a supertype.
  sql: postgres.Sql | postgres.TransactionSql,
  role: Role,
  password: string,
): Promise<void> {
  const [row] = await sql<{ statement: string }[]>`
    SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', ${role}::text, ${password}::text) AS statement
  `;

  if (!row) {
    throw new Error(`Postgres returned no statement for ${role}.`);
  }

  await sql.unsafe(row.statement);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. This needs a superuser connection.");
    process.exit(1);
  }

  const missing = ROLE_ENVIRONMENT.filter((entry) => !process.env[entry.variable]);

  if (missing.length > 0) {
    // Refusing beats generating one: a password this script invents has to be
    // printed to be usable, and a printed password is in the terminal
    // scrollback and in whatever captured the output.
    console.error("Missing password environment variables:");
    for (const entry of missing) {
      console.error(`  ${entry.variable}  (for ${entry.role})`);
    }
    console.error("\nSet them and run again. Nothing was changed.");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    const [connection] = await sql<{ user: string; superuser: boolean }[]>`
      SELECT current_user AS user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
    `;

    if (!connection?.superuser) {
      console.error(`Connected as ${connection?.user}, which is not a superuser.`);
      console.error("Altering a role's password needs one. Nothing was changed.");
      process.exit(1);
    }

    for (const { role } of ROLE_ENVIRONMENT) {
      const [exists] = await sql<{ present: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS present
      `;

      if (!exists?.present) {
        console.error(`Role ${role} does not exist. Run pnpm db:migrate first.`);
        process.exit(1);
      }
    }

    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL log_statement = 'none'");

      for (const { role, variable } of ROLE_ENVIRONMENT) {
        // Non-null: the missing-variable check above already exited on absence.
        await grantLogin(tx, role, process.env[variable] as string);
        console.log(`  ${role}  can now log in`);
      }
    });

    // Re-read from the catalogue rather than reporting what was intended. The
    // whole repository's habit: a script that says what it did, having asked.
    const roles = await sql<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean }[]>`
      SELECT rolname, rolcanlogin, rolsuper FROM pg_roles
      WHERE rolname LIKE 'trustpass%' ORDER BY rolname
    `;

    console.log("");
    for (const role of roles) {
      const flags = [role.rolcanlogin ? "login" : "nologin", role.rolsuper ? "SUPERUSER" : ""]
        .filter(Boolean)
        .join(" ");
      console.log(`  ${role.rolname.padEnd(22)} ${flags}`);
    }

    console.log(
      "\nThe privilege model has credentials. It is not in force until DATABASE_URL" +
        "\nnames trustpass_runtime — this script cannot do that, and does not pretend to.",
    );
  } finally {
    await sql.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
