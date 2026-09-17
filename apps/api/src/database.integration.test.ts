import { createDatabase, isDatabaseReachable } from "@trustpass/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { buildDependencies } from "./testing/dependencies.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises the real Postgres connection.
 *
 * Skipped when DATABASE_URL is absent so a clean checkout can still run
 * `pnpm test` without Docker. CI provides a Postgres service, so the suite
 * runs there and the skip never hides a regression.
 */
describe.skipIf(!databaseUrl)("database integration", () => {
  const db = createDatabase(databaseUrl as string, { maxConnections: 2 });

  afterAll(async () => {
    await db.$client.end();
  });

  it("reaches the configured Postgres instance", async () => {
    await expect(isDatabaseReachable(db)).resolves.toBe(true);
  });

  it("serves /health as ok when backed by the real database", async () => {
    const app = createApp(
      buildDependencies({
        version: "0.1.0-integration",
        checkDatabase: () => isDatabaseReachable(db),
      }),
    );

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      checks: { database: "up" },
    });
  });

  it("reports the database as down for an unreachable host", async () => {
    const unreachable = createDatabase("postgresql://nobody:nobody@127.0.0.1:1/none", {
      maxConnections: 1,
    });

    await expect(isDatabaseReachable(unreachable)).resolves.toBe(false);
    await unreachable.$client.end();
  });
});
