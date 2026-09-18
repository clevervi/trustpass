-- No product exists, and no status moves, without a recorded reason.
--
-- TP-051 and TP-052 made the registration and status paths write the product
-- and its event in one transaction. That covers the paths that exist. It does
-- nothing about a bulk import, a migration, a fixture or a console session --
-- and per ADR 0008 that failure is invisible, because nothing later can
-- distinguish a history that is *missing* from one that is *empty*.
--
-- Same argument the repository already makes twice, in 0002 and 0005: a rule
-- that lives only in application code is bypassed by the first path that writes
-- without going through it.
--
-- DEFERRABLE INITIALLY DEFERRED because the event references the product and so
-- must be written after it. A plain AFTER trigger fires while the event cannot
-- exist yet, which would make the rule impossible to satisfy rather than hard
-- to bypass.
--
-- Check order matters and is why these are separate triggers on product rather
-- than extra clauses in the status guard. That guard raises TP001 immediately
-- for an illegal move; these fire at COMMIT. An illegal transition therefore
-- still reports TP001 and never reaches a provenance complaint, so a caller is
-- told the move was not allowed rather than that it forgot to explain it.
--
-- SQLSTATE TP004 is project-defined and distinct from TP001 (illegal move),
-- TP002 (history is append-only) and TP003 (capacity may not record that).

CREATE OR REPLACE FUNCTION product_requires_provenance() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM lifecycle_event WHERE product_id = NEW.id) THEN
      RAISE EXCEPTION
        'A product cannot exist without a recorded origin. Write its first lifecycle event in the same transaction.'
        USING ERRCODE = 'TP004';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Scoped to this transaction, not to history. A product that moved
  -- registered -> suspended -> registered -> suspended would otherwise satisfy
  -- the third move with the event that recorded the first, and the last
  -- transition would go unexplained while looking accounted for.
  --
  -- recorded_at defaults to now(), which is the transaction timestamp, so an
  -- event written in this transaction carries exactly this value.
  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_event
    WHERE product_id = NEW.id
      AND previous_state = OLD.status
      AND resulting_state = NEW.status
      AND recorded_at >= transaction_timestamp()
  ) THEN
    RAISE EXCEPTION
      'A product cannot move from "%" to "%" without recording why, in the same transaction.',
      OLD.status, NEW.status
      USING ERRCODE = 'TP004';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_provenance_on_insert
AFTER INSERT ON product
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION product_requires_provenance();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_provenance_on_status_change
AFTER UPDATE OF status ON product
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION product_requires_provenance();
