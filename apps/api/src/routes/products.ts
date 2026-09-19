import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDependencies } from "../dependencies.js";
import { ApiErrorCode, ApiErrorSchema } from "../http/errors.js";
import { ProductCategorySchema } from "./product-category.js";

/**
 * **Authentication is enforced here. Issuer authorization is not.**
 *
 * As of #141 a request must carry a valid credential, and the principal comes
 * from that credential and from nowhere else. What has not happened yet is the
 * lookup that connects the principal to this organization:
 *
 * ```
 * credential -> actor          done, ADR 0014
 * actor -> membership -> organization -> grant    not done, ADR 0009 / ADR 0011
 * ```
 *
 * So `issuer` below is still what the caller says it is. **It is input naming
 * the organization a record belongs to, and it is not proof of any authority
 * over that organization.** A registration number is public — national
 * registries publish it, and `apps/web` shows it on every passport — so naming
 * one establishes nothing.
 *
 * Written here rather than left to be inferred, because the inference somebody
 * will make is the wrong one: "there is authentication now, so the issuer in
 * the body can be trusted". Authenticated is not authorized, and the gap
 * between them is a whole model that has not been built.
 */
const IssuerReferenceSchema = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 country code")
      .openapi({ example: "CO" }),
    registrationNumber: z
      .string()
      .regex(/^[A-Z0-9-]{4,50}$/, "Expected an uppercase alphanumeric registration number")
      .openapi({
        description: "NIT in Colombia, RFC in Mexico, EIN in the United States.",
        example: "900123456-7",
      }),
  })
  .openapi("IssuerReference");

/**
 * Note what is absent: the TrustPass ID. It is generated server side and a
 * request that supplies one is not honoured, because a caller choosing its own
 * identifier could collide with a label already printed.
 */
const RegisterProductRequestSchema = z
  .object({
    issuer: IssuerReferenceSchema,
    brand: z.string().trim().min(1).max(120).openapi({ example: "ASUS" }),
    model: z.string().trim().min(1).max(120).openapi({ example: "ROG Strix RTX 5070 Ti" }),
    serial: z.string().trim().min(2).max(120).openapi({ example: "M1LMCS004896" }),
    category: ProductCategorySchema,
  })
  .openapi("RegisterProductRequest");

const RegisteredProductSchema = z
  .object({
    trustpassId: z.string().openapi({ example: "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB" }),
    brand: z.string(),
    model: z.string(),
    serial: z.string().openapi({
      description:
        "The full serial, returned to the issuer that submitted it. The public passport masks this.",
    }),
    category: z.string(),
    status: z.string().openapi({ example: "registered" }),
    createdAt: z.string().openapi({ example: "2026-09-17T16:45:00.000Z" }),
    issuer: z.object({
      companyName: z.string(),
      country: z.string(),
      registrationNumber: z.string(),
      verificationStatus: z.string().openapi({
        description:
          "What TrustPass has actually checked about this issuer. A product registered by an unverified issuer carries exactly the weight of that issuer's word.",
        example: "unverified",
      }),
    }),
  })
  .openapi("RegisteredProduct");

const registerProductRoute = createRoute({
  method: "post",
  path: "/products",
  tags: ["products"],
  summary: "Register a product and issue its TrustPass ID",
  description:
    "Requires a credential: `Authorization: Bearer <token>`. Every failure — absent, " +
    "malformed, unknown, expired, revoked, or minted for another environment — returns " +
    "the same 401.\n\n" +
    "**The credential authenticates the caller. It does not yet authorise the issuer.** " +
    "`issuer` names the organization a record belongs to and is not proof of authority " +
    "over it: a registration number is public, and this API does not check that the " +
    "authenticated actor has any relationship with the organization named.",
  request: {
    body: {
      content: { "application/json": { schema: RegisterProductRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: RegisteredProductSchema } },
      description: "The product was registered and given a TrustPass ID",
    },
    401: {
      description:
        "No credential, or one this request may not use. Absent, malformed, unknown, " +
        "expired, revoked and minted for another environment all return this same " +
        "response: saying which applied would tell a caller whether a credential exists.",
      content: { "application/json": { schema: ApiErrorSchema } },
    },
    409: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description:
        "This issuer already holds a live identity for that serial. The message does not " +
        "carry its TrustPass ID: a serial is printed on the object, and trading one for the " +
        "other would make a label a passport lookup (ADR 0004).",
    },
    422: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description: "The body was malformed, or named an issuer that does not exist",
    },
  },
});

export function registerProductRoutes(app: OpenAPIHono, deps: AppDependencies): void {
  app.openapi(registerProductRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await deps.registerProduct(body, c.get("principal"));

    if (!result.ok && result.reason === "duplicate_serial") {
      // 409, not 422: the request is entirely valid and would have been
      // accepted a moment ago. It conflicts with state that already exists.
      //
      // The existing identifier is deliberately NOT returned. It used to be,
      // so a client that timed out mid-registration could learn what it had
      // already created — and #143 removed it, because it turned a serial
      // printed on the outside of an object into a lookup for the identifier
      // ADR 0004 spends its whole Context keeping unguessable.
      //
      // This comment said the opposite until now. The code has been right
      // since #143 and the sentence describing it was not, which is the kind
      // of stale claim that gets read as intent by whoever changes this next.
      return c.json(
        {
          error: ApiErrorCode.DUPLICATE_SERIAL,
          message:
            "That serial already has a live record under this issuer. Retire it before registering the serial again.",
        },
        409,
      );
    }

    if (!result.ok) {
      // A well-formed request naming something that does not exist is 422, not
      // 404: the endpoint is there, the instructions in the body cannot be
      // carried out. A 404 here would read as "POST /products does not exist".
      return c.json(
        {
          error: ApiErrorCode.ISSUER_NOT_FOUND,
          message: `No issuer is registered in ${body.issuer.country} with registration number ${body.issuer.registrationNumber}.`,
        },
        422,
      );
    }

    return c.json({ ...result.product, createdAt: result.product.createdAt.toISOString() }, 201);
  });
}
