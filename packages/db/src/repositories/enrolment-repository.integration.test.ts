import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { actor } from "../schema/actor.js";
import { lifecycleEvent } from "../schema/lifecycle-event.js";
import { product } from "../schema/product.js";
import { enrolProduct, findLiveHolderEnrolment } from "./enrolment-repository.js";
import { findProductHistory } from "./lifecycle-event-repository.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Enrolling a product nobody registered, against real Postgres.
 *
 * What this path records is narrow, and every test here is about keeping it
 * narrow: somebody entered a serial. Not that they own the product, not that it
 * is genuine, not that anything was checked.
 */
describe.skipIf(!databaseUrl)("enrolling a product you hold", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let n = 0;

  /**
   * Whoever is recording these. A real row, because `lifecycle_event.actor_id`
   * references `actor` and a write with no identified actor no longer compiles.
   */
  // `grantId: null` is the right answer here and not a placeholder. A holder
  // enrolment is somebody entering a serial on nobody's authority, so there
  // is no grant to name — which is what distinguishes it from an issuer
  // event whose grant went unrecorded.
  let caller: { actorId: number; grantId: null };

  function values(serial?: string) {
    n += 1;
    return {
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: serial ?? `${run}-ENR-${n}`,
      category: "gpu" as const,
    };
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);

    const [created] = await db
      .insert(actor)
      .values({ kind: "service", displayName: `${run} caller` })
      .returning({ id: actor.id });

    caller = { actorId: created?.id as number, grantId: null };
  });

  afterAll(async () => {
    // Enrolled products carry events, and events cannot be deleted. The rows
    // stay, which is the append-only guarantee working.
    await db.$client.end();
  });

  it("creates a record with no issuer and a holder origin", async () => {
    const result = await enrolProduct(
      db,
      { trustpassId: generateTrustPassId(), ...values() },
      caller,
    );
    if (!result.ok) throw new Error("expected success");

    expect(result.product.organizationId).toBeNull();
    expect(result.product.origin).toBe("holder");
  });

  it("ignores an issuer, an origin and a status handed to it anyway", async () => {
    // `EnrolProductInput` omits these three, so no caller written against the
    // type can pass them. The cast is the point: this asserts the runtime
    // behaviour rather than the compiler's, because the compiler is not what
    // is between a request and this row.
    //
    // Measured before writing it: with the literals replaced by
    // `values.organizationId ?? null` and friends, every HTTP-level test in
    // `apps/api` stayed green — Zod had already stripped the fields further
    // up, so nothing reaching this function carried them. Three layers each
    // sufficient on their own means no test of the whole chain can fail when
    // one of them goes. This test covers this layer alone.
    const smuggled = {
      trustpassId: generateTrustPassId(),
      ...values(),
      organizationId: 999,
      origin: "supply_chain",
      status: "verified",
    } as unknown as Parameters<typeof enrolProduct>[1];

    const result = await enrolProduct(db, smuggled, caller);
    if (!result.ok) throw new Error("expected success");

    expect(result.product.organizationId).toBeNull();
    expect(result.product.origin).toBe("holder");
    expect(result.product.status).toBe("registered");

    // Read from the table rather than through `findProductHistory`, which
    // projects a subset and does not carry `organization_id` — a `toMatchObject`
    // against a key the projection omits fails for the wrong reason, and did.
    const events = await db
      .select()
      .from(lifecycleEvent)
      .where(eq(lifecycleEvent.productId, result.product.id));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorKind: "holder", organizationId: null });
  });

  it("never produces active, because entering a serial is not owning a product", async () => {
    const result = await enrolProduct(
      db,
      { trustpassId: generateTrustPassId(), ...values() },
      caller,
    );
    if (!result.ok) throw new Error("expected success");

    // ADR 0008. `active` means ownership was established, and nothing here
    // established anything about who holds the object.
    expect(result.product.status).toBe("registered");
  });

  it("writes the enrolment as the record's first event, by a holder", async () => {
    const result = await enrolProduct(
      db,
      { trustpassId: generateTrustPassId(), ...values() },
      caller,
    );
    if (!result.ok) throw new Error("expected success");

    const history = await findProductHistory(db, result.product.id);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      type: "record_enrolled",
      actorKind: "holder",
      reason: "holder_request",
    });
  });

  it("records no issuer on the event either", async () => {
    const result = await enrolProduct(
      db,
      { trustpassId: generateTrustPassId(), ...values() },
      caller,
    );
    if (!result.ok) throw new Error("expected success");

    // Asserting the length is what makes the `[0]` below valid, and it is the
    // assertion rather than ceremony: an enrolment writes exactly one event,
    // and `product_id` is not unique on `lifecycle_event`. If a second event
    // ever joins this path, this fails loudly here instead of silently picking
    // whichever row Postgres returned first — which is how a test in this suite
    // passed for years while asserting about the wrong row.
    const events = await db
      .select()
      .from(lifecycleEvent)
      .where(eq(lifecycleEvent.productId, result.product.id));

    expect(events).toHaveLength(1);
    const [event] = events;

    expect(event?.organizationId).toBeNull();
  });

  it("reports a second live enrolment of the same serial as an outcome", async () => {
    const shared = `${run}-DUPE`;
    const first = await enrolProduct(
      db,
      { trustpassId: generateTrustPassId(), ...values(shared) },
      caller,
    );
    if (!first.ok) throw new Error("expected the first to succeed");

    const second = await enrolProduct(
      db,
      {
        trustpassId: generateTrustPassId(),
        ...values(shared),
      },
      caller,
    );

    // An outcome rather than an exception: a client that timed out and retried
    // is asking a reasonable question, not making a mistake.
    expect(second).toEqual({ ok: false, reason: "duplicate_live_serial" });
  });

  it("leaves no product behind when the serial was already enrolled", async () => {
    const shared = `${run}-NOORPHAN`;
    await enrolProduct(db, { trustpassId: generateTrustPassId(), ...values(shared) }, caller);
    await enrolProduct(db, { trustpassId: generateTrustPassId(), ...values(shared) }, caller);

    const rows = await db
      .select({ id: product.id })
      .from(product)
      .where(eq(product.serial, shared));

    expect(rows).toHaveLength(1);
  });

  it("does not report an unrelated unique violation as a duplicate serial", async () => {
    const shared = generateTrustPassId();
    const first = await enrolProduct(db, { trustpassId: shared, ...values() }, caller);
    if (!first.ok) throw new Error("expected the first to succeed");

    // Same identifier, different serial. That violates the TrustPass ID index,
    // not the serial one — and reporting it as "already enrolled" would tell a
    // caller their serial is taken when it is not, sending them to change the
    // one thing that was correct.
    await expect(enrolProduct(db, { trustpassId: shared, ...values() }, caller)).rejects.toThrow();
  });

  it("finds the enrolment a serial already has, case insensitively", async () => {
    const shared = `${run}-FIND`;
    const first = await enrolProduct(
      db,
      { trustpassId: generateTrustPassId(), ...values(shared) },
      caller,
    );
    if (!first.ok) throw new Error("expected success");

    const found = await findLiveHolderEnrolment(db, shared.toLowerCase());

    // The index is on lower(serial), so a lookup that was case sensitive would
    // miss the very row that caused the collision.
    expect(found?.trustpassId).toBe(first.product.trustpassId);
  });

  it("does not find an enrolment for a serial nobody enrolled", async () => {
    expect(await findLiveHolderEnrolment(db, `${run}-ABSENT`)).toBeUndefined();
  });
});
