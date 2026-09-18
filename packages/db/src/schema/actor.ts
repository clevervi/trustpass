import { sql } from "drizzle-orm";
import { bigint, check, pgEnum, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * What kind of thing an actor is.
 *
 * Per ADR 0011 an actor is anything that performs a recorded action, and it is
 * deliberately not a synonym for a human. A background job is an actor. A
 * partner's integration is an actor. Making `person` the root would force every
 * machine caller to hang off a fabricated person and every query about who did
 * something to know which rows are not people.
 */
export const actorKind = pgEnum("actor_kind", [
  /** A human being, acting for themselves or for an organization. */
  "person",
  /** An integration belonging to a party outside TrustPass. */
  "service",
  /** TrustPass itself: a scheduled job, a migration, an automated check. */
  "system",
]);

/**
 * The thing that acts.
 *
 * Permanent. An actor is never deleted, because events reference the actor that
 * recorded them and an event pointing at nothing is worse than one naming a
 * party whose access ended — ADR 0008's argument, applied to identity.
 *
 * It holds no capacity. What an actor may assert lives on a grant
 * (`capacity_grant`), which carries who granted it, over what, and until when.
 * A column here would be ADR 0009's rejected role, wearing a different table.
 *
 * It holds no credential either. A credential proves an actor is who it claims
 * and grants nothing; rotating one must not change who the actor is, or every
 * event ever recorded would point at an identity that no longer exists.
 */
export const actor = pgTable(
  "actor",
  {
    /** Internal key. Never serialised outside the system — ADR 0005. */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),

    kind: actorKind("kind").notNull(),

    /**
     * What to call this actor in an interface.
     *
     * Not an identifier and never unique: two people share a name, and a
     * display name that had to be unique would force the second one to change
     * how they are addressed. Identity is the key; this is a label.
     */
    displayName: varchar("display_name", { length: 200 }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A blank label renders as an empty space where a party should be named,
    // which reads as a missing record rather than an unnamed one.
    check("actor_display_name_not_blank", sql`length(trim(${table.displayName})) >= 2`),
  ],
);

export type Actor = typeof actor.$inferSelect;
export type NewActor = typeof actor.$inferInsert;
export type ActorKind = (typeof actorKind.enumValues)[number];
