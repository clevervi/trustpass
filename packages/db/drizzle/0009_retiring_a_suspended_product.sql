-- Only an authority may end the life of a product that is under suspension.
--
-- TP-053 stopped a holder recording product_reinstated, which is clearing a
-- suspension directly. It left holder -> product_retired allowed, which is
-- normally correct: a person can say their own device reached end of life.
--
-- What makes that a laundering path is the other rule it meets. The live-serial
-- index excludes retired products on purpose, so a warranty replacement can
-- reuse the serial of the unit it replaces. Retirement frees the serial.
--
-- Neither rule is wrong. Together they are a door:
--
--   authority suspends over a theft report  -> suspended
--   the holder retires it themselves        -> retired, serial released
--   the same serial is enrolled again       -> a passport with no history
--
-- The old record keeps its events, and that is exactly the problem: nobody
-- scanning the new code will ever see the old one.
--
-- So whoever can investigate a report is who can decide the object's life ends
-- while that report is open. A holder or an issuer must get the suspension
-- resolved first, and that resolution is itself recorded.
--
-- registered -> retired by a holder or an issuer is untouched, so warranty
-- replacement still works.
--
-- Residual, stated rather than hidden: an authority retiring a suspended
-- product does still release the serial. That is a decision an authority is
-- entitled to make, and it is recorded.

CREATE OR REPLACE FUNCTION lifecycle_event_authority() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (NEW.actor_kind = 'holder'    AND NEW.type IN ('record_enrolled', 'product_retired')) OR
    (NEW.actor_kind = 'issuer'    AND NEW.type IN ('record_enrolled', 'product_registered', 'product_retired')) OR
    (NEW.actor_kind = 'authority' AND NEW.type IN ('product_suspended', 'product_reinstated', 'product_retired')) OR
    (NEW.actor_kind = 'system'    AND NEW.type IN ('record_corrected'))
  ) THEN
    RAISE EXCEPTION 'A % cannot record "%".', NEW.actor_kind, NEW.type
      USING ERRCODE = 'TP003';
  END IF;

  -- Ending the life of a product while a report against it is open.
  IF NEW.type = 'product_retired'
     AND NEW.previous_state = 'suspended'
     AND NEW.actor_kind <> 'authority' THEN
    RAISE EXCEPTION
      'A % cannot retire a suspended product. Resolve the suspension first.', NEW.actor_kind
      USING ERRCODE = 'TP003';
  END IF;

  RETURN NEW;
END;
$$;
