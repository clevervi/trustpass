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
