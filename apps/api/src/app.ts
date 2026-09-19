import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { AppDependencies } from "./dependencies.js";
import { requireCredential } from "./http/authenticate.js";
import { type CorsPolicy, writeOrigins } from "./http/cors-policy.js";
import { ApiErrorCode, validationError } from "./http/errors.js";
import { registerEnrolmentRoutes } from "./routes/enrolments.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPassportRoutes } from "./routes/passports.js";
import { registerProductRoutes } from "./routes/products.js";

export function createApp(
  deps: AppDependencies,
  /**
   * Defaults to refusing every cross-origin write. A test that does not care
   * about CORS gets the safe answer rather than the convenient one, and a
   * caller that forgets the argument does not accidentally open the API.
   */
  corsPolicy: CorsPolicy = { kind: "none" },
): OpenAPIHono {
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

  // Every route names its own policy. Nothing inherits one, and nothing is left
  // to `cors()` with no arguments — which is how `Access-Control-Allow-Origin: *`
  // ended up on the two routes that write.
  //
  // No `app.use("*", ...)` for CORS, deliberately. Two middlewares matching the
  // same request both run, and the second overwrites the first's header, so a
  // wildcard registered for reads would silently win over an allowlist
  // registered for writes.

  // Public on purpose, and the whole point of the product: a QR on an object
  // has to resolve from any page that scans it. Read-only, so there is nothing
  // for another origin to do with it but read what is already public.
  const publicRead = cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] });

  app.use("/passports/*", publicRead);
  app.use("/health", publicRead);
  app.use("/version", publicRead);
  app.use("/openapi.json", publicRead);

  // The two that write. An empty allowlist means no browser on another origin
  // may call them, which is the right answer when nobody has said otherwise.
  const write = cors({
    origin: [...writeOrigins(corsPolicy)],
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["content-type"],
  });

  app.use("/products", write);
  app.use("/enrolments", write);

  // After CORS and not before, deliberately. Hono's `cors()` answers a
  // preflight and returns without calling the next handler, so an OPTIONS —
  // which carries no Authorization header, by specification — never reaches
  // this. Registered first, every preflight would be refused with a 401 and the
  // allowlist settled in #121 would silently stop working for every browser.
  //
  // Only the two that write. `/passports/*` is public because a QR on an object
  // has to resolve from whatever page scanned it, and that is the product.
  const credentialed = requireCredential(deps.authenticate);

  app.use("/products", credentialed);
  app.use("/enrolments", credentialed);

  registerHealthRoutes(app, deps);
  registerProductRoutes(app, deps);
  registerPassportRoutes(app, deps);
  registerEnrolmentRoutes(app, deps);

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
