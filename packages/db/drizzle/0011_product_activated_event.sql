-- Adds the event type for a transition the status machine already allowed.
--
-- registered -> active has always been legal, and no event type could record
-- it. That went unnoticed until 0010 made provenance a database guarantee and
-- the transition turned out to be impossible to perform -- two rules that
-- disagreed, surfaced by the suite that walks every transition rather than by
-- reading either rule.
--
-- Only the system may record it. Per ADR 0008 `active` is a consequence of
-- ownership being established, never a label an actor sets.

ALTER TYPE "lifecycle_event_type" ADD VALUE IF NOT EXISTS 'product_activated' BEFORE 'product_retired';
