import { z } from "@hono/zod-openapi";

/**
 * The product categories a caller may state.
 *
 * Shared by registration and enrolment rather than written twice: two copies
 * drift the moment the database enum grows, and a route still accepting a
 * category the schema dropped fails at the write with a message about an enum
 * instead of at the boundary with a message about the field.
 */
export const ProductCategorySchema = z
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
  .openapi({ example: "gpu" });
