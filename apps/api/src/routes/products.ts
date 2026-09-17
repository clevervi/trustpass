import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDependencies } from "../dependencies.js";
import { ApiErrorCode, ApiErrorSchema } from "../http/errors.js";

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
    category: z
      .enum([
        "gpu",
        "cpu",
        "motherboard",
        "laptop",
        "desktop",
        "smartphone",
        "tablet",
        "monitor",
        "camera",
        "console",
        "storage",
        "peripheral",
        "other",
      ])
      .openapi({ example: "gpu" }),
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
    409: {
      content: { "application/json": { schema: ApiErrorSchema } },
      description:
        "This issuer already holds a live identity for that serial. The message carries its TrustPass ID.",
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
    const result = await deps.registerProduct(body);

    if (!result.ok && result.reason === "duplicate_serial") {
      // 409, not 422: the request is entirely valid and would have been
      // accepted a moment ago. It conflicts with state that already exists.
      //
      // The existing identifier is returned deliberately. A client that timed
      // out mid-registration and retried needs to learn what it already
      // created, or it has no way to recover except by guessing.
      return c.json(
        {
          error: ApiErrorCode.DUPLICATE_SERIAL,
          message: `Serial ${body.serial} already belongs to ${result.existingTrustpassId} under this issuer. Retire that identity before registering the serial again.`,
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
