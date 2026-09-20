import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { AppDependencies } from "./dependencies.js";
import { requireCredential } from "./http/authenticate.js";
import { type CorsPolicy, writeOrigins } from "./http/cors-policy.js";
import { ApiErrorCode, validationError } from "./http/errors.js";
import { type RateLimit, rateLimited } from "./http/rate-limit.js";
import { registerEnrolmentRoutes } from "./routes/enrolments.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPassportRoutes } from "./routes/passports.js";
import { registerProductRoutes } from "./routes/products.js";

/**
 * What a single caller may write, and the arithmetic behind the numbers.
 *
 * A serial range off a product line is thousands of guesses. At this rate an
 * attacker gets the 20-request burst and then one request every five seconds,
 * so ten thousand serials is most of a day rather than an afternoon.
 *
 * Measured rather than derived, against the real server on the real clock. Two
 * windows, because one of them would have been misleading:
 *
 * | window | requests | answered | naive average | sustained, burst removed |
 * | ------ | -------- | -------- | ------------- | ------------------------ |
 * | 60s    | 200,084  | 31       | 0.517/s       | 0.200/s                  |
 * | 300s   | 855,216  | 79       | 0.263/s       | 0.1967/s                 |
 *
 * **The average is not a property of this limiter.** It halved between the two
 * runs without anything changing, because the burst is a fixed twenty spent in
 * the first 0.06s and the window it is divided by kept growing. Quoting it would
 * describe the measurement rather than the system. The sustained figure held at
 * 0.1967–0.200/s across both, which is the number a sweep actually pays: **14.1
 * hours for ten thousand serials**, against 10.6 if the average were believed.
 *
 * The 0.1967 is not a shortfall against the nominal 0.2. Over 299.9s the bucket
 * accrues 59.98 tokens and 59 were spent — the sixtieth had not finished
 * arriving.
 *
 * An earlier version of this comment said ten thousand serials was "most of a
 * fortnight", which was wrong by a factor of twenty-five and arithmetic nobody
 * had run.
 *
 * Chosen against the honest caller rather than against the attacker, because
 * the attacker sets no upper bound and the honest caller does: a person
 * enrolling a product they are holding makes one request, and an issuer
 * registering a batch does so from a script that can wait five seconds. If that
 * stops being true the numbers move, and the test that names them moves with
 * them.
 *
 * ponytail: one process, one map, reset on restart. A second instance doubles
 * the effective limit and a redeploy clears it. That is honest for something
 * with nothing deployed, and the upgrade path is a shared store — not a
 * cleverer bucket.
 */
export const WRITE_RATE_LIMIT = { burst: 20, perSecond: 0.2 } as const;

export function createApp(
  deps: AppDependencies,
  /**
   * Defaults to refusing every cross-origin write. A test that does not care
   * about CORS gets the safe answer rather than the convenient one, and a
   * caller that forgets the argument does not accidentally open the API.
   */
  corsPolicy: CorsPolicy = { kind: "none" },
  /**
   * Named by the caller so a test can ask for a limit it will not trip.
   *
   * The default is the real one, because a test that silently got a generous
   * limit would prove nothing about the endpoint that ships — and a test that
   * needs twenty-one requests should have to say so.
   */
  rateLimit: RateLimit = WRITE_RATE_LIMIT,
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

  /**
   * After the credential check, and the order is the argument.
   *
   * Registered before it, an unauthenticated flood would consume the limit that
   * a legitimate caller shares — the cheapest possible denial of service, paid
   * for by the people the endpoint exists for. After it, a request has already
   * been refused with a 401 before it costs anybody anything.
   *
   * The order decides more than that. `callerKey` charges the allowance to the
   * actor, and the actor is only on the context once `requireCredential` has put
   * it there — so registered first, this would silently fall back to keying on
   * the address, and an office behind one NAT would share an allowance none of
   * them spent. The correct order and the correct key are the same decision.
   *
   * The cost of this order is that the limit does not restrain somebody
   * guessing credentials, and it does not need to: `requireCredential` answers
   * one code for absent, malformed, unknown, expired, revoked and the wrong
   * environment, so a guess learns nothing to iterate on.
   *
   * What it restrains is #120: `POST /enrolments` tells a caller whether a
   * serial already has a live record, which cannot be hidden on a write
   * endpoint, so what is left is making a sweep cost something.
   */
  const limited = rateLimited(rateLimit);

  app.use("/products", limited);
  app.use("/enrolments", limited);

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
