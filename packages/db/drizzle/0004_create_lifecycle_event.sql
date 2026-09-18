CREATE TYPE "public"."lifecycle_actor_kind" AS ENUM('issuer', 'holder', 'authority', 'system');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_event_reason" AS ENUM('theft_report', 'fraud_flag', 'counterfeit_report', 'ownership_dispute', 'warranty_dispute', 'investigation_closed', 'dispute_resolved', 'issuer_request', 'holder_request', 'warranty_replacement', 'end_of_life', 'recording_error');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_event_type" AS ENUM('record_enrolled', 'product_registered', 'product_suspended', 'product_reinstated', 'product_retired', 'record_corrected');--> statement-breakpoint
CREATE TABLE "lifecycle_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "lifecycle_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"product_id" bigint NOT NULL,
	"type" "lifecycle_event_type" NOT NULL,
	"actor_kind" "lifecycle_actor_kind" NOT NULL,
	"issuer_id" bigint,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" "lifecycle_event_reason",
	"source_reference" varchar(200),
	"previous_state" "product_status",
	"resulting_state" "product_status",
	"corrects_event_id" bigint,
	CONSTRAINT "lifecycle_event_not_in_future" CHECK ("lifecycle_event"."occurred_at" <= "lifecycle_event"."recorded_at"),
	CONSTRAINT "lifecycle_event_issuer_matches_actor" CHECK (("lifecycle_event"."actor_kind" = 'issuer') = ("lifecycle_event"."issuer_id" IS NOT NULL)),
	CONSTRAINT "lifecycle_event_correction_targets" CHECK (("lifecycle_event"."type" = 'record_corrected') = ("lifecycle_event"."corrects_event_id" IS NOT NULL)),
	CONSTRAINT "lifecycle_event_transition_complete" CHECK (("lifecycle_event"."previous_state" IS NULL) = ("lifecycle_event"."resulting_state" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_issuer_id_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuer"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "lifecycle_event" ADD CONSTRAINT "lifecycle_event_corrects_event_id_lifecycle_event_id_fk" FOREIGN KEY ("corrects_event_id") REFERENCES "public"."lifecycle_event"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "lifecycle_event_product_idx" ON "lifecycle_event" USING btree ("product_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lifecycle_event_issuer_idx" ON "lifecycle_event" USING btree ("issuer_id");