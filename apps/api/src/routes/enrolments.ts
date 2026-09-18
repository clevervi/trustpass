import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDependencies } from "../dependencies.js";
import { ApiErrorCode, ApiErrorSchema } from "../http/errors.js";

/**
 * Enrolling a product you hold.
 *
 * A separate path from `POST /products` rather than an optional issuer on it.
 * Registration and enrolment are different acts making different claims, and an
 * optional field would let a caller slide between them by omission — so
 * "you forgot the issuer" would silently become "we made this a holder
 * enrolment", a claim nobody chose.
 *
 * It also matches the prefix rule from TP-030: when TP-141 locks writes, these
 * two may need different authority, and a prefix is easier to reason about than
 * a per-field exception.
 */

const EnrolProductRequestSchema = z
  .object({
    brand: z.string().trim().min(1).max(120).openapi({ example: "ASUS" }),
    model: z.string().trim().min(1).max(120).openapi({ example: "ROG Strix RTX 5070 Ti" }),
    serial: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .openapi({
        description:
          "The serial printed on the product. Stored whole and never published whole — " +
          "the passport shows its last characters only.",
        example: "M1LMCS004896",
      }),
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
  .openapi("EnrolProductRequest");

const EnrolledProductSchema = z
  .object({
    trustpassId: z.string().openapi({ example: "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB" }),
    brand: z.string(),
    model: z.string(),
    serial: z.string(),
    category: z.string(),
    status: z.string().openapi({
      description: "Always `registered`. Entering a serial establishes nothing about ownership.",
      example: "registered",
    }),
    origin: z.string().openapi({
      description: "Always `holder`: this record was started by whoever had the product.",
      example: "holder",
    }),
    createdAt: z.string().openapi({ example: "2026-09-17T14:31:00.000Z" }),
  })
  .openapi("EnrolledProduct");

const enrolRoute = createRoute({
  method: "post",
  path: "/enrolments",
  tags: ["Enrolments"],
  summary: "Enrol a product you hold",
  description:
    "Records that somebody entered this serial. It does not record that they own the " +
    "product, that the product is genuine, or that anything about it has been checked. " +
    "No business stands behind an enrolment, and the passport says so.",
  request: {
    body: {
      content: { "application/json": { schema: EnrolProductRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "The record now exists. Nothing about the product has been verified.",
      content: { "application/json": { schema: EnrolledProductSchema } },
    },
    409: {
      description:
        "A live enrolment already holds this serial. The response names it, so a client " +
        "that timed out and retried learns the identifier it already created.",
      content: { "application/json": { schema: ApiErrorSchema } },
    },
    422: {
      description: "The request body is not valid.",
      content: { "application/json": { schema: ApiErrorSchema } },
    },
  },
});

export function registerEnrolmentRoutes(app: OpenAPIHono, dependencies: AppDependencies): void {
  app.openapi(enrolRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await dependencies.enrolProduct(body);

    if (!result.ok) {
      return c.json(
        {
          error: ApiErrorCode.DUPLICATE_SERIAL,
          message: result.existingTrustpassId
            ? `Serial ${body.serial} is already enrolled as ${result.existingTrustpassId}.`
            : `Serial ${body.serial} is already enrolled.`,
        },
        409,
      );
    }

    return c.json({ ...result.product, createdAt: result.product.createdAt.toISOString() }, 201);
  });
}
