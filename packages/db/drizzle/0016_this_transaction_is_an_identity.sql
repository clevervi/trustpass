-- "This transaction" becomes an identity instead of a time window.
--
-- 0010 and 0014 asked whether an event belonged to the current transaction by
-- comparing `recorded_at >= transaction_timestamp()`. That is a half-open
-- range, not an identity, and it answers a different question than the one
-- intended:
--
--   intended:  did THIS transaction write this event?
--   asked:     was this event written after this transaction started?
--
-- Any event another transaction commits while this one is open falls inside the
-- range. Under READ COMMITTED -- Postgres's default, and what this application
-- runs on -- a later statement sees rows committed in the meantime, so the
-- answer is yes for events this transaction had nothing to do with.
--
-- Measured with two connections against this database, with 0015 applied:
--
--   A  BEGIN, one statement           (transaction_timestamp = T0)
--   B      BEGIN at T1 > T0
--   B      INSERT event registered -> suspended
--   B      COMMIT
--   A  UPDATE product SET status='suspended'      -- writes no event at all
--   A  COMMIT                                     -> ACCEPTED
--
-- A moved the product having recorded nothing. B's event, written by a
-- different transaction for its own reason, accounted for it.
--
-- pg_current_xact_id() answers the intended question directly. No range, no
-- concurrency, no clock: the event was written by this transaction or it was
-- not.
--
-- It returns the TOP-LEVEL transaction id, which is the unit wanted here.
-- Verified against this database rather than taken from the documentation:
--
--   top level        | 14601 | same
--   inside savepoint | 14601 | same
--   nested savepoint | 14601 | same
--
-- So a write path using SAVEPOINT -- a retry, a partial rollback -- still
-- records its events against the one transaction that will either commit or
-- not. The unit of provenance is the commit, and that is the right unit: a
-- savepoint rolled back leaves nothing behind to explain.
--
-- recorded_at stays. It answers "when did TrustPass learn of this", which the
-- passport publishes. recorded_in_xact answers "which write produced this",
-- which nothing outside the database ever sees. One column doing both jobs
-- would do neither well, and 0015 exists precisely because the integrity job
-- had quietly taken over a column whose visible meaning was the other one.

ALTER TABLE lifecycle_event
  ADD COLUMN recorded_in_xact xid8 NOT NULL DEFAULT '0';
--> statement-breakpoint
-- The default is '0' and that choice is load-bearing, not a placeholder.
--
-- Postgres reserves 0, 1 and 2 and hands out nothing below 3, so '0' can never
-- equal a live pg_current_xact_id(). That buys two things at once:
--
--   1. Rows written before this column existed carry '0', which reads as
--      "written by a transaction this database can no longer name". True, and
--      better than backfilling the migration's own id, which would claim every
--      historical event was written by this one statement.
--
--   2. The default FAILS CLOSED. If the trigger below is ever dropped, new rows
--      take '0', which matches no transaction, so every provenance check
--      refuses loudly. Compare 0015: recorded_at defaulted to now(), which
--      satisfied the filter, so losing that trigger would have failed OPEN and
--      in silence. A guard whose absence is invisible is the mistake this
--      repository keeps finding, so this one is arranged to be noisy.
COMMENT ON COLUMN lifecycle_event.recorded_in_xact IS
  'Top-level transaction that wrote this row. Set by trigger, never by a caller. 0 means the row predates this column.';
--> statement-breakpoint
-- Extends the function 0015 introduced rather than adding a second trigger.
-- Both columns are the same decision: the database says when a row was written
-- and by which write, and no caller gets a vote on either.
CREATE OR REPLACE FUNCTION lifecycle_event_records_its_own_time() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.recorded_at := now();
  -- pg_current_xact_id(), not pg_current_xact_id_if_assigned(). This fires on
  -- INSERT and an INSERT has already forced a transaction id, so the assigning
  -- variant costs nothing here while the _if_assigned one could return NULL
  -- into a NOT NULL column. The cost that variant exists to avoid falls on
  -- read-only transactions, and no read path reaches this function -- measured:
  -- a plain SELECT over lifecycle_event leaves pg_current_xact_id_if_assigned()
  -- NULL.
  NEW.recorded_in_xact := pg_current_xact_id();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The rule 0014 decided, asking the ownership question correctly.
--
-- The chain, the unbroken path, where it ends and this firing's own move are
-- unchanged, and their reasoning stays in 0014. What changes is the two places
-- that said `recorded_at >= transaction_timestamp()`.
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
      -- Written by this transaction. Not "written after it started".
      AND recorded_in_xact = pg_current_xact_id()
  ) AS steps
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

  SELECT status INTO settled FROM product WHERE id = NEW.id;

  IF chain.ends_at IS DISTINCT FROM settled::text THEN
    RAISE EXCEPTION
      'The events recorded for this product end at "%", but the product now stands at "%".',
      chain.ends_at, settled
      USING ERRCODE = 'TP004';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_event
    WHERE product_id = NEW.id
      AND previous_state = OLD.status
      AND resulting_state = NEW.status
      AND recorded_in_xact = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION
      'No event records this product moving from "%" to "%".', OLD.status, NEW.status
      USING ERRCODE = 'TP004';
  END IF;

  RETURN NEW;
END;
$$;
