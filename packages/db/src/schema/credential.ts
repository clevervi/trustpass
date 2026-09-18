import { sql } from "drizzle-orm";
import { bigint, check, index, pgEnum, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import { actor } from "./actor.js";

/**
 * How a credential is presented.
 *
 * Per ADR 0011 §5 the mechanism is interchangeable and the historical identity
 * is not, so this enum exists to record which kind was used rather than to
 * decide which kinds there should be. Postgres adds an enum value cheaply and
 * cannot remove one, so it covers what could plausibly be built first and
 * nothing speculative.
 */
export const credentialKind = pgEnum("credential_kind", [
  /** A key presented by a machine caller. */
  "api_key",
  /** A public key whose private half never leaves the holder. */
  "public_key",
  /** An assertion from an external identity provider. */
  "federated",
]);

/**
 * What an actor presents to prove it is that actor.
 *
 * **It grants nothing.** Per ADR 0011 §5 authentication resolves a credential
 * to an actor, and authorisation is a separate lookup of that actor's grants
 * valid at the time of the request. A valid credential belonging to an actor
 * with no grant may do nothing at all, which is the correct and frequently
 * surprising answer.
 *
 * The chain is never `credential → manufacturer`:
 *
 * ```
 * Credential → Actor → Organization → Grant → Capacity → Action
 * ```
 *
 * No secret is stored here. What proves possession — a hash, a public key, an
 * issuer and subject — is deliberately out of this phase, because the mechanism
 * is the interchangeable part and `TP-152` is about the part that is not. What
 * this table holds is the fact that a credential existed, for whom, and when it
 * was valid, which is what a historical event needs to remain readable.
 */
export const credential = pgTable(
  "credential",
  {
    /** Internal key. Never serialised outside the system — ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /** Restrict: an actor with credentials cannot be deleted from under them. */
    actorId: bigint("actor_id", { mode: "number" })
      .notNull()
      .references(() => actor.id, { onDelete: "restrict", onUpdate: "cascade" }),

    kind: credentialKind("kind").notNull(),

    /**
     * A name for this credential, so a holder with several can tell them apart
     * when revoking one. Never an identifier.
     */
    label: varchar("label", { length: 120 }).notNull(),

    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),

    /** Null means no fixed expiry. Rotation is still expected. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /**
     * When it was withdrawn, and null until it is.
     *
     * Revoking a credential says nothing about the actor's grants and nothing
     * about what was recorded under it. Per ADR 0011 §7, actions taken before
     * anybody knew a credential was compromised stand as recorded: they were
     * accepted, and that is a fact about what the system believed. Voiding them
     * retroactively would delete legitimate records — most actions in that
     * window were the real actor's — and hand anyone able to claim a compromise
     * a way to erase their own history.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("credential_actor_idx").on(table.actorId),

    check(
      "credential_expires_after_issue",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.issuedAt}`,
    ),

    check(
      "credential_revoked_after_issue",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt}`,
    ),

    check("credential_label_not_blank", sql`length(trim(${table.label})) >= 2`),
  ],
);

export type Credential = typeof credential.$inferSelect;
export type NewCredential = typeof credential.$inferInsert;
export type CredentialKind = (typeof credentialKind.enumValues)[number];
