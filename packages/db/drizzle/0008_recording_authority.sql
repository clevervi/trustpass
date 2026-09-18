-- Limits what each actor capacity may record.
--
-- The same table is declared in src/domain/recording-authority.ts, which is the
-- source of truth a reader should consult. It is repeated here because a rule
-- that lives only in application code is bypassed by the first path that writes
-- without going through it -- and this one decides whether a passport's history
-- can be edited by whoever is most motivated to edit it.
--
-- The entry that matters most is the one that is absent: a holder cannot record
-- product_reinstated. A product suspended over a theft report, cleared by the
-- person holding it, is the system helping launder a stolen device.
--
-- The two copies cannot be merged into one artefact, so the integration suite
-- compares every pairing against this trigger and fails if they diverge.
--
-- SQLSTATE TP003 is project-defined and distinct from TP001 (an illegal status
-- move) and TP002 (history is append-only), so a caller can tell "you may not
-- record that" from the other two without parsing a message.

CREATE OR REPLACE FUNCTION lifecycle_event_authority() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (NEW.actor_kind = 'holder'    AND NEW.type IN ('record_enrolled', 'product_retired')) OR
    (NEW.actor_kind = 'issuer'    AND NEW.type IN ('record_enrolled', 'product_registered', 'product_retired')) OR
    -- Deliberately the only capacity that may suspend or reinstate. A report
    -- and its resolution belong to whoever can investigate.
    (NEW.actor_kind = 'authority' AND NEW.type IN ('product_suspended', 'product_reinstated', 'product_retired')) OR
    (NEW.actor_kind = 'system'    AND NEW.type IN ('record_corrected'))
  ) THEN
    RAISE EXCEPTION 'A % cannot record "%".', NEW.actor_kind, NEW.type
      USING ERRCODE = 'TP003';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lifecycle_event_authority_insert
BEFORE INSERT ON lifecycle_event
FOR EACH ROW
EXECUTE FUNCTION lifecycle_event_authority();
