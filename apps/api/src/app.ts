import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { AppDependencies } from "./dependencies.js";
import { ApiErrorCode, validationError } from "./http/errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPassportRoutes } from "./routes/passports.js";
import { registerProductRoutes } from "./routes/products.js";

export function createApp(deps: AppDependencies): OpenAPIHono {
  const app = new OpenAPIHono({
    // Without this, a schema failure returns Hono's own 400 body and the
    // documented error envelope applies to every response except the one a
    // caller is most likely to hit. 422 rather than 400: the JSON parsed fine,
    // the instructions in it could not be followed.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(validationError(result.error.issues), 422);
      }
      return undefined;
    },
  });

  app.use("*", requestId());
  app.use("*", secureHeaders());
  app.use("*", cors());

  registerHealthRoutes(app, deps);
  registerProductRoutes(app, deps);
  registerPassportRoutes(app, deps);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      version: deps.version,
      title: "TrustPass API",
      description:
        "Verifiable digital identity for physical products. Product registration " +
        "is available; warranty, lifecycle and ownership endpoints are not " +
        "implemented yet. The paths below are the whole API.",
    },
  });

  app.notFound((c) => c.json({ error: ApiErrorCode.NOT_FOUND, message: "Unknown endpoint" }, 404));

  return app;
}
