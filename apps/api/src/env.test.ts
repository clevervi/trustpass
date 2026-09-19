import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  TRUSTPASS_ENV: "dev",
};

describe("loadEnv", () => {
  it("applies defaults for optional values", () => {
    const env = loadEnv(validEnv);

    expect(env.NODE_ENV).toBe("development");
    expect(env.API_PORT).toBe(3001);
  });

  it("coerces a numeric port from its string representation", () => {
    expect(loadEnv({ ...validEnv, API_PORT: "8080" }).API_PORT).toBe(8080);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("throws when the port is out of range", () => {
    expect(() => loadEnv({ ...validEnv, API_PORT: "99999" })).toThrow(/API_PORT/);
  });
});
