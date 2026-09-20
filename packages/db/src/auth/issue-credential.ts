import type postgres from "postgres";
import type { Environment } from "./credential-token.js";
import { issueToken } from "./credential-token.js";
import type { IssuanceRequest } from "./issuance.js";

/**
 * Creating one credential, and nothing else.
 *
 * Separate from `scripts/issue-credential.ts` because the script's first act is
 * to refuse unless stdout is a terminal — which is correct, and which makes the
 * happy path untestable through it. A test that needed an interactive terminal
 * would not run in CI, and CI is exactly where this has to be proven.
 *
 * So the barriers live in the script and the work lives here. The split is not
 * for tidiness: it is what lets the full loop — issue, present over HTTP, read
 * the row back — run unattended.
 *
 * **This grants nothing.** It writes to `actor` and `credential` and to no other
 * table. Per ADR 0011 §5 a credential resolves to an actor, and what that actor
 * may do is a separate lookup (#152). A version of this that also created a
 * membership would be doing authorisation's job quietly, and nothing today
 * would notice — the authority model has no consumers yet.
 */

export interface IssuedFor {
  /** Shown once by the caller, stored nowhere. */
  readonly token: string;
  readonly credentialId: number;
  readonly actorId: number;
  /** Whether the actor existed already, so the caller can say which it did. */
  readonly actorWasCreated: boolean;
}

/** Bounded, then loud. ADR 0014 §3 — a handle is never reused. */
const HANDLE_ATTEMPTS = 5;

export class IssuanceFailed extends Error {
  constructor(
    message: string,
    readonly reason: "no_such_actor" | "handles_exhausted",
  ) {
    super(message);
    this.name = "IssuanceFailed";
  }
}

export async function issueCredentialFor(
  sql: postgres.Sql,
  request: IssuanceRequest,
  environment: Environment,
): Promise<IssuedFor> {
  return sql.begin(async (tx) => {
    // The raw secret never reaches a statement — only its digest does — but the
    // handle and the label do, and a session logging every statement is one
    // place too many for either. `provision-roles.ts` does the same.
    await tx.unsafe("SET LOCAL log_statement = 'none'");

    const actor =
      "existing" in request.actor
        ? await findActor(tx, request.actor.existing)
        : await createActor(tx, request.actor.create.kind, request.actor.create.displayName);

    for (let attempt = 1; attempt <= HANDLE_ATTEMPTS; attempt += 1) {
      const minted = issueToken(environment);

      // `ON CONFLICT DO NOTHING` rather than catching a unique violation,
      // because a caught violation inside a transaction leaves it aborted and
      // the retry would fail for a second, unrelated reason.
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO credential (actor_id, kind, label, issued_at, handle, secret_digest)
        VALUES (${actor.id}, 'api_key', ${request.label}, now(), ${minted.handle}, ${minted.digest})
        ON CONFLICT (handle) DO NOTHING
        RETURNING id
      `;

      if (row) {
        return {
          token: minted.token,
          credentialId: Number(row.id),
          actorId: actor.id,
          actorWasCreated: actor.created,
        };
      }
    }

    throw new IssuanceFailed(
      `${HANDLE_ATTEMPTS} handles collided in a row. That is not bad luck — something is wrong with the generator.`,
      "handles_exhausted",
    );
  });
}

/**
 * Postgres returns `bigint` as a string through this driver, so every id that
 * leaves here is converted once, here. Typing it `number` and trusting the
 * driver is what produced `actorId: "1980"` against an interface promising a
 * number — a lie the compiler could not see and a test did.
 */
async function findActor(
  tx: postgres.TransactionSql,
  id: number,
): Promise<{ id: number; created: boolean }> {
  const [found] = await tx<{ id: string }[]>`SELECT id FROM actor WHERE id = ${id}`;

  if (!found) {
    // Refused rather than created. An `--actor <id>` that silently invented the
    // actor it could not find would make a typo into a second identity, and the
    // credential would work — which is the worst shape this failure could take.
    throw new IssuanceFailed(`No actor has id ${id}.`, "no_such_actor");
  }

  return { id: Number(found.id), created: false };
}

async function createActor(
  tx: postgres.TransactionSql,
  kind: string,
  displayName: string,
): Promise<{ id: number; created: boolean }> {
  const [created] = await tx<{ id: string }[]>`
    INSERT INTO actor (kind, display_name) VALUES (${kind}, ${displayName}) RETURNING id
  `;

  if (!created) {
    throw new Error("Creating the actor returned no row.");
  }

  return { id: Number(created.id), created: true };
}
