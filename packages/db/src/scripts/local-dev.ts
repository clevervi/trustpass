/**
 * Whether a run may use the published development passwords.
 *
 * `provision-roles.ts` refuses to invent a password, and that refusal is
 * correct: one it invented would have to be printed to be usable, and a printed
 * password is in the terminal scrollback and in whatever captured the output.
 *
 * A throwaway container on a developer's machine is the one case where that
 * reasoning does not apply, because the password is not a secret — it is a
 * published default, the same status `docker-compose.yml` already gives
 * `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-trustpass_local_dev}`.
 *
 * **The dangerous move would be inferring which case this is.** A check that
 * decides "this looks like development" is a guard that is wrong silently, and
 * being wrong here means writing a known password onto a role in a database
 * somebody cares about. So both conditions are required and neither is
 * inferred:
 *
 *   1. the operator says so, with a flag, every time;
 *   2. the connection is to this machine.
 *
 * The flag alone would let it run against a tunnel. The host check alone is the
 * inference this file exists to avoid.
 */

/**
 * Published, not secret. Printed by the script that uses them, because a value
 * anybody can read in the repository is not made safer by being hidden in a
 * terminal, and is made more dangerous by being treated as though it were.
 *
 * Long enough to be obviously deliberate, and named so that finding one of them
 * in a log or a connection string says immediately what it is and what it is
 * not.
 */
export const LOCAL_DEV_PASSWORDS = {
  trustpass_migration: "trustpass_migration_local_dev_not_a_secret",
  trustpass_runtime: "trustpass_runtime_local_dev_not_a_secret",
} as const;

export type LocalDevRole = keyof typeof LOCAL_DEV_PASSWORDS;

export type LocalDevRefusal =
  /** No flag. The default, and the only behaviour that existed before. */
  | "not_requested"
  /** Asked for, with nothing to check it against. */
  | "no_database_url"
  /** Asked for, and the URL is not one. */
  | "unreadable_database_url"
  /** Asked for, and the host is not this machine. */
  | "not_a_local_host";

export type LocalDevDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LocalDevRefusal };

/**
 * Exact matches only.
 *
 * Not `endsWith(".localhost")`, not `includes("localhost")`, and the difference
 * is the attack: `localhost.example.com` is a hostname somebody else controls
 * and it satisfies every loose test of the word. A resolver is not consulted
 * either — a name that resolves to 127.0.0.1 today is a name whose owner can
 * point it somewhere else tomorrow.
 *
 * **What this cannot see is a tunnel**, and that limit is real rather than
 * theoretical. `ssh -L 5433:prod:5432` makes `localhost:5433` a true statement
 * about the socket and a false one about the database, and this function says
 * yes. See #178.
 *
 * `pnpm db:setup` is not exposed to it, because it never accepts a URL — it
 * builds one carrying the published superuser password, which a real database
 * rejects before anything is written. The exposure is `pnpm db:provision
 * --local-dev` with a `DATABASE_URL` somebody supplied.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function mayUseLocalDevPasswords(input: {
  readonly requested: boolean;
  readonly databaseUrl: string | undefined;
}): LocalDevDecision {
  // Checked first, so that running without the flag never depends on anything
  // about the URL. The no-flag path behaves exactly as it did before this file
  // existed.
  if (!input.requested) {
    return { ok: false, reason: "not_requested" };
  }

  if (input.databaseUrl === undefined || input.databaseUrl.trim() === "") {
    return { ok: false, reason: "no_database_url" };
  }

  let hostname: string;

  try {
    // `URL` and not a regular expression, for the reason this repository keeps
    // rediscovering: ask the parser what the value means rather than what it
    // looks like. A pattern matching `localhost` anywhere in the string accepts
    // `postgres://localhost@db.example.com/trustpass`, where `localhost` is the
    // username and the database is somebody else's.
    hostname = new URL(input.databaseUrl).hostname;
  } catch {
    return { ok: false, reason: "unreadable_database_url" };
  }

  if (!LOCAL_HOSTS.has(hostname)) {
    return { ok: false, reason: "not_a_local_host" };
  }

  return { ok: true };
}

/**
 * The connection strings the published development setup produces.
 *
 * Built from the same environment variables `docker-compose.yml` reads, with
 * the same defaults, so the two cannot disagree about which database this is.
 * The compose file is the source of those defaults and this mirrors it — which
 * is a duplication worth naming: if the compose defaults change and these do
 * not, `pnpm db:setup` will confidently hand out a URL to the wrong port.
 *
 * ponytail: an integration test asserts the two agree by reading the compose
 * file. The upgrade path, if this grows a third reader, is to generate one from
 * the other rather than to add a third copy.
 */
export function localDevUrls(env: NodeJS.ProcessEnv = process.env): {
  readonly superuser: string;
  readonly migration: string;
  readonly runtime: string;
} {
  const host = "localhost";
  const port = env.POSTGRES_PORT ?? "5433";
  const database = env.POSTGRES_DB ?? "trustpass";
  const superuserName = env.POSTGRES_USER ?? "trustpass";
  const superuserPassword = env.POSTGRES_PASSWORD ?? "trustpass_local_dev";

  const url = (user: string, password: string): string =>
    `postgres://${user}:${password}@${host}:${port}/${database}`;

  return {
    superuser: url(superuserName, superuserPassword),
    migration: url("trustpass_migration", LOCAL_DEV_PASSWORDS.trustpass_migration),
    runtime: url("trustpass_runtime", LOCAL_DEV_PASSWORDS.trustpass_runtime),
  };
}

/** What to tell the operator, in the terms the refusal was made in. */
export function explainRefusal(reason: LocalDevRefusal): string {
  switch (reason) {
    case "not_requested":
      return "Set TRUSTPASS_MIGRATION_PASSWORD and TRUSTPASS_RUNTIME_PASSWORD, or pass --local-dev for a throwaway database on this machine.";
    case "no_database_url":
      return "--local-dev needs DATABASE_URL, because the host is half of what makes it allowed.";
    case "unreadable_database_url":
      return "DATABASE_URL could not be read as a URL, so its host could not be checked.";
    case "not_a_local_host":
      return "--local-dev only runs against localhost, 127.0.0.1 or ::1. This connection is somewhere else, and the published passwords are not going onto it.";
  }
}
