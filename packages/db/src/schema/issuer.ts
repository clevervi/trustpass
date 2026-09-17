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

    /**
     * National business identifier: NIT in Colombia, RFC in Mexico, EIN in the
     * United States, VAT number across the EU.
     *
     * This is the issuer's identity, not its name — see ADR 0006. Names are
     * only unique where naming law makes them so, and they change when a
     * company rebrands. A key that changes is not a key.
     */
    registrationNumber: varchar("registration_number", { length: 50 }).notNull(),

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
    // The uniqueness guarantee comes from the authority that issues the number,
    // rather than from an assumption about naming law. Colombia enforces
    // national name uniqueness through the RUES; the United States registers
    // names per state, so two legitimate companies may both be "Acme LLC".
    uniqueIndex("issuer_country_registration_number_idx").on(
      table.country,
      table.registrationNumber,
    ),

    // Looking an issuer up by name stays a normal thing to do; it is simply not
    // how identity is established. Lower-cased so the lookup is case tolerant.
    index("issuer_legal_name_idx").on(sql`lower(${table.legalName})`),

    // Shaped like a registration number, without teaching the schema the rules
    // of every tax authority on earth. Accepts 900123456-7, ABC123456T1A and
    // 12-3456789. Whether the number is real is what verification_status exists
    // to answer.
    check(
      "issuer_registration_number_format",
      sql`${table.registrationNumber} ~ '^[A-Z0-9-]{4,50}$'`,
    ),

    // Length alone would accept "co", "C1" or "  ". The registered format is
    // two uppercase letters and nothing else.
    check("issuer_country_iso_alpha2", sql`${table.country} ~ '^[A-Z]{2}$'`),
  ],
);

export type Issuer = typeof issuer.$inferSelect;
export type NewIssuer = typeof issuer.$inferInsert;
export type IssuerVerificationStatus = (typeof issuerVerificationStatus.enumValues)[number];
