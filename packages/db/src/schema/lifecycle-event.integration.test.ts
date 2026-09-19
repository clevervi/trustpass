import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { generateTrustPassId } from "../identity/trustpass-id.js";
import { expectSqlState, SqlState, sqlStateOf } from "../testing/sql-state.js";
import { insertProductWithProvenance } from "../testing/with-provenance.js";
import { actor } from "./actor.js";
import { lifecycleEvent, type NewLifecycleEvent } from "./lifecycle-event.js";
import { organization } from "./organization.js";
import { product } from "./product.js";

const databaseUrl = process.env.DATABASE_URL;

/**
 * Exercises the lifecycle event table against a real Postgres instance.
 *
 * Every guarantee here — append-only, the closed sets, the paired columns —
 * exists only in the database. Asserting them against a mock would test the
 * mock, and the whole point of putting them in the database is that they hold
 * for writers that never went through this code.
 */
describe.skipIf(!databaseUrl)("lifecycle_event table", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let organizationId: number;
  let productId: number;
  let sequence = 0;

  /** Two of them, so "it kept alice" is distinguishable from "it kept a value". */
  let alice: number;
  let bob: number;

  function build(overrides: Partial<NewLifecycleEvent> = {}): NewLifecycleEvent {
    return {
      productId,
      type: "product_registered",
      actorKind: "issuer",
      organizationId,
      // now(), not a Date: recorded_at defaults to the transaction
      // timestamp, and a Date read afterwards is later than it.
      occurredAt: sql`now()` as unknown as Date,
      ...overrides,
    };
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);

    const [created] = await db
      .insert(organization)
      .values({
        companyName: `Events ${run}`,
        legalName: `Events ${run} SAS`,
        registrationNumber: `${run}-EV`,
        country: "CO",
      })
      .returning({ id: organization.id });
    organizationId = created?.id as number;

    const registered = await insertProductWithProvenance(db, {
      trustpassId: generateTrustPassId(),
      organizationId,
      brand: "ASUS",
      model: "ROG Strix RTX 5070 Ti",
      serial: `${run}-EV-SERIAL`,
      category: "gpu",
      status: "registered",
    });
    productId = registered?.id as number;

    const people = await db
      .insert(actor)
      .values([
        { kind: "service", displayName: `${run} alice` },
        { kind: "service", displayName: `${run} bob` },
      ])
      .returning({ id: actor.id });

    alice = people[0]?.id as number;
    bob = people[1]?.id as number;
  });

  afterAll(async () => {
    // Events cannot be deleted, which is the point of the table — so the
    // product and issuer that own them cannot be deleted either. The rows stay.
    // This is a deliberate consequence of append-only rather than an oversight:
    // a test suite that could clean up after itself would prove the guarantee
    // does not hold.
    await db.$client.end();
  });

  describe("the history cannot be rewritten", () => {
    it("refuses an UPDATE with TP002, not a generic failure", async () => {
      const [event] = await db.insert(lifecycleEvent).values(build()).returning();

      await expectSqlState(
        db
          .update(lifecycleEvent)
          .set({ reason: "fraud_flag" })
          .where(eq(lifecycleEvent.id, event?.id as number)),
        SqlState.HISTORY_IS_APPEND_ONLY,
      );
    });

    it("refuses a DELETE with TP002", async () => {
      const [event] = await db.insert(lifecycleEvent).values(build()).returning();

      await expectSqlState(
        db.delete(lifecycleEvent).where(eq(lifecycleEvent.id, event?.id as number)),
        SqlState.HISTORY_IS_APPEND_ONLY,
      );
    });

    it("refuses an UPDATE that changes nothing, because the guard is not about intent", async () => {
      const [event] = await db.insert(lifecycleEvent).values(build()).returning();

      // A no-op UPDATE is still an UPDATE. A guard that let it through would be
      // relying on the writer's honesty about what they meant to change.
      await expectSqlState(
        db
          .update(lifecycleEvent)
          .set({ type: "product_registered" })
          .where(eq(lifecycleEvent.id, event?.id as number)),
        SqlState.HISTORY_IS_APPEND_ONLY,
      );
    });

    it("leaves the original intact after a rejected write", async () => {
      const [event] = await db
        .insert(lifecycleEvent)
        .values(build({ reason: "issuer_request" }))
        .returning();

      await db
        .update(lifecycleEvent)
        .set({ reason: "fraud_flag" })
        .where(eq(lifecycleEvent.id, event?.id as number))
        .catch(() => undefined);

      const [after] = await db
        .select()
        .from(lifecycleEvent)
        .where(eq(lifecycleEvent.id, event?.id as number));

      expect(after?.reason).toBe("issuer_request");
    });
  });

  describe("attribution, once written, is not a field anybody may revise", () => {
    // `actor_id` arrived in 0026 and holds identity, so the append-only
    // guarantee is checked against it specifically rather than assumed to
    // extend. A column added after a trigger was written is exactly the case
    // where "it is covered by the existing guard" is a belief.

    it("refuses to change who an event names", async () => {
      const [event] = await db
        .insert(lifecycleEvent)
        .values(build({ actorId: alice }))
        .returning();

      await expectSqlState(
        db
          .update(lifecycleEvent)
          .set({ actorId: bob })
          .where(eq(lifecycleEvent.id, event?.id as number)),
        SqlState.HISTORY_IS_APPEND_ONLY,
      );

      const [after] = await db
        .select()
        .from(lifecycleEvent)
        .where(eq(lifecycleEvent.id, event?.id as number));

      expect(after?.actorId).toBe(alice);
    });

    it("refuses to attribute an event that named nobody", async () => {
      // The one that matters most for the 13,171 events written before
      // authentication existed. A null `actor_id` means "recorded before the
      // system knew who was asking", which is true of those rows — and filling
      // one in later would turn an honest gap into a fabricated fact, which is
      // the same argument ADR 0011 §7 makes about revocation.
      const [historical] = await db
        .insert(lifecycleEvent)
        .values(build({ actorId: null }))
        .returning();

      await expectSqlState(
        db
          .update(lifecycleEvent)
          .set({ actorId: alice })
          .where(eq(lifecycleEvent.id, historical?.id as number)),
        SqlState.HISTORY_IS_APPEND_ONLY,
      );
    });

    it("refuses to renumber an actor that history names", async () => {
      // The cascade door. The foreign key is ON UPDATE CASCADE, so an actor
      // whose id changed would drag every event it is named in along with it —
      // rewriting attribution without ever touching `lifecycle_event`.
      //
      // The door is shut before that, by the identity column: 428C9, "column
      // can only be updated to DEFAULT".
      await db
        .insert(lifecycleEvent)
        .values(build({ actorId: alice }))
        .returning();

      await expectSqlState(
        db.execute(sql`UPDATE actor SET id = id + 1000000 WHERE id = ${alice}`),
        SqlState.GENERATED_ALWAYS,
      );
    });

    it("refuses the cascade even with the identity guard taken away", async () => {
      // An earlier version of the test above claimed the guarantee rested on
      // `generatedAlwaysAsIdentity`, and that a migration relaxing it would
      // open the cascade silently. That was reasoning, and it was wrong.
      //
      // Measured instead: relax the identity column, then renumber. The update
      // cascades into `lifecycle_event` and the append-only trigger fires on
      // it, because a cascaded UPDATE is an UPDATE. TP002, not a rewritten
      // history.
      //
      // So the two guards are independent rather than stacked, and this test
      // exists to keep the second one honest. The DDL is real and the
      // transaction is rolled back; `ALTER TABLE` is transactional in
      // Postgres, which is what makes this measurable at all.
      await db
        .insert(lifecycleEvent)
        .values(build({ actorId: alice }))
        .returning();

      // **The rollback is unconditional, and that is not fussiness.**
      //
      // The first version let the failing UPDATE abort the transaction, which
      // rolls back the DDL with it. That works exactly while the test passes.
      // Running it with `lifecycle_event_no_update` dropped, to check the test
      // was not decoration, the UPDATE succeeded — so the transaction committed
      // and left `actor.id` writable for every run afterwards. A test that
      // weakens the database when its subject is broken is worse than no test.
      //
      // So the outcome is captured and a sentinel is always thrown. The DDL
      // cannot commit whatever the database decides.
      const ROLLBACK = Symbol("roll this back whatever happened");
      let outcome: unknown = "the update was accepted";

      await db
        .transaction(async (tx) => {
          await tx.execute(sql`ALTER TABLE actor ALTER COLUMN id SET GENERATED BY DEFAULT`);

          try {
            // A free id rather than a memorable one. The first version used a
            // literal, and it collided with a row an earlier run of this very
            // test had left behind — so the UPDATE failed with 23505 before it
            // could reach the cascade, and the test asserted the wrong refusal.
            await tx.execute(
              sql`UPDATE actor SET id = (SELECT max(id) + 1 FROM actor) WHERE id = ${alice}`,
            );
          } catch (error) {
            outcome = error;
          }

          throw ROLLBACK;
        })
        .catch((error) => {
          if (error !== ROLLBACK) {
            throw error;
          }
        });

      expect(sqlStateOf(outcome)).toBe(SqlState.HISTORY_IS_APPEND_ONLY);

      // And the column is back the way it was, because the transaction that
      // relaxed it did not commit. Asserted rather than assumed: a test that
      // left `actor.id` writable would weaken every run after it.
      const rows = (await db.execute(sql`
        SELECT is_identity || ':' || coalesce(identity_generation, 'none') AS identity
        FROM information_schema.columns
        WHERE table_name = 'actor' AND column_name = 'id'
      `)) as unknown as { identity: string }[];

      expect(rows[0]?.identity).toBe("YES:ALWAYS");
    });

    it("refuses to delete an actor that history names", async () => {
      await db
        .insert(lifecycleEvent)
        .values(build({ actorId: alice }))
        .returning();

      // RESTRICT, not cascade. Deleting the actor would erase who did what,
      // which is the same erasure the append-only trigger prevents through a
      // different door.
      await expectSqlState(
        db.execute(sql`DELETE FROM actor WHERE id = ${alice}`),
        SqlState.RESTRICT_VIOLATION,
      );
    });
  });

  describe("a mistake is corrected by recording, not by editing", () => {
    it("links a correction to what it corrects", async () => {
      const [wrong] = await db
        .insert(lifecycleEvent)
        .values(
          build({
            type: "product_suspended",
            actorKind: "authority",
            organizationId: null,
            reason: "theft_report",
          }),
        )
        .returning();

      const [correction] = await db
        .insert(lifecycleEvent)
        .values(
          build({
            type: "record_corrected",
            actorKind: "system",
            organizationId: null,
            reason: "recording_error",
            correctsEventId: wrong?.id as number,
          }),
        )
        .returning();

      expect(correction?.correctsEventId).toBe(wrong?.id);

      // Both rows survive. What the system believed at the time is itself a
      // fact, and a correction that erased it would destroy that.
      const history = await db
        .select()
        .from(lifecycleEvent)
        .where(eq(lifecycleEvent.productId, productId))
        .orderBy(desc(lifecycleEvent.id));

      expect(history.map((row) => row.id)).toEqual(
        expect.arrayContaining([wrong?.id, correction?.id]),
      );
    });

    it("refuses a correction that points at nothing", async () => {
      await expectSqlState(
        db
          .insert(lifecycleEvent)
          .values(build({ type: "record_corrected", actorKind: "system", organizationId: null })),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("refuses a correction target on an event that is not a correction", async () => {
      const [existing] = await db.insert(lifecycleEvent).values(build()).returning();

      await expectSqlState(
        db.insert(lifecycleEvent).values(build({ correctsEventId: existing?.id as number })),
        SqlState.CHECK_VIOLATION,
      );
    });
  });

  describe("an event is past tense", () => {
    it("refuses an occurrence in the future", async () => {
      // ADR 0008: a thing recorded as happening after it was recorded is not an
      // event, it is a schedule — and a schedule in the history table lets a
      // passport display a future as a fact.
      await expectSqlState(
        db.insert(lifecycleEvent).values(build({ occurredAt: new Date(Date.now() + 86_400_000) })),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("keeps when it happened separate from when it was learned", async () => {
      const march = new Date("2026-03-04T10:00:00Z");
      const [event] = await db
        .insert(lifecycleEvent)
        .values(
          build({
            occurredAt: march,
            type: "product_suspended",
            actorKind: "authority",
            organizationId: null,
            reason: "theft_report",
          }),
        )
        .returning();

      expect(event?.occurredAt.toISOString()).toBe(march.toISOString());
      // A repair done in March and recorded in September is two dates. The
      // distance between them is itself information about the record's
      // strength, so collapsing them loses more than a column.
      expect(event?.recordedAt.getTime()).toBeGreaterThan(march.getTime());
    });
  });

  describe("when TrustPass learned of something is not the caller's to say", () => {
    // The provenance triggers identify this transaction's events by
    // recorded_at. A writer who can set that column chooses which transaction
    // its event appears to belong to, which is the whole guarantee. 0015 takes
    // the column away from every writer, the owner included.

    /**
     * The type refuses `recordedAt` since 0015. These tests supply it anyway,
     * because the type is not the guard — it only stops an honest mistake. The
     * database is the guard, and that is what is under test here.
     */
    function planted(recordedAt: unknown, overrides: Partial<NewLifecycleEvent> = {}) {
      return { ...build(overrides), recordedAt } as NewLifecycleEvent;
    }

    it("ignores a recorded_at the caller supplies", async () => {
      const decade = new Date(Date.now() + 10 * 365 * 86_400_000);

      const [event] = await db.insert(lifecycleEvent).values(planted(decade)).returning();

      // Compared in SQL rather than in JavaScript: the host clock runs ahead of
      // the container's, so a Date taken here is not the same instant as now()
      // and a comparison between them measures the skew, not the guarantee.
      //
      // Bounded from below as well, and that is not padding. `recorded_at <=
      // now()` alone would also accept 1970 — it would pass for a trigger that
      // wrote any past constant, which is a different bug wearing this one's
      // clothes. The requirement is that the column holds the time of the write,
      // so the test says so, with a minute of room for the clock skew above.
      const [row] = await db.execute<{ server_written: boolean }>(
        sql`SELECT recorded_at <= now()
                   AND recorded_at > now() - interval '1 minute' AS server_written
            FROM lifecycle_event WHERE id = ${event?.id as number}`,
      );

      expect(row?.server_written).toBe(true);
    });

    it("ignores a recorded_in_xact the caller supplies", async () => {
      // The same argument as recorded_at, and the reason it had to be made
      // again: a column the writer chooses cannot be the one that decides which
      // transaction owns a row. '0' is what the default would give, and nothing
      // a caller passes may reach the column either.
      const [event] = await db
        .insert(lifecycleEvent)
        .values(planted(new Date(), { recordedInXact: "0" } as Partial<NewLifecycleEvent>))
        .returning();

      const [row] = await db.execute<{ belongs_to_a_real_transaction: boolean }>(
        sql`SELECT recorded_in_xact <> '0'::xid8 AS belongs_to_a_real_transaction
            FROM lifecycle_event WHERE id = ${event?.id as number}`,
      );

      expect(row?.belongs_to_a_real_transaction).toBe(true);
    });

    it("no longer lets a future occurrence ride in on a future recorded_at", async () => {
      // lifecycle_event_not_in_future compares occurred_at to recorded_at, so
      // a caller supplying both in the future satisfied it. An event that has
      // not happened yet then sat in the history for a passport to render as a
      // fact — ADR 0008's distinction between an event and a schedule, lost to
      // a column nobody was guarding.
      const later = new Date(Date.now() + 5 * 365 * 86_400_000);

      await expectSqlState(
        db
          .insert(lifecycleEvent)
          .values(planted(new Date(later.getTime() + 86_400_000), { occurredAt: later })),
        SqlState.CHECK_VIOLATION,
      );
    });
  });

  describe("an actor is recorded whole or not at all", () => {
    it("refuses the issuer capacity without an issuer", async () => {
      await expectSqlState(
        db.insert(lifecycleEvent).values(build({ organizationId: null })),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("refuses an issuer reference from a non-issuer actor", async () => {
      await expectSqlState(
        db.insert(lifecycleEvent).values(build({ actorKind: "holder", type: "record_enrolled" })),
        SqlState.CHECK_VIOLATION,
      );
    });

    it.each([
      ["holder", "record_enrolled"],
      ["authority", "product_suspended"],
      ["system", "record_corrected"],
    ] as const)("accepts a %s acting with no issuer", async (actorKind, type) => {
      // Each capacity is given a type it is allowed to record. Since TP-053 the
      // pairing matters, so a sweep over actors with one fixed type would be
      // testing the authority trigger by accident rather than the actor check.
      const target =
        type === "record_corrected"
          ? (await db.insert(lifecycleEvent).values(build()).returning())[0]?.id
          : undefined;

      const [event] = await db
        .insert(lifecycleEvent)
        .values(build({ actorKind, organizationId: null, type, correctsEventId: target ?? null }))
        .returning();

      expect(event?.actorKind).toBe(actorKind);
    });
  });

  describe("a transition names both ends or neither", () => {
    it("accepts a complete transition", async () => {
      const [event] = await db
        .insert(lifecycleEvent)
        .values(
          build({
            type: "product_suspended",
            actorKind: "authority",
            organizationId: null,
            reason: "theft_report",
            previousState: "registered",
            resultingState: "suspended",
          }),
        )
        .returning();

      expect(event?.previousState).toBe("registered");
      expect(event?.resultingState).toBe("suspended");
    });

    it.each([
      ["only a destination", { resultingState: "suspended" }],
      ["only a source", { previousState: "registered" }],
    ] as const)("refuses %s", async (_label, states) => {
      // "It became suspended" with no source hides whether the move was legal.
      await expectSqlState(
        db.insert(lifecycleEvent).values(build(states)),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("accepts an event that is not a transition at all", async () => {
      const [event] = await db
        .insert(lifecycleEvent)
        .values(build({ type: "record_enrolled", actorKind: "holder", organizationId: null }))
        .returning();

      expect(event?.previousState).toBeNull();
      expect(event?.resultingState).toBeNull();
    });
  });

  describe("history outlives what it describes", () => {
    it("refuses to delete a product that has events", async () => {
      sequence += 1;
      const doomed = await insertProductWithProvenance(db, {
        trustpassId: generateTrustPassId(),
        organizationId,
        brand: "ASUS",
        model: "RTX",
        serial: `${run}-DOOMED-${sequence}`,
        category: "gpu",
        status: "registered",
      });

      await db.insert(lifecycleEvent).values(build({ productId: doomed?.id as number }));

      // Deleting a product would silently delete its history, and the history
      // is what a passport exists to preserve. Products are retired.
      await expectSqlState(
        db.delete(product).where(eq(product.id, doomed?.id as number)),
        SqlState.RESTRICT_VIOLATION,
      );
    });

    it("refuses to delete a party that recorded events", async () => {
      // The protection moved with the identity. Per ADR 0012 the organization
      // is the party, so it is the row that cannot vanish from under the events
      // referencing it — deleting it would silently delete who acted.
      await expectSqlState(
        db.delete(organization).where(eq(organization.id, organizationId)),
        SqlState.RESTRICT_VIOLATION,
      );
    });
  });

  describe("the closed sets are closed", () => {
    it.each([
      ["type", { type: "sold" as never }],
      ["reason", { reason: "it seemed broken" as never }],
      ["actor kind", { actorKind: "somebody" as never }],
    ])("refuses an unlisted %s", async (_label, overrides) => {
      await expectSqlState(
        db.insert(lifecycleEvent).values(build(overrides)),
        SqlState.INVALID_TEXT_REPRESENTATION,
      );
    });
  });
});
