import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Whether a party has been checked against a national registry.
 *
 * Declared here because per ADR 0012 `organization` is the canonical identity
 * and verification is a property of the party. The database name stays
 * `issuer_verification_status`: renaming a Postgres enum is a migration with no
 * benefit, and the old name is referenced by two tables until `issuer` goes.
 */
export const verificationStatus = pgEnum("issuer_verification_status", [
  /** Registered, nothing checked. The default, and the honest one. */
  "unverified",
  /** Documentation submitted, review in progress. */
  "pending",
  /** Legal existence confirmed against an authoritative source. */
  "verified",
  /** Previously trusted, trust withdrawn. Never silently returns to verified. */
  "suspended",
]);

/**
 * A party with a legal identity.
 *
 * Per ADR 0009, `issuer` is one role an organization plays. A repair network, an
 * insurer, a regulator and a police force are the same kind of thing playing
 * different ones, and the schema currently cannot name any of them: an event
 * whose actor is an authority is *required* to have `issuer_id IS NULL` by
 * `lifecycle_event_issuer_matches_actor`, so a passport can report a theft and
 * structurally cannot say who reported it.
 *
 * **It carries no capacity.** Not `type = 'manufacturer'`, which ADR 0011 §1
 * rejects: a maker that also runs a service centre has one type and two jobs,
 * and the day it gains a third the column becomes an array and the scoping is
 * gone. What an organization may do belongs on a `capacity_grant`, where it can
 * carry who said so, over what, and until when.
 *
 * Keyed by registration number per ADR 0006, for the reason that ADR gives:
 * a legal name is not an identifier. Two companies share one, one company
 * changes its own, and a rename must not orphan everything it signed.
 */
export const organization = pgTable(
  "organization",
  {
    /** Internal key. Never serialised outside the system — ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /**
     * The name the party trades under.
     *
     * Kept distinct from `legalName` deliberately. They look redundant and are
     * not: a company sells as one name and signs as another, and a migration
     * that collapsed them would destroy information to tidy a schema. Whether
     * they should eventually be one field is a question for when somebody has a
     * reason, not for an identity migration.
     */
    companyName: varchar("company_name", { length: 200 }).notNull(),

    legalName: varchar("legal_name", { length: 200 }).notNull(),

    /**
     * The identifier a national registry assigns. Public data: a buyer can
     * check it against that registry without taking TrustPass's word, which is
     * the whole point of ADR 0003.
     */
    registrationNumber: varchar("registration_number", { length: 50 }).notNull(),

    /** ISO 3166-1 alpha-2. A registration number means nothing without it. */
    country: varchar("country", { length: 2 }).notNull(),

    /**
     * Whether TrustPass has checked this party against a national registry.
     *
     * Per ADR 0012 this is a **claim**: it answers "is this company checked,
     * now", which is what a buyer deciding today needs and what the passport
     * renders. Changes to it are **events**, and those do not exist yet.
     *
     * So this column is currently the only record of the fact, which is ADR
     * 0011 §4's rejected shape — "was this party verified in March" has no
     * answer. The migration that brings it here carries the **current value**
     * and deliberately invents no history: a timeline reconstructed from a
     * mutable column would be a plausible fiction, which is the one thing this
     * project refuses to publish. The events come next, and the history starts
     * when they do.
     */
    verificationStatus: verificationStatus("verification_status").notNull().default("unverified"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One registry, one number, one organization. Registration numbers are
    // unique within a country and not across them, which is why the country is
    // part of the key rather than a detail beside it.
    uniqueIndex("organization_country_registration_idx").on(
      table.country,
      table.registrationNumber,
    ),

    check("organization_country_iso_alpha2", sql`${table.country} ~ '^[A-Z]{2}$'`),

    check(
      "organization_registration_number_format",
      sql`${table.registrationNumber} ~ '^[A-Z0-9-]{4,50}$'`,
    ),

    check("organization_legal_name_not_blank", sql`length(trim(${table.legalName})) >= 2`),

    check("organization_company_name_not_blank", sql`length(trim(${table.companyName})) >= 2`),
  ],
);

export type Organization = typeof organization.$inferSelect;
export type NewOrganization = typeof organization.$inferInsert;

export type VerificationStatus = (typeof verificationStatus.enumValues)[number];
