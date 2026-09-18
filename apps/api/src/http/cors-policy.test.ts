import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { buildDependencies } from "../testing/dependencies.js";
import { describeCorsPolicy, readCorsPolicy, writeOrigins } from "./cors-policy.js";

describe("readCorsPolicy", () => {
  it("treats an absent variable as a question nobody answered", () => {
    // Not "none", and the difference is the whole module. A default that means
    // "allow nothing" looks safe and hides that nobody decided; a default that
    // means "allow everything" is what was there before.
    expect(readCorsPolicy(undefined)).toEqual({ kind: "unset" });
  });

  it("treats an empty variable as a decision to allow none", () => {
    expect(readCorsPolicy("")).toEqual({ kind: "none" });
    expect(readCorsPolicy("  ,  ,")).toEqual({ kind: "none" });
  });

  it("reads a list, trimming what an operator is likely to type", () => {
    expect(readCorsPolicy("https://a.example, https://b.example")).toEqual({
      kind: "allowlist",
      origins: ["https://a.example", "https://b.example"],
    });
  });

  it("refuses a wildcard rather than quietly dropping it", () => {
    // Found by this test: `TRUSTPASS_ALLOWED_ORIGINS=*` produced an allowlist
    // of ["*"], reopening the exact hole the module exists to close.
    //
    // Refused rather than filtered. Dropping it silently would leave an
    // operator believing they had opened the API while every request failed.
    for (const raw of ["*", "*, https://a.example", "https://a.example,*"]) {
      const policy = readCorsPolicy(raw);

      expect(policy.kind).toBe("refused");
      expect(writeOrigins(policy)).toEqual([]);
    }
  });

  it("never yields a wildcard, whatever is configured", () => {
    for (const raw of ["*", "*, https://a.example", undefined, "", "https://a.example"]) {
      expect(writeOrigins(readCorsPolicy(raw))).not.toContain("*");
    }
  });

  it("says what it decided, for the startup line", () => {
    expect(describeCorsPolicy(readCorsPolicy(undefined))).toMatch(/is not set/);
    expect(describeCorsPolicy(readCorsPolicy(""))).toMatch(/no browser origin/);
    expect(describeCorsPolicy(readCorsPolicy("https://a.example"))).toMatch(/https:\/\/a\.example/);
    expect(describeCorsPolicy(readCorsPolicy("*"))).toMatch(/never accepts every origin/);
  });
});

const ALLOWED = "https://trustpass.example";
const DISALLOWED = "https://evil.example";

function app(raw: string | undefined) {
  return createApp(buildDependencies({}), readCorsPolicy(raw));
}

function preflight(instance: ReturnType<typeof createApp>, path: string, origin: string) {
  return instance.request(path, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
}

describe("what a browser is told, per route", () => {
  it("lets an allowed origin write", async () => {
    const response = await preflight(app(ALLOWED), "/enrolments", ALLOWED);

    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("tells a disallowed origin nothing it can use", async () => {
    const response = await preflight(app(ALLOWED), "/enrolments", DISALLOWED);

    // Absent, not "*" and not the origin echoed back. A browser with no
    // Access-Control-Allow-Origin refuses the response, which is the point.
    expect(response.headers.get("access-control-allow-origin")).not.toBe(DISALLOWED);
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("refuses every origin when the policy says none", async () => {
    const response = await preflight(app(""), "/enrolments", ALLOWED);

    expect(response.headers.get("access-control-allow-origin")).not.toBe(ALLOWED);
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("applies the same allowlist to the other write route", async () => {
    // Both directions, because one of them is not enough.
    //
    // The first version asserted only that a disallowed origin gets no header.
    // That is equally true when the route has no CORS policy at all, and the
    // mutation check proved it: deleting `app.use("/products", write)` left the
    // test green. Registering a policy per route means forgetting one is
    // possible, so the test has to notice a route with none.
    const allowed = await preflight(app(ALLOWED), "/products", ALLOWED);
    const refused = await preflight(app(ALLOWED), "/products", DISALLOWED);

    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(refused.headers.get("access-control-allow-origin")).not.toBe(DISALLOWED);
  });

  it("keeps the passport open to anyone, which is the product", async () => {
    // A QR on an object has to resolve from whatever page scanned it. This one
    // is `*` because somebody decided it is, and the reason is in the code.
    const response = await app(ALLOWED).request("/passports/TP1-ANYTHING", {
      headers: { origin: DISALLOWED },
    });

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("keeps health, version and the schema readable from anywhere", async () => {
    for (const path of ["/health", "/version", "/openapi.json"]) {
      const response = await app("").request(path, { headers: { origin: DISALLOWED } });

      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("defaults to refusing writes when createApp is given no policy", async () => {
    // The argument is optional, and a caller that forgets it gets the safe
    // answer rather than the convenient one.
    const response = await preflight(createApp(buildDependencies({})), "/enrolments", ALLOWED);

    expect(response.headers.get("access-control-allow-origin")).not.toBe(ALLOWED);
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});
