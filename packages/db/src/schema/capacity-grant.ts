import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { actor } from "./actor.js";
import { lifecycleActorKind } from "./actor-capacity.js";
import { organization } from "./organization.js";

/**
 * What a grant applies to.
 *
 * A closed set rather than free text, for ADR 0008's reason: free text cannot
 * be queried and invites a sentence where a fact belongs. The first time
 * somebody writes "all ASUS products in Latin America" the system has a
 * paragraph where it needed something it can evaluate.
 *
 * Per ADR 0011 §8 there is **no global form**. A capacity with no scope is not a
 * permission, it is a master key, and one compromised grant would poison every
 * passport — which is the fraud this whole system exists to resist.
 */
export const grantScopeKind = pgEnum("grant_scope_kind", [
  /** The products of the organization the grant is held through. */
  "own_organization",
  /** A jurisdiction. What an authority's warrant actually covers. */
  "country",
]);

/**
 * Who holds which capacity, over what, from when, until when.
 *
 * The composition ADR 0009 describes: `RECORDING_AUTHORITY` decides what a
 * capacity may assert, and a grant decides who holds that capacity. The two stay
 * separate so this table does not quietly redefine rules that already have tests
 * and a trigger behind them.
 *
 * **Never updated.** Not to revoke it, not to extend it, not to change its
 * scope. Per ADR 0011 §4 that is what makes "what authority did this actor hold
 * on 2 August" a query rather than a belief — reconstructing it must not depend
 * on anybody having refrained from an `UPDATE`.
 *
 * So there is no `revoked_at` column here, and its absence is the design. A
 * revocation is a separate fact (`capacity_grant_revocation`), because setting a
 * column would mean the event still points at the grant while the grant changes
 * underneath it: history rewritten without a single event being touched.
 *
 * Extending or rescoping is not a mutation and not a revocation. It is a new
 * grant, and this shape makes that the only available option by having nowhere
 * to put an edit.
 *
 * Named `capacity_grant` because `grant` is a reserved word in Postgres —
 * measured, not assumed: `CREATE TABLE grant` is a syntax error. Quoting it
 * would work and would put `"grant"` inside every trigger body, where one
 * missing pair of quotes is a syntax error buried in PL/pgSQL.
 */
export const capacityGrant = pgTable(
  "capacity_grant",
  {
    /** Internal key. Never serialised outside the system — ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /** Restrict: an actor holding grants cannot be deleted from under them. */
    actorId: bigint("actor_id", { mode: "number" })
      .notNull()
      .references(() => actor.id, { onDelete: "restrict", onUpdate: "cascade" }),

    /**
     * The organization this capacity is held through, when one is involved.
     *
     * Null for a `system` capacity, which belongs to TrustPass rather than to
     * any party. Required for `own_organization` scope, since a scope that
     * names an organization needs the organization to name.
     */
    organizationId: bigint("organization_id", { mode: "number" }).references(
      () => organization.id,
      { onDelete: "restrict", onUpdate: "cascade" },
    ),

    /**
     * Which capacity. The same set `RECORDING_AUTHORITY` is keyed by, so the
     * two compose instead of drifting — the pairing that already has an
     * integration suite comparing it against the database.
     *
     * `holder` is deliberately not grantable; see the check below.
     */
    capacity: lifecycleActorKind("capacity").notNull(),

    scopeKind: grantScopeKind("scope_kind").notNull(),

    /** The jurisdiction, when the scope is one. */
    scopeCountry: varchar("scope_country", { length: 2 }),

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),

    /** Null means no fixed end. It does not mean permanent; it means unstated. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * Who granted it. A capacity nobody granted is a capacity nobody can be
     * asked about, which is ADR 0009's whole objection to a role column.
     *
     * Null only for the root of the chain — the first grant in a fresh
     * database, which nothing preceded. Every other row names its grantor.
     */
    grantedBy: bigint("granted_by", { mode: "number" }).references(() => actor.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),

    /**
     * What was checked, as an opaque handle into somebody else's system: a
     * registry extract, a warrant number, a signed delegation.
     *
     * Per ADR 0010 §4 it is never rendered as a claim. **A reference is not
     * evidence that was checked**; it is a pointer to something a reader could
     * check, and displaying "verified" because one exists is ADR 0003's failure
     * reached through a new table.
     */
    evidenceReference: varchar("evidence_reference", { length: 200 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "Which grants does this actor hold" runs on the hot path of every
    // authorisation decision, which is every write.
    index("capacity_grant_actor_idx").on(table.actorId),

    index("capacity_grant_organization_idx").on(table.organizationId),

    // ADR 0009 §8: a holder's capacity is granted by nobody and cannot be,
    // because no registry of people who own things exists and inventing a grant
    // would fabricate an authority. It is self-asserted, recorded as
    // self-asserted, and rendered as such. A grantable `holder` would make that
    // honest carve-out silently untrue.
    check("capacity_grant_holder_is_not_granted", sql`${table.capacity} <> 'holder'`),

    // A scope naming a country needs the country, and one that does not must
    // not carry a stray value that a later query might read as meaningful.
    check(
      "capacity_grant_country_scope_names_a_country",
      sql`(${table.scopeKind} = 'country') = (${table.scopeCountry} IS NOT NULL)`,
    ),

    check(
      "capacity_grant_scope_country_iso_alpha2",
      sql`${table.scopeCountry} IS NULL OR ${table.scopeCountry} ~ '^[A-Z]{2}$'`,
    ),

    // A scope over "this organization's products" with no organization is a
    // scope over nothing, which would read as a grant that permits nothing
    // rather than one that is malformed.
    check(
      "capacity_grant_own_organization_scope_has_one",
      sql`${table.scopeKind} <> 'own_organization' OR ${table.organizationId} IS NOT NULL`,
    ),

    check(
      "capacity_grant_expires_after_it_starts",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveFrom}`,
    ),
  ],
);

/**
 * The fact that a grant ended early.
 *
 * A separate table rather than a column, and the separation is the decision.
 * ADR 0011 §4 rejects `capacity_grant.revoked_at` explicitly: setting it is an
 * edit, and an editable grant means the answer to "was this valid then" is
 * whatever the row says now. The event would still point at the grant and the
 * grant would have quietly changed underneath it.
 *
 * One revocation per grant, enforced by a unique index. A grant is not revoked
 * twice; a second attempt is a bug or a race, and either should fail loudly.
 *
 * Revoking does not invalidate what was recorded under the grant. Per ADR 0011
 * §6 a lapsed grant produces no new claims and invalidates none of the old ones,
 * and what a reader sees is a qualifier — *"recorded by an authority whose
 * warrant was later withdrawn"* — never an erasure.
 */
export const capacityGrantRevocation = pgTable(
  "capacity_grant_revocation",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    grantId: bigint("grant_id", { mode: "number" })
      .notNull()
      .references(() => capacityGrant.id, { onDelete: "restrict", onUpdate: "cascade" }),

    /**
     * When the grant stopped applying.
     *
     * Load-bearing, and the reason this is a timestamp rather than a flag: a
     * grant revoked in September **was valid in August**. A query asking what
     * an actor could do in August must compare against this, not against
     * whether a revocation exists.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull(),

    revokedBy: bigint("revoked_by", { mode: "number" })
      .notNull()
      .references(() => actor.id, { onDelete: "restrict", onUpdate: "cascade" }),

    /** Why, in words, until there is a closed set worth enumerating. */
    reason: varchar("reason", { length: 200 }).notNull(),

    /** What backs it, where anything does. Never rendered as a claim. */
    evidenceReference: varchar("evidence_reference", { length: 200 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("capacity_grant_revocation_grant_idx").on(table.grantId),

    check("capacity_grant_revocation_reason_not_blank", sql`length(trim(${table.reason})) >= 2`),
  ],
);

export type CapacityGrant = typeof capacityGrant.$inferSelect;
export type NewCapacityGrant = typeof capacityGrant.$inferInsert;
export type CapacityGrantRevocation = typeof capacityGrantRevocation.$inferSelect;
export type NewCapacityGrantRevocation = typeof capacityGrantRevocation.$inferInsert;
export type GrantScopeKind = (typeof grantScopeKind.enumValues)[number];
