-- The rules move to the identity that will still exist.
--
-- Four constraints keyed on issuer_id, and none of them is a mechanical
-- reference. Each encodes something the system means:
--
--   product_live_issuer_serial_idx    one live identity per serial, per party
--   product_live_holder_serial_idx    one live holder record per serial
--   product_holder_has_no_issuer      a record has a party or a holder origin
--   lifecycle_event_issuer_matches_actor  an issuer event names the issuer
--
-- Moved, not rewritten. Every one means exactly what it meant, asked of
-- organization_id — which 0020 and 0021 guarantee holds the same party for
-- every row that had an issuer, so the new checks are satisfied by the existing
-- data rather than requiring it to change.
--
-- The fourth one deserves a note, because it is the one that could have been
-- improved here and deliberately was not.
--
-- ADR 0012 makes a *wider* rule possible for the first time: a police force is
-- an organization too, so an authority event could finally name who reported a
-- theft — which this constraint has structurally forbidden, and which
-- lifecycle-event.ts has been carrying a comment about since 0018. That is new
-- capability rather than a move, and doing both in one change would make it
-- impossible to tell which of the two broke anything. It has its own issue.
--
-- product_live_holder_serial_idx keeps its name. Its subject did not change:
-- it is still about records with no party at all, and the column it reads to
-- find them is the only thing that moved.

ALTER TABLE "lifecycle_event" DROP CONSTRAINT "lifecycle_event_issuer_matches_actor";--> statement-breakpoint
ALTER TABLE "product" DROP CONSTRAINT "product_holder_has_no_issuer";--> statement-breakpoint
DROP INDEX "product_live_issuer_serial_idx";--> statement-breakpoint
DROP INDEX "product_live_holder_serial_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "product_live_organization_serial_idx" ON "product" USING btree ("organization_id",lower("serial")) WHERE "product"."status" <> 'retired';--> statement-breakpoint
CREATE UNIQUE INDEX "product_live_holder_serial_idx" ON "product" USING btree (lower("serial")) WHERE "product"."organization_id" IS NULL AND "product"."status" <> 'retired';--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_organization_matches_actor" CHECK (("lifecycle_event"."actor_kind" = 'issuer') = ("lifecycle_event"."organization_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_holder_has_no_organization" CHECK (("product"."origin" = 'holder') = ("product"."organization_id" IS NULL));