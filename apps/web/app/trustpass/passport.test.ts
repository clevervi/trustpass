import { describe, expect, it, vi } from "vitest";
import { fetchPassport, type PassportView } from "./passport";

const PASSPORT: PassportView = {
  trustpassId: "TP1-4C6V1TSVSEH70HNMC2N0WMSD3H8",
  brand: "ASUS",
  model: "ROG Strix RTX 5070 Ti",
  category: "gpu",
  status: "registered",
  serial: { suffix: "4896", hiddenCharacters: 8 },
  registeredOn: "2026-09-17",
  issuer: {
    companyName: "Andes Tech Imports",
    country: "CO",
    registrationNumber: "900123456-7",
    verificationStatus: "verified",
  },
  claims: [
    { claim: "issuer", state: "verified" },
    { claim: "serial", state: "recorded" },
  ],
};

function respond(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

const baseUrl = "http://api.test";

describe("fetchPassport — the answers", () => {
  it("returns the passport on 200", async () => {
    await expect(
      fetchPassport(PASSPORT.trustpassId, { baseUrl, fetchImpl: respond(200, PASSPORT) }),
    ).resolves.toEqual({ outcome: "found", passport: PASSPORT });
  });

  it("accepts a passport whose serial could not be shown", async () => {
    const passport = { ...PASSPORT, serial: null };

    await expect(
      fetchPassport(PASSPORT.trustpassId, { baseUrl, fetchImpl: respond(200, passport) }),
    ).resolves.toEqual({ outcome: "found", passport });
  });

  it("reports not found only for the specific passport_not_found code", async () => {
    await expect(
      fetchPassport("TP1-X", {
        baseUrl,
        fetchImpl: respond(404, { error: "passport_not_found", message: "..." }),
      }),
    ).resolves.toEqual({ outcome: "not_found" });
  });

  it.each([
    ["mistyped_trustpass_id", "mistyped"],
    ["malformed_trustpass_id", "malformed"],
  ] as const)("reports %s as unreadable, not as not found", async (code, reason) => {
    await expect(
      fetchPassport("TP1-X", { baseUrl, fetchImpl: respond(422, { error: code, message: "..." }) }),
    ).resolves.toEqual({ outcome: "unreadable", reason });
  });
});

describe("fetchPassport — a failure to check is never a verdict", () => {
  // The most important property of this module. "We could not check" and "this
  // product is not registered" are different answers, and giving the second when
  // the truth is the first tells a buyer a genuine product is fake.

  it("does not report not found when the API cannot be reached", async () => {
    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(fetchPassport("TP1-X", { baseUrl, fetchImpl: unreachable })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("does not report not found for a generic 404 from a route that does not exist", async () => {
    // An API without this route answers with the app-wide not_found code.
    await expect(
      fetchPassport("TP1-X", {
        baseUrl,
        fetchImpl: respond(404, { error: "not_found", message: "Unknown endpoint" }),
      }),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("does not crash on an HTML error page", async () => {
    const gateway = vi.fn(
      async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(fetchPassport("TP1-X", { baseUrl, fetchImpl: gateway })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("does not crash on a 404 whose body is not JSON", async () => {
    const proxy = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(fetchPassport("TP1-X", { baseUrl, fetchImpl: proxy })).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("does not render a half-formed passport", async () => {
    const { claims: _claims, ...incomplete } = PASSPORT;

    await expect(
      fetchPassport("TP1-X", { baseUrl, fetchImpl: respond(200, incomplete) }),
    ).resolves.toEqual({ outcome: "unavailable" });
  });

  it("does not render a passport whose issuer is malformed", async () => {
    const broken = { ...PASSPORT, issuer: { companyName: "Andes" } };

    await expect(
      fetchPassport("TP1-X", { baseUrl, fetchImpl: respond(200, broken) }),
    ).resolves.toEqual({ outcome: "unavailable" });
  });
});

describe("fetchPassport — the request", () => {
  it("asks the passports route, without caching", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PASSPORT), { status: 200 }));

    await fetchPassport("TP1-ABC", {
      baseUrl: "http://api.test/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/passports/TP1-ABC", {
      cache: "no-store",
    });
  });

  it("encodes the identifier into the path", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));

    await fetchPassport("a/../b?c", { baseUrl, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledWith("http://api.test/passports/a%2F..%2Fb%3Fc", {
      cache: "no-store",
    });
  });
});
