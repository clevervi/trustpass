import postgres from "postgres";
import { ENVIRONMENTS, type Environment } from "../auth/credential-token.js";
import {
  canDeliverSecret,
  type IssuanceRequest,
  parseIssuanceArgs,
  REFUSAL,
  type RefusalReason,
} from "../auth/issuance.js";
import { IssuanceFailed, type IssuedFor, issueCredentialFor } from "../auth/issue-credential.js";
import { actorKind } from "../schema/actor.js";

/**
 * Mints one credential and shows its secret once.
 *
 * ADR 0014 §8. Issuance is off the API entirely in this phase, and that is a
 * decision rather than a shortcut: putting it on an endpoint needs an `INSERT`
 * grant the runtime does not have (#119 gives it `SELECT` on `credential` and
 * nothing else), an authorization model for who may issue, and a delivery
 * mechanism for the secret. Three decisions hiding inside one route.
 *
 * **This grants nothing.** Per ADR 0011 §5 a credential resolves to an actor and
 * authorisation is a separate lookup of that actor's grants. So this writes to
 * `actor` and `credential` and to nothing else — no membership, no capacity
 * grant. If it created either, #152 would inherit a model where every
 * credential arrived with authority attached, and nothing today would notice:
 * the authority model has no consumers yet.
 *
 * The secret exists in this process and in the operator's terminal. It is never
 * written to a file, a log, or a column.
 */

/** What an operator is told, per refusal. The codes live in `issuance.ts`. */
const EXPLANATION: Record<RefusalReason, string> = {
  [REFUSAL.NOT_A_TERMINAL]:
    "stdout is not a terminal. A pipe or a redirect would capture the secret into a file,\n" +
    "which is the one thing this command exists to prevent. Run it interactively.",
  [REFUSAL.CONTINUOUS_INTEGRATION]:
    "CI is set. A secret printed on a runner is a secret in a build log.",
  [REFUSAL.NO_ACTOR]: "Name an actor: --actor <id>, or --create-actor <kind> <name>.",
  [REFUSAL.AMBIGUOUS_ACTOR]: "Use --actor or --create-actor, not both.",
  [REFUSAL.ACTOR_NOT_AN_ID]: "--actor takes a positive whole number.",
  [REFUSAL.UNKNOWN_ACTOR_KIND]: `--create-actor takes a kind: ${actorKind.enumValues.join(", ")}.`,
  [REFUSAL.NO_LABEL]:
    "Name the credential: --label <name>. An actor with several needs to tell them apart.",
  [REFUSAL.LABEL_TOO_SHORT]: "A label needs at least two characters after trimming.",
  [REFUSAL.UNKNOWN_ARGUMENT]: "Unrecognised argument. Nothing was changed.",
  [REFUSAL.MISSING_VALUE]: "A flag was given no value. Nothing was changed.",
};

function refuse(reason: RefusalReason): never {
  console.error(`Refusing: ${reason}`);
  console.error(EXPLANATION[reason]);
  process.exit(1);
}

async function main(): Promise<void> {
  // Before anything else, and before reading arguments. An operator who piped
  // this should learn that first, not after the command has decided what it
  // would have done.
  const delivery = canDeliverSecret({ isTTY: Boolean(process.stdout.isTTY), env: process.env });

  if (delivery !== null) {
    refuse(delivery);
  }

  const parsed = parseIssuanceArgs(process.argv.slice(2));

  if ("refused" in parsed) {
    refuse(parsed.refused);
  }

  const request: IssuanceRequest = parsed;
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not set. This needs a connection that may INSERT on credential,",
    );
    console.error("which the runtime role deliberately cannot — see #119.");
    process.exit(1);
  }

  const environment = process.env.TRUSTPASS_ENV as Environment | undefined;

  if (!environment || !ENVIRONMENTS.includes(environment)) {
    console.error(`TRUSTPASS_ENV must be one of: ${ENVIRONMENTS.join(", ")}.`);
    console.error("A token is bound to one environment, so this cannot be guessed.");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    const issued = await issueCredentialFor(sql, request, environment);
    report(issued, request);
  } catch (error) {
    if (error instanceof IssuanceFailed && error.reason === "no_such_actor") {
      // Named, and with the way out. On a database straight from `db:reset`
      // there are no actors at all, so "no such actor" without the alternative
      // sends an operator to write an INSERT by hand.
      console.error(`Refusing: ${error.message}`);
      console.error("Use --create-actor <kind> <name> to make one, or pick an existing id.");
      process.exit(1);
    }
    throw error;
  } finally {
    await sql.end();
  }
}

function report(issued: IssuedFor, request: IssuanceRequest): void {
  const how = issued.actorWasCreated
    ? `created now, kind ${"create" in request.actor ? request.actor.create.kind : "?"}`
    : "existing";

  // Said out loud, because an actor that appeared without anybody noticing is
  // an identity nobody can account for.
  console.log(`actor:      ${issued.actorId}  (${how})`);
  console.log(`credential: ${issued.credentialId}`);
  console.log("");
  console.log(`  ${issued.token}`);
  console.log("");
  console.log("Shown once. It is stored nowhere: the database holds a SHA-256 of the secret");
  console.log("and cannot return it. Losing it means revoking this credential and issuing");
  console.log("another, which is also how rotation works.");
  console.log("");
  console.log("Your terminal scrollback is not storage. Clear it when you are done.");
  console.log("");
  console.log("This credential authenticates and grants nothing. What its actor may do is a");
  console.log("separate lookup that does not exist yet (#152).");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
