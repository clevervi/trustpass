import { type AuthenticatedPrincipal, createDatabase, type Database, schema } from "@trustpass/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { enrolProduct } from "../enrolments/enrol-product.js";
import { buildDependencies, credentialHeaders, TEST_TOKEN } from "../testing/dependencies.js";
import { registerProduct } from "./register-product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Naming an issuer is not being one.
 *
 * #150 made every write require a credential, and left `issuer` in the request
 * body taken on trust: a registration number is public — national registries
 * publish them and `apps/web` prints one on every passport — so naming one
 * established nothing. An authenticated caller could register a product under
 * any organization in the database.
 *
 * These are the cases that close that, written before the check exists.
 *
 * **The capacity is `issuer` specifically, and the reason is in the record.**
 * `insertProduct` writes `actorKind: "issuer"` as a literal, so the event this
 * operation produces *claims* the issuer capacity. Accepting any grant for the
 * organization would let an actor holding only `authority` produce a record
 * saying `issuer` — something nobody granted. The rule that outlives this
 * endpoint: authorise the claim the record will make, not a weaker one.
 */
describe.skipIf(!databaseUrl)("acting for an organization you have authority over", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;

  /** The organization the credential's actor may act for. */
  let mine: { id: number; country: string; registrationNumber: string };
  /** One it has nothing to do with. */
  let theirs: { id: number; country: string; registrationNumber: string };

  let authorised: AuthenticatedPrincipal;
  let withoutGrant: AuthenticatedPrincipal;
  let membershipEnded: AuthenticatedPrincipal;
  let wrongCapacity: AuthenticatedPrincipal;
  let grantExpired: AuthenticatedPrincipal;

  let sequence = 0;

  async function organization(name: string) {
    sequence += 1;
    const registrationNumber = `${run}-${sequence.toString().padStart(3, "0")}`;

    const [created] = await db
      .insert(schema.organization)
      .values({
        companyName: name,
        legalName: `${name} ${run} SAS`,
        registrationNumber,
        country: "CO",
      })
      .returning({ id: schema.organization.id });

    return { id: created?.id as number, country: "CO", registrationNumber };
  }

  async function actorFor(name: string): Promise<number> {
    sequence += 1;
    const [created] = await db
      .insert(schema.actor)
      .values({ kind: "service", displayName: `${run} ${name}` })
      .returning({ id: schema.actor.id });

    return created?.id as number;
  }

  /**
   * An actor with a membership and, optionally, a grant.
   *
   * Both carry lifetimes on purpose: per ADR 0011 §2 a grant held through an
   * organization applies only while a membership covers the moment, so a
   * fixture that gave every membership an open end could not express the case
   * that matters most here.
   */
  async function principal(options: {
    readonly name: string;
    readonly organizationId: number;
    readonly membershipEndedAt?: Date;
    readonly capacity?: "issuer" | "authority";
    readonly grantExpiresAt?: Date;
    readonly withGrant?: boolean;
    /**
     * An additional grant, written **before** the one under test.
     *
     * `grantsHeldAt` orders by id, so this actor's first held grant is not the
     * one that authorises an issuer write. Without it every mutation that picks
     * the wrong grant — `held[0]` instead of the one matching the capacity —
     * would be undetectable, because the actor held exactly one.
     */
    readonly precededBy?: "authority";
  }): Promise<AuthenticatedPrincipal> {
    const actorId = await actorFor(options.name);
    const hour = 3_600_000;

    await db.insert(schema.membership).values({
      actorId,
      organizationId: options.organizationId,
      beganAt: new Date(Date.now() - 24 * hour),
      endedAt: options.membershipEndedAt ?? null,
    });

    if (options.precededBy !== undefined) {
      await db.insert(schema.capacityGrant).values({
        actorId,
        organizationId: options.organizationId,
        capacity: options.precededBy,
        scopeKind: "own_organization",
        effectiveFrom: new Date(Date.now() - 24 * hour),
        expiresAt: null,
      });
    }

    if (options.withGrant !== false) {
      await db.insert(schema.capacityGrant).values({
        actorId,
        organizationId: options.organizationId,
        capacity: options.capacity ?? "issuer",
        scopeKind: "own_organization",
        effectiveFrom: new Date(Date.now() - 24 * hour),
        expiresAt: options.grantExpiresAt ?? null,
      });
    }

    return { actorId, credentialId: actorId };
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string, { maxConnections: 4 });

    mine = await organization("Andes Tech");
    theirs = await organization("Somebody Else");

    authorised = await principal({
      name: "authorised",
      organizationId: mine.id,
      // Holds two grants over the same organization, the `authority` one first.
      // Only the `issuer` grant may authorise a registration, and the event has
      // to name that one — see "records which grant authorised the write".
      precededBy: "authority",
    });
    withoutGrant = await principal({
      name: "no grant",
      organizationId: mine.id,
      withGrant: false,
    });
    membershipEnded = await principal({
      name: "membership ended",
      organizationId: mine.id,
      membershipEndedAt: new Date(Date.now() - 3_600_000),
    });
    wrongCapacity = await principal({
      name: "wrong capacity",
      organizationId: mine.id,
      capacity: "authority",
    });
    grantExpired = await principal({
      name: "grant expired",
      organizationId: mine.id,
      grantExpiresAt: new Date(Date.now() - 3_600_000),
    });
  });

  afterAll(async () => {
    // No cleanup. A registered product carries a lifecycle event, events cannot
    // be deleted and the product foreign key is RESTRICT, so these rows and the
    // organizations that own them stay. Each run uses its own prefix.
    await db.$client.end();
  });

  function app(as: AuthenticatedPrincipal) {
    return createApp(
      buildDependencies({
        authenticate: async (presented) => (presented === TEST_TOKEN ? as : null),
        registerProduct: (input, who) => registerProduct(db, input, who),
        // Wired because the grant-pinning pair below needs both paths: an
        // issuer write that must name its grant and a holder enrolment that
        // must not. Asserting only the first would pass against an
        // implementation that wrote a grant onto every event.
        enrolProduct: (input, who) => enrolProduct(db, input, who),
      }),
    );
  }

  function register(
    as: AuthenticatedPrincipal,
    issuer: { country: string; registrationNumber: string },
    serial: string,
  ) {
    return app(as).request("/products", {
      method: "POST",
      headers: { "content-type": "application/json", ...credentialHeaders() },
      body: JSON.stringify({
        issuer,
        brand: "ASUS",
        model: "ROG Strix RTX 5070 Ti",
        serial,
        category: "gpu",
      }),
    });
  }

  it("registers for the organization the actor holds an issuer grant over", async () => {
    const response = await register(authorised, mine, `${run}-OK`);

    expect(response.status).toBe(201);
  });

  it("refuses an organization the actor has no grant over", async () => {
    // The defect this issue exists for. `theirs` is a real organization and the
    // caller is properly authenticated; naming a public registration number is
    // all it took before.
    const response = await register(authorised, theirs, `${run}-NOT-MINE`);

    expect(response.status).toBe(403);
  });

  it("refuses a member of the organization who holds no grant at all", async () => {
    // Belonging is not authority. ADR 0009: a capacity is granted, never a role
    // somebody has by being present.
    const response = await register(withoutGrant, mine, `${run}-NO-GRANT`);

    expect(response.status).toBe(403);
  });

  it("refuses an actor whose membership ended, though it still authenticates", async () => {
    // **The boundary ADR 0014 exists to hold.** The credential resolves to this
    // actor and always will — a membership ending says nothing about identity.
    // Authority is pinned to the moment it is used, and this moment is not
    // covered.
    //
    // A test that only covered "no grant at all" would pass against an
    // implementation that ignored membership entirely.
    const response = await register(membershipEnded, mine, `${run}-ENDED`);

    expect(response.status).toBe(403);
  });

  it("refuses a grant of the wrong capacity", async () => {
    // The event this operation writes claims `actor_kind: "issuer"`. An actor
    // granted `authority` over the organization may suspend and reinstate its
    // products and may not register one under a record that says issuer.
    const response = await register(wrongCapacity, mine, `${run}-CAPACITY`);

    expect(response.status).toBe(403);
  });

  it("refuses a grant that has expired", async () => {
    const response = await register(grantExpired, mine, `${run}-EXPIRED`);

    expect(response.status).toBe(403);
  });

  it("records which grant authorised the write, not merely that one did", async () => {
    // ADR 0011 §3. The event already said `actor_kind: 'issuer'`, which is a
    // claim about a capacity — a role. This asserts the *authority*: the
    // specific grant the check consulted.
    //
    // The difference is invisible until it is needed. A grant is revoked or
    // expires, `grantsHeldAt` will never return it again, and an event saying
    // only `issuer` can no longer be traced to what permitted it — or show that
    // anything did. Measured before this shipped: 8,133 events claiming
    // `issuer`, zero with a grant.
    const serial = `${run}-GRANT-PINNED`;

    expect((await register(authorised, mine, serial)).status).toBe(201);

    const [created] = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    const [event] = await db
      .select({ grantId: schema.lifecycleEvent.grantId })
      .from(schema.lifecycleEvent)
      .where(eq(schema.lifecycleEvent.productId, created?.id as number));

    // The grant this actor actually holds, read back rather than remembered, so
    // the assertion is against the row and not against a value this test set.
    const [held] = await db
      .select({ id: schema.capacityGrant.id })
      .from(schema.capacityGrant)
      .where(
        and(
          eq(schema.capacityGrant.actorId, authorised.actorId),
          // This actor also holds an `authority` grant over the same
          // organization, written first. Naming the capacity here is what makes
          // the assertion able to tell them apart.
          eq(schema.capacityGrant.capacity, "issuer"),
        ),
      );

    // Both halves. `toBe(held.id)` alone would pass against an implementation
    // that wrote any non-null number, and `not.toBeNull()` alone would pass
    // against one that wrote somebody else's grant.
    expect(event?.grantId).not.toBeNull();
    expect(event?.grantId).toBe(held?.id);
  });

  it("records no grant for an enrolment, because none authorised it", async () => {
    // The other half, and the reason `grantId` is nullable rather than
    // optional. A null on a `holder` event means "nobody's authority was
    // needed"; the same null on an `issuer` event means the record lost
    // something. A test that only asserted the issuer case would pass against
    // an implementation that wrote the grant onto everything.
    const serial = `${run}-ENROLMENT-NO-GRANT`;

    const response = await app(authorised).request("/enrolments", {
      method: "POST",
      headers: { "content-type": "application/json", ...credentialHeaders() },
      body: JSON.stringify({ brand: "ASUS", model: "ROG", serial, category: "gpu" }),
    });

    expect(response.status).toBe(201);

    const [created] = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    const [event] = await db
      .select({
        grantId: schema.lifecycleEvent.grantId,
        actorKind: schema.lifecycleEvent.actorKind,
      })
      .from(schema.lifecycleEvent)
      .where(eq(schema.lifecycleEvent.productId, created?.id as number));

    expect(event?.actorKind).toBe("holder");
    expect(event?.grantId).toBeNull();
  });

  it("keeps 403 and 422 apart, because collapsing them lies to the honest caller", async () => {
    // 422 already discloses that an organization exists, deliberately, and a
    // registration number is public anyway. Collapsing 403 into it would tell
    // somebody acting for their own organization that no such organization is
    // registered — sending them to fix data that is correct.
    const forbidden = await register(authorised, theirs, `${run}-FORBIDDEN`);
    const missing = await register(
      authorised,
      { country: "CO", registrationNumber: `${run}-NONE` },
      `${run}-MISSING`,
    );

    expect(forbidden.status).toBe(403);
    expect(missing.status).toBe(422);

    await expect(missing.json()).resolves.toMatchObject({ error: "issuer_not_found" });
  });

  it("writes nothing when it refuses", async () => {
    const serial = `${run}-REFUSED-NOTHING`;

    expect((await register(authorised, theirs, serial)).status).toBe(403);

    const rows = await db
      .select({ id: schema.product.id })
      .from(schema.product)
      .where(eq(schema.product.serial, serial));

    expect(rows).toHaveLength(0);
  });

  it("still refuses a request with no credential at all", async () => {
    // Authentication has not moved. A 403 for an unauthenticated caller would
    // mean the authorisation check ran before anybody knew who was asking.
    const response = await app(authorised).request("/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        issuer: mine,
        brand: "ASUS",
        model: "ROG",
        serial: `${run}-ANON`,
        category: "gpu",
      }),
    });

    expect(response.status).toBe(401);
  });
});
