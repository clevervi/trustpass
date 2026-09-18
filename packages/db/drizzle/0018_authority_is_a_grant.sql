-- Authority becomes a record with a lifetime, instead of a word on an event.
--
-- ADR 0011. lifecycle_event.actor_kind is self-declared: whoever reaches a write
-- path names the capacity they are acting in and the database believes them.
-- These tables are what it will be checked against.
--
-- The shape that matters is capacity_grant having NO revoked_at column, and the
-- absence is the design rather than an omission. ADR 0011 rejects it explicitly:
-- setting a column is an edit, and an editable grant means the answer to "was
-- this valid then" is whatever the row says now. The event would still point at
-- the grant while the grant changed underneath it — history rewritten without a
-- single event being touched.
--
-- So a revocation is its own fact, and "what authority did this actor hold on 2
-- August" is a query:
--
--   SELECT g.* FROM capacity_grant g
--   LEFT JOIN capacity_grant_revocation r ON r.grant_id = g.id
--   WHERE g.actor_id = $actor
--     AND g.effective_from <= $t
--     AND (g.expires_at IS NULL OR g.expires_at >  $t)
--     AND (r.revoked_at IS NULL OR r.revoked_at >  $t);
--
-- The last line is the one an implementation gets wrong. `r.revoked_at > $t`,
-- never `r.grant_id IS NULL`: a grant revoked in September WAS valid in August,
-- and filtering out every revoked grant answers "what may this actor do now"
-- while silently destroying the answer to "what could they do then" — the
-- question this entire ADR exists to keep answerable.
--
-- capacity_grant, not grant. `grant` is a reserved word in Postgres — measured,
-- not assumed: CREATE TABLE grant is a syntax error. Quoting works and would put
-- "grant" inside every trigger body below, where one missing pair of quotes is a
-- syntax error buried in PL/pgSQL.
--
-- lifecycle_event.grant_id arrives nullable and deliberately without a trigger
-- requiring it. No write path resolves a grant yet, so a constraint landing
-- before the code that satisfies it is a broken suite here and an outage
-- somewhere with deployments. The order is: schema, then write paths, then the
-- trigger that refuses NULL on new events.

CREATE TYPE "public"."actor_kind" AS ENUM('person', 'service', 'system');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('api_key', 'public_key', 'federated');--> statement-breakpoint
CREATE TYPE "public"."grant_scope_kind" AS ENUM('own_organization', 'country');--> statement-breakpoint
CREATE TABLE "actor" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "actor_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "actor_kind" NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actor_display_name_not_blank" CHECK (length(trim("actor"."display_name")) >= 2)
);
--> statement-breakpoint
CREATE TABLE "capacity_grant" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "capacity_grant_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" bigint NOT NULL,
	"organization_id" bigint,
	"capacity" "lifecycle_actor_kind" NOT NULL,
	"scope_kind" "grant_scope_kind" NOT NULL,
	"scope_country" varchar(2),
	"effective_from" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"granted_by" bigint,
	"evidence_reference" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_grant_holder_is_not_granted" CHECK ("capacity_grant"."capacity" <> 'holder'),
	CONSTRAINT "capacity_grant_country_scope_names_a_country" CHECK (("capacity_grant"."scope_kind" = 'country') = ("capacity_grant"."scope_country" IS NOT NULL)),
	CONSTRAINT "capacity_grant_scope_country_iso_alpha2" CHECK ("capacity_grant"."scope_country" IS NULL OR "capacity_grant"."scope_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "capacity_grant_own_organization_scope_has_one" CHECK ("capacity_grant"."scope_kind" <> 'own_organization' OR "capacity_grant"."organization_id" IS NOT NULL),
	CONSTRAINT "capacity_grant_expires_after_it_starts" CHECK ("capacity_grant"."expires_at" IS NULL OR "capacity_grant"."expires_at" > "capacity_grant"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "capacity_grant_revocation" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "capacity_grant_revocation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"grant_id" bigint NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"revoked_by" bigint NOT NULL,
	"reason" varchar(200) NOT NULL,
	"evidence_reference" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capacity_grant_revocation_reason_not_blank" CHECK (length(trim("capacity_grant_revocation"."reason")) >= 2)
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credential_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" bigint NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"label" varchar(120) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_expires_after_issue" CHECK ("credential"."expires_at" IS NULL OR "credential"."expires_at" > "credential"."issued_at"),
	CONSTRAINT "credential_revoked_after_issue" CHECK ("credential"."revoked_at" IS NULL OR "credential"."revoked_at" >= "credential"."issued_at"),
	CONSTRAINT "credential_label_not_blank" CHECK (length(trim("credential"."label")) >= 2)
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "membership_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" bigint NOT NULL,
	"organization_id" bigint NOT NULL,
	"began_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_ends_after_it_begins" CHECK ("membership"."ended_at" IS NULL OR "membership"."ended_at" > "membership"."began_at")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "organization_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"legal_name" varchar(200) NOT NULL,
	"registration_number" varchar(50) NOT NULL,
	"country" varchar(2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_country_iso_alpha2" CHECK ("organization"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "organization_registration_number_format" CHECK ("organization"."registration_number" ~ '^[A-Z0-9-]{4,50}$'),
	CONSTRAINT "organization_legal_name_not_blank" CHECK (length(trim("organization"."legal_name")) >= 2)
);
--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD COLUMN "grant_id" bigint;--> statement-breakpoint
ALTER TABLE "capacity_grant" ADD CONSTRAINT "capacity_grant_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "capacity_grant" ADD CONSTRAINT "capacity_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "capacity_grant" ADD CONSTRAINT "capacity_grant_granted_by_actor_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."actor"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "capacity_grant_revocation" ADD CONSTRAINT "capacity_grant_revocation_grant_id_capacity_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."capacity_grant"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "capacity_grant_revocation" ADD CONSTRAINT "capacity_grant_revocation_revoked_by_actor_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."actor"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_actor_id_actor_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actor"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "capacity_grant_actor_idx" ON "capacity_grant" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "capacity_grant_organization_idx" ON "capacity_grant" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_grant_revocation_grant_idx" ON "capacity_grant_revocation" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "credential_actor_idx" ON "credential" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "membership_actor_idx" ON "membership" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "membership_organization_idx" ON "membership" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_country_registration_idx" ON "organization" USING btree ("country","registration_number");--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_grant_id_capacity_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."capacity_grant"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
-- The semantics of NULL, written where a reader will meet it.
--
-- One `WHERE grant_id IS NULL` away from being read as "this event had no
-- authority behind it", which would turn a limitation of the system into an
-- accusation about a record — ADR 0003's failure reached through a nullable
-- column. Over eight thousand events predate it and no grant existed to point
-- them at; inventing a "legacy" grant would have them referencing something
-- nobody issued, to nobody, for nothing.
COMMENT ON COLUMN lifecycle_event.grant_id IS
  'The grant this action was authorised under. NULL means the event was recorded before TrustPass could prove authority (pre-TP-141). It does NOT mean the event lacked authority.';
--> statement-breakpoint
-- Authority is append-only, for the reason 0005 gives about history: a row that
-- can be edited is a claim about the past that whoever has the most to gain can
-- rewrite. Here the stakes are the same — a grant that can be edited makes every
-- event pointing at it unreadable, because what it says now is not what it said.
--
-- A BEFORE trigger rather than a REVOKE, again per 0005: the application
-- connects as the owner, and the owner can re-grant itself any privilege it was
-- denied. A trigger fires for every writer including the owner.
--
-- SQLSTATE TP005 is project-defined and distinct from TP001 (illegal status
-- move), TP002 (history is append-only), TP003 (unauthorised recording) and
-- TP004 (provenance required), so a caller can tell "authority cannot be
-- rewritten" from the other four without parsing a message.
CREATE OR REPLACE FUNCTION capacity_grant_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'A grant cannot be modified. Revoke it and issue a new one.'
      USING ERRCODE = 'TP005';
  END IF;

  RAISE EXCEPTION
    'A grant cannot be deleted. Authority is append-only.'
    USING ERRCODE = 'TP005';
END;
$$;
--> statement-breakpoint
-- No column list: every column is protected, not the interesting ones. A guard
-- covering scope but not expires_at protects nothing.
CREATE TRIGGER capacity_grant_no_update
BEFORE UPDATE ON capacity_grant
FOR EACH ROW
EXECUTE FUNCTION capacity_grant_append_only();
--> statement-breakpoint
CREATE TRIGGER capacity_grant_no_delete
BEFORE DELETE ON capacity_grant
FOR EACH ROW
EXECUTE FUNCTION capacity_grant_append_only();
--> statement-breakpoint
-- TRUNCATE is not a DELETE and a row-level trigger never sees it. Without this
-- every grant is one statement away from gone, and every event referencing one
-- becomes unreadable at the same instant.
CREATE TRIGGER capacity_grant_no_truncate
BEFORE TRUNCATE ON capacity_grant
FOR EACH STATEMENT
EXECUTE FUNCTION capacity_grant_append_only();
--> statement-breakpoint
-- A revocation is as permanent as the grant it ends. Editing one would move the
-- moment authority stopped, which changes the answer for every event recorded
-- near it.
CREATE TRIGGER capacity_grant_revocation_no_update
BEFORE UPDATE ON capacity_grant_revocation
FOR EACH ROW
EXECUTE FUNCTION capacity_grant_append_only();
--> statement-breakpoint
CREATE TRIGGER capacity_grant_revocation_no_delete
BEFORE DELETE ON capacity_grant_revocation
FOR EACH ROW
EXECUTE FUNCTION capacity_grant_append_only();
--> statement-breakpoint
CREATE TRIGGER capacity_grant_revocation_no_truncate
BEFORE TRUNCATE ON capacity_grant_revocation
FOR EACH STATEMENT
EXECUTE FUNCTION capacity_grant_append_only();
--> statement-breakpoint
-- A membership ends; it does not change. ended_at is the only column an update
-- may touch, and the guard names that narrowness rather than trusting callers
-- to observe it — moving an actor to a different organization retroactively
-- would rewrite who every event they recorded was acting for.
CREATE OR REPLACE FUNCTION membership_only_ends() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A membership cannot be deleted. End it by setting ended_at.'
      USING ERRCODE = 'TP005';
  END IF;

  IF NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.began_at IS DISTINCT FROM OLD.began_at
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Only ended_at may be changed on a membership.'
      USING ERRCODE = 'TP005';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER membership_only_ends_update
BEFORE UPDATE ON membership
FOR EACH ROW
EXECUTE FUNCTION membership_only_ends();
--> statement-breakpoint
CREATE TRIGGER membership_no_delete
BEFORE DELETE ON membership
FOR EACH ROW
EXECUTE FUNCTION membership_only_ends();
