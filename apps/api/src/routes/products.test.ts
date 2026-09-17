import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { AppDependencies } from "../dependencies.js";
import type { RegisterProductResult } from "../products/register-product.js";
import { buildDependencies } from "../testing/dependencies.js";

const VALID_BODY = {
  issuer: { country: "CO", registrationNumber: "900123456-7" },
  brand: "ASUS",
  model: "ROG Strix RTX 5070 Ti",
  serial: "M1LMCS004896",
  category: "gpu",
};

const REGISTERED: RegisterProductResult = {
  ok: true,
  product: {
    trustpassId: "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB",
    brand: "ASUS",
    model: "ROG Strix RTX 5070 Ti",
    serial: "M1LMCS004896",
    category: "gpu",
    status: "registered",
    createdAt: new Date("2026-09-17T16:45:00.000Z"),
    issuer: {
      companyName: "Andes Tech Imports",
      country: "CO",
      registrationNumber: "900123456-7",
      verificationStatus: "unverified",
    },
  },
};

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /products — success", () => {
  it("returns 201 with the created product", async () => {
    const app = createApp(buildDependencies({ registerProduct: async () => REGISTERED }));
    const response = await post(app, VALID_BODY);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      trustpassId: "TP1-1M9PK74S40YWR2XBMKZ2JYJEGTB",
      status: "registered",
      issuer: { registrationNumber: "900123456-7", verificationStatus: "unverified" },
    });
  });

  it("serialises createdAt as an ISO string", async () => {
    const app = createApp(buildDependencies({ registerProduct: async () => REGISTERED }));
    const body = (await (await post(app, VALID_BODY)).json()) as { createdAt: string };

    expect(body.createdAt).toBe("2026-09-17T16:45:00.000Z");
  });

  it("never exposes the internal key", async () => {
    // ADR 0005: the identity key never crosses the API boundary. Nothing in the
    // type system enforces that, so it is asserted here.
    const app = createApp(buildDependencies({ registerProduct: async () => REGISTERED }));
    const body = (await (await post(app, VALID_BODY)).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("issuerId");
    expect(body.issuer).not.toHaveProperty("id");
  });

  it("ignores a client-supplied TrustPass ID", async () => {
    // A caller that could choose its own identifier could collide with a label
    // already printed, or reuse one it had seen elsewhere.
    const registerProduct = vi.fn<AppDependencies["registerProduct"]>(async () => REGISTERED);
    const app = createApp(buildDependencies({ registerProduct }));

    await post(app, { ...VALID_BODY, trustpassId: "TP1-ATTACKERCHOSENVALUEHERE0" });

    expect(registerProduct).toHaveBeenCalledOnce();
    expect(registerProduct.mock.calls[0]?.[0]).not.toHaveProperty("trustpassId");
  });
});

describe("POST /products — validation", () => {
  it("returns 422 rather than Hono's default 400", async () => {
    // The documented envelope has to apply to the response a caller is most
    // likely to hit, not to every response except that one.
    const app = createApp(buildDependencies());
    const response = await post(app, {});

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "validation_failed" });
  });

  it("names every offending field, not just the first", async () => {
    // Fixing one field per round trip is a worse experience than strict
    // validation in the first place.
    const app = createApp(buildDependencies());
    const response = await post(app, { brand: "", model: "", serial: "x", category: "spaceship" });
    const body = (await response.json()) as { details: Array<{ path: string }> };

    const paths = body.details.map((detail) => detail.path);
    expect(paths).toEqual(expect.arrayContaining(["brand", "model", "serial", "category"]));
  });

  it.each([
    ["a lower-case country", { ...VALID_BODY.issuer, country: "co" }],
    ["a three-letter country", { ...VALID_BODY.issuer, country: "COL" }],
    ["a registration number with spaces", { ...VALID_BODY.issuer, registrationNumber: "900 123" }],
  ])("rejects %s", async (_label, issuer) => {
    const app = createApp(buildDependencies());
    const response = await post(app, { ...VALID_BODY, issuer });

    expect(response.status).toBe(422);
  });

  it("rejects a category outside the enum", async () => {
    const app = createApp(buildDependencies());
    const response = await post(app, { ...VALID_BODY, category: "spaceship" });

    expect(response.status).toBe(422);
  });

  it("does not reach the service when the body is invalid", async () => {
    const registerProduct = vi.fn<AppDependencies["registerProduct"]>(async () => REGISTERED);
    const app = createApp(buildDependencies({ registerProduct }));

    await post(app, {});

    expect(registerProduct).not.toHaveBeenCalled();
  });
});

describe("POST /products — unknown issuer", () => {
  it("returns a structured 422, not a database message", async () => {
    const app = createApp(
      buildDependencies({
        registerProduct: async () => ({ ok: false, reason: "issuer_not_found" }),
      }),
    );
    const response = await post(app, VALID_BODY);

    expect(response.status).toBe(422);

    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("issuer_not_found");
    expect(body.message).toContain("900123456-7");
    expect(body.message).toContain("CO");
    // A caller must never be shown SQL, a constraint name or a table name.
    expect(body.message).not.toMatch(/constraint|violates|relation|SQLSTATE/i);
  });
});

describe("POST /products — documentation", () => {
  it("appears in the OpenAPI document with both schemas", async () => {
    const app = createApp(buildDependencies());
    const doc = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<
        string,
        { post?: { requestBody?: unknown; responses?: Record<string, unknown> } }
      >;
      components: { schemas: Record<string, unknown> };
    };

    expect(Object.keys(doc.paths)).toContain("/products");
    expect(doc.paths["/products"]?.post?.requestBody).toBeDefined();
    expect(Object.keys(doc.paths["/products"]?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(["201", "422"]),
    );
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["RegisterProductRequest", "RegisteredProduct", "ApiError"]),
    );
  });
});
