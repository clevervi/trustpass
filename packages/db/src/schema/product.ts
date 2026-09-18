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
import { organization } from "./organization.js";

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

/**
 * Where a product's TrustPass record started.
 *
 * Per ADR 0007 as amended this is the origin of the **record**, not of the
 * product: a graphics card has had an identity since it was made, and what
 * begins here is this system's knowledge of it.
 *
 * Per ADR 0008 it is a property of the record, set once, and is **not** the
 * actor capacity of any one event. A `supply_chain` record can later carry an
 * event whose actor is an authority, and nothing about that is contradictory.
 *
 * None of these values says anything about whether the object is genuine.
 * `manufacturer` means a maker started the record; ADR 0003 is why that is not
 * the same as the object being what the record describes.
 */
export const productOrigin = pgEnum("product_origin", [
  /** The maker started the record. */
  "manufacturer",
  /** A distributor or retailer did, somewhere between factory and buyer. */
  "supply_chain",
  /** Whoever had the object did, at some point after it was made. */
  "holder",
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
    issuerId: bigint("issuer_id", { mode: "number" }).references(() => issuer.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),

    /**
     * Which party registered this product.
     *
     * Per ADR 0012 `organization` is the canonical identity of a party and
     * `issuer` is a role it plays. This column exists beside `issuerId` during
     * the move, which is the additive path `CONTRIBUTING.md` requires: add a
     * column, backfill it, stop using the old one, in separate migrations. The
     * destructive half gets its own pull request so the diff that drops data is
     * the whole diff.
     *
     * Nullable for the same reason `issuerId` is: a holder-enrolled record has
     * no party behind it.
     */
    organizationId: bigint("organization_id", { mode: "number" }).references(
      () => organization.id,
      {
        onDelete: "restrict",
        onUpdate: "cascade",
      },
    ),

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

    /**
     * Where this record started. See `productOrigin`.
     *
     * Defaulted to `supply_chain` rather than `manufacturer`, and the default is
     * a claim like any other: every product registered before this column
     * existed came through `POST /products` from a business whose relationship
     * to the factory nobody recorded. Calling those `manufacturer` would assert
     * something no row supports.
     */
    origin: productOrigin("origin").notNull().default("supply_chain"),

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

    // The same lookup, against the identity that will outlive issuer_id.
    index("product_organization_id_idx").on(table.organizationId),

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
    //
    // A holder-enrolled product has no issuer, and Postgres treats NULL as
    // distinct from NULL -- so every such row falls outside this index. Measured
    // rather than assumed: three rows with the same serial and a null issuer all
    // inserted cleanly against it. Their rule is the separate index below.
    uniqueIndex("product_live_organization_serial_idx")
      .on(table.organizationId, sql`lower(${table.serial})`)
      .where(sql`${table.status} <> 'retired'`),

    // One live holder record per serial.
    //
    // A separate index rather than NULLS NOT DISTINCT on the one above, and not
    // only because Drizzle cannot express that: the policy for a record with no
    // issuer is a different policy, and it should be readable as one instead of
    // hiding in how Postgres compares nulls.
    //
    // Without it anyone could enrol a device, have something unwelcome recorded
    // against it, enrol it again and show the clean passport -- which breaks the
    // one rule the serial indexes exist for. A holder has no issuer namespace to
    // scope uniqueness to, so the scope is every holder record.
    //
    // It costs a real false positive: two genuinely different products with
    // colliding serials from different makers, both holder-enrolled, and the
    // second is refused. That is the cheaper failure of the two, and #49 owns
    // resolving a collision properly.
    uniqueIndex("product_live_holder_serial_idx")
      .on(sql`lower(${table.serial})`)
      .where(sql`${table.organizationId} IS NULL AND ${table.status} <> 'retired'`),

    // A record has an issuer or it has a holder origin. Never both, never
    // neither: an issuer-registered product with no issuer is an orphan, and a
    // holder-enrolled one with an issuer is a person claiming a company's
    // standing.
    // Renamed with the identity it now names. The rule is unchanged: a record
    // has a party behind it or it has a holder origin, never both and never
    // neither — an organization-registered product with no organization is an
    // orphan, and a holder-enrolled one with a party is a person claiming a
    // company's standing.
    check(
      "product_holder_has_no_organization",
      sql`(${table.origin} = 'holder') = (${table.organizationId} IS NULL)`,
    ),

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
export type ProductOrigin = (typeof productOrigin.enumValues)[number];
