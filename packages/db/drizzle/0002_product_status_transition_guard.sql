-- Enforces the product status lifecycle in the database.
--
-- The same set is declared in src/domain/product-status.ts, which is the
-- source of truth a reader should consult. It is repeated here because a rule
-- that lives only in application code is bypassed by the first path that writes
-- without going through it, and status gates what the public passport is
-- allowed to claim.
--
-- The two copies cannot be merged into one artefact, so the integration suite
-- compares every source-to-target pair against this trigger and fails if they
-- ever disagree.
--
-- SQLSTATE TP001 is a project-defined code. It distinguishes an illegal
-- transition from an ordinary check violation, so a caller can report "that
-- move is not allowed" rather than "the database said no".

CREATE OR REPLACE FUNCTION product_status_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A product cannot be born active: nobody owns it yet. Nor suspended:
    -- nothing has gone wrong yet. Nor retired: it never lived. Without this,
    -- the transition rules below are bypassed by inserting the end state.
    IF NEW.status NOT IN ('draft', 'registered') THEN
      RAISE EXCEPTION 'A product cannot be created with status "%".', NEW.status
        USING ERRCODE = 'TP001';
    END IF;

    RETURN NEW;
  END IF;

  -- Updating a brand or a serial leaves the status alone. Treating that as a
  -- transition would block every ordinary write.
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'draft'      AND NEW.status IN ('registered', 'retired')) OR
    (OLD.status = 'registered' AND NEW.status IN ('active', 'suspended', 'retired')) OR
    (OLD.status = 'active'     AND NEW.status IN ('suspended', 'retired')) OR
    -- Deliberately not 'active'. Clearing a suspension returns the product to
    -- registered; activating it again is a separate, separately recorded act.
    -- A product that quietly becomes active again erases the reason it was
    -- suspended in the first place.
    (OLD.status = 'suspended'  AND NEW.status IN ('registered', 'retired'))
    -- 'retired' appears nowhere as a source: it is terminal.
  ) THEN
    RAISE EXCEPTION 'Product status cannot move from "%" to "%".', OLD.status, NEW.status
      USING ERRCODE = 'TP001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER product_status_guard_insert
BEFORE INSERT ON product
FOR EACH ROW
EXECUTE FUNCTION product_status_guard();
--> statement-breakpoint
-- UPDATE OF status: the trigger does not fire for writes that leave status out
-- of the SET list, which is most of them.
CREATE TRIGGER product_status_guard_update
BEFORE UPDATE OF status ON product
FOR EACH ROW
EXECUTE FUNCTION product_status_guard();
