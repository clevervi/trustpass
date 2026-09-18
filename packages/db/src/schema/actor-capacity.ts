import { pgEnum } from "drizzle-orm/pg-core";

/**
 * In what capacity an actor acted.
 *
 * Declared here rather than beside `lifecycle_event` because it is now used by
 * two tables: an event records the capacity something was recorded in, and a
 * `capacity_grant` records who holds that capacity. Leaving it in one of them
 * would have made the other import it and produced a cycle — `capacity_grant`
 * needs the enum, and `lifecycle_event` needs a foreign key to the grant.
 *
 * The database name stays `lifecycle_actor_kind`. Renaming a Postgres enum is a
 * migration with no benefit, and the old name is already referenced by a trigger
 * function and by the `RECORDING_AUTHORITY` integration suite.
 *
 * Not who the actor is. Identifying a party requires authentication, which is
 * `TP-141`; recording the capacity is what the system can honestly assert until
 * `capacity_grant` is populated and the write paths resolve against it.
 */
export const lifecycleActorKind = pgEnum("lifecycle_actor_kind", [
  /** A registered business. */
  "issuer",
  /** Whoever had the object. Per ADR 0007 this asserts very little, and per ADR 0009 §8 it is the one capacity nobody grants. */
  "holder",
  /** A police report, a customs seizure, a regulator. */
  "authority",
  /** TrustPass itself — a scheduled expiry, a migration, an automated check. */
  "system",
]);

export type LifecycleActorKind = (typeof lifecycleActorKind.enumValues)[number];
