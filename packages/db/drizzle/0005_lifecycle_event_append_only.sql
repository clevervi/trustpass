-- Makes lifecycle_event append-only in the database.
--
-- ADR 0008 decides that an event is past-tense and fixed: the past does not
-- change, so a mistake is corrected by recording a correcting event rather than
-- by editing the original. What was recorded at the time is itself a fact about
-- what the system believed, and erasing it erases that.
--
-- This lives in a trigger rather than in application code for the same reason
-- the status transition guard does: a rule that exists only in TypeScript is
-- bypassed by the first path that writes without going through it. Here the
-- stakes are higher than a bad status, because an editable history is not a
-- history — it is a claim about the past that anyone with a connection can
-- rewrite, and a passport built on it proves nothing.
--
-- Deliberately not enforced with table permissions instead. A REVOKE is scoped
-- to a role, and the application connects as the owner; the owner bypasses RLS
-- and can re-grant itself anything. A BEFORE trigger fires for every writer
-- including the owner, which is the point.
--
-- SQLSTATE TP002 is a project-defined code, distinct from the TP001 the status
-- guard raises, so a caller can tell "that move is not allowed" from "history
-- cannot be rewritten" without parsing a message.

CREATE OR REPLACE FUNCTION lifecycle_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'A lifecycle event cannot be modified. Record a correcting event instead.'
      USING ERRCODE = 'TP002';
  END IF;

  RAISE EXCEPTION
    'A lifecycle event cannot be deleted. History is append-only.'
    USING ERRCODE = 'TP002';
END;
$$;
--> statement-breakpoint
-- No column list on UPDATE: every column is protected, not just the interesting
-- ones. A guard that covers `reason` but not `occurred_at` protects nothing.
CREATE TRIGGER lifecycle_event_no_update
BEFORE UPDATE ON lifecycle_event
FOR EACH ROW
EXECUTE FUNCTION lifecycle_event_append_only();
--> statement-breakpoint
CREATE TRIGGER lifecycle_event_no_delete
BEFORE DELETE ON lifecycle_event
FOR EACH ROW
EXECUTE FUNCTION lifecycle_event_append_only();
--> statement-breakpoint
-- TRUNCATE is not a DELETE and a row-level trigger never sees it. Without this
-- the whole history is one statement away from gone.
CREATE TRIGGER lifecycle_event_no_truncate
BEFORE TRUNCATE ON lifecycle_event
FOR EACH STATEMENT
EXECUTE FUNCTION lifecycle_event_append_only();
