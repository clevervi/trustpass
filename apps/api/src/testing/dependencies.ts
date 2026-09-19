import type { AuthenticatedPrincipal } from "@trustpass/db";
import type { AppDependencies } from "../dependencies.js";
import type { Authenticator } from "../http/authenticate.js";

/**
 * A credential a test can present, shaped exactly like a real one.
 *
 * Eleven and forty-three characters after the prefix, because the verifier a
 * real deployment uses refuses anything else — a fixture of the wrong shape
 * would pass against a stub and fail against the thing it stands for.
 */
export const TEST_TOKEN = `tp.dev.${"A".repeat(11)}.${"B".repeat(43)}`;

/** Whose request it is. Named, so a test can say "this one, not that one". */
export const TEST_PRINCIPAL: AuthenticatedPrincipal = { actorId: 1, credentialId: 1 };

/**
 * Authenticates one exact token and refuses everything else.
 *
 * Deliberately not `async () => principal`. A stub that ignores what it was
 * given authenticates a request carrying no header at all, so every test using
 * it would pass whether or not the middleware ever read one — and the header
 * path would be covered by nothing.
 */
export function authenticates(
  token: string = TEST_TOKEN,
  principal: AuthenticatedPrincipal = TEST_PRINCIPAL,
): Authenticator {
  return async (presented) => (presented === token ? principal : null);
}

/** The header a test attaches to a write. */
export function credentialHeaders(token: string = TEST_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Builds the dependency set with working defaults, so a test states only what
 * it actually cares about. A test that has to spell out every dependency stops
 * saying what it is testing.
 */
export function buildDependencies(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    version: "0.0.0-test",
    // Nobody, unless a test says otherwise. The convenient default would be a
    // fixed principal, and it would let a write test pass without ever having
    // an identity — which is the state #141 exists to end.
    authenticate: async () => null,
    checkDatabase: async () => true,
    enrolProduct: async () => {
      throw new Error("enrolProduct was called without being stubbed for this test.");
    },
    registerProduct: async () => {
      throw new Error("registerProduct was called but this test did not provide one.");
    },
    readPassport: async () => {
      throw new Error("readPassport was called but this test did not provide one.");
    },
    ...overrides,
  };
}
