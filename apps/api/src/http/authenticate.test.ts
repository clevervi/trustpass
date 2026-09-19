import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  authenticates,
  buildDependencies,
  credentialHeaders,
  TEST_PRINCIPAL,
  TEST_TOKEN,
  withoutCredential,
} from "../testing/dependencies.js";
import { bearerToken, requireCredential } from "./authenticate.js";

describe("bearerToken", () => {
  it("reads the credential out of a well-formed header", () => {
    expect(bearerToken(`Bearer ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
  });

  it("accepts the scheme in any case, because RFC 7235 says it is not one", () => {
    expect(bearerToken(`bearer ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
    expect(bearerToken(`BEARER ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
  });

  it("takes the token verbatim, whatever case it is in", () => {
    // The scheme is case-insensitive; the credential is not. Lower-casing the
    // whole header is the convenient mistake, and it would make every token
    // fail a byte-for-byte comparison for a reason nobody would look for.
    const mixed = `tp.dev.${"aA".repeat(5)}b.${"cC".repeat(21)}d`;

    expect(bearerToken(`Bearer ${mixed}`)).toBe(mixed);
  });

  const REFUSED: readonly (readonly [string, string | undefined])[] = [
    ["no header", undefined],
    ["an empty header", ""],
    ["a scheme with no credential", "Bearer"],
    ["a credential with no scheme", TEST_TOKEN],
    ["another scheme entirely", `Basic ${TEST_TOKEN}`],
    ["a third segment", `Bearer ${TEST_TOKEN} extra`],
    ["two spaces", `Bearer  ${TEST_TOKEN}`],
  ];

  for (const [label, header] of REFUSED) {
    it(`yields nothing for ${label}`, () => {
      expect(bearerToken(header)).toBeUndefined();
    });
  }

  it("yields an empty credential for a scheme with a trailing space", () => {
    // Not `undefined`, and deliberately not special-cased. `"Bearer "` splits
    // into two parts, the second of which is empty, and an empty string is
    // refused by the verifier for the same reason every other malformed value
    // is. A branch here would add code that changes no outcome.
    //
    // Pinned rather than left implicit, because "it does not crash" is the
    // claim being made and an empty credential is where a parser would.
    expect(bearerToken("Bearer ")).toBe("");
  });
});

describe("the principal comes from the credential", () => {
  /** A route that does nothing but report who the middleware decided it was. */
  function probe() {
    const app = new Hono();

    app.use("/whoami", requireCredential(authenticates()));
    app.post("/whoami", (c) => c.json({ principal: c.get("principal") }));

    return app;
  }

  it("reaches the handler", async () => {
    const response = await probe().request("/whoami", {
      method: "POST",
      headers: credentialHeaders(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ principal: TEST_PRINCIPAL });
  });

  it("is not the one the body asks for", async () => {
    // The confused deputy, at the door. A request that names somebody else must
    // still be the actor its credential belongs to — and the body is not even
    // consulted, which is the property rather than a policy about it.
    const response = await probe().request("/whoami", {
      method: "POST",
      headers: { ...credentialHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ actorId: 999, credentialId: 999, actor_kind: "issuer" }),
    });

    expect(await response.json()).toEqual({ principal: TEST_PRINCIPAL });
  });

  it("is not overwritten by a body that names the variable itself", async () => {
    // The direct attempt, rather than the oblique one above. #141 exists
    // because the body used to be the authority, and a request field called
    // `principal` is the shape somebody would reach for if any part of this
    // ever merged request data into the context.
    const response = await probe().request("/whoami", {
      method: "POST",
      headers: { ...credentialHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        principal: { actorId: 999, credentialId: 999 },
        actorId: 999,
        actor: { id: 999 },
      }),
    });

    expect(await response.json()).toEqual({ principal: TEST_PRINCIPAL });
  });

  it("refuses rather than falling back when there is no credential", async () => {
    // The failure mode point 8 of the review names: `principal ?? body.actor`.
    // A fallback would turn every unauthenticated request into an
    // authenticated one carrying whatever identity it asked for, and it would
    // look like graceful degradation in a diff.
    const response = await probe().request("/whoami", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal: { actorId: 999, credentialId: 999 } }),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("999");
  });
});

const BODY = JSON.stringify({
  brand: "ASUS",
  model: "ROG",
  serial: "NEEDS-A-CREDENTIAL",
  category: "gpu",
});

function app() {
  return createApp(
    buildDependencies({
      authenticate: authenticates(),
      registerProduct: async () => {
        throw new Error("registerProduct ran, so the request was not refused at the door.");
      },
      enrolProduct: async () => {
        throw new Error("enrolProduct ran, so the request was not refused at the door.");
      },
    }),
  );
}

function write(path: string, headers: Record<string, string> = {}) {
  return app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: BODY,
  });
}

describe("the harness itself", () => {
  // The seam has a default, and a default drifts. This is the guard on it.
  //
  // If `buildDependencies` ever authenticates by default, every write test in
  // the repository keeps passing and the ones below stop testing anything —
  // they would be asserting 401 against a fixture that hands out a principal,
  // and they would fail loudly rather than silently, which is the point. This
  // test fails first and says why.
  it("authenticates nobody unless a test says otherwise", async () => {
    const { authenticate } = buildDependencies();

    expect(await authenticate(TEST_TOKEN)).toBeNull();
    expect(await authenticate(undefined)).toBeNull();
  });

  it("refuses a credential that is not the one it was given", async () => {
    // The stub must compare, not assume. One that returned a principal for
    // anything would authenticate a request with no header at all.
    const authenticate = authenticates();

    expect(await authenticate(TEST_TOKEN)).toEqual(TEST_PRINCIPAL);
    expect(await authenticate(undefined)).toBeNull();
    expect(await authenticate(`${TEST_TOKEN}x`)).toBeNull();
  });
});

describe("the write routes refuse a request with no credential", () => {
  const PRESENTED: readonly (readonly [string, Record<string, string>])[] = [
    ["no header at all", withoutCredential()],
    ["an empty header", { authorization: "" }],
    ["a scheme with nothing after it", { authorization: "Bearer" }],
    ["another scheme", { authorization: `Basic ${TEST_TOKEN}` }],
    [
      "a token that belongs to nobody",
      credentialHeaders(`tp.dev.${"Z".repeat(11)}.${"Z".repeat(43)}`),
    ],
    ["a token for another environment", credentialHeaders(TEST_TOKEN.replace("dev", "live"))],
    ["something that is not a token", credentialHeaders("nonsense")],
    ["a scheme with a trailing space and nothing else", { authorization: "Bearer " }],
    // Right shape, right handle, one character different in the secret. The
    // case a forger actually has: everything correct except the part that
    // cannot be guessed.
    ["the right handle with the wrong secret", credentialHeaders(`${TEST_TOKEN.slice(0, -1)}C`)],
  ];

  for (const path of ["/products", "/enrolments"]) {
    for (const [label, headers] of PRESENTED) {
      it(`refuses ${path} with ${label}`, async () => {
        // The stubs throw if they run, so a green test here also says the
        // request never reached the thing that would have written a record.
        const response = await write(path, headers);

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
      });
    }
  }

  it("never answers a bad header with a server error", async () => {
    // 401 and 500 are both refusals from a caller's point of view and are not
    // the same thing at all: a 500 says the header reached something that did
    // not expect it, and the difference between 500 and 401 is itself an
    // oracle — it separates "malformed" from "wrong", which §7 exists to keep
    // indistinguishable.
    for (const path of ["/products", "/enrolments"]) {
      for (const [label, headers] of PRESENTED) {
        const response = await write(path, headers);

        expect(response.status, `${path} with ${label}`).toBeLessThan(500);
      }
    }
  });

  it("gives one identical answer to every one of them", async () => {
    // ADR 0014 §7. Absent, malformed, unknown, expired, revoked and the wrong
    // environment all produce one response, because a caller learning which
    // applied would learn whether a credential exists.
    const answers = new Set<string>();

    for (const [, headers] of PRESENTED) {
      const response = await write("/products", headers);

      answers.add(
        JSON.stringify({
          status: response.status,
          body: await response.text(),
          authenticate: response.headers.get("www-authenticate"),
        }),
      );
    }

    expect(answers.size).toBe(1);
  });

  it("says nothing about the credential in what it returns", async () => {
    const response = await write("/products", credentialHeaders(TEST_TOKEN));
    const refused = await write("/products", credentialHeaders("tp.dev.QQQQQQQQQQQ.x"));
    const text = await refused.text();

    expect(response.status).not.toBe(401);
    for (const leak of ["expired", "revoked", "unknown", "environment", "handle", "secret"]) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
  });
});

describe("what the credential does not cover", () => {
  it("lets a valid credential through", async () => {
    const response = await createApp(
      buildDependencies({
        authenticate: authenticates(),
        enrolProduct: async () => ({ ok: false, reason: "duplicate_serial" }),
      }),
    ).request("/enrolments", {
      method: "POST",
      headers: { "content-type": "application/json", ...credentialHeaders() },
      body: BODY,
    });

    // 409 and not 401: it got past the door and reached the handler.
    expect(response.status).toBe(409);
  });

  it("keeps the passport, health, version and the schema open", async () => {
    // A QR on an object has to resolve from whatever page scanned it, and a
    // health check that needs a credential is a health check nobody can run.
    for (const path of ["/health", "/version", "/openapi.json"]) {
      expect((await app().request(path)).status).not.toBe(401);
    }

    expect((await app().request("/passports/TP1-ANYTHING")).status).not.toBe(401);
  });

  it("answers a preflight without one", async () => {
    // The ordering trap. A browser never sends Authorization on a preflight,
    // so registering this middleware before `cors()` would refuse every one of
    // them and the allowlist settled in #121 would stop working — while every
    // non-browser client kept working, which is the worst way to find out.
    const response = await createApp(buildDependencies({ authenticate: authenticates() }), {
      kind: "allowlist",
      origins: ["https://trustpass.example"],
    }).request("/products", {
      method: "OPTIONS",
      headers: {
        origin: "https://trustpass.example",
        "access-control-request-method": "POST",
      },
    });

    expect(response.status).not.toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://trustpass.example");
  });
});
