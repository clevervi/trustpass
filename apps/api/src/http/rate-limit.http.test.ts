import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { buildDependencies, credentialHeaders, TEST_TOKEN } from "../testing/dependencies.js";

/**
 * The limiter as a caller meets it, rather than as a function.
 *
 * `rate-limit.test.ts` proves the decision. This proves the wiring: that the
 * middleware is registered on the endpoints that write, that a refusal looks
 * like every other error, and that it tells a client when to come back.
 *
 * Both are needed. A correct bucket registered on nothing is a rate limit
 * nobody is subject to, and every test in the other file would still pass.
 */
describe("what a caller meets when they write too often", () => {
  const BODY = {
    brand: "ASUS",
    model: "ROG Strix RTX 5070 Ti",
    serial: "SW-RATE-0001",
    category: "gpu",
  };

  function app(limit: { burst: number; perSecond: number }) {
    return createApp(
      buildDependencies({
        authenticate: async (presented) =>
          presented === TEST_TOKEN ? { actorId: 1, credentialId: 1 } : null,
        enrolProduct: async () => ({ ok: false, reason: "duplicate_serial" }) as const,
      }),
      { kind: "none" },
      limit,
    );
  }

  function post(under: ReturnType<typeof createApp>, serial = BODY.serial, token = TEST_TOKEN) {
    return under.request("/enrolments", {
      method: "POST",
      headers: { "content-type": "application/json", ...credentialHeaders(token) },
      body: JSON.stringify({ ...BODY, serial }),
    });
  }

  it("limits an app built the way the process builds it, with no limit named", async () => {
    // Every other test here names a limit, which is correct — a test about the
    // limiter should say what it is subject to. The gap that leaves is that
    // nothing exercised the default, and the default is the only one a caller
    // ever meets.
    //
    // Measured: raising `WRITE_RATE_LIMIT` to a million left all 178 tests
    // green. Five integration files now pass a deliberately generous limit, so
    // the way to break this in future is to "fix" a 429 in a test by widening
    // the shipping constant, and nothing would have objected.
    //
    // Twenty-one written out rather than `WRITE_RATE_LIMIT.burst + 1`, because a
    // bound derived from the value under test passes whatever that value becomes.
    const under = createApp(
      buildDependencies({
        authenticate: async (presented) =>
          presented === TEST_TOKEN ? { actorId: 1, credentialId: 1 } : null,
        enrolProduct: async () => ({ ok: false, reason: "duplicate_serial" }) as const,
      }),
    );

    for (let index = 0; index < 20; index += 1) {
      expect((await post(under)).status).toBe(409);
    }

    expect((await post(under)).status).toBe(429);
  });

  it("answers 429 once the burst is spent", async () => {
    const under = app({ burst: 3, perSecond: 0.001 });

    for (let index = 0; index < 3; index += 1) {
      expect((await post(under)).status).toBe(409);
    }

    expect((await post(under)).status).toBe(429);
  });

  it("says when to come back", async () => {
    const under = app({ burst: 1, perSecond: 0.25 });

    await post(under);
    const refused = await post(under);

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("says nothing about what was being asked for", async () => {
    // The reason this file exists alongside the unit tests. A refusal that
    // echoed the serial would hand back, in the 429, exactly the detail the
    // 409 was changed to withhold — and a sweep would read the limit as a
    // confirmation.
    const under = app({ burst: 1, perSecond: 0.001 });

    await post(under, "SW-RATE-SECRET");
    const refused = await post(under, "SW-RATE-SECRET");
    const raw = await refused.text();

    expect(refused.status).toBe(429);
    expect(raw).not.toContain("SW-RATE-SECRET");
    expect(raw).not.toMatch(/TP\d-/);
    expect(JSON.parse(raw)).toEqual({
      error: "too_many_requests",
      message: expect.any(String),
    });
  });

  it("refuses the same way whichever serial is asked about", async () => {
    // Two different serials, one limit. If the refusals differed, the
    // difference would be about the serial.
    const under = app({ burst: 1, perSecond: 0.001 });

    await post(under, "SW-RATE-AAAA");
    const first = await post(under, "SW-RATE-BBBB");
    const second = await post(under, "SW-RATE-CCCC");

    expect(await first.text()).toBe(await second.text());
    expect(first.status).toBe(second.status);
  });

  it("refuses identically whichever endpoint was being written to", async () => {
    // The strongest axis available, and the one a weaker assertion misses.
    //
    // "Does not contain the serial" passes for a message built from
    // `c.req.url` — the URL holds the path, not the serial — so a refusal
    // could describe what was being asked for and still satisfy it. Measured:
    // that exact mutation survived until this case existed.
    //
    // Two endpoints, one limit, one spent token. If the bodies differ at all,
    // the difference is about the request.
    const under = app({ burst: 1, perSecond: 0.001 });

    await post(under);

    const onEnrolments = await post(under);
    const onProducts = await under.request("/products", {
      method: "POST",
      headers: { "content-type": "application/json", ...credentialHeaders() },
      body: JSON.stringify({
        issuer: { country: "CO", registrationNumber: "NOPE-000" },
        ...BODY,
      }),
    });

    expect(onEnrolments.status).toBe(429);
    expect(onProducts.status).toBe(429);
    expect(await onProducts.text()).toBe(await onEnrolments.text());
  });

  it("limits the other write endpoint too", async () => {
    // `/products` writes as well, and an enumeration guard on one of two write
    // endpoints is a guard on neither.
    const under = app({ burst: 1, perSecond: 0.001 });

    const write = () =>
      under.request("/products", {
        method: "POST",
        headers: { "content-type": "application/json", ...credentialHeaders() },
        body: JSON.stringify({
          issuer: { country: "CO", registrationNumber: "NOPE-000" },
          ...BODY,
        }),
      });

    await write();

    expect((await write()).status).toBe(429);
  });

  it("does not limit the public read, which a scanned QR depends on", async () => {
    // `/passports/*` is public because a QR on an object has to resolve from
    // whatever page scanned it. A limit there is a product that stops working
    // at a busy moment, and it protects nothing: the identifier is already
    // unguessable, which is what ADR 0004 is for.
    const under = app({ burst: 1, perSecond: 0.001 });

    const read = () => under.request("/health");

    await read();
    await read();

    expect((await read()).status).not.toBe(429);
  });

  describe("whose allowance is being spent", () => {
    // Shaped like real credentials rather than left as bare strings: a fixture
    // of the wrong shape passes against a stub and fails against the verifier it
    // stands for.
    const shaped = (tail: string) => `tp.dev.${"A".repeat(11)}.${tail.repeat(43)}`;

    const ALICE = shaped("C");
    const BOB = shaped("D");
    const ALICE_SECOND_CREDENTIAL = shaped("E");

    function appWithActors(
      limit: { burst: number; perSecond: number },
      actors: Readonly<Record<string, { actorId: number; credentialId: number }>>,
    ) {
      return createApp(
        buildDependencies({
          authenticate: async (presented) => (presented ? (actors[presented] ?? null) : null),
          enrolProduct: async () => ({ ok: false, reason: "duplicate_serial" }) as const,
        }),
        { kind: "none" },
        limit,
      );
    }

    it("keeps two actors apart even though they share an address", async () => {
      // The NAT case #120 names. Under Vitest every request comes from the same
      // place — there is no socket, so `callerAddress` answers the shared bucket
      // for all of them — which makes this the exact situation an office behind
      // one address is in. Keyed on the address, Bob would be refused for what
      // Alice spent.
      const under = appWithActors(
        { burst: 1, perSecond: 0.001 },
        { [ALICE]: { actorId: 1, credentialId: 1 }, [BOB]: { actorId: 2, credentialId: 2 } },
      );

      expect((await post(under, BODY.serial, ALICE)).status).toBe(409);
      expect((await post(under, BODY.serial, ALICE)).status).toBe(429);

      expect((await post(under, BODY.serial, BOB)).status).toBe(409);
    });

    it("refuses two different actors with the same bytes", async () => {
      // `never exposes the internal key` — the rule this repository already
      // asserts for products, passports and enrolments — applies to a refusal
      // too. `actor.id` is a database key, and a 429 reading "Too many requests
      // from actor:1" would put one in a response.
      //
      // This was very nearly not written. The mutation that adds the caller to
      // the message survived, and the first reading called it "not a defect"
      // because #120 is about not disclosing *what was asked for*, which the
      // caller's own identity is not. That reasoning was scoped to this issue
      // and missed the standing rule — the body is a constant, and two actors
      // are the way to say so.
      const under = appWithActors(
        { burst: 1, perSecond: 0.001 },
        { [ALICE]: { actorId: 1, credentialId: 1 }, [BOB]: { actorId: 2, credentialId: 2 } },
      );

      await post(under, BODY.serial, ALICE);
      const refusedAlice = await post(under, BODY.serial, ALICE);

      await post(under, BODY.serial, BOB);
      const refusedBob = await post(under, BODY.serial, BOB);

      expect(refusedAlice.status).toBe(429);
      expect(refusedBob.status).toBe(429);
      expect(await refusedBob.text()).toBe(await refusedAlice.text());
    });

    it("gives one actor one allowance however many credentials they hold", async () => {
      // The other direction, and the one that decides whether the limit means
      // anything: keyed on the credential, a sweep buys throughput by minting
      // another one.
      const under = appWithActors(
        { burst: 1, perSecond: 0.001 },
        {
          [ALICE]: { actorId: 1, credentialId: 1 },
          [ALICE_SECOND_CREDENTIAL]: { actorId: 1, credentialId: 2 },
        },
      );

      expect((await post(under, BODY.serial, ALICE)).status).toBe(409);

      expect((await post(under, BODY.serial, ALICE_SECOND_CREDENTIAL)).status).toBe(429);
    });
  });

  it("refuses an unauthenticated caller before spending anybody's allowance", async () => {
    // The order the middleware is registered in, asserted rather than assumed.
    // Registered before the credential check, an unauthenticated flood would
    // consume the limit a legitimate caller shares — the cheapest denial of
    // service there is.
    const under = app({ burst: 1, perSecond: 0.001 });

    for (let index = 0; index < 5; index += 1) {
      const anonymous = await under.request("/enrolments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(BODY),
      });

      expect(anonymous.status).toBe(401);
    }

    // The single token is still there for somebody who authenticates.
    expect((await post(under)).status).toBe(409);
  });
});
