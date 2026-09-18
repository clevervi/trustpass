-- Exactly one status change per product per transaction, each with its own event.
--
-- 0010 scoped the provenance check to the transaction, which stops an event
-- from an earlier transaction being reused. It does not stop an event from the
-- same transaction explaining two moves:
--
--   UPDATE ... 'suspended'    -- move 1
--   UPDATE ... 'registered'   -- move 2
--   UPDATE ... 'suspended'    -- move 3
--   INSERT event registered -> suspended    -- explains move 1
--   INSERT event suspended -> registered    -- explains move 2
--   COMMIT                                   -- accepted, move 3 unexplained
--
-- Moves 1 and 3 share a (previous_state, resulting_state) pair, so the same
-- event satisfied both. Reproduced against Postgres before this migration.
--
-- Counting firings is not possible from inside a row trigger, so the rule is
-- turned around: require exactly one transition event for this product in this
-- transaction. Two moves then produce either two events -- a count of 2, refused
-- -- or one event, also refused. The correspondence becomes 1:1 by construction.
--
-- The rule stands on its own merits. A transaction that moves a product twice is
-- doing two things, and each deserves its own transaction and its own recorded
-- reason. Every write path already does exactly one.

CREATE OR REPLACE FUNCTION product_requires_provenance() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  explaining_events integer;
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

  -- recorded_at defaults to now(), which is the transaction timestamp, so an
  -- event written in this transaction carries exactly this value. Events from
  -- earlier transactions are older and do not count.
  SELECT count(*) INTO explaining_events
  FROM lifecycle_event
  WHERE product_id = NEW.id
    AND previous_state IS NOT NULL
    AND recorded_at >= transaction_timestamp();

  IF explaining_events = 0 THEN
    RAISE EXCEPTION
      'A product cannot move from "%" to "%" without recording why, in the same transaction.',
      OLD.status, NEW.status
      USING ERRCODE = 'TP004';
  END IF;

  IF explaining_events > 1 THEN
    RAISE EXCEPTION
      'A product may change status once per transaction. % transitions were recorded for this product; record each move separately.',
      explaining_events
      USING ERRCODE = 'TP004';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_event
    WHERE product_id = NEW.id
      AND previous_state = OLD.status
      AND resulting_state = NEW.status
      AND recorded_at >= transaction_timestamp()
  ) THEN
    RAISE EXCEPTION
      'The event recorded for this product does not describe the move from "%" to "%".',
      OLD.status, NEW.status
      USING ERRCODE = 'TP004';
  END IF;

  RETURN NEW;
END;
$$;
