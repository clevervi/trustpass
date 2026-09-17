import { describe, expect, it } from "vitest";
import { cacheControlFor, resolvePassportOrigin } from "./passport-origin";

const PROD = { isProduction: true } as const;
const DEV = { isProduction: false } as const;

describe("resolvePassportOrigin — configuration wins", () => {
  it("uses NEXT_PUBLIC_SITE_URL when it is set", () => {
    expect(resolvePassportOrigin({ ...PROD, configured: "https://trustpass.example" })).toEqual({
      kind: "configured",
      baseUrl: "https://trustpass.example",
    });
  });

  it("trims a trailing slash so the path is not doubled", () => {
    expect(resolvePassportOrigin({ ...PROD, configured: "https://trustpass.example/" })).toEqual({
      kind: "configured",
      baseUrl: "https://trustpass.example",
    });
  });

  it("ignores the request Host entirely when configured", () => {
    // The property that closes the poisoning vector at its source: with the
    // variable set, nothing a request carries can change where a QR points.
    const origin = resolvePassportOrigin({
      ...DEV,
      configured: "https://trustpass.example",
      host: "evil.example",
    });

    expect(origin).toEqual({ kind: "configured", baseUrl: "https://trustpass.example" });
  });

  it.each([
    ["a relative path", "/trustpass"],
    ["a bare host with no scheme", "trustpass.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a file: URL", "file:///etc/passwd"],
    ["an empty string", ""],
  ])("rejects %s rather than concatenating it into something URL-shaped", (_label, value) => {
    expect(resolvePassportOrigin({ ...PROD, configured: value }).kind).toBe("unknown");
  });
});

describe("resolvePassportOrigin — production refuses to guess", () => {
  // An unset variable in production is a deployment mistake. Publishing a guess
  // prints it onto a physical object that cannot be recalled.

  it("returns unknown when the variable is unset", () => {
    expect(resolvePassportOrigin({ ...PROD, configured: undefined })).toEqual({ kind: "unknown" });
  });

  it("does not fall back to the request Host in production", () => {
    expect(
      resolvePassportOrigin({ ...PROD, configured: undefined, host: "trustpass.example" }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("resolvePassportOrigin — development uses the request", () => {
  it("derives the origin from Host so any port works", () => {
    expect(
      resolvePassportOrigin({ ...DEV, configured: undefined, host: "localhost:3002" }),
    ).toEqual({ kind: "request", baseUrl: "http://localhost:3002" });
  });

  it("returns unknown when there is no Host at all", () => {
    expect(resolvePassportOrigin({ ...DEV, configured: undefined, host: null }).kind).toBe(
      "unknown",
    );
  });

  it.each([
    ["a path appended", "localhost:3000/evil"],
    ["a scheme", "http://evil.example"],
    ["two hosts comma-separated", "localhost:3000, evil.example"],
    ["credentials", "user:pass@evil.example"],
    ["whitespace", "localhost:3000 evil.example"],
    ["a newline", "localhost:3000\nX-Injected: 1"],
  ])("refuses a malformed Host with %s", (_label, host) => {
    expect(resolvePassportOrigin({ ...DEV, configured: undefined, host }).kind).toBe("unknown");
  });
});

describe("cacheControlFor — a request-derived answer is never cached", () => {
  // This is the pairing that matters. Deriving the origin from Host is only
  // safe because the result cannot be stored and replayed to anyone else.

  it("caches a configured origin for a year", () => {
    expect(cacheControlFor({ kind: "configured", baseUrl: "https://trustpass.example" })).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("never caches a request-derived origin", () => {
    const header = cacheControlFor({ kind: "request", baseUrl: "http://localhost:3002" });

    expect(header).toBe("no-store");
    expect(header).not.toContain("public");
    expect(header).not.toContain("max-age");
  });

  it("never caches an unknown origin", () => {
    expect(cacheControlFor({ kind: "unknown" })).toBe("no-store");
  });
});
