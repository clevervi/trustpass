import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route.js";

/**
 * The route, not the functions it calls.
 *
 * `lib/passport-origin.test.ts` asserts that `cacheControlFor` returns
 * `no-store` for a request-derived origin. `lib/qr.test.ts` asserts that
 * `qrSvgDocument` escapes its description. Both are true and both stayed green
 * while this route dropped its CSP, dropped `nosniff`, cached an attacker's host
 * for a year and accepted an unbounded identifier — measured in #196, four
 * mutations, all four surviving.
 *
 * A helper with a unit test and a caller with none is a guard that nothing
 * checks. This is the caller.
 */
describe("what the qr.svg route actually returns", () => {
  const CODE = "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB";

  /**
   * The route reads its origin from the environment, so a test states it.
   *
   * `vi.stubEnv` rather than assignment: Next types `NODE_ENV` as read-only, so
   * writing to it fails `tsc` even though it works at runtime — and a test that
   * only ran under vitest while breaking the typecheck would be found by CI
   * rather than here. It also restores in one call, which hand-rolled save and
   * restore does not do when an expectation throws.
   */
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    // Not production: the request-derived branch exists only outside it, and
    // half of what this file checks is that branch behaving differently.
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const ask = (trustpassId: string, host = "localhost:3000") =>
    GET(new Request(`http://${host}/trustpass/${trustpassId}/qr.svg`, { headers: { host } }), {
      params: Promise.resolve({ trustpassId }),
    });

  describe("the headers a document served from this origin needs", () => {
    it("serves an SVG that declares its own namespace", async () => {
      const response = await ask(CODE);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/svg+xml");
      expect(await response.text()).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    it("refuses the document permission to do anything", async () => {
      // An SVG is a document, and a document served from this origin can script.
      // The escaping in `qrSvgDocument` is the first defence and this is the
      // second; a test that only checked the escaping would let this one go.
      const policy = (await ask(CODE)).headers.get("content-security-policy");

      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("sandbox");
    });

    it("tells the browser not to guess the type", async () => {
      expect((await ask(CODE)).headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("escapes an identifier that would otherwise close the tag, through the route", async () => {
      // `lib/qr.test.ts` asserts `qrSvgDocument` escapes. This asserts the route
      // passes the caller-controlled identifier through it — a different claim,
      // and the one that matters for a URL anybody can construct.
      const body = await (await ask('TP1-"><script>alert(1)</script>')).text();

      expect(body).not.toContain("<script>");
      expect(body).toContain("&lt;script&gt;");
    });
  });

  describe("what may be cached, which depends on where the origin came from", () => {
    it("refuses to cache a response whose origin came from the request", async () => {
      // The mutation that matters most. Replacing `cacheControlFor(origin)` with
      // a literal `public, max-age=31536000, immutable` is cache poisoning: the
      // `Host` header is the caller's, and a shared cache would then serve their
      // host to everyone who came after, under a URL that gets printed onto
      // labels.
      //
      // Asserting the header merely exists would not catch that. Asserting the
      // value for a request-derived origin does.
      const response = await ask(CODE, "attacker.example");

      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("caches a configured origin for a year, because that one cannot change", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trustpass.example");

      const response = await ask(CODE, "attacker.example");

      expect(response.headers.get("cache-control")).toContain("max-age=31536000");
    });

    it("answers differently for the same identifier depending on the origin's source", async () => {
      // The strongest form, and the one a constant cannot satisfy. Two requests
      // for the same code, differing only in whether the origin was configured.
      // A literal `Cache-Control` makes these identical.
      const fromRequest = (await ask(CODE, "attacker.example")).headers.get("cache-control");

      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trustpass.example");
      const fromConfig = (await ask(CODE, "attacker.example")).headers.get("cache-control");

      expect(fromRequest).not.toBe(fromConfig);
    });

    it("does not cache the refusal when no origin can be established", async () => {
      // In production an unset variable is a deployment mistake, and the route
      // publishes nothing rather than guessing. A cached 503 would outlive the
      // fix.
      vi.stubEnv("NODE_ENV", "production");

      const response = await ask(CODE, "attacker.example");

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("what it refuses to encode", () => {
    it("refuses an identifier longer than the API's own bound", async () => {
      // A QR grows with its input. Unbounded, this route is an invitation to ask
      // for a very large image many times.
      expect((await ask("T".repeat(65))).status).toBe(404);
    });

    it("accepts one exactly at the bound, so the limit is the limit", async () => {
      // Without this, narrowing the bound to something useless would still pass:
      // a test that only checks the refusal cannot tell 64 from 1.
      expect((await ask("T".repeat(64))).status).toBe(200);
    });
  });
});
