-- recorded_at is written by the database, not by whoever inserts the row.
--
-- 0010 and 0014 identify the events belonging to the current transaction with
-- `recorded_at >= transaction_timestamp()`. The column had defaultNow() and a
-- doc comment claiming it was "set by the database, not by the caller". Neither
-- was true: a default is what happens when nobody supplies a value, and any
-- writer may supply one.
--
-- So the trigger decided what "this transaction" meant by reading a column the
-- writer chose. That is self-defeating, because these rules live in the database
-- exactly so a path nobody has written yet cannot step around them -- the same
-- argument 0005 and 0008 each make about their own guard.
--
-- Measured against this database with every trigger enabled, before the fix:
--
--   1. plant an event registered -> suspended, alone in its own transaction,
--      with recorded_at = now() + 10 years            -> accepted
--   2. a later, separate transaction runs
--      UPDATE product SET status='suspended'
--      and writes no event at all                     -> COMMIT succeeded
--
-- A status change with no reason recorded in its transaction, which is the one
-- thing 0010 exists to make impossible. The history is append-only, so it could
-- never be explained afterwards either.
--
-- Same root cause, second consequence: lifecycle_event_not_in_future compares
-- occurred_at to recorded_at, so a caller-supplied future recorded_at carried a
-- future occurred_at past it. An event that has not happened yet is not an
-- event, and a passport would have rendered it as one.
--
-- Third: apps/api/src/passports/read-passport.ts publishes recordedOn on the
-- public passport. Until now that was a caller-controlled value presented to a
-- reader as when TrustPass learned of something.
--
-- Overwritten rather than refused, and the choice is forced rather than
-- preferred. The column default fills recorded_at in before any BEFORE trigger
-- runs, so by the time this function sees NEW there is no way to tell a caller
-- who passed now() from a caller who passed nothing. A guard that cannot
-- distinguish the two cannot refuse one of them. Assignment can ignore both,
-- which reaches the same end state without pretending to a detection it does
-- not have.
--
-- now(), not clock_timestamp(): now() is transaction_timestamp(), so every event
-- written in a transaction lands on exactly the value 0014's filter compares
-- against, and every event from an earlier transaction falls below it. The
-- chain's order stays with `ORDER BY id`, which is insertion order and is the
-- write-order protocol documented on the table.

CREATE OR REPLACE FUNCTION lifecycle_event_records_its_own_time() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.recorded_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A BEFORE trigger fires for every writer including the owner, which is why
-- 0005 chose one over a REVOKE and why this does too. The application connects
-- as the owner and the owner can re-grant itself any privilege it was denied.
CREATE TRIGGER lifecycle_event_recorded_at_is_ours
BEFORE INSERT ON lifecycle_event
FOR EACH ROW
EXECUTE FUNCTION lifecycle_event_records_its_own_time();
