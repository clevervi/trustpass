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
import type { TrustPassId } from "../identity/trustpass-id.js";
import { issuer } from "./issuer.js";

/**
 * What kind of thing this is.
 *
 * A closed set rather than free text: the category drives what a passport
 * shows and, later, what counts as an anomalous repair rate. Free text
 * fragments the same product across "GPU", "gpu" and "Graphics card", and that
 * fragmentation is permanent.
 *
 * Postgres can add an enum value cheaply and cannot remove one, so the initial
 * set is deliberately narrow: the electronics this first market actually
 * resells. `other` exists because refusing to register a real product is worse
 * than an imprecise label.
 */
export const productCategory = pgEnum("product_category", [
  "gpu",
  "cpu",
  "motherboard",
  "laptop",
  "desktop",
  "smartphone",
  "tablet",
  "monitor",
  "camera",
  "console",
  "storage",
  "peripheral",
  "other",
]);

/**
 * Where the product is in its own lifecycle.
 *
 * This is the product's current state, singular and mutable. It is not its
 * history — lifecycle events are an append-only record and arrive in TP-050.
 * Conflating the two gets expensive later.
 *
 * Which transitions are legal is TP-025. This declares the states only.
 */
export const productStatus = pgEnum("product_status", [
  /** A row exists. Nothing is claimed by it. The honest default. */
  "draft",
  /**
   * A TrustPass record exists. It does not say who vouches for it — a
   * manufacturer and a person enrolling their own device both land here, and
   * which it was is carried by origin and by the record's first event.
   */
  "registered",
  /** Ownership has been established. A consequence, never a label anyone sets. */
  "active",
  /** Something is wrong: a fraud flag, a theft report, a disputed claim. */
  "suspended",
  /** End of life. Terminal. */
  "retired",
]);

export const product = pgTable(
  "product",
  {
    /** Internal key. Never serialised outside the system — see ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /**
     * The public identifier, printed on the label and resolved by the passport.
     *
     * Typed as `TrustPassId` so an unvalidated string cannot be written here by
     * accident. Sized well past the current 31 characters because ADR 0004
     * versions the format, and a `TP2-` format that needs more room should not
     * also need a migration.
     */
    trustpassId: varchar("trustpass_id", { length: 64 }).$type<TrustPassId>().notNull(),

    /**
     * Who issued this product. Restrict rather than cascade: deleting an issuer
     * with products would erase the provenance of everything it signed, which
     * is the one thing a passport exists to preserve. Issuers are suspended,
     * not deleted.
     */
    issuerId: bigint("issuer_id", { mode: "number" })
      .notNull()
      .references(() => issuer.id, { onDelete: "restrict", onUpdate: "cascade" }),

    brand: varchar("brand", { length: 120 }).notNull(),

    model: varchar("model", { length: 120 }).notNull(),

    /**
     * The manufacturer's serial, stored whole.
     *
     * Storage and display are separate concerns. A full serial shown publicly
     * lets a third party impersonate the product elsewhere or claim against its
     * warranty, so the passport masks it (TP-031). Masking at write time would
     * destroy the value the system needs for verification.
     */
    serial: varchar("serial", { length: 120 }).notNull(),

    category: productCategory("category").notNull(),

    status: productStatus("status").notNull().default("draft"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One identifier, one product. This is the guarantee the superseded
    // "TrustPass ID is the primary key" criterion was protecting; a unique
    // index enforces it without making a random value the clustering key.
    uniqueIndex("product_trustpass_id_idx").on(table.trustpassId),

    // "Everything this issuer registered" is the query behind an issuer
    // dashboard and behind most fraud signals.
    index("product_issuer_id_idx").on(table.issuerId),

    // Looking a product up by serial is how a support conversation starts.
    // Lower-cased because serials get typed by hand off a sticker.
    index("product_serial_idx").on(sql`lower(${table.serial})`),

    // The rule that makes a passport mean anything: one physical product, one
    // live identity. If a serial could hold two, a seller would show whichever
    // history looked better and the passport would prove nothing.
    //
    // It lives here rather than in application code because an application
    // check reads, decides, then writes, and two concurrent retries both pass
    // the read before either writes. Under a retry storm that is not a rare
    // race, it is the expected behaviour.
    //
    // Lower-cased for the same reason as the lookup index. A plain unique index
    // is case sensitive, so "M1LMCS004896" and "m1lmcs004896" would both be
    // accepted and the constraint would stop nothing anyone actually types.
    // The issuer table had exactly this defect before it was caught.
    //
    // "Active" means every status except retired. A draft, registered, active
    // or suspended product still holds a live identity and must block a second
    // one. Retirement releases the serial, because a warranty replacement unit
    // legitimately carries the serial of the unit it replaced, and a retired
    // product poisoning its serial forever would make that impossible.
    //
    // Scoped to one issuer on purpose. Two issuers holding units with colliding
    // serials is legitimate -- serials are only unique within a manufacturer's
    // own numbering. The same serial across different issuers is a fraud signal
    // to weigh, not a constraint to enforce (TP-111).
    uniqueIndex("product_live_issuer_serial_idx")
      .on(table.issuerId, sql`lower(${table.serial})`)
      .where(sql`${table.status} <> 'retired'`),

    // Shape only. The application parser in identity/trustpass-id.ts is
    // authoritative, including the check symbol; this catches a raw UUID, an
    // empty string or a truncated value reaching the column by another path.
    // Deliberately loose about what follows "TP" so a future format version is
    // not locked out by a constraint written today.
    check("product_trustpass_id_shape", sql`${table.trustpassId} ~ '^TP[0-9]'`),

    // A serial of one character is a placeholder someone meant to replace.
    check("product_serial_not_blank", sql`length(trim(${table.serial})) >= 2`),
  ],
);

export type Product = typeof product.$inferSelect;
export type NewProduct = typeof product.$inferInsert;
export type ProductCategory = (typeof productCategory.enumValues)[number];
export type ProductStatus = (typeof productStatus.enumValues)[number];
