import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { AppDependencies } from "./dependencies.js";
import { registerHealthRoutes } from "./routes/health.js";

export function createApp(deps: AppDependencies): OpenAPIHono {
  const app = new OpenAPIHono();

  app.use("*", requestId());
  app.use("*", secureHeaders());
  app.use("*", cors());

  registerHealthRoutes(app, deps);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      version: deps.version,
      title: "TrustPass API",
      description:
        "Verifiable digital identity, warranty and lifecycle history for physical products.",
    },
  });

  app.notFound((c) => c.json({ error: "not_found", message: "Unknown endpoint" }, 404));

  return app;
}
