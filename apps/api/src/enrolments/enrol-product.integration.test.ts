import { createDatabase, type Database, schema } from "@trustpass/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  authenticates,
  buildDependencies,
  credentialHeaders,
  withoutCredential,
} from "../testing/dependencies.js";
import { enrolProduct } from "./enrol-product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * What the request cannot decide, proved against the row it produces.
 *
 * The middleware tests show the principal reaches a handler. They stub the
 * service, so they prove the HTTP contract and nothing about what is written.
 * This closes that gap the only way it can be closed: by reading the row back.
 *
 * ADR 0014 §6 says nothing in a request body is identity. Three things make
 * that true of this path, and each is sufficient on its own:
 *
 *   the Zod schema        four fields, and `z.object` strips the rest
 *   enrolProduct          builds the repository input field by field, never
 *                         by spreading what it was handed
 *   the repository        writes `origin: "holder"`, `organizationId: null`
 *                         and `actorKind: "holder"` as literals
 *
 * **What this file proves, and what it does not.** Each layer was removed on
 * purpose and every test here stayed green; only removing all three turned two
 * of them red. That is what "sufficient on its own" means, and it also means
 * no test at this level can fail when one layer goes.
 *
 * So the single-layer tests live where the layer does — `routes/enrolments.test.ts`
 * for the schema, `enrolment-repository.integration.test.ts` for the literals —
 * and what is left here is the composition: a request that tries everything at
 * once produces the row it should. The service's field-by-field construction
 * has no test of its own, because with the repository's literals in place its
 * removal changes nothing observable; it is redundancy, and it is recorded as
 * redundancy rather than counted as a guard.
 */
describe.skipIf(!databaseUrl)("POST /enrolments against a real database", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });
    app = createApp(
      buildDependencies({
        authenticate: authenticates(),
        enrolProduct: (input) => enrolProduct(db, input),
      }),
    );
  });

  afterAll(async () => {
    // Deliberately no cleanup, matching `register-product.integration.test.ts`.
    //
    // The first version of this teardown deleted the events and then the
    // products, and Postgres refused it with TP002 — "A lifecycle event cannot
    // be deleted. History is append-only." The trigger is right and the
    // teardown was wrong: a cleanup that succeeded here would prove a
    // product's history can be erased.
    //
    // It also surfaced as a failing test *file* with every test passing, which
    // is a shape worth remembering — the summary line said 120 passed.
    //
    // Each run uses its own prefix, so the rows accumulate without colliding.
    await db.$client.end();
  });

  function post(payload: unknown, headers: Record<string, string> = credentialHeaders()) {
    return app.request("/enrolments", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  }

  async function storedFor(serial: string) {
    const [product] = await db
      .select()
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    const [event] = await db
      .select()
      .from(schema.lifecycleEvent)
      .where(eq(schema.lifecycleEvent.productId, product?.id as number));

    return { product, event };
  }

  it("refuses without a credential, and writes nothing", async () => {
    const serial = `${run}-NO-CREDENTIAL`;
    const response = await post(
      { brand: "ASUS", model: "ROG", serial, category: "gpu" },
      withoutCredential(),
    );

    expect(response.status).toBe(401);

    // The row is the assertion. A 401 that still wrote would look identical
    // from outside and be the only kind of authentication failure that matters.
    const rows = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    expect(rows).toHaveLength(0);
  });

  it("enrols with a credential, and records a holder enrolment", async () => {
    const serial = `${run}-PLAIN`;
    const response = await post({ brand: "ASUS", model: "ROG", serial, category: "gpu" });

    expect(response.status).toBe(201);

    const { product, event } = await storedFor(serial);

    expect(product?.origin).toBe("holder");
    expect(product?.organizationId).toBeNull();
    expect(event?.actorKind).toBe("holder");
  });

  it("writes the same row when the body claims to be somebody else", async () => {
    // The confused deputy, at the far end. Every field here is one the record
    // actually has, so a handler spreading its input into the repository would
    // write them — and the response would look correct while the row lied.
    const serial = `${run}-CLAIMS`;
    const response = await post({
      brand: "ASUS",
      model: "ROG",
      serial,
      category: "gpu",
      actorId: 999,
      actor_id: 999,
      actorKind: "issuer",
      actor_kind: "issuer",
      credentialId: 999,
      credential_id: 999,
      organizationId: 999,
      organization_id: 999,
      issuerId: 999,
      issuer_id: 999,
      issuer: { country: "CO", registrationNumber: "999" },
      origin: "supply_chain",
      status: "verified",
      trustpassId: "TP1-ATTACKER-CHOSE-THIS",
    });

    expect(response.status).toBe(201);

    const { product, event } = await storedFor(serial);

    // Identity: the literals the repository writes, not the claims in the body.
    expect(product?.origin).toBe("holder");
    expect(product?.organizationId).toBeNull();
    expect(event?.actorKind).toBe("holder");
    expect(event?.organizationId).toBeNull();

    // Status too. "verified" is a claim about the product that this path has
    // no standing to make, and it is the one a caller would most like to set.
    expect(product?.status).toBe("registered");

    // And the identifier, which ADR 0004 spends its whole Context keeping out
    // of a caller's control.
    expect(product?.trustpassId).not.toBe("TP1-ATTACKER-CHOSE-THIS");
    expect(product?.trustpassId.startsWith("TP1-")).toBe(true);
  });

  it("writes the same row whichever credential presents it", async () => {
    // Today's honest limitation, pinned so it is noticed when it changes.
    //
    // The enrolment records no actor: there is no column for one, so two
    // different principals produce indistinguishable rows. That is not the
    // final state — recording who enrolled is a schema change — and this test
    // will fail the day it lands, which is the point of writing it now.
    const somebodyElse = { actorId: 4242, credentialId: 4242 };
    const other = createApp(
      buildDependencies({
        authenticate: authenticates(
          "tp.dev.CCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
          somebodyElse,
        ),
        enrolProduct: (input) => enrolProduct(db, input),
      }),
    );

    const serial = `${run}-OTHER`;
    const response = await other.request("/enrolments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...credentialHeaders("tp.dev.CCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"),
      },
      body: JSON.stringify({ brand: "ASUS", model: "ROG", serial, category: "gpu" }),
    });

    expect(response.status).toBe(201);

    const { product, event } = await storedFor(serial);

    expect(product?.origin).toBe("holder");
    expect(event?.actorKind).toBe("holder");
  });

  it("returns nothing the caller put in that it did not keep", async () => {
    const serial = `${run}-ECHO`;
    const response = await post({
      brand: "ASUS",
      model: "ROG",
      serial,
      category: "gpu",
      actorKind: "issuer",
      status: "verified",
    });

    const returned = (await response.json()) as Record<string, unknown>;

    // A response that echoed the claim would tell a caller it had been accepted
    // even though the row disagrees, which is worse than refusing the field.
    expect(returned.status).toBe("registered");
    expect(returned.origin).toBe("holder");
    expect(returned).not.toHaveProperty("actorKind");
    expect(returned).not.toHaveProperty("organizationId");
    expect(returned).not.toHaveProperty("id");
  });
});
