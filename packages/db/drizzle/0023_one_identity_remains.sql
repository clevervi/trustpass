-- One identity remains. This migration deletes, and it is the whole diff.
--
-- ADR 0012, phase two. 0020 created the organizations and moved every
-- reference; 0021 kept the two in step; 0022 moved the four constraints; and
-- the application stopped reading `issuer` at all. This removes it.
--
-- `pnpm db:preflight` reports READY before this runs and THE IDENTITY MIGRATION
-- IS COMPLETE after. That is not decoration: the preflight counts rows, source
-- files **and** the Postgres catalogue, because `grep repo = 0` does not
-- demonstrate `catalog = 0` — raised in review, and the catalogue is where the
-- three orphan functions below were found.
--
-- NOT generated as drizzle-kit wrote it. Its version opened with:
--
--   DROP TABLE "issuer" CASCADE;
--
-- CASCADE is the wrong verb here. It removes whatever depends on the table
-- without naming it, which is precisely the outcome this migration exists to
-- rule out: the question is not "can this be forced through" but "is anything
-- still attached". So every dependency is dropped explicitly, in order, and the
-- table goes last **without** CASCADE — if anything is still attached at that
-- point, Postgres refuses and the transaction takes the whole migration with
-- it.

DO $$
DECLARE
  unmoved_products bigint;
  unmoved_events bigint;
  parties bigint;
BEGIN
  -- Nothing may still depend on the old column for its party. If anything
  -- does, dropping the column loses who registered a product or who recorded
  -- an event, and the history is append-only so it could never be restated.
  SELECT count(*) INTO unmoved_products FROM product
    WHERE issuer_id IS NOT NULL AND organization_id IS NULL;
  SELECT count(*) INTO unmoved_events FROM lifecycle_event
    WHERE issuer_id IS NOT NULL AND organization_id IS NULL;

  IF unmoved_products > 0 OR unmoved_events > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop issuer_id: % products and % events would lose their party.',
      unmoved_products, unmoved_events
      USING ERRCODE = 'TP005';
  END IF;

  -- And every issuer must already exist as an organization, or a party
  -- disappears with the table.
  SELECT count(*) INTO parties FROM issuer i
  WHERE NOT EXISTS (
    SELECT 1 FROM organization o
    WHERE o.country = i.country AND o.registration_number = i.registration_number
  );

  IF parties > 0 THEN
    RAISE EXCEPTION 'Refusing to drop issuer: % parties exist only there.', parties
      USING ERRCODE = 'TP005';
  END IF;
END;
$$;
--> statement-breakpoint
-- The triggers that kept the two identities in step. They go before their
-- functions, and both go before the table, so nothing fires against a column
-- that is halfway gone.
DROP TRIGGER IF EXISTS issuer_gains_an_organization ON issuer;
--> statement-breakpoint
DROP TRIGGER IF EXISTS issuer_changes_reach_organization ON issuer;
--> statement-breakpoint
DROP TRIGGER IF EXISTS product_resolves_its_organization ON product;
--> statement-breakpoint
DROP TRIGGER IF EXISTS lifecycle_event_resolves_its_organization ON lifecycle_event;
--> statement-breakpoint
-- A trigger vanishes with its table; a function does not. These three exist
-- only to keep `issuer` and `organization` in step, and a dead trigger function
-- outliving its table is a thing somebody later wires to something else.
--
-- The catalogue check found them. No amount of grepping the repository would
-- have: they are not in it, they are in migrations that already ran.
DROP FUNCTION IF EXISTS issuer_has_an_organization();
--> statement-breakpoint
DROP FUNCTION IF EXISTS issuer_changes_reach_its_organization();
--> statement-breakpoint
DROP FUNCTION IF EXISTS resolve_organization_from_issuer();
--> statement-breakpoint
ALTER TABLE "lifecycle_event" DROP CONSTRAINT "lifecycle_event_issuer_id_issuer_id_fk";
--> statement-breakpoint
ALTER TABLE "product" DROP CONSTRAINT "product_issuer_id_issuer_id_fk";
--> statement-breakpoint
DROP INDEX "lifecycle_event_issuer_idx";
--> statement-breakpoint
DROP INDEX "product_issuer_id_idx";
--> statement-breakpoint
ALTER TABLE "lifecycle_event" DROP COLUMN "issuer_id";
--> statement-breakpoint
ALTER TABLE "product" DROP COLUMN "issuer_id";
--> statement-breakpoint
-- No CASCADE, deliberately. Everything that depended on this table has been
-- dropped by name above; if something was missed, this is where the migration
-- stops and says so rather than removing it quietly.
DROP TABLE "issuer";
--> statement-breakpoint
DO $$
DECLARE
  residue bigint;
BEGIN
  -- What the preflight will ask afterwards, asked here first, so the
  -- transaction can still refuse.
  SELECT
    (SELECT count(*) FROM pg_class
       WHERE relname = 'issuer' AND relkind = 'r' AND relnamespace = 'public'::regnamespace)
  + (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'issuer_id')
  + (SELECT count(*) FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef ILIKE '%issuer_id%')
  + (SELECT count(*) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND (p.prosrc ILIKE '%from issuer%' OR p.prosrc ILIKE '%issuer_id%'
              OR p.proname ILIKE '%issuer%'))
  INTO residue;

  IF residue > 0 THEN
    RAISE EXCEPTION 'Something still references issuer after the drop (% objects).', residue
      USING ERRCODE = 'TP005';
  END IF;

  -- And the guarantees that matter must still be in force. A migration that
  -- removed a table and a trigger would pass every count above.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'lifecycle_event'::regclass
      AND tgname = 'lifecycle_event_no_update' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'History is editable after this migration. Refusing.'
      USING ERRCODE = 'TP005';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'capacity_grant'::regclass
      AND tgname = 'capacity_grant_no_update' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Authority is editable after this migration. Refusing.'
      USING ERRCODE = 'TP005';
  END IF;
END;
$$;
