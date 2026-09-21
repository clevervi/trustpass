/**
 * From nothing to a database the tests and the API can use, in one command.
 *
 * Before this, standing one up was four steps and a credential nobody had
 * written down:
 *
 *   pnpm db:up
 *   pnpm db:migrate                       needs DATABASE_URL
 *   TRUSTPASS_MIGRATION_PASSWORD=? \
 *   TRUSTPASS_RUNTIME_PASSWORD=?   pnpm db:provision
 *   RUNTIME_DATABASE_URL=?                assembled by hand
 *
 * The last two are the ones that cost. `pnpm db:reset` did the first two and
 * stopped, so a reset left the roles without passwords and every integration
 * test skipping — silently, because skipping is what they do when the variable
 * is absent.
 *
 * **This is a Node script rather than a chain of `&&` in package.json** for one
 * reason: the steps need `DATABASE_URL` in their environment, and setting a
 * variable inline in an npm script is shell syntax that differs between
 * PowerShell and sh. This repository is developed on Windows and tested on
 * Linux, so the chain would have had to work in both or acquire `cross-env`.
 * Node already runs everywhere.
 *
 * It refuses anything that is not the loopback, and it says what it is doing at
 * each step, because a command that does four things silently is a command
 * nobody can debug when the third one fails.
 */
import { spawnSync } from "node:child_process";
import { composePsJson, repositoryRoot } from "./compose-port.js";
import { explainRefusal, localDevUrls, mayUseLocalDevPasswords } from "./local-dev.js";

/**
 * `shell: true` with a single string, never with an argument array.
 *
 * Node raises DEP0190 for the array form under a shell, because the arguments
 * are concatenated rather than escaped — so the array reads as though it were
 * protecting something and is not. The shell itself is needed: `pnpm` and
 * `docker` are `.cmd` shims on Windows and will not spawn directly.
 *
 * Every argument here is a literal in this file. Nothing reaches it from a
 * request, a file or an environment variable, which is what makes the string
 * form acceptable rather than merely quieter.
 */
function run(label: string, command: string, args: readonly string[], databaseUrl: string): void {
  console.log(`\n=== ${label} ===`);

  const result = spawnSync([command, ...args].join(" "), {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  if (result.status !== 0) {
    console.error(`\n${label} failed. Nothing after this step ran.`);
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const urls = localDevUrls();

  /**
   * The compose database, always, and `DATABASE_URL` is deliberately ignored.
   *
   * The first version of this read `.env` and preferred whatever it found,
   * which reads as courteous and is wrong in two ways that only appeared when
   * it was tested. `docker compose up` starts *this project's* container
   * whatever the URL says, so a `DATABASE_URL` pointing elsewhere would have
   * started one database and configured another. And `.env` holds how the
   * **application** connects — per `0024` that names `trustpass_runtime`, a
   * role with no DDL rights at all, so migrating with it could only ever fail.
   *
   * `POSTGRES_PORT`, `POSTGRES_DB` and the rest still work, because compose
   * reads exactly the same variables. One knob moves both sides, which is why
   * they cannot disagree.
   */
  const databaseUrl = urls.superuser;

  // By construction this passes. It is here because `localDevUrls` and this
  // guard are separate functions, and the day one of them changes, the failure
  // should be a refusal rather than a published password on an unknown host.
  const decision = mayUseLocalDevPasswords({
    requested: true,
    databaseUrl,
    composePs: composePsJson(repositoryRoot()),
  });

  if (!decision.ok) {
    console.error("This command sets up a throwaway database on this machine.");
    console.error(explainRefusal(decision.reason));
    console.error("\nNothing was changed.");
    process.exit(1);
  }

  run("Starting Postgres", "docker", ["compose", "up", "-d", "--wait"], databaseUrl);
  run("Applying migrations", "pnpm", ["--filter", "@trustpass/db", "db:migrate"], databaseUrl);
  run(
    "Giving the roles a way in",
    "pnpm",
    ["--filter", "@trustpass/db", "db:provision", "--local-dev"],
    databaseUrl,
  );

  console.log("\n=== Ready ===\n");
  console.log("  The API connects as the runtime role:");
  console.log(`    DATABASE_URL=${urls.runtime}`);
  console.log("");
  console.log("  The integration tests want the same role under their own name:");
  console.log(`    RUNTIME_DATABASE_URL=${urls.runtime}`);
  console.log("");
  console.log("  Migrations run as the migration role:");
  console.log(`    ${urls.migration}`);
  console.log("");
  console.log("These passwords are published in packages/db/src/scripts/local-dev.ts.");
  console.log("They are for a throwaway container on this machine and nowhere else.");
}

main();
