import {
  createDatabase,
  type Database,
  issueCredentialFor,
  schema,
  verifyCredential,
} from "@trustpass/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { buildDependencies } from "../testing/dependencies.js";
import { enrolProduct } from "./enrol-product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * The loop, end to end: issue a credential, present it over HTTP, read the row.
 *
 * Everything else in this repository tests one segment of this with the next
 * one stubbed. That is deliberate and it is not enough on its own, because
 * every segment can be correct while the joins between them are not — a
 * command that stores a digest of something other than the secret it printed
 * satisfies every test that does not then try to use the token.
 *
 * So there are no stubs here except the app's own dependency seam, and the
 * credential is a real row created by the real issuance path.
 *
 *   issueCredentialFor
 *          -> the token it printed
 *          -> Authorization: Bearer, over HTTP
 *          -> 201
 *          -> lifecycle_event.actor_id
 *          -> the actor the command was told to use
 *
 * The last line is the one that cannot pass by accident.
 */
describe.skipIf(!databaseUrl)("a credential issued by the operator command", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });

    // The real verifier, not a stub that recognises one token. This is the same
    // wiring `apps/api/src/index.ts` uses.
    app = createApp(
      buildDependencies({
        authenticate: (presented) => verifyCredential(db, presented, "dev"),
        enrolProduct: (input, principal) => enrolProduct(db, input, principal),
      }),
    );
  });

  afterAll(async () => {
    // No cleanup. Enrolments carry lifecycle events, events cannot be deleted,
    // and the product foreign key is RESTRICT — so these rows cannot be removed
    // and that is the append-only guarantee working. Each run has its own prefix.
    await db.$client.end();
  });

  async function issue(label: string) {
    return issueCredentialFor(
      db.$client,
      {
        label: `${run} ${label}`,
        actor: { create: { kind: "service", displayName: `${run} ${label}` } },
      },
      "dev",
    );
  }

  function enrol(serial: string, token?: string) {
    return app.request("/enrolments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ brand: "ASUS", model: "ROG", serial, category: "gpu" }),
    });
  }

  async function eventFor(serial: string) {
    const [product] = await db
      .select()
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    const [event] = await db
      .select()
      .from(schema.lifecycleEvent)
      .where(eq(schema.lifecycleEvent.productId, product?.id as number));

    return event;
  }

  it("writes a record attributed to the actor the command created", async () => {
    const issued = await issue("loop");
    const serial = `${run}-LOOP`;

    const response = await enrol(serial, issued.token);

    expect(response.status).toBe(201);
    expect((await eventFor(serial))?.actorId).toBe(issued.actorId);
  });

  it("keeps two issued credentials apart all the way to the row", async () => {
    // One credential producing the right actor could be a constant. Two, each
    // resolving to its own, cannot.
    const alice = await issue("alice");
    const bob = await issue("bob");

    expect(await enrol(`${run}-A`, alice.token)).toMatchObject({ status: 201 });
    expect(await enrol(`${run}-B`, bob.token)).toMatchObject({ status: 201 });

    const forAlice = await eventFor(`${run}-A`);
    const forBob = await eventFor(`${run}-B`);

    expect(forAlice?.actorId).toBe(alice.actorId);
    expect(forBob?.actorId).toBe(bob.actorId);
    expect(forAlice?.actorId).not.toBe(forBob?.actorId);
  });

  it("refuses the same token once the credential is revoked, with no restart", async () => {
    // Revocation is consulted per request, which is the property ADR 0014 §4
    // rejected JWT to preserve. Proved against a credential this command made,
    // rather than one a test hand-wrote.
    const issued = await issue("revoked");

    expect(await enrol(`${run}-BEFORE`, issued.token)).toMatchObject({ status: 201 });

    await db
      .update(schema.credential)
      .set({ revokedAt: new Date() })
      .where(eq(schema.credential.id, issued.credentialId));

    expect(await enrol(`${run}-AFTER`, issued.token)).toMatchObject({ status: 401 });
  });

  it("refuses a token for another environment, though the credential is real", async () => {
    const issued = await issue("wrong env");

    // The same credential, presented as live. The row exists and is active; the
    // prefix is what stops it, before any lookup.
    const asLive = issued.token.replace(".dev.", ".live.");

    expect(await enrol(`${run}-ENV`, asLive)).toMatchObject({ status: 401 });
  });

  it("still refuses a request with no credential at all", async () => {
    const response = await enrol(`${run}-NONE`);

    expect(response.status).toBe(401);

    const rows = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.serial, `${run}-NONE`));

    expect(rows).toHaveLength(0);
  });
});
