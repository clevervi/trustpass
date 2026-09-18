import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../client.js";
import { grantsHeldAt, heldCapacityAt } from "../repositories/authority-repository.js";
import { expectSqlState, SqlState } from "../testing/sql-state.js";
import { actor } from "./actor.js";
import { capacityGrant, capacityGrantRevocation } from "./capacity-grant.js";
import { credential } from "./credential.js";
import { membership } from "./membership.js";
import { organization } from "./organization.js";

const databaseUrl = process.env.DATABASE_URL;

/** Fixed instants, so every assertion names the moment it is asking about. */
const JANUARY = new Date("2026-01-15T12:00:00Z");
const AUGUST = new Date("2026-08-15T12:00:00Z");
const SEPTEMBER = new Date("2026-09-15T12:00:00Z");
const NOVEMBER = new Date("2026-11-15T12:00:00Z");
const DECEMBER = new Date("2026-12-15T12:00:00Z");

describe.skipIf(!databaseUrl)("authority is a record with a lifetime", () => {
  const run = Math.random().toString(36).slice(2, 8).toUpperCase();
  let db: Database;
  let orgId: number;
  let n = 0;

  /**
   * An actor with a membership covering every instant these tests ask about.
   *
   * The membership is not incidental: since ADR 0011 §2 as amended, a grant
   * held through an organization applies only while a membership covers the
   * moment. A fixture without one would make every grant in this file
   * inapplicable, and the suite would be asserting the wrong thing while
   * looking green.
   */
  async function newActor(kind: "person" | "service" | "system" = "person"): Promise<number> {
    n += 1;
    const [created] = await db
      .insert(actor)
      .values({ kind, displayName: `${run} actor ${n}` })
      .returning({ id: actor.id });

    const actorId = created?.id as number;
    await db
      .insert(membership)
      .values({ actorId, organizationId: orgId, beganAt: new Date("2025-01-01T00:00:00Z") });

    return actorId;
  }

  /** An actor with no membership at all, for the cases that are about its absence. */
  async function unaffiliatedActor(): Promise<number> {
    n += 1;
    const [created] = await db
      .insert(actor)
      .values({ kind: "system", displayName: `${run} unaffiliated ${n}` })
      .returning({ id: actor.id });

    return created?.id as number;
  }

  /** A grant over the organization's own products, which is the ordinary shape. */
  function grantOver(actorId: number, from: Date, until: Date | null) {
    return {
      actorId,
      organizationId: orgId,
      capacity: "issuer" as const,
      scopeKind: "own_organization" as const,
      scopeCountry: null,
      effectiveFrom: from,
      expiresAt: until,
    };
  }

  beforeAll(async () => {
    db = createDatabase(databaseUrl as string);

    const [created] = await db
      .insert(organization)
      .values({
        companyName: `Authority ${run}`,
        legalName: `Authority ${run} SAS`,
        registrationNumber: `${run}-AUTH`,
        country: "CO",
      })
      .returning({ id: organization.id });
    orgId = created?.id as number;
  });

  afterAll(async () => {
    // Grants cannot be deleted, which is the point of the table — so the actors
    // and organizations they reference cannot be either. The rows stay. A suite
    // that could clean up after itself would prove the guarantee does not hold.
    await db.$client.end();
  });

  describe("a grant revoked later was still valid earlier", () => {
    it("answers valid for August when the revocation lands in September", async () => {
      // The clause the whole design rests on, and the one an implementation gets
      // wrong: `revoked_at > at`, never "no revocation exists". Filtering out
      // every revoked grant answers "what may this actor do now" and silently
      // destroys the answer to "what could they do then" — which is the question
      // ADR 0011 exists to keep answerable.
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      await db.insert(capacityGrantRevocation).values({
        grantId: granted?.id as number,
        revokedAt: SEPTEMBER,
        revokedBy: actorId,
        reason: "warrant withdrawn",
      });

      expect(await heldCapacityAt(db, actorId, "issuer", AUGUST)).toBe(true);
      expect(await heldCapacityAt(db, actorId, "issuer", NOVEMBER)).toBe(false);
    });

    it("does not hold it at the instant it was revoked", async () => {
      // The boundary. Revoked *at* September means it no longer applies then —
      // an off-by-one here decides whether an action taken in the same second as
      // a revocation was authorised.
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      await db.insert(capacityGrantRevocation).values({
        grantId: granted?.id as number,
        revokedAt: SEPTEMBER,
        revokedBy: actorId,
        reason: "warrant withdrawn",
      });

      expect(await heldCapacityAt(db, actorId, "issuer", SEPTEMBER)).toBe(false);
    });
  });

  describe("authentication is not authorisation", () => {
    it("a valid credential with an expired grant authorises nothing", async () => {
      // The cheapest possible demonstration that the two are different systems.
      // The credential is in perfect order; it is simply not what decides this.
      const actorId = await newActor();

      await db.insert(credential).values({
        actorId,
        kind: "api_key",
        label: "still valid in December",
        issuedAt: JANUARY,
        expiresAt: DECEMBER,
      });

      await db.insert(capacityGrant).values(grantOver(actorId, JANUARY, SEPTEMBER));

      expect(await heldCapacityAt(db, actorId, "issuer", AUGUST)).toBe(true);
      expect(await heldCapacityAt(db, actorId, "issuer", NOVEMBER)).toBe(false);
    });

    it("a valid credential with a revoked grant authorises nothing", async () => {
      const actorId = await newActor();

      await db.insert(credential).values({
        actorId,
        kind: "api_key",
        label: "not the thing being asked",
        issuedAt: JANUARY,
        expiresAt: DECEMBER,
      });

      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      await db.insert(capacityGrantRevocation).values({
        grantId: granted?.id as number,
        revokedAt: AUGUST,
        revokedBy: actorId,
        reason: "credential compromised",
      });

      expect(await heldCapacityAt(db, actorId, "issuer", NOVEMBER)).toBe(false);
    });

    it("an actor with a credential and no grant may do nothing at all", async () => {
      // ADR 0011 §5's "correct and frequently surprising answer".
      const actorId = await newActor();

      await db.insert(credential).values({
        actorId,
        kind: "public_key",
        label: "authenticates perfectly",
        issuedAt: JANUARY,
        expiresAt: null,
      });

      expect(await grantsHeldAt(db, actorId, AUGUST)).toHaveLength(0);
    });

    it("a rotated credential changes nothing about what was held", async () => {
      // The event points at the grant, never at the credential in force today.
      // If rotation could move authority, every historical attribution would be
      // re-decided by whatever key the actor happens to hold now.
      const actorId = await newActor();
      await db.insert(capacityGrant).values(grantOver(actorId, JANUARY, null));

      const [first] = await db
        .insert(credential)
        .values({ actorId, kind: "api_key", label: "rotated out", issuedAt: JANUARY })
        .returning({ id: credential.id });

      const before = await grantsHeldAt(db, actorId, AUGUST);

      await db
        .update(credential)
        .set({ revokedAt: SEPTEMBER })
        .where(eq(credential.id, first?.id as number));
      await db
        .insert(credential)
        .values({ actorId, kind: "api_key", label: "rotated in", issuedAt: SEPTEMBER });

      expect(await grantsHeldAt(db, actorId, AUGUST)).toEqual(before);
    });
  });

  describe("authority cannot be rewritten", () => {
    it("refuses an UPDATE to a grant with TP005, not a generic failure", async () => {
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      await expectSqlState(
        db
          .update(capacityGrant)
          .set({ expiresAt: DECEMBER })
          .where(eq(capacityGrant.id, granted?.id as number)),
        SqlState.AUTHORITY_IS_APPEND_ONLY,
      );
    });

    it("refuses a DELETE of a grant", async () => {
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      await expectSqlState(
        db.delete(capacityGrant).where(eq(capacityGrant.id, granted?.id as number)),
        SqlState.AUTHORITY_IS_APPEND_ONLY,
      );
    });

    it("refuses an UPDATE that changes nothing, because the guard is not about intent", async () => {
      // A no-op UPDATE is still an UPDATE. Letting it through would rely on the
      // writer's honesty about what they meant to change.
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      await expectSqlState(
        db
          .update(capacityGrant)
          .set({ capacity: "issuer" })
          .where(eq(capacityGrant.id, granted?.id as number)),
        SqlState.AUTHORITY_IS_APPEND_ONLY,
      );
    });

    it("refuses moving the moment a revocation happened", async () => {
      // Editing this would move the instant authority stopped, changing the
      // answer for every event recorded near it.
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      const [revocation] = await db
        .insert(capacityGrantRevocation)
        .values({
          grantId: granted?.id as number,
          revokedAt: SEPTEMBER,
          revokedBy: actorId,
          reason: "warrant withdrawn",
        })
        .returning({ id: capacityGrantRevocation.id });

      await expectSqlState(
        db
          .update(capacityGrantRevocation)
          .set({ revokedAt: JANUARY })
          .where(eq(capacityGrantRevocation.id, revocation?.id as number)),
        SqlState.AUTHORITY_IS_APPEND_ONLY,
      );
    });

    it("refuses a second revocation of the same grant", async () => {
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values(grantOver(actorId, JANUARY, null))
        .returning({ id: capacityGrant.id });

      const revocation = {
        grantId: granted?.id as number,
        revokedAt: SEPTEMBER,
        revokedBy: actorId,
        reason: "warrant withdrawn",
      };
      await db.insert(capacityGrantRevocation).values(revocation);

      await expectSqlState(
        db.insert(capacityGrantRevocation).values({ ...revocation, revokedAt: NOVEMBER }),
        SqlState.UNIQUE_VIOLATION,
      );
    });
  });

  describe("a grant is scoped, and a holder's is not granted at all", () => {
    it("refuses a country scope that names no country", async () => {
      const actorId = await newActor();

      await expectSqlState(
        db.insert(capacityGrant).values({
          actorId,
          organizationId: orgId,
          capacity: "authority",
          scopeKind: "country",
          scopeCountry: null,
          effectiveFrom: JANUARY,
        }),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("refuses an own-organization scope with no organization", async () => {
      const actorId = await newActor();

      await expectSqlState(
        db.insert(capacityGrant).values({
          actorId,
          organizationId: null,
          capacity: "issuer",
          scopeKind: "own_organization",
          effectiveFrom: JANUARY,
        }),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("refuses a grant of the holder capacity", async () => {
      // ADR 0009 §8: a holder's capacity is granted by nobody, because no
      // registry of people who own things exists and inventing a grant would
      // fabricate an authority. It is self-asserted and recorded as such, and a
      // grantable holder would make that carve-out silently untrue.
      const actorId = await newActor();

      await expectSqlState(
        db.insert(capacityGrant).values({
          actorId,
          organizationId: orgId,
          capacity: "holder",
          scopeKind: "own_organization",
          effectiveFrom: JANUARY,
        }),
        SqlState.CHECK_VIOLATION,
      );
    });
  });

  describe("authority ends with the relationship it was held through", () => {
    it("holds nothing after the membership ended", async () => {
      // The hole this section exists for. grantsHeldAt consulted the grant and
      // its revocation and nothing else, so an actor who left in June kept the
      // organization's capacity in July — and would have kept it until the
      // grant expired nineteen months later.
      //
      // The grant is not revoked. It simply stops applying, which is a
      // different fact about a different thing.
      const actorId = await unaffiliatedActor();
      await db
        .insert(membership)
        .values({ actorId, organizationId: orgId, beganAt: JANUARY, endedAt: AUGUST });
      await db.insert(capacityGrant).values(grantOver(actorId, JANUARY, null));

      expect(await heldCapacityAt(db, actorId, "issuer", SEPTEMBER)).toBe(false);
    });

    it("still held it while the membership ran", async () => {
      // The other half. A guard that refused everything would also pass the
      // test above and would make the whole model useless.
      const actorId = await unaffiliatedActor();
      await db
        .insert(membership)
        .values({ actorId, organizationId: orgId, beganAt: JANUARY, endedAt: SEPTEMBER });
      await db.insert(capacityGrant).values(grantOver(actorId, JANUARY, null));

      expect(await heldCapacityAt(db, actorId, "issuer", AUGUST)).toBe(true);
    });

    it("does not need a membership for a grant held through no organization", async () => {
      // A system capacity belongs to TrustPass rather than to any party, so a
      // join would silently drop every one of them — the failure mode of
      // fixing this with an inner join instead of a condition.
      const actorId = await unaffiliatedActor();
      await db.insert(capacityGrant).values({
        actorId,
        organizationId: null,
        capacity: "system",
        scopeKind: "country",
        scopeCountry: "CO",
        effectiveFrom: JANUARY,
      });

      expect(await heldCapacityAt(db, actorId, "system", AUGUST)).toBe(true);
    });
  });

  describe("an actor is never its own grantor", () => {
    it("refuses a grant an actor wrote to itself", async () => {
      // Being permitted to record an event does not make you permitted to hand
      // that permission to somebody else. Conflating them means the first
      // compromised actor mints authority indefinitely, and every grant it
      // writes is technically well-formed.
      const actorId = await newActor();

      await expectSqlState(
        db
          .insert(capacityGrant)
          .values({ ...grantOver(actorId, JANUARY, null), grantedBy: actorId }),
        SqlState.CHECK_VIOLATION,
      );
    });

    it("allows the root grant, which nothing preceded", async () => {
      const actorId = await newActor();
      const [granted] = await db
        .insert(capacityGrant)
        .values({ ...grantOver(actorId, JANUARY, null), grantedBy: null })
        .returning({ id: capacityGrant.id });

      expect(granted?.id).toBeGreaterThan(0);
    });
  });

  describe("a membership ends; it does not change", () => {
    it("allows ending one", async () => {
      const actorId = await newActor();
      const [joined] = await db
        .insert(membership)
        .values({ actorId, organizationId: orgId, beganAt: JANUARY })
        .returning({ id: membership.id });

      await db
        .update(membership)
        .set({ endedAt: SEPTEMBER })
        .where(eq(membership.id, joined?.id as number));

      const [row] = await db
        .select()
        .from(membership)
        .where(eq(membership.id, joined?.id as number));
      expect(row?.endedAt?.toISOString()).toBe(SEPTEMBER.toISOString());
    });

    it("refuses moving an actor to a different organization", async () => {
      // Retroactively rewriting who every event that actor recorded was acting
      // for, without touching a single event.
      const actorId = await newActor();
      const otherActor = await newActor();
      const [joined] = await db
        .insert(membership)
        .values({ actorId, organizationId: orgId, beganAt: JANUARY })
        .returning({ id: membership.id });

      await expectSqlState(
        db
          .update(membership)
          .set({ actorId: otherActor })
          .where(eq(membership.id, joined?.id as number)),
        SqlState.AUTHORITY_IS_APPEND_ONLY,
      );
    });

    it("refuses deleting one", async () => {
      const actorId = await newActor();
      const [joined] = await db
        .insert(membership)
        .values({ actorId, organizationId: orgId, beganAt: JANUARY })
        .returning({ id: membership.id });

      await expectSqlState(
        db.delete(membership).where(eq(membership.id, joined?.id as number)),
        SqlState.AUTHORITY_IS_APPEND_ONLY,
      );
    });
  });

  describe("a null grant on an event is not an absence of authority", () => {
    it("says so in the column comment, where a reader will meet it", async () => {
      // The misreading is one `WHERE grant_id IS NULL` away, and it turns a
      // limitation of the system into an accusation about a record — ADR 0003's
      // failure reached through a nullable column. Over eight thousand events
      // predate the column and no grant existed to point them at.
      //
      // Asserted rather than trusted to survive a future migration, because the
      // comment is the only place the semantics live for somebody reading the
      // database instead of the repository.
      const [row] = await db.execute<{ comment: string | null }>(
        sql`SELECT col_description('lifecycle_event'::regclass, attnum) AS comment
            FROM pg_attribute
            WHERE attrelid = 'lifecycle_event'::regclass AND attname = 'grant_id'`,
      );

      expect(row?.comment).toContain("before TrustPass could prove authority");
      expect(row?.comment).toContain("does NOT mean the event lacked authority");
    });
  });
});
