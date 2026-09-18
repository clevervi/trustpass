-- The events written in a transaction must describe the path the product took.
--
-- 0013 required exactly one transition event per product per transaction. That
-- made the correspondence 1:1, and it did so by forbidding something that is
-- not actually wrong: a transaction deliberately moving a product twice, with a
-- recorded reason for each move, has nothing to hide.
--
-- The property that matters is not "one move" but "the events account for every
-- move" -- raised in review, and correct. Counting a row trigger's own firings
-- is impossible from inside it, so the rule is expressed differently:
--
--   the transition events written in this transaction, read in order, form an
--   unbroken chain, and that chain ends where the product now stands.
--
-- Any single firing can check that, and it is stronger than counting. It also
-- refuses events that describe a path the product never took, which a count
-- cannot see:
--
--   2 moves, 2 events  -> chain reg->susp->reg ends at reg, product is reg. OK.
--   2 moves, 1 event   -> chain ends at susp, product is reg. Refused.
--   1 move,  2 events  -> chain ends at reg, product is susp. Refused.
--   3 moves, 2 events  -> chain ends at reg, product is susp. Refused.
--
-- The first row is the case 0013 refused and this one allows, because there was
-- never anything wrong with it.

CREATE OR REPLACE FUNCTION product_requires_provenance() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  chain record;
  settled product_status;
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

  -- recorded_at defaults to now(), the transaction timestamp, so events from
  -- earlier transactions are older and are not part of this chain.
  SELECT
    count(*) AS steps,
    bool_and(previous_state = expected) AS unbroken,
    max(resulting_state::text) FILTER (WHERE rn = total) AS ends_at
  INTO chain
  FROM (
    SELECT
      previous_state,
      resulting_state,
      lag(resulting_state) OVER (ORDER BY id) AS expected,
      row_number() OVER (ORDER BY id) AS rn,
      count(*) OVER () AS total
    FROM lifecycle_event
    WHERE product_id = NEW.id
      AND previous_state IS NOT NULL
      AND recorded_at >= transaction_timestamp()
  ) AS steps
  -- The first step has no predecessor to match, so it is exempt from the
  -- unbroken check; where it starts is settled by where the chain ends.
  WHERE rn > 1 OR true;

  IF chain.steps = 0 THEN
    RAISE EXCEPTION
      'A product cannot move from "%" to "%" without recording why, in the same transaction.',
      OLD.status, NEW.status
      USING ERRCODE = 'TP004';
  END IF;

  IF chain.steps > 1 AND NOT coalesce(chain.unbroken, true) THEN
    RAISE EXCEPTION
      'The events recorded for this product do not form an unbroken path; each must start where the previous one ended.'
      USING ERRCODE = 'TP004';
  END IF;

  -- Against where the product actually ended up, not against NEW.
  --
  -- The trigger fires once per UPDATE and each firing carries the NEW from its
  -- own statement, so in a transaction with two moves the first firing's NEW is
  -- the intermediate state. Comparing the chain to that would refuse a
  -- perfectly recorded pair of moves — which is exactly what it did before this
  -- line was written, and only a live run showed it.
  SELECT status INTO settled FROM product WHERE id = NEW.id;

  IF chain.ends_at IS DISTINCT FROM settled::text THEN
    RAISE EXCEPTION
      'The events recorded for this product end at "%", but the product now stands at "%".',
      chain.ends_at, settled
      USING ERRCODE = 'TP004';
  END IF;

  -- And this firing's own move has to appear in that chain, so a path that is
  -- internally consistent and lands correctly still cannot omit a step.
  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_event
    WHERE product_id = NEW.id
      AND previous_state = OLD.status
      AND resulting_state = NEW.status
      AND recorded_at >= transaction_timestamp()
  ) THEN
    RAISE EXCEPTION
      'No event records this product moving from "%" to "%".', OLD.status, NEW.status
      USING ERRCODE = 'TP004';
  END IF;

  RETURN NEW;
END;
$$;
