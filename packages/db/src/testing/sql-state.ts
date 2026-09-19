import { expect } from "vitest";

/**
 * SQLSTATE codes, asserted by value so that a test cannot pass because an
 * operation failed for an unrelated reason such as a dropped connection.
 *
 * https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const SqlState = {
  NOT_NULL_VIOLATION: "23502",
  /**
   * Raised by ON DELETE RESTRICT, immediately. Distinct from
   * FOREIGN_KEY_VIOLATION, which ON DELETE NO ACTION raises later, when the
   * constraint is checked. Asserting the wrong one passes for the wrong reason.
   */
  RESTRICT_VIOLATION: "23001",
  FOREIGN_KEY_VIOLATION: "23503",
  UNIQUE_VIOLATION: "23505",
  CHECK_VIOLATION: "23514",
  INVALID_TEXT_REPRESENTATION: "22P02",
  /**
   * Project-defined. Raised by the product status trigger so that an illegal
   * lifecycle move is distinguishable from an ordinary check violation, and a
   * caller can say "that move is not allowed" rather than "the database said
   * no". See drizzle/0002_product_status_transition_guard.sql.
   */
  ILLEGAL_STATUS_TRANSITION: "TP001",
  /**
   * Project-defined, and deliberately distinct from TP001. Raised when
   * something tries to modify or delete a lifecycle event, so a caller can tell
   * "that move is not allowed" from "history cannot be rewritten" without
   * parsing a message.
   * See drizzle/0005_lifecycle_event_append_only.sql.
   */
  HISTORY_IS_APPEND_ONLY: "TP002",
  /**
   * Project-defined. Raised when a capacity records an event its standing does
   * not support — a holder clearing a theft report against its own product,
   * say. Distinct from TP001 and TP002 so a caller can tell "you may not record
   * that" from the other two without parsing a message.
   * See drizzle/0008_recording_authority.sql.
   */
  UNAUTHORISED_RECORDING: "TP003",
  /**
   * Project-defined. Raised at COMMIT by a deferred constraint trigger when a
   * product exists, or a status moved, with no lifecycle event explaining it.
   * Distinct from TP001 so an illegal move is still reported as illegal rather
   * than as unexplained. See drizzle/0010_provenance_is_guaranteed.sql.
   */
  PROVENANCE_REQUIRED: "TP004",

  /**
   * Authority cannot be rewritten.
   *
   * A grant, its revocation and a membership's bindings are facts about what
   * was true at a moment, and every event recorded under one points at it.
   * Editing a grant would make those events say something their author never
   * said, without a single event being touched — which is why ADR 0011 keeps
   * grants append-only and gives a revocation its own row.
   *
   * Distinct from TP002, which is about the history of a product. A caller
   * needs to tell "the past cannot be edited" from "the authority for the past
   * cannot be edited" without parsing a message.
   */
  AUTHORITY_IS_APPEND_ONLY: "TP005",

  /**
   * Project-defined. Raised by `0024_three_roles_one_database.sql` when the
   * privilege model it builds is not the one it ends up with — an object still
   * owned by the wrong role, a runtime holding a privilege nobody granted, a
   * new role carrying a cluster-level attribute.
   *
   * Distinct from the five above because those are refusals *of* a write. This
   * one is a refusal to finish a migration, and the difference matters when
   * reading a failed deploy: TP001–TP005 mean the database defended itself,
   * TP006 means the defences were about to be installed wrongly.
   */
  PRIVILEGE_MODEL_VIOLATED: "TP006",

  /**
   * Postgres's own. What a role without a privilege gets — and the code the
   * least-privilege suite asserts, because it is the difference between "a
   * trigger refused this" and "this role was never able to try".
   *
   * Worth knowing where it lands: permission is checked before any trigger
   * fires, so the runtime updating a lifecycle event raises this rather than
   * TP002. Two answers to the same attack, from two independent layers.
   */
  INSUFFICIENT_PRIVILEGE: "42501",

  /**
   * A `GENERATED ALWAYS AS IDENTITY` column was given a value.
   *
   * It matters to `lifecycle_event.actor_id`, whose foreign key is
   * `ON UPDATE CASCADE`: an actor whose id could change would drag every event
   * naming it along, rewriting attribution without touching the history table
   * at all. This is the code that closes that door, and it comes from the
   * identity column rather than from the append-only trigger — a different
   * mechanism, which is why it is asserted by name.
   */
  GENERATED_ALWAYS: "428C9",
} as const;

export type SqlStateCode = (typeof SqlState)[keyof typeof SqlState];

/**
 * Drizzle wraps driver failures, so the SQLSTATE lives somewhere down the
 * `cause` chain rather than on the error that surfaces.
 */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * The driver's own message, which carries what a RAISE EXCEPTION actually said.
 *
 * Drizzle's wrapper stringifies as "Failed query: ..." and drops it, so
 * asserting against the surfaced error tests the wrapper rather than the
 * database. Walks to the node that carries the SQLSTATE and reads its message.
 */
export function sqlMessageOf(error: unknown): string | undefined {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const candidate = current as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return candidate.message;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * Asserts that an operation fails with a specific SQLSTATE.
 *
 * Fails loudly when the operation succeeds, which a bare `rejects` matcher
 * would not: a constraint that silently stopped constraining would otherwise
 * look like a passing test.
 */
export async function expectSqlState(
  operation: Promise<unknown>,
  code: SqlStateCode,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(sqlStateOf(error)).toBe(code);
    return;
  }

  expect.fail(`Expected SQLSTATE ${code}, but the operation succeeded.`);
}
