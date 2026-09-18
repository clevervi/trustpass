import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  customType,
  index,
  pgEnum,
  pgTable,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { issuer } from "./issuer.js";
import { product, productStatus } from "./product.js";

/**
 * Postgres's 64-bit transaction identifier.
 *
 * Declared here because Drizzle has no built-in for it. Read as a string: it is
 * 64-bit and a JavaScript number cannot hold the whole range, and nothing in
 * this codebase does arithmetic on it — the only operation is equality, and the
 * database performs that.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "xid8";
  },
});

/**
 * What happened to a product.
 *
 * Per ADR 0008 an event and a claim are different statements. This table holds
 * only events: things that occurred, in the past, which do not change. A claim
 * about what is currently true lives elsewhere and is revisable.
 *
 * Append-only, and enforced as such by a trigger rather than by convention. A
 * mistake is corrected by recording a correcting event, never by editing the
 * original — the history is the product, and a history that can be rewritten
 * proves nothing.
 *
 * **Transition events are written in the same order as the transitions they
 * describe.** The provenance trigger reads a transaction's events in `id` order
 * — insertion order — and requires them to form an unbroken path ending where
 * the product now stands. Writing the second move's event before the first
 * move's therefore produces a chain that does not match the path, and the
 * transaction is refused.
 *
 * That refusal is wanted: an event written before its cause records nothing.
 * It is written down here because until it was, it was a property of an
 * identity column rather than a rule anybody had decided, and the next person
 * to change the ordering would have had no way to know they were changing what
 * the history means.
 */

/**
 * What kind of thing happened.
 *
 * Closed set. Postgres adds an enum value cheaply and cannot remove one, so
 * this covers what the system can actually record today and nothing
 * speculative. Warranty, ownership and repair events arrive with the milestones
 * that can produce them.
 */
export const lifecycleEventType = pgEnum("lifecycle_event_type", [
  /**
   * The TrustPass record began here.
   *
   * Per ADR 0007 as amended, this does not mean the product's identity began —
   * the object is older than the record. It marks where TrustPass's knowledge
   * starts, and therefore where the unknown period before it ends.
   */
  "record_enrolled",
  /** The issuer committed to the record: draft became registered. */
  "product_registered",
  /** Something was reported about this specific unit. */
  "product_suspended",
  /** A suspension was cleared. Deliberately not the same as being activated. */
  "product_reinstated",
  /**
   * Ownership was established and the product entered an owner's hands.
   *
   * The status machine has always allowed `registered -> active`, and until now
   * no event type could record it — so once provenance became a database
   * guarantee, a legal transition became impossible to perform. Two rules that
   * disagreed, found by the transition suite rather than by reading either.
   *
   * Only the system may record it. Per ADR 0008 `active` is a consequence of
   * ownership being established, never a label an actor sets, and ownership
   * arrives in v0.5.0.
   */
  "product_activated",
  /** End of life. The serial is released. */
  "product_retired",
  /**
   * A previously recorded event was wrong.
   *
   * The correction mechanism. The original row stays exactly as written,
   * because what was recorded at the time is itself a fact.
   */
  "record_corrected",
]);

/**
 * Why it happened.
 *
 * A closed set rather than a description, for the reason ADR 0008 gives: free
 * text cannot be queried, cannot be translated, and invites a sentence where a
 * fact belongs. The first time someone writes "suspended pending investigation
 * into possible theft" the system has a paragraph where it needed
 * `theft_report`.
 *
 * These are reasons, not states. `suspended` remains one product status; what
 * distinguishes a theft report from a warranty dispute lives here, in the
 * history, which is the one place that does not get overwritten.
 */
export const lifecycleEventReason = pgEnum("lifecycle_event_reason", [
  "theft_report",
  "fraud_flag",
  "counterfeit_report",
  "ownership_dispute",
  "warranty_dispute",
  "investigation_closed",
  "dispute_resolved",
  "issuer_request",
  "holder_request",
  "warranty_replacement",
  "end_of_life",
  /** Used by `record_corrected`. */
  "recording_error",
]);

/**
 * In what capacity the actor acted.
 *
 * Not who they are. Identifying a person requires authentication, which is
 * `TP-141`; recording the capacity is what the system can honestly assert
 * today. An event whose actor is unknown is worse than one that says the
 * capacity and stops there.
 */
export const lifecycleActorKind = pgEnum("lifecycle_actor_kind", [
  /** A registered business. `issuer_id` identifies which. */
  "issuer",
  /** Whoever had the object. Per ADR 0007 this asserts very little. */
  "holder",
  /** A police report, a customs seizure, a regulator. */
  "authority",
  /** TrustPass itself — a scheduled expiry, a migration, an automated check. */
  "system",
]);

export const lifecycleEvent = pgTable(
  "lifecycle_event",
  {
    /** Internal key. Never serialised outside the system — ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /**
     * Restrict, never cascade. Deleting a product would silently delete its
     * history, and the history is the thing a passport exists to preserve.
     * Products are retired, not deleted.
     */
    productId: bigint("product_id", { mode: "number" })
      .notNull()
      .references(() => product.id, { onDelete: "restrict", onUpdate: "cascade" }),

    type: lifecycleEventType("type").notNull(),

    actorKind: lifecycleActorKind("actor_kind").notNull(),

    /**
     * Which issuer acted, when one did.
     *
     * Nullable because a holder, an authority or the system is not an issuer.
     * Restrict for the same reason as the product reference: an issuer with
     * recorded events cannot be deleted out from under them.
     */
    issuerId: bigint("issuer_id", { mode: "number" }).references(() => issuer.id, {
      onDelete: "restrict",
      onUpdate: "cascade",
    }),

    /**
     * When this happened in the world.
     *
     * Separate from `recordedAt` on purpose. A repair done in March and
     * recorded in September is two dates, and storing one forces a choice
     * between lying about when it happened and lying about when it became
     * known. The distance between them is itself information: a sale recorded
     * two years late is a weaker record than one recorded the same day.
     */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),

    /**
     * When TrustPass learned of it.
     *
     * Written by the database, which the default alone did not achieve. A
     * default is what happens when nobody supplies a value, and any writer may
     * supply one — while the provenance triggers decide what "this transaction"
     * means by reading precisely this column. An event planted in an earlier
     * transaction with `recorded_at` set ten years ahead let a later status
     * change commit with nothing recorded to explain it, which is the one thing
     * 0010 exists to prevent.
     *
     * A BEFORE INSERT trigger now overwrites it with `now()` (0015), for every
     * writer including the owner. Overwritten rather than refused because the
     * column default fills the value in before any BEFORE trigger runs, so a
     * caller who passed `now()` is indistinguishable from one who passed
     * nothing.
     */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Which write produced this row — the top-level transaction that inserted
     * it. Never read outside the database.
     *
     * Separate from `recordedAt`, and the separation is the point. "When did
     * TrustPass learn of this" is a fact the passport publishes; "which write
     * produced this" is an integrity question nobody outside ever asks. The
     * provenance triggers were using the first column to answer the second, and
     * it answered badly: `recorded_at >= transaction_timestamp()` is a time
     * **range**, so any event another transaction committed while this one was
     * open fell inside it and could account for a move this transaction never
     * explained. Reproduced with two connections; see 0016.
     *
     * Equality against `pg_current_xact_id()` has no range to fall into.
     *
     * Defaulted to `'0'`, which Postgres reserves and never hands out, so the
     * default **fails closed**: if the trigger that sets this were dropped, new
     * rows would match no transaction and every provenance check would refuse
     * loudly. `recordedAt`'s `defaultNow()` fails open, which is why it needed a
     * trigger to be trustworthy at all.
     */
    recordedInXact: xid8("recorded_in_xact").notNull().default(sql`'0'`),

    /** Why. Nullable: `product_registered` needs no reason beyond itself. */
    reason: lifecycleEventReason("reason"),

    /**
     * What backs this, where anything does.
     *
     * A police report number, a case reference, an invoice identifier. Free
     * text on purpose — unlike `reason`, this is an opaque handle into someone
     * else's system and nothing here can enumerate it. It is never rendered as
     * a claim; a reference is not evidence that was checked.
     */
    sourceReference: varchar("source_reference", { length: 200 }),

    /**
     * What the product's status moved from and to.
     *
     * Both nullable because not every event is a transition — a correction
     * changes no status, and an enrolment has no previous state to leave.
     */
    previousState: productStatus("previous_state"),

    resultingState: productStatus("resulting_state"),

    /**
     * Which event this corrects. Only ever set on `record_corrected`.
     *
     * A self-reference rather than an edit: the original row stays exactly as
     * written, because what was recorded at the time is itself a fact about
     * what the system believed. Restrict, so a corrected event cannot be
     * removed and leave its correction pointing at nothing.
     */
    correctsEventId: bigint("corrects_event_id", { mode: "number" }).references(
      (): AnyPgColumn => lifecycleEvent.id,
      { onDelete: "restrict", onUpdate: "cascade" },
    ),
  },
  (table) => [
    // "Everything that happened to this product, newest first" is the passport's
    // history section and every audit query.
    index("lifecycle_event_product_idx").on(table.productId, table.occurredAt.desc()),

    // "Everything this issuer recorded" is the issuer dashboard and the first
    // place a fraud pattern shows up.
    index("lifecycle_event_issuer_idx").on(table.issuerId),

    // An event is past-tense by ADR 0008. Something recorded as having happened
    // after it was recorded is not an event, it is a schedule, and a schedule
    // in the history table would let a passport display a future as a fact.
    check("lifecycle_event_not_in_future", sql`${table.occurredAt} <= ${table.recordedAt}`),

    // An issuer reference without the issuer capacity, or the capacity without
    // the reference, is a half-recorded actor. Either the issuer is named or
    // the event was not theirs.
    check(
      "lifecycle_event_issuer_matches_actor",
      sql`(${table.actorKind} = 'issuer') = (${table.issuerId} IS NOT NULL)`,
    ),

    // A correction points at what it corrects; nothing else may.
    check(
      "lifecycle_event_correction_targets",
      sql`(${table.type} = 'record_corrected') = (${table.correctsEventId} IS NOT NULL)`,
    ),

    // A transition names both ends or neither. One end alone cannot be read:
    // "it became suspended" without a source hides whether that was legal.
    check(
      "lifecycle_event_transition_complete",
      sql`(${table.previousState} IS NULL) = (${table.resultingState} IS NULL)`,
    ),
  ],
);

export type LifecycleEvent = typeof lifecycleEvent.$inferSelect;
/**
 * `recordedAt` and `recordedInXact` are omitted deliberately: the database
 * overwrites both on insert (0015, 0016), so a value supplied here is
 * discarded. Refusing them at the type makes that visible when the code is
 * written, rather than when somebody reads the row back and finds values they
 * did not write.
 */
export type NewLifecycleEvent = Omit<
  typeof lifecycleEvent.$inferInsert,
  "recordedAt" | "recordedInXact"
>;
export type LifecycleEventType = (typeof lifecycleEventType.enumValues)[number];
export type LifecycleEventReason = (typeof lifecycleEventReason.enumValues)[number];
export type LifecycleActorKind = (typeof lifecycleActorKind.enumValues)[number];
