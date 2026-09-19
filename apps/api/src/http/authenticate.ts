import type { AuthenticatedPrincipal } from "@trustpass/db";
import type { MiddlewareHandler } from "hono";
import { ApiErrorCode } from "./errors.js";

/**
 * Who is making this request. Set by the middleware, never by a request body.
 *
 * Declared on Hono's variable map so a handler reading it is typed rather than
 * casting, and so `c.get("principal")` cannot silently be `undefined` in a
 * handler the middleware does not cover.
 */
declare module "hono" {
  interface ContextVariableMap {
    principal: AuthenticatedPrincipal;
  }
}

/**
 * Resolves a presented credential, or nothing.
 *
 * Kept on the dependency seam rather than reaching for a database here, for the
 * reason `AppDependencies` already gives: routes stay testable without a
 * running Postgres. It also means a test can state which actor is calling,
 * which is the thing these routes now depend on.
 */
export type Authenticator = (
  presented: string | undefined,
) => Promise<AuthenticatedPrincipal | null>;

/**
 * Pulls the credential out of an `Authorization` header, or returns nothing.
 *
 * Exported because it is worth testing alone. The scheme is compared
 * case-insensitively — RFC 7235 says it is case-insensitive, and a client
 * sending `bearer` is not an attacker — but the token is taken verbatim,
 * because it is compared byte for byte further down.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (typeof header !== "string") {
    return undefined;
  }

  // Exactly two parts. A header with three would otherwise have its first
  // segment taken as the whole credential, which is the same truncation bug
  // the token format itself had.
  const parts = header.split(" ");

  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return undefined;
  }

  return parts[1];
}

/**
 * Refuses a request that does not carry a valid credential.
 *
 * Absent, malformed, unknown, expired, revoked, the wrong environment and the
 * wrong secret all produce one 401 with one body. A caller learning which of
 * those applied would learn whether a credential exists — ADR 0014 §7, and the
 * same oracle #143 removed from `/enrolments`.
 *
 * `WWW-Authenticate: Bearer` and nothing more. RFC 7235 requires the header on
 * a 401, and the `error="invalid_token"` parameter RFC 6750 allows is exactly
 * the distinction this refusal exists not to make.
 *
 * Register it **after** the CORS middleware. Hono's `cors()` answers a
 * preflight and returns without calling the next handler, so a browser's
 * OPTIONS — which carries no `Authorization` header, by specification — never
 * reaches this. Registered the other way round, every preflight would be
 * refused and the allowlist settled in #121 would silently stop working.
 */
export function requireCredential(authenticate: Authenticator): MiddlewareHandler {
  return async (c, next) => {
    const principal = await authenticate(bearerToken(c.req.header("authorization")));

    if (principal === null) {
      return c.json(
        {
          error: ApiErrorCode.UNAUTHENTICATED,
          message: "This request needs a credential.",
        },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }

    c.set("principal", principal);

    return next();
  };
}
