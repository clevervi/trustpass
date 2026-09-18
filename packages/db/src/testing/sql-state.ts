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
