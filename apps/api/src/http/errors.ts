import { z } from "@hono/zod-openapi";

/**
 * The one error shape this API returns.
 *
 * `error` is a stable machine-readable code a client can branch on; `message`
 * is for a human reading a log or a screen. Clients that branch on prose break
 * the first time the prose improves, so the code is the contract and the
 * message is not.
 */
export const ApiErrorSchema = z
  .object({
    error: z.string().openapi({
      description: "Stable machine-readable code. Branch on this, not on the message.",
      example: "validation_failed",
    }),
    message: z.string().openapi({
      example: "The request body did not match the expected shape.",
    }),
    details: z
      .array(
        z.object({
          path: z.string().openapi({ example: "serial" }),
          message: z
            .string()
            .openapi({ example: "Too small: expected string to have >=2 characters" }),
        }),
      )
      .optional()
      .openapi({
        description: "Present when the failure can be attributed to specific fields.",
      }),
  })
  .openapi("ApiError");

export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Codes this API can return. Adding one is a contract change. */
export const ApiErrorCode = {
  VALIDATION_FAILED: "validation_failed",
  ISSUER_NOT_FOUND: "issuer_not_found",
  DUPLICATE_SERIAL: "duplicate_serial",
  NOT_FOUND: "not_found",
  /** The identifier's check symbol failed: a transcription error, not an unknown product. */
  MISTYPED_TRUSTPASS_ID: "mistyped_trustpass_id",
  /** The value is not a TrustPass ID in any version this build understands. */
  MALFORMED_TRUSTPASS_ID: "malformed_trustpass_id",
  PASSPORT_NOT_FOUND: "passport_not_found",
  /**
   * No credential, or one this request may not use. Deliberately one code for
   * absent, malformed, unknown, expired, revoked and the wrong environment:
   * a caller learning which applied would learn whether a credential exists.
   */
  UNAUTHENTICATED: "unauthenticated",
  /**
   * Authenticated, and not permitted to act for the organization named.
   *
   * Deliberately distinct from `issuer_not_found`. Collapsing the two would
   * tell somebody acting for their own organization that no such organization
   * is registered — a lie to the honest caller, sending them to fix data that
   * is correct. What it discloses, that the organization exists, the 422
   * already discloses and a public registry publishes.
   */
  NOT_AUTHORISED_FOR_ISSUER: "not_authorised_for_issuer",
  /**
   * Too many requests from this caller, whatever they were asking for.
   *
   * Carries nothing about the request. `POST /enrolments` still answers whether
   * a serial has a live record — #120 explains why a write endpoint cannot hide
   * that — so what a limit adds is price, and a limit that reported *what* it
   * was limiting would hand back the detail it exists to protect.
   *
   * Nothing about the caller either, which is a separate rule and was nearly
   * missed. `actor.id` is a database key, and `never exposes the internal key`
   * is asserted for products, for passports and for enrolments. A refusal is
   * not exempt: the body is a constant, and a test refuses two actors with the
   * same bytes to keep it one.
   */
  TOO_MANY_REQUESTS: "too_many_requests",
} as const;

/**
 * Flattens a Zod failure into the envelope.
 *
 * Reports every offending field rather than the first, because a caller fixing
 * one field at a time across four round trips is a worse experience than the
 * validation being strict in the first place.
 */
export function validationError(issues: readonly z.core.$ZodIssue[]): ApiError {
  return {
    error: ApiErrorCode.VALIDATION_FAILED,
    message: "The request body did not match the expected shape.",
    details: issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  };
}
