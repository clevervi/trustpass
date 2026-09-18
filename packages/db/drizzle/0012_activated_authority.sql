-- Grants the system the authority to record product_activated.
--
-- Separate from 0011 because Postgres refuses to use a new enum value in the
-- same transaction that added it.

CREATE OR REPLACE FUNCTION lifecycle_event_authority() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (NEW.actor_kind = 'holder'    AND NEW.type IN ('record_enrolled', 'product_retired')) OR
    (NEW.actor_kind = 'issuer'    AND NEW.type IN ('record_enrolled', 'product_registered', 'product_retired')) OR
    (NEW.actor_kind = 'authority' AND NEW.type IN ('product_suspended', 'product_reinstated', 'product_retired')) OR
    (NEW.actor_kind = 'system'    AND NEW.type IN ('record_corrected', 'product_activated'))
  ) THEN
    RAISE EXCEPTION 'A % cannot record "%".', NEW.actor_kind, NEW.type
      USING ERRCODE = 'TP003';
  END IF;

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
