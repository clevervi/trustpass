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
 * What TrustPass has actually checked about an issuer.
 *
 * Not a boolean, because "we hold their legal registration", "we hold nothing"
 * and "we checked and later revoked it" are different facts with different
 * consequences for what a passport is allowed to display. Per ADR 0003 the
 * issuer is the root of the trust model: every claim a passport shows inherits
 * its credibility from this column.
 */
export const issuerVerificationStatus = pgEnum("issuer_verification_status", [
  /** Registered, nothing checked. The default, and the honest one. */
  "unverified",
  /** Documentation submitted, review in progress. */
  "pending",
  /** Legal existence confirmed against an authoritative source. */
  "verified",
  /** Previously trusted, trust withdrawn. Never silently returns to verified. */
  "suspended",
]);

export const issuer = pgTable(
  "issuer",
  {
    /** Internal key. Never serialised outside the system — see ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /** Trading name, the one a buyer would recognise on a passport. */
    companyName: varchar("company_name", { length: 200 }).notNull(),

    /** Registered name, the one a company registry would return. */
    legalName: varchar("legal_name", { length: 200 }).notNull(),

    /** ISO 3166-1 alpha-2. */
    country: varchar("country", { length: 2 }).notNull(),

    verificationStatus: issuerVerificationStatus("verification_status")
      .notNull()
      .default("unverified"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Company registries issue one legal name per jurisdiction, so a collision
    // here is a duplicate record rather than two real companies. Duplicate
    // issuers fragment a product's trust history across two identities, which
    // is precisely the failure the passport exists to prevent.
    //
    // Indexed on the lower-cased name: a plain unique index is case sensitive,
    // so "ANDES TECH SAS" and "Andes Tech SAS" would both be accepted and the
    // constraint would prevent nothing that anyone actually types.
    //
    // Known limit: whitespace and punctuation variants still slip through
    // ("ANDES  TECH" with two spaces). Catching those belongs to the issuer
    // verification workflow, which compares against a registry, not to an index.
    uniqueIndex("issuer_legal_name_country_idx").on(sql`lower(${table.legalName})`, table.country),

    // Length alone would accept "co", "C1" or "  ". The registered format is
    // two uppercase letters and nothing else.
    check("issuer_country_iso_alpha2", sql`${table.country} ~ '^[A-Z]{2}$'`),
  ],
);

export type Issuer = typeof issuer.$inferSelect;
export type NewIssuer = typeof issuer.$inferInsert;
export type IssuerVerificationStatus = (typeof issuerVerificationStatus.enumValues)[number];
