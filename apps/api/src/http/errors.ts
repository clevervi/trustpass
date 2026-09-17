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
  NOT_FOUND: "not_found",
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
