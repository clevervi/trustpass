import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { actor } from "./actor.js";

/**
 * Raw bytes. Declared here because Drizzle has no built-in for `bytea`.
 *
 * A digest is bytes, not text, and storing it as hex would make a
 * case-insensitive comparison possible by accident — which for a value compared
 * with `timingSafeEqual` is the wrong kind of forgiving.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
     * The half of a token that is not a secret — ADR 0014 §3.
     *
     * Stored in clear on purpose: it identifies a credential and proves
     * nothing. It exists so verification is an indexed lookup rather than a
     * scan over every digest, which would otherwise make the digest itself the
     * lookup key — a value whose leak through a log line is more interesting
     * than it needs to be.
     *
     * Null for the kinds that have no bearer secret. The checks below say which.
     */
    handle: varchar("handle", { length: 11 }),

    /**
     * SHA-256 of the secret, and the only representation of one that exists
     * anywhere — ADR 0014 §3.
     *
     * Not bcrypt or argon2, and not because they are worse. A slow, salted,
     * memory-hard function protects a user-chosen password, whose search space
     * is small enough to walk. This is 256 random bits from `crypto.randomBytes`;
     * there is no space to walk, and a slow hash on every request buys latency
     * and nothing else.
     *
     * Computed in Node and never by `pgcrypto`: hashing in SQL puts the raw
     * secret in a query string, where `log_statement` can catch it.
     */
    secretDigest: bytea("secret_digest"),

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

    /**
     * Not because a 64-bit collision is likely — because both alternatives are
     * silent. A collision that overwrites loses a credential; one that returns
     * the wrong row authenticates the wrong actor. Issuance retries with a
     * fresh handle and fails loudly rather than reusing one.
     */
    unique("credential_handle_key").on(table.handle),

    check(
      "credential_expires_after_issue",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.issuedAt}`,
    ),

    check(
      "credential_revoked_after_issue",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt}`,
    ),

    check("credential_label_not_blank", sql`length(trim(${table.label})) >= 2`),

    /**
     * A handle implies `api_key`, and deliberately not the other way round.
     *
     * Only `api_key` presents a bearer secret. A public key and a federated
     * assertion prove possession differently, and giving them these columns
     * because they happen to exist would record a secret that is not one.
     *
     * The converse — every `api_key` has a handle — was written first and
     * refused by Postgres against 180 existing rows, which is the useful part.
     * Those credentials were created while this table stored no secret at all;
     * demanding one retroactively means either inventing a digest or writing
     * `revoked_at` on rows nobody revoked, and per ADR 0011 §7 a revocation is
     * a fact that it happened, not a convenient way to mark a row unusable.
     *
     * Leaving them legal is safe for a structural reason rather than a hopeful
     * one: verification looks a credential up **by handle**, so a row with none
     * is unreachable by every code path that authenticates. The failure mode of
     * a secretless `api_key` is that it never authenticates, which is the
     * direction a failure is allowed to go.
     */
    check(
      "credential_secret_belongs_to_api_key",
      sql`${table.handle} IS NULL OR ${table.kind} = 'api_key'`,
    ),

    /** Half a credential verifies nothing and would be found only on use. */
    check(
      "credential_secret_is_whole",
      sql`(${table.handle} IS NULL) = (${table.secretDigest} IS NULL)`,
    ),

    /**
     * SHA-256 is 32 bytes. A shorter value reaching `timingSafeEqual` throws,
     * and a thrown error inside a verifier is a distinguishable answer.
     */
    check(
      "credential_digest_is_sha256",
      sql`${table.secretDigest} IS NULL OR octet_length(${table.secretDigest}) = 32`,
    ),

    /**
     * `varchar(11)` gives the ceiling; this gives the floor. A truncated handle
     * would store cleanly and then match nothing, which is a failure that only
     * appears when somebody tries to authenticate.
     */
    check(
      "credential_handle_is_whole",
      sql`${table.handle} IS NULL OR length(${table.handle}) = 11`,
    ),
  ],
);

export type Credential = typeof credential.$inferSelect;
export type NewCredential = typeof credential.$inferInsert;
export type CredentialKind = (typeof credentialKind.enumValues)[number];
