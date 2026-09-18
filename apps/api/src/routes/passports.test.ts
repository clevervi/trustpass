import { generateTrustPassId, type TrustPassId } from "@trustpass/db";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AppDependencies } from "../dependencies.js";
import type { PublicPassport, ReadPassportResult } from "../passports/read-passport.js";
import { buildDependencies } from "../testing/dependencies.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function passportFor(trustpassId: string): PublicPassport {
  return {
    trustpassId,
    brand: "ASUS",
    model: "ROG Strix RTX 5070 Ti",
    category: "gpu",
    status: "registered",
    origin: "supply_chain",
    serial: { suffix: "4896", hiddenCharacters: 8 },
    registeredOn: "2026-09-17",
    issuer: {
      companyName: "Andes Tech Imports",
      country: "CO",
      registrationNumber: "900123456-7",
      verificationStatus: "unverified",
    },
    claims: [
      { claim: "issuer", state: "unverified" },
      { claim: "serial", state: "recorded" },
      { claim: "secure_tag", state: "not_present" },
      { claim: "warranty", state: "not_recorded" },
      { claim: "physical_authenticity", state: "not_verifiable" },
    ],
    history: [
      {
        type: "product_registered",
        actorKind: "issuer",
        occurredOn: "2026-09-17",
        recordedOn: "2026-09-17",
        reason: null,
      },
    ],
  };
}

/** A real identifier with one body character swapped, so its check symbol fails. */
function mistype(id: string): string {
  const position = 4;
  const original = id.charAt(position);
  const replacement = ALPHABET.charAt((ALPHABET.indexOf(original) + 1) % ALPHABET.length);
  return id.slice(0, position) + replacement + id.slice(position + 1);
}

function appWith(readPassport: AppDependencies["readPassport"]) {
  return createApp(buildDependencies({ readPassport }));
}

describe("GET /passports/{trustpassId} — found", () => {
  it("returns 200 with the public passport", async () => {
    const id = generateTrustPassId();
    const app = appWith(async () => ({ ok: true, passport: passportFor(id) }));

    const response = await app.request(`/passports/${id}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      trustpassId: id,
      serial: { suffix: "4896", hiddenCharacters: 8 },
      registeredOn: "2026-09-17",
    });
  });

  it("never exposes an internal key", async () => {
    // ADR 0005. Nothing in the type system enforces it, so it is asserted.
    const id = generateTrustPassId();
    const app = appWith(async () => ({ ok: true, passport: passportFor(id) }));

    const body = (await (await app.request(`/passports/${id}`)).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("issuerId");
    expect(body.issuer).not.toHaveProperty("id");
  });

  it("returns the claims in reading order", async () => {
    const id = generateTrustPassId();
    const app = appWith(async () => ({ ok: true, passport: passportFor(id) }));

    const body = (await (await app.request(`/passports/${id}`)).json()) as {
      claims: { claim: string }[];
    };

    expect(body.claims.map((claim) => claim.claim)).toEqual([
      "issuer",
      "serial",
      "secure_tag",
      "warranty",
      "physical_authenticity",
    ]);
  });

  it("forgives case and separators, and looks up the canonical form", async () => {
    // ADR 0004: forgiving of humans, strict about correctness.
    const id = generateTrustPassId();
    const readPassport = vi.fn<AppDependencies["readPassport"]>(async () => ({
      ok: true,
      passport: passportFor(id),
    }));

    const response = await appWith(readPassport).request(
      `/passports/${id.toLowerCase().replace("-", "")}`,
    );

    expect(response.status).toBe(200);
    expect(readPassport).toHaveBeenCalledWith(id as TrustPassId);
  });
});

describe("GET /passports/{trustpassId} — the distinction the milestone exists for", () => {
  it("reports a mistyped identifier as 422, not as a missing product", async () => {
    // Telling someone at a counter that the product they are buying is not
    // registered, when they mistyped one character, is a false fraud accusation.
    const readPassport = vi.fn<AppDependencies["readPassport"]>();

    const response = await appWith(readPassport).request(
      `/passports/${mistype(generateTrustPassId())}`,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "mistyped_trustpass_id" });
  });

  it.each([
    ["a word", "hello"],
    ["a string of the right length that is not an identifier", "X".repeat(31)],
    ["a UUID", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
  ])("reports %s as malformed", async (_label, value) => {
    const response = await appWith(vi.fn()).request(`/passports/${value}`);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "malformed_trustpass_id" });
  });

  it("reports a format version this build does not understand as malformed", async () => {
    const id = generateTrustPassId();

    const response = await appWith(vi.fn()).request(`/passports/TP2-${id.slice(4)}`);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "malformed_trustpass_id" });
  });

  it("never reaches the database with an identifier that did not parse", async () => {
    // The parse gate is upstream of the lookup. An unverified string cannot
    // reach Postgres, and a typo cannot be answered by a query.
    const readPassport = vi.fn<AppDependencies["readPassport"]>();
    const app = appWith(readPassport);

    await app.request(`/passports/${mistype(generateTrustPassId())}`);
    await app.request("/passports/hello");

    expect(readPassport).not.toHaveBeenCalled();
  });

  it("does not answer a bad identifier with the generic validation error", async () => {
    // A strict param schema would route this through defaultHook and return
    // validation_failed, erasing the distinction. This fails if anyone tightens it.
    const response = await appWith(vi.fn()).request("/passports/hello");
    const body = (await response.json()) as { error: string };

    expect(body.error).not.toBe("validation_failed");
  });

  it("returns 404 when a well-formed identifier has no passport", async () => {
    const readPassport = vi.fn<AppDependencies["readPassport"]>(
      async (): Promise<ReadPassportResult> => ({ ok: false, reason: "not_found" }),
    );

    const response = await appWith(readPassport).request(`/passports/${generateTrustPassId()}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "passport_not_found" });
  });
});

describe("GET /passports/{trustpassId} — caching and reflection", () => {
  it.each([
    ["a passport", "found"],
    ["an unknown identifier", "not_found"],
    ["a mistyped identifier", "mistyped"],
  ] as const)("marks %s as uncacheable", async (_label, outcome) => {
    // A cached "active" after a theft report is the harm the system exists to
    // prevent; a cached 404 would hide a product registered a minute later.
    const id = generateTrustPassId();
    const app = appWith(async () =>
      outcome === "found"
        ? { ok: true, passport: passportFor(id) }
        : { ok: false, reason: "not_found" },
    );
    const path = outcome === "mistyped" ? `/passports/${mistype(id)}` : `/passports/${id}`;

    const response = await app.request(path);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("never echoes the submitted value back in an error", async () => {
    // A public page renders these responses. Reflecting caller input there is
    // an injection surface.
    const hostile = "%3Cscript%3Ealert(1)%3C%2Fscript%3E";

    const response = await appWith(vi.fn()).request(`/passports/${hostile}`);
    const text = await response.text();

    expect(text).not.toContain("script");
    expect(text).not.toContain("alert");
  });
});

describe("GET /passports/{trustpassId} — documentation", () => {
  it("appears in the OpenAPI document with the Passport schema", async () => {
    const doc = (await (await appWith(vi.fn()).request("/openapi.json")).json()) as {
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
      components: { schemas: Record<string, unknown> };
    };

    expect(Object.keys(doc.paths)).toContain("/passports/{trustpassId}");
    expect(Object.keys(doc.paths["/passports/{trustpassId}"]?.get?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "404", "422"]),
    );
    expect(Object.keys(doc.components.schemas)).toContain("Passport");
  });
});
