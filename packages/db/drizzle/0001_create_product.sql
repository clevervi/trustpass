CREATE TYPE "public"."product_category" AS ENUM('gpu', 'cpu', 'motherboard', 'laptop', 'desktop', 'smartphone', 'tablet', 'monitor', 'camera', 'console', 'storage', 'peripheral', 'other');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'registered', 'active', 'suspended', 'retired');--> statement-breakpoint
CREATE TABLE "product" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trustpass_id" varchar(64) NOT NULL,
	"issuer_id" bigint NOT NULL,
	"brand" varchar(120) NOT NULL,
	"model" varchar(120) NOT NULL,
	"serial" varchar(120) NOT NULL,
	"category" "product_category" NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_trustpass_id_shape" CHECK ("product"."trustpass_id" ~ '^TP[0-9]'),
	CONSTRAINT "product_serial_not_blank" CHECK (length(trim("product"."serial")) >= 2)
);
--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_issuer_id_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuer"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "product_trustpass_id_idx" ON "product" USING btree ("trustpass_id");--> statement-breakpoint
CREATE INDEX "product_issuer_id_idx" ON "product" USING btree ("issuer_id");--> statement-breakpoint
CREATE INDEX "product_serial_idx" ON "product" USING btree (lower("serial"));