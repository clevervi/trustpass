-- The runtime may change a product's status. Not its identity.
--
-- `0024` granted `UPDATE` on the whole of `product` because the application
-- updates products, and at table granularity that is the only answer available.
-- It is wider than anything the application does. Every write in the codebase
-- reaches exactly two columns, and the statement is not a matter of opinion --
-- it was read from Drizzle's own logger:
--
--   update "product" set "status" = $1, "updated_at" = $2
--   where "product"."id" = $3
--
-- So the credential the API holds could, today, rewrite a serial, move a
-- product to another company, or restate when it was registered. Nothing in the
-- application asks to and nothing stops it.
--
--
-- WHY THIS IS NOT A CHECK CONSTRAINT, AND WHY IT IS NOT A TRIGGER
--
-- The obvious alternative was a constraint, and it was tried before it was
-- rejected. `product_holder_has_no_organization` already reads
--
--   (origin = 'holder') = (organization_id IS NULL)
--
-- and it is a coherence rule: it asks whether the values in a row agree with
-- each other. Measured against the live table with the table-level grant in
-- place:
--
--   UPDATE product SET origin = 'holder', organization_id = NULL   ACCEPTED
--
-- An issuer-registered product becomes a holder enrolment and loses the company
-- that registered it, and the constraint has no objection, because the new pair
-- is internally consistent. No arrangement of CHECK expressions fixes that. The
-- question is not whether the values agree; it is which columns may change at
-- all, and a constraint cannot see the difference between a column somebody set
-- and a column that was already there.
--
-- A BEFORE UPDATE trigger comparing OLD to NEW can see it, and was rejected for
-- two reasons. It runs per row, so it charges every legitimate status change for
-- a guarantee that does not depend on the row. And it is the kind of guard this
-- repository has already watched fail: the attack table in
-- `least-privilege.integration.test.ts` disables one, redefines one and drops
-- one, and the runtime is refused each time only because it holds no privilege
-- over triggers. A privilege needs no such protection -- there is nothing to
-- disable, and revoking it requires being the table's owner, which the runtime
-- is not.
--
-- The privilege is also checked earlier than either. Postgres validates the
-- target list of an UPDATE at executor start, before a row is read, before a
-- constraint is evaluated and before a trigger fires.
--
--
-- WHY `updated_at` IS GRANTED, WHICH LOOKS LIKE A CONCESSION
--
-- It is not one, and granting `status` alone was measured first. Drizzle's
-- `$onUpdate` on `product.updated_at` injects that column into every UPDATE the
-- schema emits, so `GRANT UPDATE (status)` reads like the tighter, more careful
-- decision and refuses the application's own statement with 42501. The narrower
-- grant here would be an outage, not a stronger guarantee.
--
-- Worth naming because of how it nearly shipped: with `GRANT UPDATE (status)`
-- alone, 34 of the 35 tests in the least-privilege file still passed, because
-- not one of them ran an UPDATE. A test asserting the application still works
-- now does.

REVOKE UPDATE ON TABLE product FROM trustpass_runtime;
--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON TABLE product TO trustpass_runtime;
--> statement-breakpoint

DO $$
DECLARE
  wider text;
BEGIN
  -- Asked of the catalogue rather than trusted from the two statements above,
  -- for the reason `0024` gave: `has_column_privilege` answers for privileges
  -- arriving by role membership and by PUBLIC as well as by a GRANT naming the
  -- role, which is exactly how a privilege appears that no migration wrote.

  -- The criterion, stated as it was agreed: no column of `product` other than
  -- `status` and `updated_at` is updatable by this role. Derived from
  -- `pg_attribute` so that a column added by a later migration is covered
  -- without anyone remembering to add it here -- and so that a column added
  -- outside a migration cannot hide.
  SELECT string_agg(attname, ', ' ORDER BY attnum) INTO wider
  FROM pg_attribute
  WHERE attrelid = 'product'::regclass
    AND attnum > 0
    AND NOT attisdropped
    AND attname NOT IN ('status', 'updated_at')
    AND has_column_privilege('trustpass_runtime', 'product', attname, 'UPDATE');

  IF wider IS NOT NULL THEN
    RAISE EXCEPTION 'The runtime can still update: %. Refusing.', wider
      USING ERRCODE = 'TP006';
  END IF;

  -- And the two it must keep. A migration that revoked everything would satisfy
  -- the check above and stop the application.
  IF NOT has_column_privilege('trustpass_runtime', 'product', 'status', 'UPDATE')
     OR NOT has_column_privilege('trustpass_runtime', 'product', 'updated_at', 'UPDATE')
  THEN
    RAISE EXCEPTION 'The runtime cannot perform the status update the API makes. Refusing.'
      USING ERRCODE = 'TP006';
  END IF;

  -- `has_table_privilege` reports false once the grant is column-level, which
  -- is correct and is the point: there is no longer a table-wide answer. Only
  -- the reading of it changes, and the row for `product` in the grant matrix
  -- test changes with it.
  IF has_table_privilege('trustpass_runtime', 'product', 'UPDATE') THEN
    RAISE EXCEPTION 'A table-wide UPDATE on product survived the REVOKE. Refusing.'
      USING ERRCODE = 'TP006';
  END IF;

  -- Untouched by this migration, and therefore worth asserting: a REVOKE that
  -- took more than it was asked for would be an outage discovered in
  -- production rather than here.
  IF NOT has_table_privilege('trustpass_runtime', 'product', 'SELECT')
     OR NOT has_table_privilege('trustpass_runtime', 'product', 'INSERT')
  THEN
    RAISE EXCEPTION 'The runtime lost a privilege this migration did not revoke. Refusing.'
      USING ERRCODE = 'TP006';
  END IF;

  IF has_table_privilege('trustpass_runtime', 'product', 'DELETE') THEN
    RAISE EXCEPTION 'The runtime can delete products. Refusing.'
      USING ERRCODE = 'TP006';
  END IF;
END;
$$;
