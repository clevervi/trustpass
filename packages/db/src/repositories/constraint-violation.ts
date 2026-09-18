/**
 * The SQLSTATE and constraint name behind a failed write.
 *
 * Drizzle wraps driver failures, so neither is on the error that surfaces —
 * both live somewhere down the `cause` chain. Shared because every repository
 * that turns a specific constraint into an outcome needs the same walk, and two
 * copies drift the moment one of them learns about a new wrapper.
 */
export interface ConstraintViolation {
  readonly code?: string;
  readonly constraint?: string;
}

export function violatedConstraint(error: unknown): ConstraintViolation {
  let current: unknown = error;

  while (current !== null && current !== undefined) {
    const candidate = current as { code?: unknown; constraint_name?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint_name === "string" ? candidate.constraint_name : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }

  return {};
}

/** Postgres unique_violation. */
export const UNIQUE_VIOLATION = "23505";
