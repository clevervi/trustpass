import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppDependencies } from "../dependencies.js";

const HealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]).openapi({ example: "ok" }),
    version: z.string().openapi({ example: "0.1.0" }),
    uptimeSeconds: z.number().openapi({ example: 12.4 }),
    checks: z.object({
      database: z.enum(["up", "down"]).openapi({ example: "up" }),
    }),
  })
  .openapi("Health");

const VersionSchema = z
  .object({
    name: z.string().openapi({ example: "trustpass-api" }),
    version: z.string().openapi({ example: "0.1.0" }),
  })
  .openapi("Version");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  summary: "Liveness and dependency health",
  responses: {
    200: {
      content: { "application/json": { schema: HealthSchema } },
      description: "All dependencies are reachable",
    },
    503: {
      content: { "application/json": { schema: HealthSchema } },
      description: "At least one dependency is unreachable",
    },
  },
});

const versionRoute = createRoute({
  method: "get",
  path: "/version",
  tags: ["system"],
  summary: "Deployed service version",
  responses: {
    200: {
      content: { "application/json": { schema: VersionSchema } },
      description: "Service identity",
    },
  },
});

export function registerHealthRoutes(app: OpenAPIHono, deps: AppDependencies): void {
  app.openapi(healthRoute, async (c) => {
    const databaseUp = await deps.checkDatabase();

    const body = {
      status: databaseUp ? ("ok" as const) : ("degraded" as const),
      version: deps.version,
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      checks: { database: databaseUp ? ("up" as const) : ("down" as const) },
    };

    // A degraded dependency must not report 200: load balancers and uptime
    // probes only act on the status code, never on the body.
    return c.json(body, databaseUp ? 200 : 503);
  });

  app.openapi(versionRoute, (c) => c.json({ name: "trustpass-api", version: deps.version }, 200));
}
