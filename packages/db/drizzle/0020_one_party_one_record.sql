-- One party, one record. Phase one: additive, and it deletes nothing.
--
-- ADR 0012. #107 added `organization` without reconciling it with `issuer`, so
-- the database holds two tables for one legal party. This migration makes every
-- issuer an organization and gives `product` and `lifecycle_event` a reference
-- to it, **beside** the existing `issuer_id` rather than instead of it.
--
-- That split is CONTRIBUTING.md's rule, not caution for its own sake: add a
-- column, backfill it, stop using the old one, in separate migrations — and a
-- destructive change gets its own pull request so the diff that drops data is
-- the whole diff. Nothing here drops anything.
--
-- What this migration moves, measured before writing it:
--
--   issuers                                           376
--   organizations                                      16
--   products referencing an issuer                   1563
--   events referencing an issuer                     1836
--   issuer/organization sharing country+registration     0
--
-- The last row matters. No issuer currently matches an existing organization,
-- so every one of the 376 becomes a new row — but the migration is written to
-- match first and insert only what is missing, because that will not be true
-- the second time anybody runs something like this.
--
-- Preconditions are checked before anything is written, and they RAISE. A
-- migration runs inside one transaction, so a raise leaves nothing behind —
-- verified rather than assumed: a probe migration that created a table and then
-- raised left no table and no journal entry.
--
-- What this migration deliberately does NOT do: invent a verification history.
-- `issuer.verification_status` is a mutable column and the only record of the
-- fact, so the current value is carryable and a timeline is not. Per ADR 0012
-- verification changes become events, and the history starts when those exist.
-- Reconstructing 2024 from a column that has been overwritten since would be a
-- plausible fiction, which is the one thing this project refuses to publish.

DO $$
DECLARE
  bad_country bigint;
  bad_registration bigint;
  ambiguous bigint;
BEGIN
  -- An issuer whose registry identity cannot be read cannot be matched to an
  -- organization, and guessing would attach products to the wrong party.
  SELECT count(*) INTO bad_country FROM issuer WHERE country !~ '^[A-Z]{2}$';
  SELECT count(*) INTO bad_registration FROM issuer
    WHERE registration_number !~ '^[A-Z0-9-]{4,50}$';

  IF bad_country > 0 OR bad_registration > 0 THEN
    RAISE EXCEPTION
      'Cannot migrate: % issuers have an unreadable country and % an unreadable registration number.',
      bad_country, bad_registration
      USING ERRCODE = 'TP005';
  END IF;

  -- Two issuers sharing one registry identity would collapse into one
  -- organization and silently merge two parties' products. The issuer table has
  -- a unique index on (country, registration_number), so this should be
  -- impossible; it is checked because "should be impossible" is what a
  -- precondition is for, and discovering it mid-migration is worse.
  SELECT count(*) INTO ambiguous FROM (
    SELECT country, registration_number FROM issuer
    GROUP BY country, registration_number HAVING count(*) > 1
  ) AS duplicated;

  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      'Cannot migrate: % registry identities are held by more than one issuer.', ambiguous
      USING ERRCODE = 'TP005';
  END IF;
END;
$$;
--> statement-breakpoint
-- Added nullable and made NOT NULL after the backfill. Adding it NOT NULL
-- outright fails against the rows already here, which is the ordinary trap and
-- the reason the generated statement was not used as written.
ALTER TABLE "organization" ADD COLUMN "company_name" varchar(200);
--> statement-breakpoint
-- Organizations created before this column existed have only a legal name. It
-- is the better default than a placeholder: a party that trades under its legal
-- name is common, and inventing a trading name would be inventing a fact.
UPDATE "organization" SET "company_name" = "legal_name" WHERE "company_name" IS NULL;
--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "company_name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_company_name_not_blank" CHECK (length(trim("organization"."company_name")) >= 2);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "verification_status" "issuer_verification_status" DEFAULT 'unverified' NOT NULL;
--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD COLUMN "organization_id" bigint;
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "organization_id" bigint;
--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
CREATE INDEX "lifecycle_event_organization_idx" ON "lifecycle_event" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "product_organization_id_idx" ON "product" USING btree ("organization_id");
--> statement-breakpoint
-- Every issuer becomes an organization, matched by registry identity rather
-- than copied into a new row. ADR 0012: the migration moves references, it does
-- not duplicate parties — so an issuer that already has an organization reuses
-- it, and only the missing ones are created.
--
-- verification_status is carried across as the current value. That is the only
-- honest thing to carry: see the header.
INSERT INTO "organization" ("company_name", "legal_name", "registration_number", "country", "verification_status", "created_at")
SELECT i."company_name", i."legal_name", i."registration_number", i."country", i."verification_status", i."created_at"
FROM "issuer" i
WHERE NOT EXISTS (
  SELECT 1 FROM "organization" o
  WHERE o."country" = i."country" AND o."registration_number" = i."registration_number"
);
--> statement-breakpoint
UPDATE "product" p
SET "organization_id" = o."id"
FROM "issuer" i
JOIN "organization" o
  ON o."country" = i."country" AND o."registration_number" = i."registration_number"
WHERE p."issuer_id" = i."id";
--> statement-breakpoint
-- The append-only guard refuses this, and it is right to.
--
-- `UPDATE lifecycle_event` is blocked by `lifecycle_event_no_update` (TP002),
-- which fires for every writer including the owner. A backfill is an UPDATE on
-- history, and the trigger cannot tell a harmless one from a harmful one —
-- which is the point, because "this edit is fine" is what every harmful edit
-- says. Measured: the first version of this migration died here.
--
-- Three ways out were considered.
--
--   1. Widen the trigger to permit an update touching only organization_id.
--      Narrow, checkable, and *permanent* — a standing exception is standing
--      exploitable, for a migration that runs once.
--   2. Leave historical events with organization_id NULL, as `grant_id` does.
--      Honest, and it makes phase two unable to drop issuer_id without losing
--      which party acted on 1,836 events. The tension does not go away; it
--      moves to a migration that also deletes things.
--   3. Disable the trigger for this statement, inside this transaction.
--
-- Three, because DDL is transactional in Postgres: if anything after this
-- raises, the rollback restores the trigger along with everything else, so
-- there is no window in which the guard is off and the transaction survived.
-- The postcondition below asserts it is back, and a test asserts the guard
-- still refuses an ordinary update afterwards.
--
-- The event's content does not change. What happened, who did it, why and when
-- are all untouched; the same party is re-addressed under the identity that
-- will outlive `issuer`. That is the argument for doing it at all, and it is
-- deliberately not an argument the trigger is being taught to accept.
ALTER TABLE "lifecycle_event" DISABLE TRIGGER "lifecycle_event_no_update";
--> statement-breakpoint
UPDATE "lifecycle_event" e
SET "organization_id" = o."id"
FROM "issuer" i
JOIN "organization" o
  ON o."country" = i."country" AND o."registration_number" = i."registration_number"
WHERE e."issuer_id" = i."id";
--> statement-breakpoint
ALTER TABLE "lifecycle_event" ENABLE TRIGGER "lifecycle_event_no_update";
--> statement-breakpoint
-- Postconditions. Every reference that pointed at an issuer must now also point
-- at an organization, and every issuer must be findable as one.
--
-- These raise for the same reason the preconditions do: a migration that half
-- worked is worse than one that did not run, and the transaction makes "did not
-- run" available.
DO $$
DECLARE
  unmatched_issuers bigint;
  unmoved_products bigint;
  unmoved_events bigint;
BEGIN
  SELECT count(*) INTO unmatched_issuers
  FROM "issuer" i
  WHERE NOT EXISTS (
    SELECT 1 FROM "organization" o
    WHERE o."country" = i."country" AND o."registration_number" = i."registration_number"
  );

  SELECT count(*) INTO unmoved_products
  FROM "product" WHERE "issuer_id" IS NOT NULL AND "organization_id" IS NULL;

  SELECT count(*) INTO unmoved_events
  FROM "lifecycle_event" WHERE "issuer_id" IS NOT NULL AND "organization_id" IS NULL;

  -- The guard must be back on. If this migration ever left it disabled, every
  -- later write to history would pass silently and nothing would say so.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'lifecycle_event'::regclass
      AND tgname = 'lifecycle_event_no_update'
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION
      'Migration would have left lifecycle_event editable. Refusing.'
      USING ERRCODE = 'TP005';
  END IF;

  IF unmatched_issuers > 0 OR unmoved_products > 0 OR unmoved_events > 0 THEN
    RAISE EXCEPTION
      'Migration did not complete: % issuers unmatched, % products and % events still reference an issuer with no organization.',
      unmatched_issuers, unmoved_products, unmoved_events
      USING ERRCODE = 'TP005';
  END IF;
END;
$$;
