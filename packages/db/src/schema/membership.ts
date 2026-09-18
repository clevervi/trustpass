import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, timestamp } from "drizzle-orm/pg-core";
import { actor } from "./actor.js";
import { organization } from "./organization.js";

/**
 * An actor acting on behalf of an organization, for a period.
 *
 * Per ADR 0011 §2 the period is the point. The case that forces it: an employee
 * authorised to register products leaves. The organization persists, the actor
 * persists, and what must stop is the ability to act for that organization from
 * that date. Nothing already recorded changes at all.
 *
 * Deleting the membership instead would make every event that actor recorded
 * unexplainable — they would reference a relationship the database says never
 * existed, which is `0005_lifecycle_event_append_only`'s objection arriving
 * through a different table.
 *
 * Append-only, like everything else carrying authority here: a membership is
 * ended by writing `ended_at`, which is the one field this table permits
 * changing, and the trigger enforces that narrowness rather than trusting it.
 */
export const membership = pgTable(
  "membership",
  {
    /** Internal key. Never serialised outside the system — ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    /**
     * Restrict, never cascade. An actor with recorded memberships cannot be
     * deleted out from under the events that reference it.
     */
    actorId: bigint("actor_id", { mode: "number" })
      .notNull()
      .references(() => actor.id, { onDelete: "restrict", onUpdate: "cascade" }),

    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organization.id, { onDelete: "restrict", onUpdate: "cascade" }),

    /** When the actor began acting for this organization. */
    beganAt: timestamp("began_at", { withTimezone: true }).notNull(),

    /**
     * When it stopped. Null means it has not.
     *
     * A membership that has ended is not deleted and not hidden: an event
     * recorded in March references a relationship that was real in March, and a
     * reader in September needs to be able to see that it was.
     */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "Which organizations does this actor act for" is the lookup behind every
    // authorisation decision, so it is on the hot path of every write.
    index("membership_actor_idx").on(table.actorId),

    index("membership_organization_idx").on(table.organizationId),

    // A membership that ended before it began describes nothing. Cheap to
    // check, and the kind of inversion a timezone mistake produces silently.
    check(
      "membership_ends_after_it_begins",
      sql`${table.endedAt} IS NULL OR ${table.endedAt} > ${table.beganAt}`,
    ),
  ],
);

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;
