import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CLAIM_STATES, CLAIM_SUBJECTS, parseTrustPassId, schema } from "@trustpass/db";
import type { AppDependencies } from "../dependencies.js";
import { ApiErrorCode, ApiErrorSchema } from "../http/errors.js";

/**
 * Deliberately permissive. Bounding the length is all this does.
 *
 * A format regex here would send every bad identifier through the app's
 * `defaultHook` and out as `validation_failed`, erasing the one distinction this
 * endpoint exists to make: a mistyped code is not an unregistered product.
 * `parseTrustPassId` in the handler decides.
 */
const PassportParamsSchema = z.object({
  trustpassId: z
    .string()
    .min(1)
    .max(64)
    .openapi({
      param: { name: "trustpassId", in: "path" },
      description:
        "The TrustPass ID from the label. Case and separators are forgiven; a failed " +
        "check symbol is reported as a mistyped code, not as an unknown product.",
      example: "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB",
    }),
});

const PassportSchema = z
  .object({
    trustpassId: z.string().openapi({ example: "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB" }),
    brand: z.string().openapi({ example: "ASUS" }),
    model: z.string().openapi({ example: "ROG Strix RTX 5070 Ti" }),
    category: z.enum(schema.productCategory.enumValues),
    status: z.enum(["registered", "active", "suspended", "retired"]).openapi({
      description: "A draft is never published, so it never appears here.",
    }),
    serial: z
      .object({
        suffix: z.string().openapi({ example: "4896" }),
        hiddenCharacters: z.number().int().positive().openapi({ example: 8 }),
      })
      .nullable()
      .openapi({
        description:
          "The last four characters and how many are withheld. Null when the serial is too " +
          "short for more characters to stay hidden than are shown. The whole serial is never returned.",
      }),
    registeredOn: z.string().openapi({
      description: "The registration date. Deliberately not a timestamp.",
      example: "2026-09-17",
    }),
    issuer: z
      .object({
        companyName: z.string().openapi({ example: "Andes Tech Imports" }),
        country: z.string().openapi({ example: "CO" }),
        registrationNumber: z.string().openapi({
          description:
            "Public by design: national registries publish it, and it lets a reader verify " +
            "the issuer independently instead of taking TrustPass's word.",
          example: "900123456-7",
        }),
        verificationStatus: z.enum(schema.verificationStatus.enumValues),
      })
      .nullable()
      .openapi({
        description:
          "Null when no business registered this product — a holder enrolment. " +
          "Null and an unverified issuer are different facts: one says there is no " +
          "company to check, the other says nobody has checked one that exists. A " +
          "consumer that collapses them invents an issuer the record does not have.",
      }),
    claims: z
      .array(z.object({ claim: z.enum(CLAIM_SUBJECTS), state: z.enum(CLAIM_STATES) }))
      .openapi({
        description:
          "What TrustPass has actually checked, claim by claim, in reading order. Per ADR 0003 " +
          "these are never collapsed into one verdict, and physical authenticity is never verifiable.",
      }),
  })
  .openapi("Passport");

const readPassportRoute = createRoute({
  method: "get",
  path: "/passports/{trustpassId}",
  tags: ["passports"],
  summary: "Read the public passport for a TrustPass ID",
  request: { params: PassportParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: PassportSchema } },
      description: "The passport",
    },
    404: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "No passport exists for this identifier",
    },
    422: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description:
        "The identifier is mistyped (its check symbol fails) or is not a TrustPass ID at all",
    },
  },
});

export function registerPassportRoutes(app: OpenAPIHono, deps: AppDependencies): void {
  app.openapi(readPassportRoute, async (c) => {
    // Every answer from this route is uncacheable, not only the passport. A
    // cached passport still reading "active" after a theft report is the harm
    // the system exists to prevent, and a cached 404 would hide a product
    // registered a minute later.
    c.header("Cache-Control", "no-store");

    const { trustpassId } = c.req.valid("param");
    const parsed = parseTrustPassId(trustpassId);

    // Messages never echo the input. A public page reads them, and reflecting a
    // caller-controlled string there is an injection surface.
    if (!parsed.ok && parsed.error === "checksum_mismatch") {
      return c.json(
        {
          error: ApiErrorCode.MISTYPED_TRUSTPASS_ID,
          message:
            "This code has a typo: its check symbol does not match. Compare it with the label character by character.",
        },
        422,
      );
    }

    if (!parsed.ok) {
      return c.json(
        {
          error: ApiErrorCode.MALFORMED_TRUSTPASS_ID,
          message: "This is not a TrustPass ID.",
        },
        422,
      );
    }

    const result = await deps.readPassport(parsed.id);

    if (!result.ok) {
      return c.json(
        {
          error: ApiErrorCode.PASSPORT_NOT_FOUND,
          message: "No passport exists for this TrustPass ID.",
        },
        404,
      );
    }

    // The service keeps claims as a readonly array; the response schema infers a
    // mutable one. Copy at the serialisation boundary rather than loosening the
    // service type.
    return c.json({ ...result.passport, claims: [...result.passport.claims] }, 200);
  });
}
