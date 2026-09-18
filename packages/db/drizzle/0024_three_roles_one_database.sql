-- Three roles, one database. The runtime cannot remove what protects the record.
--
-- `0005_lifecycle_event_append_only.sql` argued *for* putting the guarantees in
-- triggers like this:
--
--   "the application connects as the owner, and the owner can grant itself any
--    privilege back."
--
-- Read again, that sentence is also the description of a hole. Every guarantee
-- this repository owns — TP001 through TP005, the deferred provenance check,
-- the append-only history — is enforced by a trigger, and a trigger can be
-- disabled by whoever owns its table. Measured, before writing any of this:
--
--   trustpass: superuser=t createdb=t createrole=t replication=t bypassrls=t
--   trustpass owns 8 of 8 tables, 8 of 8 sequences, 7 of 7 functions
--   PUBLIC holds CONNECT and TEMP on the database (the default, never revoked)
--
-- Five flags, not the two the issue recorded. `replication` alone lets that
-- credential stream the whole database out of the cluster without touching a
-- single table.
--
-- Two of the seven attacks in the `0023` rehearsal — dropping a trigger,
-- dropping a table — were refused because a purpose-made role did not own
-- anything. Run today with the credential the API actually uses, both succeed.
--
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not change what the running API can do. Not one privilege here takes
-- effect until `DATABASE_URL` names `trustpass_runtime`, and a migration cannot
-- edit an environment file. Until that happens this is a model with nobody
-- standing in it. The roles are created NOLOGIN and without a password for the
-- same reason: `pnpm db:provision` grants LOGIN from an environment secret, so
-- no credential is ever committed.
--
-- It also does not demote `trustpass`. That credential stays superuser and
-- stays the way an operator reaches this database. The boundary drawn here is
-- between the *application* and the record, which is the boundary an attacker
-- crosses over HTTP. An operator with the superuser password is a different
-- threat and a different answer (#122).
--
--
-- WHY EVERY GRANT IS NAMED
--
-- The rehearsal used `GRANT SELECT, INSERT, UPDATE ON ALL TABLES`. `ALL TABLES`
-- has the defect `0023` refused in `DROP TABLE ... CASCADE`: it acts on things
-- without naming them, so nobody reviewing it can say what it did. Worse, it is
-- wrong — measured across every repository and service:
--
--   .insert()  ->  product, lifecycle_event.  Nothing else.
--   .update()  ->  product.                   Nothing else.
--   .delete()  ->  nothing at all, anywhere.
--
-- So the runtime gets INSERT on two tables, UPDATE on one, and DELETE on none.
-- A capability that does not exist does not get a privilege, and the privilege
-- ships with the capability that needs it. `least-privilege.integration.test.ts`
-- fails when a table appears without an entry in the matrix, which turns "we
-- forgot to grant it" into a red test rather than a silent grant or a
-- production outage.
--
-- No sequence privileges, either. Every `id` is `GENERATED ALWAYS AS IDENTITY`
-- (`attidentity = 'a'`), not `serial`, and an identity column's sequence is
-- advanced by the system without a privilege check on the inserting role. The
-- rehearsal granted `USAGE, SELECT ON ALL SEQUENCES` for a need that does not
-- exist. The test inserts as the runtime role and proves it.

DO $$
BEGIN
  -- Creating roles and moving ownership needs more than this migration can ask
  -- for politely. Fail with a sentence rather than with a permission error four
  -- statements from now, half applied.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'This migration creates roles and transfers ownership, which needs a superuser. Connected as %.',
      current_user
      USING ERRCODE = 'TP006';
  END IF;
END;
$$;
--> statement-breakpoint
-- Roles are cluster-level, not database-level, so this has to be idempotent:
-- a second database in the same cluster (the `0023` rehearsal clone, for one)
-- runs the same migration against roles that already exist.
DO $$
BEGIN
  -- Owns every object. Cannot log in, so there is no password to leak and no
  -- network path to it — the privileges are reachable only by a role that is
  -- already inside and already a member.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustpass_owner') THEN
    CREATE ROLE trustpass_owner NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  -- Runs DDL, by being a member of the owner. Note what that means and do not
  -- dress it up: a member can `SET ROLE` to the owner at will, so compromising
  -- this role is compromising the owner. Splitting them does not reduce the
  -- privilege; it removes a password and gives DDL its own credential that a
  -- deploy holds and the application never does.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustpass_migration') THEN
    CREATE ROLE trustpass_migration NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  -- The application. This one is the point of the migration.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trustpass_runtime') THEN
    CREATE ROLE trustpass_runtime NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;
--> statement-breakpoint
GRANT trustpass_owner TO trustpass_migration;
--> statement-breakpoint
DO $$
BEGIN
  -- Every migration session becomes the owner on connect. Without this, a table
  -- created by a future migration is owned by `trustpass_migration` instead, and
  -- the ownership assertion below quietly stops being true for new objects —
  -- the drift is invisible until something needs to alter one.
  EXECUTE format(
    'ALTER ROLE trustpass_migration IN DATABASE %I SET role = trustpass_owner',
    current_database()
  );
END;
$$;
--> statement-breakpoint
-- PUBLIC holds CONNECT and TEMP on every database by default, and nobody ever
-- revoked them here. TEMP is not nothing: a role that can create temporary
-- tables can stage data inside the transaction it is attacking.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO trustpass_runtime', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO trustpass_migration', current_database());
END;
$$;
--> statement-breakpoint
-- Ownership, named object by named object.
--
-- `REASSIGN OWNED BY trustpass TO trustpass_owner` would be one line and is the
-- wrong line, for the reason `0023` gave about CASCADE: it moves whatever the
-- role happens to own, including the database itself and anything an operator
-- created by hand, and the diff does not say what moved.
--
-- One hazard worth knowing before running any of these by hand later, found
-- while mutation-checking this migration: **changing a table's owner destroys
-- the grants that were made to the role becoming the owner.** Moving `product`
-- to `trustpass_runtime` and straight back left its ACL as
-- `{trustpass_owner=arwdDxtm/trustpass_owner}` — the runtime's SELECT, INSERT
-- and UPDATE simply gone, with no error and no warning, while
-- `lifecycle_event` beside it still had its entry. The application would have
-- started returning 42501 on every read of its central table. An `ALTER TABLE
-- ... OWNER TO` is never only an ownership change; re-GRANT after one, and let
-- `least-privilege.integration.test.ts` be what tells you.
ALTER TABLE actor OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE capacity_grant OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE capacity_grant_revocation OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE credential OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE lifecycle_event OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE membership OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE organization OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE product OWNER TO trustpass_owner;
--> statement-breakpoint
-- The seven trigger functions. A function left owned by the old role is a
-- function the old role can still redefine — `CREATE OR REPLACE FUNCTION` on an
-- append-only guard is a quieter attack than dropping it, because the trigger
-- stays listed in `pg_trigger` and keeps firing.
ALTER FUNCTION capacity_grant_append_only() OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER FUNCTION lifecycle_event_append_only() OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER FUNCTION lifecycle_event_authority() OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER FUNCTION lifecycle_event_records_its_own_time() OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER FUNCTION membership_only_ends() OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER FUNCTION product_requires_provenance() OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER FUNCTION product_status_guard() OWNER TO trustpass_owner;
--> statement-breakpoint
-- Identity sequences are owned by their columns, so they follow their tables
-- for ordinary purposes — but `pg_class.relowner` does not, and an unmoved
-- sequence is an object the old role still owns. Moved by name, like the rest.
ALTER SEQUENCE actor_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE capacity_grant_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE capacity_grant_revocation_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE credential_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE lifecycle_event_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE membership_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE organization_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER SEQUENCE product_id_seq OWNER TO trustpass_owner;
--> statement-breakpoint
-- Drizzle's own bookkeeping. If the migration runner cannot write this table it
-- cannot record that a migration ran, and the next deploy replays everything.
ALTER SCHEMA drizzle OWNER TO trustpass_owner;
--> statement-breakpoint
ALTER TABLE drizzle.__drizzle_migrations OWNER TO trustpass_owner;
--> statement-breakpoint
-- USAGE, never CREATE. On Postgres 15 and later PUBLIC no longer holds CREATE
-- on the public schema — verified here, the ACL reads `=U/pg_database_owner` —
-- so the REVOKE below changes nothing today. It is one idempotent line, and it
-- makes the invariant true for a database restored from a dump taken before 15,
-- which is exactly the path #122 is about to start exercising.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO trustpass_runtime;
--> statement-breakpoint
-- The matrix. Read it as the answer to "what can the application do", because
-- after this that is precisely what it is.
--
--   product                    SELECT INSERT UPDATE   registered, then moved
--   lifecycle_event            SELECT INSERT          append-only, twice over
--   organization               SELECT                 written by migrations only
--   actor                      SELECT
--   membership                 SELECT
--   capacity_grant             SELECT
--   capacity_grant_revocation  SELECT
--   credential                 SELECT
--
-- `lifecycle_event` is the one to look at. The append-only trigger already
-- refuses an UPDATE with TP002, so withholding the privilege looks redundant —
-- and it is the whole idea. The trigger is the thing an attacker who reaches
-- the owner turns off. The missing privilege is the thing that still says no
-- afterwards.
GRANT SELECT, INSERT, UPDATE ON TABLE product TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE lifecycle_event TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE actor TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE capacity_grant TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE capacity_grant_revocation TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE credential TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE membership TO trustpass_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE organization TO trustpass_runtime;
--> statement-breakpoint
-- Functions default to EXECUTE for PUBLIC, and `proacl` is NULL on all seven
-- here, so the runtime would hold EXECUTE on every one of them. Today that is
-- unreachable — each returns `trigger`, and Postgres refuses to call a trigger
-- function directly — but the default is what applies to the first function
-- that does not, and a `SECURITY DEFINER` function reachable by PUBLIC is the
-- shortest path there is from "can connect" to "owns the database". There are
-- none right now. This is how there continue to be none by accident.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE trustpass_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
-- Deliberately absent: `ALTER DEFAULT PRIVILEGES ... GRANT ... TO
-- trustpass_runtime`. It would spare a line per future table and it would undo
-- the enumeration this migration is made of — a table added in 0025 would
-- become readable by the application without anyone deciding that it should.
-- The cost of leaving it out is that a new table needs its GRANT written down,
-- and the audit test fails until it is.
DO $$
DECLARE
  offender text;
BEGIN
  -- Nothing may still be owned by the role the application used to be.
  SELECT string_agg(relname, ', ') INTO offender
  FROM pg_class
  WHERE relnamespace = 'public'::regnamespace
    AND relkind IN ('r', 'S')
    AND relowner <> 'trustpass_owner'::regrole;

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'These objects are still owned by someone else: %', offender
      USING ERRCODE = 'TP006';
  END IF;

  -- The runtime owns nothing. An owner can re-grant itself anything, so
  -- "owns nothing" is the load-bearing half of "cannot do anything".
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relowner = 'trustpass_runtime'::regrole
  ) THEN
    RAISE EXCEPTION 'The runtime role owns an object. It can grant itself the rest.'
      USING ERRCODE = 'TP006';
  END IF;

  -- And it must not hold the privileges it was never given. Asked of the
  -- catalogue rather than trusted from the GRANTs above, because
  -- `has_table_privilege` answers for membership and PUBLIC too, which is how a
  -- privilege arrives without a GRANT naming it.
  IF has_table_privilege('trustpass_runtime', 'lifecycle_event', 'UPDATE')
     OR has_table_privilege('trustpass_runtime', 'lifecycle_event', 'DELETE')
     OR has_table_privilege('trustpass_runtime', 'product', 'DELETE')
     OR has_table_privilege('trustpass_runtime', 'capacity_grant', 'INSERT')
     OR has_table_privilege('trustpass_runtime', 'organization', 'INSERT')
  THEN
    RAISE EXCEPTION 'The runtime role holds a privilege this migration did not grant.'
      USING ERRCODE = 'TP006';
  END IF;

  IF has_schema_privilege('trustpass_runtime', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'The runtime role can create objects in the schema.'
      USING ERRCODE = 'TP006';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('trustpass_owner', 'trustpass_migration', 'trustpass_runtime')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'One of the new roles carries a cluster-level attribute.'
      USING ERRCODE = 'TP006';
  END IF;

  -- The same closing question `0023` asked: a migration that quietly removed a
  -- guarantee would satisfy every count above.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'lifecycle_event'::regclass
      AND tgname = 'lifecycle_event_no_update' AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'History is editable after this migration. Refusing.'
      USING ERRCODE = 'TP006';
  END IF;
END;
$$;
