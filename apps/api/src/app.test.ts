import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { buildDependencies } from "./testing/dependencies.js";

function buildApp(databaseUp: boolean) {
  return createApp(
    buildDependencies({ version: "0.1.0-test", checkDatabase: async () => databaseUp }),
  );
}

describe("GET /health", () => {
  it("returns 200 and status ok when the database is reachable", async () => {
    const response = await buildApp(true).request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      version: "0.1.0-test",
      checks: { database: "up" },
    });
  });

  it("returns 503 and status degraded when the database is unreachable", async () => {
    const response = await buildApp(false).request("/health");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { database: "down" },
    });
  });
});

describe("GET /version", () => {
  it("returns the service identity", async () => {
    const response = await buildApp(true).request("/version");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "trustpass-api",
      version: "0.1.0-test",
    });
  });
});

describe("OpenAPI document", () => {
  it("is generated and describes the system routes", async () => {
    const response = await buildApp(true).request("/openapi.json");
    const doc = (await response.json()) as { paths: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/health", "/version"]));
  });
});

describe("unknown routes", () => {
  it("returns a structured 404", async () => {
    const response = await buildApp(true).request("/does-not-exist");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      message: "Unknown endpoint",
    });
  });
});
