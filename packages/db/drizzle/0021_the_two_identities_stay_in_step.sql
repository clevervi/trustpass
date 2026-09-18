-- While both identities exist, the database keeps them in step.
--
-- 0020 moved every existing reference and stopped there, which left a gap that
-- opened immediately: the write paths still insert `issuer_id` and nothing
-- else, so every row written after that migration drifted. Measured within
-- minutes of applying it, by the invariant tests written for it —
--
--   issuers with no organization                  21
--   products with an issuer and no organization   82
--
-- — all created by the suite in the time between.
--
-- The obvious fix is to change `insertProduct`, `enrolProduct` and the issuer
-- write path to populate both columns. That is three call sites today and the
-- argument against it is the one this repository has made for every guarantee
-- it owns: a rule living only in application code is bypassed by the first path
-- that writes without going through it, and phase one exists precisely because
-- there will be more paths before phase two arrives.
--
-- So the database does it, for every writer including the owner.
--
-- These triggers are temporary and their end is scheduled: when `issuer` goes,
-- they go with it. They are the cost of an additive migration having two
-- correct answers at once, which is the price CONTRIBUTING.md's rule about
-- separate migrations asks you to pay on purpose.

CREATE OR REPLACE FUNCTION issuer_has_an_organization() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Matched by registry identity, never duplicated. ADR 0012: one party, one
  -- record — so an issuer whose organization already exists reuses it, which is
  -- also what makes this safe to run for an issuer created by any path.
  INSERT INTO organization (company_name, legal_name, registration_number, country, verification_status, created_at)
  SELECT NEW.company_name, NEW.legal_name, NEW.registration_number, NEW.country, NEW.verification_status, NEW.created_at
  WHERE NOT EXISTS (
    SELECT 1 FROM organization o
    WHERE o.country = NEW.country AND o.registration_number = NEW.registration_number
  );

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- AFTER, not BEFORE: the issuer's own constraints should decide whether it is a
-- valid party before anything is created on its behalf.
CREATE TRIGGER issuer_gains_an_organization
AFTER INSERT ON issuer
FOR EACH ROW
EXECUTE FUNCTION issuer_has_an_organization();
--> statement-breakpoint
-- Insert is not enough: an issuer that changes keeps changing.
--
-- The first version of this migration synced on INSERT only, and the invariant
-- test caught what that leaves — two issuers reading `verified` while their
-- organizations read `unverified`, because a later UPDATE moved one and not the
-- other. Which is precisely the defect ADR 0009 named when it refused two
-- tables for one party: *"the same entity would exist twice, with two
-- verification states that can disagree."*
--
-- Writing the fix is cheaper than the alternative, which is a phase one where
-- the two identities are allowed to drift and phase two has to decide which of
-- them was telling the truth.
CREATE OR REPLACE FUNCTION issuer_changes_reach_its_organization() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A registry identity is what links the two rows. Changing it would silently
  -- re-point the correspondence at a different party, or at none, and no caller
  -- currently needs to — so while both tables exist, it is refused rather than
  -- guessed at.
  IF NEW.country IS DISTINCT FROM OLD.country
     OR NEW.registration_number IS DISTINCT FROM OLD.registration_number THEN
    RAISE EXCEPTION
      'An issuer''s registry identity cannot change while it is linked to an organization.'
      USING ERRCODE = 'TP005';
  END IF;

  UPDATE organization o
  SET company_name = NEW.company_name,
      legal_name = NEW.legal_name,
      verification_status = NEW.verification_status
  WHERE o.country = NEW.country
    AND o.registration_number = NEW.registration_number;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issuer_changes_reach_organization
AFTER UPDATE ON issuer
FOR EACH ROW
EXECUTE FUNCTION issuer_changes_reach_its_organization();
--> statement-breakpoint
-- Resolves organization_id from issuer_id when a caller supplied only the old
-- one. Shared by product and lifecycle_event because the rule is identical and
-- two copies of it would be two things to keep identical.
--
-- It never overwrites a value the caller gave. A caller that knows the
-- organization is ahead of this migration, not behind it.
CREATE OR REPLACE FUNCTION resolve_organization_from_issuer() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.issuer_id IS NOT NULL AND NEW.organization_id IS NULL THEN
    SELECT o.id INTO NEW.organization_id
    FROM issuer i
    JOIN organization o
      ON o.country = i.country AND o.registration_number = i.registration_number
    WHERE i.id = NEW.issuer_id;

    -- Only complain when the issuer is real and its organization is missing.
    --
    -- Without the EXISTS, a product naming an issuer that does not exist raised
    -- TP005 from here instead of the foreign key's 23503 — measured, it broke
    -- "refuses a product whose issuer does not exist", and that test was right
    -- to fail. A guard that answers a question it was not asked makes the real
    -- answer unreachable, and "no such issuer" is a different fact from "the
    -- two identities are out of step".
    IF NEW.organization_id IS NULL
       AND EXISTS (SELECT 1 FROM issuer WHERE id = NEW.issuer_id) THEN
      RAISE EXCEPTION
        'Issuer % has no organization. The two identities are out of step.', NEW.issuer_id
        USING ERRCODE = 'TP005';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_resolves_its_organization
BEFORE INSERT ON product
FOR EACH ROW
EXECUTE FUNCTION resolve_organization_from_issuer();
--> statement-breakpoint
CREATE TRIGGER lifecycle_event_resolves_its_organization
BEFORE INSERT ON lifecycle_event
FOR EACH ROW
EXECUTE FUNCTION resolve_organization_from_issuer();
--> statement-breakpoint
-- And close the gap the interval already opened. Same shape as 0020's backfill,
-- including the bracketed guard: history is append-only and a backfill is an
-- UPDATE, so the trigger comes off for one statement inside this transaction
-- and the postcondition checks it came back.
INSERT INTO organization (company_name, legal_name, registration_number, country, verification_status, created_at)
SELECT i.company_name, i.legal_name, i.registration_number, i.country, i.verification_status, i.created_at
FROM issuer i
WHERE NOT EXISTS (
  SELECT 1 FROM organization o
  WHERE o.country = i.country AND o.registration_number = i.registration_number
);
--> statement-breakpoint
-- And reconcile what already drifted, for the same reason the rest of this
-- migration exists.
UPDATE organization o
SET company_name = i.company_name,
    legal_name = i.legal_name,
    verification_status = i.verification_status
FROM issuer i
WHERE o.country = i.country
  AND o.registration_number = i.registration_number
  AND (o.verification_status IS DISTINCT FROM i.verification_status
       OR o.company_name IS DISTINCT FROM i.company_name
       OR o.legal_name IS DISTINCT FROM i.legal_name);
--> statement-breakpoint
UPDATE product p
SET organization_id = o.id
FROM issuer i
JOIN organization o ON o.country = i.country AND o.registration_number = i.registration_number
WHERE p.issuer_id = i.id AND p.organization_id IS NULL;
--> statement-breakpoint
ALTER TABLE lifecycle_event DISABLE TRIGGER lifecycle_event_no_update;
--> statement-breakpoint
UPDATE lifecycle_event e
SET organization_id = o.id
FROM issuer i
JOIN organization o ON o.country = i.country AND o.registration_number = i.registration_number
WHERE e.issuer_id = i.id AND e.organization_id IS NULL;
--> statement-breakpoint
ALTER TABLE lifecycle_event ENABLE TRIGGER lifecycle_event_no_update;
--> statement-breakpoint
DO $$
DECLARE
  unmatched bigint;
  unmoved_products bigint;
  unmoved_events bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'lifecycle_event'::regclass
      AND tgname = 'lifecycle_event_no_update'
      AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Migration would have left lifecycle_event editable. Refusing.'
      USING ERRCODE = 'TP005';
  END IF;

  SELECT count(*) INTO unmatched FROM issuer i
  WHERE NOT EXISTS (
    SELECT 1 FROM organization o
    WHERE o.country = i.country AND o.registration_number = i.registration_number
  );

  SELECT count(*) INTO unmoved_products FROM product
  WHERE issuer_id IS NOT NULL AND organization_id IS NULL;

  SELECT count(*) INTO unmoved_events FROM lifecycle_event
  WHERE issuer_id IS NOT NULL AND organization_id IS NULL;

  IF EXISTS (
    SELECT 1 FROM issuer i
    JOIN organization o ON o.country = i.country AND o.registration_number = i.registration_number
    WHERE o.verification_status IS DISTINCT FROM i.verification_status
  ) THEN
    RAISE EXCEPTION 'Two identities disagree about whether a party is verified. Refusing.'
      USING ERRCODE = 'TP005';
  END IF;

  IF unmatched > 0 OR unmoved_products > 0 OR unmoved_events > 0 THEN
    RAISE EXCEPTION
      'Still out of step: % issuers, % products, % events.',
      unmatched, unmoved_products, unmoved_events
      USING ERRCODE = 'TP005';
  END IF;
END;
$$;
